/**
 * Epic #192 (A.5) — PR body / commit message linked-issue parser.
 *
 * Recognises the standard GitHub keywords that auto-close issues plus the
 * `Refs` keyword for soft references (Refs #N marks the requirement as
 * touched but does NOT mark it implemented). Returns deduplicated arrays.
 *
 * The parser also extracts file/range hunks from a unified diff so the
 * living-spec sync can store {@link RequirementImplementation} rows for the
 * "Implemented by" UI section.
 */

const CLOSE_KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
] as const;
const REF_KEYWORDS = ["ref", "refs", "references"] as const;

const buildPattern = (keywords: readonly string[]): RegExp =>
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- keywords is only ever the hardcoded CLOSE_KEYWORDS/REF_KEYWORDS `as const` arrays; no user input reaches this regex.
  new RegExp(`\\b(?:${keywords.join("|")})\\s*:?\\s*#(\\d+)`, "gi");

const closesPattern = buildPattern(CLOSE_KEYWORDS);
const refsPattern = buildPattern(REF_KEYWORDS);

/**
 * Branch-name issue extractor (Epic #394 / #398).
 *
 * Matches Qodo-Merge-style branch refs:
 *   - `feature/123-add-thing`         → 123
 *   - `bugfix/issue-456-broken`       → 456
 *   - `gh-789`                        → 789
 *   - `42-quick-fix`                  → 42
 *
 * Reject patterns: bare numeric prefixes that are clearly version tags
 * (e.g. `v1.2.0`) — those don't match because of the leading `v`. The
 * regex requires the digits to be flanked by `^`, `/`, `-`, or end-of-input.
 */
const BRANCH_ISSUE_PATTERN = /(?:^|[/_-])(?:issue-|gh-)?(\d+)(?:[/_-]|$)/g;

export interface ParsedLinks {
  closes: number[];
  refs: number[];
}

export function parseLinkedIssues(body: string | null | undefined): ParsedLinks {
  if (!body || typeof body !== "string") return { closes: [], refs: [] };
  const closes = new Set<number>();
  const refs = new Set<number>();
  for (const m of body.matchAll(closesPattern)) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) closes.add(n);
  }
  for (const m of body.matchAll(refsPattern)) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) refs.add(n);
  }
  return {
    closes: [...closes].sort((a, b) => a - b),
    refs: [...refs].sort((a, b) => a - b),
  };
}

/**
 * Extract issue numbers from a git branch name (Epic #394 / #398).
 *
 * Returns deduplicated, sorted issue numbers found anywhere in the branch
 * name. Returns `[]` for null/empty input or branches with no numeric
 * segments. Always returns numbers >0.
 */
export function parseBranchIssueNumbers(branch: string | null | undefined): number[] {
  if (!branch || typeof branch !== "string") return [];
  const out = new Set<number>();
  for (const m of branch.matchAll(BRANCH_ISSUE_PATTERN)) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export interface DiffHunk {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

const FILE_HEADER = /^\+\+\+\s+b\/(.+)$/;
const HUNK_HEADER = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Parse a unified diff into a flat list of file+line-range hunks. The
 * input is expected to be the textual diff (e.g. from `git diff`); empty
 * input returns `[]`.
 */
export function parseDiffHunks(diff: string | null | undefined): DiffHunk[] {
  if (!diff || typeof diff !== "string") return [];
  const lines = diff.split(/\r?\n/);
  const out: DiffHunk[] = [];
  let currentFile: string | null = null;
  for (const line of lines) {
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch && currentFile) {
      const start = Number.parseInt(hunkMatch[1], 10);
      const span = hunkMatch[2] ? Number.parseInt(hunkMatch[2], 10) : 1;
      out.push({
        filePath: currentFile,
        startLine: Number.isFinite(start) ? start : null,
        endLine: Number.isFinite(start) ? start + Math.max(0, span - 1) : null,
      });
    }
  }
  return out;
}
