/**
 * Epic #394 (#398) — AC traceability lookup.
 *
 * Resolves a PR (body + branch name + repo) back to the canonical
 * `AcceptanceCriterion[]` extracted from its originating `PublishedIssue`
 * → `IssueDraft` row. Replaces the body-text heuristic that previously
 * lived in `webhooks-github.ts`.
 *
 * Ordering of inputs:
 *   1. PR body — `Closes/Fixes/Resolves #N` keywords (case-insensitive).
 *   2. Branch name — `(?:^|/|-)(?:issue-|gh-)?(\d+)(?:[-/]|$)`.
 *
 * Lookup chain:
 *   `issueNumbers[] → PublishedIssue rows (filtered by repo) → IssueDraft.body`
 *   → `extractAcceptanceCriteria(body)` → `AcceptanceCriterionWithSource[]`
 *
 * If no link is found (or no ACs are extractable) the function returns
 * `[]` — the agent's caller is responsible for emitting a `skipped` audit
 * entry and short-circuiting before any LLM call.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../prisma.js";
import { parseBranchIssueNumbers, parseLinkedIssues } from "../../living-spec/diff-parser.js";

export interface AcceptanceCriterionWithSource {
  /** Stable identifier: `<sourceIssueNumber>-AC<index>` (e.g. `42-AC3`). */
  id: string;
  /** Raw AC text (the body of the bullet point). */
  text: string;
  /** Issue number this AC was extracted from. */
  sourceIssueNumber: number;
  /** Optional draft id for richer traceability — `null` if unknown. */
  draftId: string | null;
}

export interface ResolveAcceptanceCriteriaInput {
  prBody: string | null | undefined;
  branchName: string | null | undefined;
  repoOwner: string;
  repoName: string;
  /** Optional projectId scope — when set, only PublishedIssues whose draft
   * belongs to this project are considered (defence in depth). */
  projectId?: string | null;
}

export interface ResolveAcceptanceCriteriaResult {
  criteria: AcceptanceCriterionWithSource[];
  /** Issue numbers that linked from PR body / branch but had no PublishedIssue match. */
  unresolvedIssueNumbers: number[];
  /** Resolved (linked + matched) issue numbers that contributed ACs. */
  linkedIssueNumbers: number[];
  /** Reason the result is empty, when applicable. */
  skipReason: "no_linked_issue" | "no_published_issue" | "no_acceptance_criteria" | null;
}

/**
 * Public entry point. Hermetic against the DB through the optional `prisma`
 * argument so unit tests can pass a stub without standing up the schema.
 */
export async function resolveAcceptanceCriteriaForPr(
  input: ResolveAcceptanceCriteriaInput,
  prisma: PrismaClient = defaultPrisma,
): Promise<ResolveAcceptanceCriteriaResult> {
  const fromBody = parseLinkedIssues(input.prBody).closes;
  const fromBranch = parseBranchIssueNumbers(input.branchName);
  const issueNumbers = uniqSortedAsc([...fromBody, ...fromBranch]);
  if (issueNumbers.length === 0) {
    return {
      criteria: [],
      unresolvedIssueNumbers: [],
      linkedIssueNumbers: [],
      skipReason: "no_linked_issue",
    };
  }
  // Look up PublishedIssue rows scoped to the repo via PublishBatch ownership.
  // We cannot filter by (owner, repo) directly on PublishedIssue — that lives
  // on the parent PublishBatch. Use a nested filter so the DB does the join.
  const where: Record<string, unknown> = {
    issueNumber: { in: issueNumbers },
    batch: {
      targetOwner: input.repoOwner,
      targetRepo: input.repoName,
    },
  };
  if (input.projectId) {
    (where.batch as Record<string, unknown>) = {
      ...(where.batch as Record<string, unknown>),
      projectId: input.projectId,
    };
  }
  const rows = await prisma.publishedIssue.findMany({
    where: where as never,
    include: { draft: true },
    orderBy: { issueNumber: "asc" },
  });
  if (rows.length === 0) {
    return {
      criteria: [],
      unresolvedIssueNumbers: issueNumbers,
      linkedIssueNumbers: [],
      skipReason: "no_published_issue",
    };
  }
  const matchedIssueNumbers = new Set(rows.map((r) => r.issueNumber));
  const unresolved = issueNumbers.filter((n) => !matchedIssueNumbers.has(n));

  const criteria: AcceptanceCriterionWithSource[] = [];
  // De-dupe ACs that share both issue + text — same draft published twice
  // (re-publish) shouldn't double the input to the judge.
  const seen = new Set<string>();
  for (const row of rows) {
    const draft = row.draft;
    if (!draft) continue;
    const acs = extractAcceptanceCriteria(draft.body ?? "");
    acs.forEach((text, idx) => {
      const id = `${row.issueNumber}-AC${idx + 1}`;
      const key = `${row.issueNumber}::${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      criteria.push({
        id,
        text,
        sourceIssueNumber: row.issueNumber,
        draftId: draft.id ?? null,
      });
    });
  }

  if (criteria.length === 0) {
    return {
      criteria: [],
      unresolvedIssueNumbers: unresolved,
      linkedIssueNumbers: [...matchedIssueNumbers].sort((a, b) => a - b),
      skipReason: "no_acceptance_criteria",
    };
  }

  return {
    criteria,
    unresolvedIssueNumbers: unresolved,
    linkedIssueNumbers: [...matchedIssueNumbers].sort((a, b) => a - b),
    skipReason: null,
  };
}

/**
 * Pull `- [ ] ...` checkbox bullets out of the `## Acceptance criteria`
 * section of an issue body. Falls back to scanning the whole body for
 * Given/When/Then bullets when the section header is missing (matches the
 * legacy webhook behaviour).
 */
export function extractAcceptanceCriteria(body: string): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  let inAcSection = false;
  let sawAcSection = false;
  const out: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,6}\s+(?:acceptance\s+criteria|acceptance-criteria|ac:?)\b/i.test(line)) {
      inAcSection = true;
      sawAcSection = true;
      continue;
    }
    // Leaving the AC section on the next heading at any depth.
    if (inAcSection && /^#{1,6}\s+/.test(line)) {
      inAcSection = false;
    }
    if (inAcSection) {
      const m = /^[-*]\s*\[[ xX]\]\s*(.+)$/.exec(line);
      if (m) {
        out.push(stripMd(m[1]));
      }
      continue;
    }
  }

  // Fallback: when no AC section header existed at all, scan the whole body
  // for Given/When/Then checkbox bullets to preserve legacy behaviour.
  if (!sawAcSection) {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const m = /^[-*]\s*\[[ xX]\]\s*(.+)$/.exec(line);
      if (m && /given|when|then/i.test(m[1])) {
        out.push(stripMd(m[1]));
      }
    }
  }

  // De-dupe within a single body (sometimes AC lines are repeated in
  // "Definition of done" — caller should not see them twice).
  return Array.from(new Set(out));
}

function stripMd(text: string): string {
  // Remove leading bold markers (`**Given** ...`) that don't add information.
  return text.replace(/\*\*/g, "").trim();
}

function uniqSortedAsc(arr: number[]): number[] {
  return Array.from(new Set(arr)).sort((a, b) => a - b);
}
