/**
 * Epic #394 P2 (#405) — Incremental PR-review planning.
 *
 * On `synchronize` events the agent should NOT re-judge ACs whose
 * cited evidence files are unchanged since the last completed review.
 * This module is the pure decision layer:
 *
 *   - {@link isWhitespaceOnlyDiff} — true when `A..B` differs only in
 *     whitespace (no LLM call needed).
 *   - {@link extractChangedFiles} — pull the list of file paths from a
 *     unified diff (handles `diff --git` blocks).
 *   - {@link planIncrementalReview} — combine the prior verdicts with
 *     the changed-file set to produce the per-AC re-judge plan.
 */
import type { JudgeVerdict } from "./prompts.js";

export interface AcceptanceCriterionForPlan {
  id: string;
  text: string;
}

export interface IncrementalPlan {
  /** True when the diff is whitespace-only — caller should skip the LLM entirely. */
  skip: boolean;
  /** Reason recorded in the audit row when `skip` is true or no AC needs re-judging. */
  skipReason?: "no_substantive_change";
  /** ACs whose cited files appear in the new diff — must be re-judged. */
  toReJudge: AcceptanceCriterionForPlan[];
  /** Verdicts inherited from the prior review (carried forward unchanged). */
  inherited: JudgeVerdict[];
  /** Files that changed between `lastReviewedSha..HEAD` (post-skip-glob). */
  changedFiles: string[];
}

/**
 * Strip diff metadata (file headers, hunk markers) and return true when
 * every remaining +/- line is whitespace-only.
 *
 * The implementation is intentionally conservative — anything that's not
 * obviously whitespace falls through to "substantive" so we never skip
 * a real change.
 */
export function isWhitespaceOnlyDiff(diff: string): boolean {
  if (!diff.trim()) return true;
  const lines = diff.split("\n");
  let sawAdd = false;
  let sawDel = false;
  for (const raw of lines) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("@@") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("Binary files")
    ) {
      continue;
    }
    if (raw.startsWith("+") || raw.startsWith("-")) {
      // Whitespace-only edit lines are fine; non-whitespace = substantive.
      const body = raw.slice(1);
      if (body.trim().length > 0) {
        // Check if the line consists ONLY of whitespace changes by
        // comparing trimmed content. If the trimmed body is non-empty,
        // it's a real character change.
        return false;
      }
      if (raw.startsWith("+")) sawAdd = true;
      else sawDel = true;
    }
  }
  // If we never saw any +/- lines, treat as no-op (whitespace-only).
  void sawAdd;
  void sawDel;
  return true;
}

/** Extract every file path that appears in the diff. Deduped, in order. */
export function extractChangedFiles(diff: string): string[] {
  if (!diff) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // `diff --git a/path/to/x b/path/to/x` — both paths are usually equal;
  // for renames they differ. We accept both so renames count as changes
  // to either side.
  const headerRx = /^diff --git a\/(\S+)\s+b\/(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = headerRx.exec(diff)) !== null) {
    for (const p of [m[1], m[2]]) {
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  // Fallback for diffs without `diff --git` headers (e.g. plain unified
  // diff from `diff -u`). Use `+++ b/<path>` or `+++ /dev/null` (deletion).
  if (out.length === 0) {
    const plusRx = /^\+\+\+\s+(\S+)$/gm;
    let pm: RegExpExecArray | null;
    while ((pm = plusRx.exec(diff)) !== null) {
      let p = pm[1].trim();
      if (p === "/dev/null") continue;
      if (p.startsWith("b/")) p = p.slice(2);
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Epic #394 P2 review F3 — extract rename pairs from a unified diff.
 *
 * GitHub renders renames as a `diff --git a/old b/new` block followed by
 * `rename from old` / `rename to new` (or `similarity index N%`).
 * Carrying forward an inherited AC verdict that cites `old` is unsafe
 * because the old path no longer exists — future changes to `new` will
 * never re-trigger that AC. We collect the (old, new) pairs so
 * `planIncrementalReview` can invalidate the affected inherited verdicts.
 */
export function extractRenames(diff: string): Array<{ from: string; to: string }> {
  if (!diff) return [];
  const renames: Array<{ from: string; to: string }> = [];
  // We scan blocks delimited by `diff --git` lines. Each block may
  // contain `rename from`/`rename to` lines OR (on the GitHub patch
  // format) `similarity index` plus `rename from`/`rename to`.
  const blocks = diff.split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const headerMatch = /^a\/(\S+)\s+b\/(\S+)/m.exec(block);
    if (!headerMatch) continue;
    const aPath = headerMatch[1];
    const bPath = headerMatch[2];
    const hasRenameFrom = /^rename from /m.test(block);
    const hasRenameTo = /^rename to /m.test(block);
    if (hasRenameFrom && hasRenameTo && aPath !== bPath) {
      renames.push({ from: aPath, to: bPath });
    }
  }
  return renames;
}

/**
 * Decide which ACs to re-judge given the new diff and the prior verdicts.
 *
 * Rules:
 *   - whitespace-only diff → `skip: true`, no LLM call.
 *   - prior verdict has cited evidence files → re-judge ONLY when one of
 *     those files appears in the new diff. Otherwise the verdict is
 *     inherited.
 *   - prior verdict had no cited evidence files (defensive) → always
 *     re-judge to be safe.
 *   - AC has no prior verdict (first time we see it) → re-judge.
 */
export function planIncrementalReview(input: {
  diff: string;
  criteria: AcceptanceCriterionForPlan[];
  priorVerdicts: JudgeVerdict[];
}): IncrementalPlan {
  const changedFiles = extractChangedFiles(input.diff);
  if (isWhitespaceOnlyDiff(input.diff)) {
    return {
      skip: true,
      skipReason: "no_substantive_change",
      toReJudge: [],
      inherited: input.priorVerdicts.slice(),
      changedFiles,
    };
  }

  const priorByAc = new Map<string, JudgeVerdict>();
  for (const v of input.priorVerdicts) {
    if (v.acId) priorByAc.set(v.acId, v);
  }

  const changedSet = new Set(changedFiles);
  // Epic #394 P2 review F3 — if an AC's cited evidence file was renamed
  // in `lastReviewedSha..HEAD`, the inherited verdict still cites the
  // OLD path, which means subsequent diffs will never re-trigger that
  // AC again. Force a re-judge so the new verdict cites the renamed
  // path going forward.
  const renamedFromPaths = new Set(extractRenames(input.diff).map((r) => r.from));

  const toReJudge: AcceptanceCriterionForPlan[] = [];
  const inherited: JudgeVerdict[] = [];

  for (const ac of input.criteria) {
    const prior = priorByAc.get(ac.id);
    if (!prior) {
      toReJudge.push(ac);
      continue;
    }
    const evidence = prior.evidenceFiles ?? [];
    if (evidence.length === 0) {
      // Defensive: we can't safely inherit a verdict with no evidence.
      toReJudge.push(ac);
      continue;
    }
    const intersects = evidence.some((f) => changedSet.has(f));
    const evidenceRenamed = evidence.some((f) => renamedFromPaths.has(f));
    if (intersects || evidenceRenamed) {
      toReJudge.push(ac);
    } else {
      inherited.push(prior);
    }
  }

  if (toReJudge.length === 0) {
    return {
      skip: true,
      skipReason: "no_substantive_change",
      toReJudge: [],
      inherited,
      changedFiles,
    };
  }

  return {
    skip: false,
    toReJudge,
    inherited,
    changedFiles,
  };
}

/**
 * Render a one-paragraph addendum for the review body summarising which
 * ACs were re-evaluated vs. inherited (#405 AC: "the posted review body
 * shows which ACs were re-evaluated vs. inherited").
 */
export function renderIncrementalAddendum(input: {
  reJudgedIds: string[];
  inheritedIds: string[];
  fromSha: string | null;
  toSha: string | null;
}): string {
  if (input.reJudgedIds.length === 0 && input.inheritedIds.length === 0) return "";
  const range =
    input.fromSha && input.toSha
      ? `${input.fromSha.slice(0, 7)}..${input.toSha.slice(0, 7)}`
      : "incremental";
  const reJudged = input.reJudgedIds.length > 0 ? input.reJudgedIds.join(", ") : "none";
  const inherited = input.inheritedIds.length > 0 ? input.inheritedIds.join(", ") : "none";
  return `_Incremental review (${range}): re-evaluated ${reJudged}; inherited ${inherited}._`;
}
