/**
 * Epic #192 (A.5) — living-spec sync.
 *
 * On `pull_request.closed` (with `merged:true`), walks every issue number
 * referenced in the PR body via `Closes #N` keywords and marks the linked
 * `Requirement` rows as implemented. Each PR also produces one
 * `RequirementImplementation` row per (file × hunk) so the UI can show
 * "Implemented by" links.
 *
 * The mapping from `issueNumber → Requirement` goes through the existing
 * `PublishedIssue → IssueDraft → Requirement` chain (the same path the
 * publishing pipeline uses to track which AI-generated draft became which
 * GitHub issue). The handler is **idempotent**: replaying the same merge
 * event does not duplicate `RequirementImplementation` rows (deduped by the
 * `(requirementId, prNumber, filePath)` triple).
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { noteRequirementCodeLinksChanged } from "../docs-gen/approved-requirements-staleness.js";
import { connectionsNamedByPrUrl } from "../docs-gen/approved-requirements-scope.js";
import { createChildLogger } from "../logger.js";
import { parseDiffHunks, parseLinkedIssues, type DiffHunk } from "./diff-parser.js";
import type { PullRequestPayload, RepositoryPayload } from "./webhook.js";

const log = createChildLogger("living-spec-requirement-sync");

export interface SyncMergedPRInput {
  pr: PullRequestPayload;
  repo: RepositoryPayload;
  /** Optional unified diff (omit when not yet fetched — sync still updates implementedAt). */
  diff?: string | null;
}

export interface SyncMergedPRResult {
  requirementsUpdated: number;
  implementationsCreated: number;
  driftedFiles: string[];
}

export interface SyncDeps {
  prisma?: PrismaClient;
}

/**
 * Resolve every Requirement linked to the PR via `Closes #N` keywords.
 * Walks `PublishedIssue` rows to find the issue number → requirement chain.
 */
async function resolveLinkedRequirements(
  prisma: PrismaClient,
  closedIssueNumbers: number[],
): Promise<Array<{ id: string; projectId: string }>> {
  if (closedIssueNumbers.length === 0) return [];
  const published = await prisma.publishedIssue.findMany({
    where: { issueNumber: { in: closedIssueNumbers } },
    include: { draft: true },
  });
  const requirementIds = new Set<string>();
  const out: Array<{ id: string; projectId: string }> = [];
  for (const row of published) {
    const reqId = row.draft?.requirementId;
    if (!reqId || requirementIds.has(reqId)) continue;
    requirementIds.add(reqId);
    out.push({ id: reqId, projectId: row.draft.projectId });
  }
  return out;
}

export async function syncMergedPR(
  input: SyncMergedPRInput,
  deps: SyncDeps = {},
): Promise<SyncMergedPRResult> {
  const prisma = deps.prisma ?? defaultPrisma;
  const { pr, repo } = input;
  if (!pr.merged) {
    return { requirementsUpdated: 0, implementationsCreated: 0, driftedFiles: [] };
  }
  const links = parseLinkedIssues(pr.body);
  const requirements = await resolveLinkedRequirements(prisma, links.closes);
  if (requirements.length === 0) {
    return { requirementsUpdated: 0, implementationsCreated: 0, driftedFiles: [] };
  }
  const mergedAt = pr.merged_at ? new Date(pr.merged_at) : new Date();
  const sha = pr.merge_commit_sha ?? pr.head?.sha ?? "";
  const prUrl = pr.html_url ?? (repo.html_url ? `${repo.html_url}/pull/${pr.number}` : "");

  // Update implementedAt/By idempotently. We use updateMany with a "first
  // implementation wins" semantic — once `implementedAt` is set, subsequent
  // re-merges leave the original timestamp untouched but will still log a
  // RequirementImplementation row for the new commit/diff hunks.
  const reqIds = requirements.map((r) => r.id);
  await prisma.requirement.updateMany({
    where: { id: { in: reqIds }, implementedAt: null },
    data: {
      implementedAt: mergedAt,
      implementedByPr: pr.number,
      implementedBySha: sha,
    },
  });

  const hunks: DiffHunk[] = parseDiffHunks(input.diff ?? "");
  let implementationsCreated = 0;
  const linked = new Set<string>();
  if (hunks.length > 0) {
    for (const req of requirements) {
      for (const hunk of hunks) {
        // Idempotency: skip if a row for (req, prNumber, filePath, startLine) exists.
        const existing = await prisma.requirementImplementation.findFirst({
          where: {
            requirementId: req.id,
            prNumber: pr.number,
            filePath: hunk.filePath,
            startLine: hunk.startLine ?? null,
          },
        });
        if (existing) continue;
        await prisma.requirementImplementation.create({
          data: {
            requirementId: req.id,
            prNumber: pr.number,
            prUrl,
            commitSha: sha,
            filePath: hunk.filePath,
            startLine: hunk.startLine ?? null,
            endLine: hunk.endLine ?? null,
            mergedAt,
          },
        });
        implementationsCreated += 1;
        linked.add(req.id);
      }
    }
    // #1246 — a merged pull request's files can bring an approved requirement
    // into a repository- or path-scoped reader BRD's list: ask the check to
    // look again, for the requirements that gained a row, and only in a
    // project that connects the repository the pull request is in. A pull
    // request is matched to requirements by issue number alone, so the rows
    // can land on another project's requirement; that project's list never
    // counts them (`approved-requirements-scope.ts`), so it is not checked.
    // Best effort: the rows are written; a failed lookup here must not fail
    // the webhook (the next ingest's check reads the same links).
    if (linked.size > 0) {
      try {
        const inRepository = await projectsConnecting(
          prisma,
          prUrl,
          requirements.filter((r) => linked.has(r.id)).map((r) => r.projectId),
        );
        const ids = requirements
          .filter((r) => linked.has(r.id) && inRepository.has(r.projectId))
          .map((r) => r.id);
        if (ids.length > 0) void noteRequirementCodeLinksChanged(ids);
      } catch (err) {
        log.warn("Could not check reader BRDs after a merged pull request", {
          prNumber: pr.number,
          error: (err as Error).message,
        });
      }
    }
  }

  // Drift detection: any file in the diff that doesn't match a known
  // project area is surfaced for the UI. v1.2 keeps this simple — we
  // report the file paths and let the UI decide what to do. Any path
  // outside `src/`, `ui/`, `server/`, `e2e/`, `docs/`, `packages/`,
  // `scripts/` is "drift". This is intentionally conservative.
  const KNOWN_PREFIXES = ["src/", "ui/", "server/", "e2e/", "docs/", "packages/", "scripts/"];
  const driftedFiles = [
    ...new Set(
      hunks
        .map((h) => h.filePath)
        .filter((p) => !KNOWN_PREFIXES.some((prefix) => p.startsWith(prefix))),
    ),
  ];

  return {
    requirementsUpdated: requirements.length,
    implementationsCreated,
    driftedFiles,
  };
}

/** #1246 — which of `projectIds` have a live connection the pull request URL names. */
async function projectsConnecting(
  prisma: PrismaClient,
  prUrl: string,
  projectIds: readonly string[],
): Promise<Set<string>> {
  const connections = await prisma.repoConnection.findMany({
    where: { projectId: { in: [...new Set(projectIds)] }, deletedAt: null },
    select: { id: true, projectId: true, ownerOrOrg: true, repoName: true },
  });
  const named = new Set(connectionsNamedByPrUrl(prUrl, connections));
  return new Set(connections.filter((c) => named.has(c.id)).map((c) => c.projectId));
}
