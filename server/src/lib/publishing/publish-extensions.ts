/**
 * Publish extensions — Epic #163 (#97 + #108).
 *
 * After a successful publish batch, this module handles:
 *
 *   1. **GitHub Projects v2** (Issue #108): for each PublishedIssue created
 *      this batch, call `addProjectV2ItemById` and apply the per-project
 *      field mappings. Per AC #3, failures are recorded in the
 *      PublishedIssue.errorMessage but never roll back the issue itself.
 *
 *   2. **.copilot-workspace.md handoff** (Issue #97): commit a single
 *      handoff brief to the target repo when `metadata.copilotWorkspace`
 *      is true. Idempotent — uses the existing file SHA + content hash to
 *      avoid no-op commits.
 *
 * Both extensions are opt-in per publish batch (via metadata flags) and per
 * project (Projects v2 requires `Project.githubProjectId`).
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import {
  COPILOT_WORKSPACE_PATH,
  renderCopilotWorkspaceMarkdown,
  workspaceContentHash,
  type WorkspaceEpic,
} from "./copilot-workspace-md.js";
import {
  addProjectItem,
  applyFieldMappings,
  parseFieldMappings,
  type ProjectV2FieldMappings,
} from "./projects-v2.js";
import type { PublishOctokitLike } from "./types.js";

const log = createChildLogger("publish-extensions");

export interface PublishExtensionsConfig {
  copilotWorkspace: boolean;
  projectsV2: boolean;
}

/** Read flags from a batch's metadata JSON blob. Defaults to `false`. */
export function parseExtensionFlags(metadata: string | null): PublishExtensionsConfig {
  if (!metadata) return { copilotWorkspace: false, projectsV2: false };
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return {
      copilotWorkspace: parsed.copilotWorkspace === true,
      projectsV2: parsed.projectsV2 === true,
    };
  } catch {
    return { copilotWorkspace: false, projectsV2: false };
  }
}

// ---- Projects v2 ----------------------------------------------------------

export interface AddItemsArgs {
  client: PublishOctokitLike;
  batchId: string;
  projectId: string;
  actorId: string;
}

export interface AddItemsResult {
  added: number;
  failed: number;
  fieldUpdateOk: number;
  fieldUpdateFailed: number;
}

export async function addPublishedIssuesToProject(args: AddItemsArgs): Promise<AddItemsResult> {
  const project = await prisma.project.findUnique({
    where: { id: args.projectId },
    select: {
      githubProjectId: true,
      githubProjectFieldMappings: true,
    },
  });
  const result: AddItemsResult = {
    added: 0,
    failed: 0,
    fieldUpdateOk: 0,
    fieldUpdateFailed: 0,
  };
  if (!project?.githubProjectId) {
    return result;
  }
  const mappings: ProjectV2FieldMappings | null = parseFieldMappings(
    project.githubProjectFieldMappings,
  );

  const issues = await prisma.publishedIssue.findMany({
    where: {
      batchId: args.batchId,
      status: { in: ["created", "updated"] },
      issueId: { not: "" },
    },
  });
  for (const issue of issues) {
    try {
      const added = await addProjectItem(args.client, {
        projectId: project.githubProjectId,
        contentId: issue.issueId,
      });
      result.added += 1;
      if (mappings) {
        const updates = await applyFieldMappings(args.client, {
          projectId: project.githubProjectId,
          itemId: added.projectItemId,
          mappings,
        });
        for (const u of updates) {
          if (u.ok) result.fieldUpdateOk += 1;
          else result.fieldUpdateFailed += 1;
        }
      }
      audit({
        actor: { id: args.actorId },
        action: "publish.projects_v2.item_added",
        target: { type: "github_issue", id: String(issue.issueNumber) },
        metadata: {
          batchId: args.batchId,
          projectId: args.projectId,
          githubProjectId: project.githubProjectId,
          fields: mappings ? Object.keys(mappings).length : 0,
        },
      });
    } catch (err) {
      result.failed += 1;
      const message = (err as Error).message ?? "unknown";
      log.warn("publish.projects_v2.item_add_failed", {
        batchId: args.batchId,
        issueNumber: issue.issueNumber,
        message,
      });
      // AC #3: NEVER roll back the underlying issue. Just record the
      // failure on the PublishedIssue row for the publish-history UI.
      await prisma.publishedIssue.update({
        where: { id: issue.id },
        data: {
          errorMessage: `projects_v2: ${message}`.slice(0, 4000),
        },
      });
      audit({
        actor: { id: args.actorId },
        action: "publish.projects_v2.item_failed",
        target: { type: "github_issue", id: String(issue.issueNumber) },
        metadata: {
          batchId: args.batchId,
          projectId: args.projectId,
          githubProjectId: project.githubProjectId,
          error: message,
        },
      });
    }
  }
  return result;
}

// ---- .copilot-workspace.md ------------------------------------------------

export interface CommitWorkspaceArgs {
  client: PublishOctokitLike;
  batchId: string;
  projectId: string;
  target: { owner: string; repo: string };
  actorId: string;
  /** Optional default branch override; otherwise resolved via the repo API. */
  branch?: string;
}

export interface CommitWorkspaceResult {
  /** True when a commit was actually pushed. False when the file was
   * already up-to-date OR there are no published issues to summarize. */
  committed: boolean;
  path: string;
  contentHash: string | null;
}

export async function commitCopilotWorkspaceBrief(
  args: CommitWorkspaceArgs,
): Promise<CommitWorkspaceResult> {
  const epics = await loadBatchEpics(args.batchId, args.projectId);
  if (epics.length === 0) {
    return { committed: false, path: COPILOT_WORKSPACE_PATH, contentHash: null };
  }
  const repo = `${args.target.owner}/${args.target.repo}`;
  const content = renderCopilotWorkspaceMarkdown({
    epics,
    repo,
    generatedAt: new Date().toISOString(),
  });
  const contentHash = await workspaceContentHash(content);

  const branch = args.branch ?? (await resolveDefaultBranch(args.client, args.target));

  // Probe the existing file (404 = create, 200 = update).
  let existingSha: string | null = null;
  try {
    const probe = await args.client.request<{ sha: string }>({
      method: "GET",
      url: `${contentsPath(args.target)}?ref=${encodeURIComponent(branch)}`,
    });
    existingSha = probe.data?.sha ?? null;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      log.warn("copilot_workspace.probe_failed", { repo, status, err: (err as Error).message });
    }
  }

  const body: Record<string, unknown> = {
    message: `chore(metis): update .copilot-workspace.md (batch ${args.batchId})`,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
  };
  if (existingSha) body.sha = existingSha;

  try {
    await args.client.request({
      method: "PUT",
      url: contentsPath(args.target),
      data: body,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 422 with "no changes" means the contents matched — treat as already up-to-date.
    if (status === 422) {
      audit({
        actor: { id: args.actorId },
        action: "publish.copilot_workspace.unchanged",
        target: { type: "github_repo", id: repo },
        metadata: { batchId: args.batchId, contentHash, path: COPILOT_WORKSPACE_PATH },
      });
      return { committed: false, path: COPILOT_WORKSPACE_PATH, contentHash };
    }
    throw err;
  }

  audit({
    actor: { id: args.actorId },
    action: "publish.copilot_workspace.committed",
    target: { type: "github_repo", id: repo },
    metadata: {
      batchId: args.batchId,
      projectId: args.projectId,
      path: COPILOT_WORKSPACE_PATH,
      branch,
      contentHash,
      epics: epics.length,
    },
  });
  return { committed: true, path: COPILOT_WORKSPACE_PATH, contentHash };
}

// ---- Helpers --------------------------------------------------------------

function contentsPath(target: { owner: string; repo: string }): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${COPILOT_WORKSPACE_PATH}`;
}

async function resolveDefaultBranch(
  client: PublishOctokitLike,
  target: { owner: string; repo: string },
): Promise<string> {
  try {
    const res = await client.request<{ default_branch?: string }>({
      method: "GET",
      url: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`,
    });
    return res.data?.default_branch ?? "main";
  } catch {
    return "main";
  }
}

async function loadBatchEpics(batchId: string, projectId: string): Promise<WorkspaceEpic[]> {
  const issues = await prisma.publishedIssue.findMany({
    where: {
      batchId,
      status: { in: ["created", "updated"] },
      issueNumber: { gt: 0 },
    },
    include: {
      draft: {
        select: {
          id: true,
          title: true,
          body: true,
          draftType: true,
          parentDraftId: true,
          storyPoints: true,
          metadata: true,
        },
      },
    },
  });
  if (issues.length === 0) return [];
  const draftIdToIssue = new Map<string, { number: number; title: string }>();
  for (const i of issues) {
    if (i.draft) draftIdToIssue.set(i.draft.id, { number: i.issueNumber, title: i.draft.title });
  }

  // For every epic in this batch, gather the sub-issues whose parentDraftId
  // points at it. We only consider sub-issues we ALSO published (or already
  // existed in this project's history) so the brief reflects the actual
  // remote shape.
  const epics: WorkspaceEpic[] = [];
  for (const i of issues) {
    if (!i.draft || i.draft.draftType !== "epic") continue;
    const subDrafts = await prisma.issueDraft.findMany({
      where: { parentDraftId: i.draft.id, projectId },
      select: { id: true, title: true, storyPoints: true, metadata: true },
      orderBy: { createdAt: "asc" },
    });
    const subs = subDrafts.flatMap((sd) => {
      const remote = draftIdToIssue.get(sd.id);
      if (!remote) return [];
      return [
        {
          number: remote.number,
          title: sd.title,
          storyPoints: sd.storyPoints ?? null,
          dependencies: extractDependencies(sd.metadata),
        },
      ];
    });
    epics.push({
      number: i.issueNumber,
      title: i.draft.title,
      summary: extractSummary(i.draft.body),
      subIssues: subs,
    });
  }
  return epics;
}

function extractSummary(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const para = trimmed.split(/\n\s*\n/)[0];
  return para.length > 480 ? `${para.slice(0, 480)}…` : para;
}

function extractDependencies(metadata: string | null): number[] {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata) as { dependencies?: unknown };
    if (Array.isArray(parsed.dependencies)) {
      return parsed.dependencies
        .map((n) => (typeof n === "number" ? n : Number(n)))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch {
    /* ignore */
  }
  return [];
}
