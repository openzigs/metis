/**
 * Epic #394 P2 (#406) — Existing PR-comment reader + dedup filter.
 *
 * Cursor Bugbot pattern: before posting suggestions, fetch the existing
 * review comments on the PR (human + prior bot passes) and:
 *
 *   1. Pass them into the judge prompt as `<existing_comments>` context
 *      so the LLM can avoid restating points that were already raised.
 *   2. After the judge returns candidate inline comments, drop any that
 *      overlap ≥0.7 with an existing comment on the same file:line.
 *
 * Similarity is computed via Jaccard token overlap (lower-cased,
 * stop-word-ish filtered, length-3+ tokens) — embeddings are overkill
 * for two short strings and would require a network round-trip we don't
 * need on the hot path.
 */

import type { InlineCommentSuggestion } from "./prompts.js";

/** Minimal Octokit surface — `pulls.listReviewComments`. */
export type ReviewCommentsOctokit = {
  pulls: {
    listReviewComments: (params: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
      page?: number;
      sort?: "created" | "updated";
      direction?: "asc" | "desc";
    }) => Promise<{
      data: Array<{
        id: number;
        path?: string | null;
        line?: number | null;
        original_line?: number | null;
        body?: string | null;
        user?: { login?: string | null } | null;
      }>;
    }>;
  };
};

export interface ExistingComment {
  id: number;
  filePath: string;
  line: number;
  body: string;
  author: string;
}

export const MAX_FETCHED_COMMENTS = 100;
export const DEFAULT_DEDUP_THRESHOLD = 0.7;

/**
 * Fetch up to {@link MAX_FETCHED_COMMENTS} most-recent review comments.
 * Returns an empty array on Octokit failure — this is a "best effort"
 * enrichment, never a hard dependency for the review path.
 */
export async function fetchExistingReviewComments(
  octokit: ReviewCommentsOctokit,
  input: { owner: string; repo: string; prNumber: number },
): Promise<ExistingComment[]> {
  try {
    const resp = await octokit.pulls.listReviewComments({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      per_page: MAX_FETCHED_COMMENTS,
      sort: "created",
      direction: "desc",
    });
    const rows = Array.isArray(resp?.data) ? resp.data : [];
    const out: ExistingComment[] = [];
    for (const r of rows) {
      const path = String(r.path ?? "").trim();
      const line = Number(r.line ?? r.original_line ?? 0);
      const body = String(r.body ?? "").trim();
      if (!path || !body || !Number.isFinite(line) || line <= 0) continue;
      out.push({
        id: Number(r.id),
        filePath: path,
        line,
        body,
        author: String(r.user?.login ?? "unknown"),
      });
      if (out.length >= MAX_FETCHED_COMMENTS) break;
    }
    return out;
  } catch {
    return [];
  }
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "this",
  "that",
  "with",
  "from",
  "you",
  "are",
  "was",
  "but",
  "not",
  "should",
  "would",
  "could",
  "have",
  "has",
  "into",
  "your",
]);

function tokenize(s: string): Set<string> {
  const tokens = new Set<string>();
  if (!s) return tokens;
  for (const raw of s.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/** Jaccard set similarity. Empty inputs return 0. */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

export interface DedupResult {
  kept: InlineCommentSuggestion[];
  dropped: Array<{ candidate: InlineCommentSuggestion; matchedExistingId: number; score: number }>;
}

/**
 * Drop candidates that overlap ≥ threshold with an existing comment on
 * the same `(filePath, line)`. Comments on different files or lines are
 * always kept.
 */
export function filterCandidatesAgainstExisting(
  candidates: readonly InlineCommentSuggestion[],
  existing: readonly ExistingComment[],
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): DedupResult {
  if (existing.length === 0) {
    return { kept: candidates.slice(), dropped: [] };
  }
  // Group existing by `path:line` for O(1) lookup.
  const byKey = new Map<string, ExistingComment[]>();
  for (const e of existing) {
    const key = `${e.filePath}:${e.line}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }

  const kept: InlineCommentSuggestion[] = [];
  const dropped: DedupResult["dropped"] = [];

  for (const c of candidates) {
    const key = `${c.filePath}:${c.line}`;
    const peers = byKey.get(key);
    if (!peers || peers.length === 0) {
      kept.push(c);
      continue;
    }
    let bestScore = 0;
    let bestId = peers[0].id;
    for (const p of peers) {
      const s = jaccardSimilarity(c.body, p.body);
      if (s > bestScore) {
        bestScore = s;
        bestId = p.id;
      }
    }
    if (bestScore >= threshold) {
      dropped.push({ candidate: c, matchedExistingId: bestId, score: bestScore });
    } else {
      kept.push(c);
    }
  }

  return { kept, dropped };
}

/**
 * Render the `<existing_comments>` block for the judge prompt. Returns
 * an empty string when there are no existing comments — callers should
 * detect that and skip injection.
 */
export function renderExistingCommentsBlock(existing: readonly ExistingComment[]): string {
  if (existing.length === 0) return "";
  const lines = existing
    .slice(0, MAX_FETCHED_COMMENTS)
    .map(
      (c) =>
        `- [${c.author}] ${c.filePath}:${c.line} — ${c.body.replace(/\s+/g, " ").slice(0, 240)}`,
    );
  return `<existing_comments>\nThe following comments already exist on this PR. Do NOT restate them — focus on new findings.\n${lines.join("\n")}\n</existing_comments>`;
}
