/**
 * Epic #394 (#399) — PR diff fetcher.
 *
 * Pulls the unified diff for a pull request via `octokit.pulls.get` with
 * `mediaType.format = 'diff'`, enforces a per-project size cap, and strips
 * file blocks matching the configured skip-globs (lockfiles, build outputs,
 * snapshots) before the diff is forwarded to the judge LLM.
 *
 * The Octokit client is injected so unit tests stay hermetic and so the
 * production path can reuse the cached, throttled, retried client built by
 * `acquirePublishOctokit` (`server/src/lib/publishing/octokit-factory.ts`).
 *
 * Defaults (overridable per-project on `Project.prReviewMaxDiffBytes` /
 * `Project.prReviewSkipGlobs`):
 *
 *   maxBytes = 1_048_576   (1 MiB)
 *   skipGlobs = lockfiles + dist/build + snapshots
 */

export const PR_REVIEW_DEFAULT_MAX_DIFF_BYTES = 1_048_576;

export const PR_REVIEW_DEFAULT_SKIP_GLOBS: readonly string[] = [
  "**/*.lock",
  "**/dist/**",
  "**/build/**",
  "**/*.snap",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

export type DiffFetchOctokit = {
  pulls: {
    get: (params: {
      owner: string;
      repo: string;
      pull_number: number;
      mediaType?: { format?: string };
    }) => Promise<{ data: unknown }>;
  };
};

export interface FetchPrDiffInput {
  octokit: DiffFetchOctokit;
  owner: string;
  repo: string;
  prNumber: number;
  /** Per-project cap; falls back to {@link PR_REVIEW_DEFAULT_MAX_DIFF_BYTES}. */
  maxBytes?: number | null;
  /** Per-project skip list; falls back to {@link PR_REVIEW_DEFAULT_SKIP_GLOBS}. */
  skipGlobs?: readonly string[] | null;
}

export interface FetchPrDiffResult {
  diff: string;
  /** Total bytes of the raw diff (pre-skip-filter). */
  rawBytes: number;
  /** Bytes after skip-glob filtering. */
  filteredBytes: number;
  /** True when the raw diff exceeded the cap and judge input was suppressed. */
  tooLarge: boolean;
  /** File paths stripped from the diff because they matched a skip glob. */
  skippedFiles: string[];
}

/**
 * Fetch + filter a PR diff. Returns `{ tooLarge: true, diff: "" }` when the
 * raw diff exceeds the size cap so the caller can short-circuit and post a
 * "too large to auto-review" comment instead.
 */
export async function fetchPrDiff(input: FetchPrDiffInput): Promise<FetchPrDiffResult> {
  const maxBytes =
    input.maxBytes && input.maxBytes > 0 ? input.maxBytes : PR_REVIEW_DEFAULT_MAX_DIFF_BYTES;
  const globs = input.skipGlobs?.length ? input.skipGlobs : PR_REVIEW_DEFAULT_SKIP_GLOBS;

  const resp = await input.octokit.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    mediaType: { format: "diff" },
  });
  const raw = typeof resp.data === "string" ? resp.data : String(resp.data ?? "");
  const rawBytes = byteLength(raw);
  if (rawBytes > maxBytes) {
    return {
      diff: "",
      rawBytes,
      filteredBytes: 0,
      tooLarge: true,
      skippedFiles: [],
    };
  }
  const { diff, skippedFiles } = stripSkipGlobs(raw, globs);
  return {
    diff,
    rawBytes,
    filteredBytes: byteLength(diff),
    tooLarge: false,
    skippedFiles,
  };
}

/**
 * Remove every file block whose `+++ b/...` path matches any of the provided
 * glob patterns. Splits the diff on `diff --git` boundaries so we can keep
 * or drop each block atomically.
 *
 * Exported for unit testing.
 */
export function stripSkipGlobs(
  diff: string,
  globs: readonly string[],
): { diff: string; skippedFiles: string[] } {
  if (!diff || globs.length === 0) return { diff, skippedFiles: [] };
  const blocks = splitDiffByFile(diff);
  const matchers = globs.map(globToRegExp);
  const kept: string[] = [];
  const skippedFiles: string[] = [];
  for (const block of blocks) {
    const path = extractFilePath(block);
    if (path && matchers.some((rx) => rx.test(path))) {
      skippedFiles.push(path);
      continue;
    }
    kept.push(block);
  }
  return { diff: kept.join(""), skippedFiles };
}

function splitDiffByFile(diff: string): string[] {
  // Preserve the original "diff --git" line at the start of each block.
  // Split on the keyword while keeping it via a lookahead.
  if (!diff.includes("diff --git")) return [diff];
  return diff.split(/(?=^diff --git\s)/m).filter((s) => s.length > 0);
}

function extractFilePath(block: string): string | null {
  // Prefer the `+++ b/…` line (post-image path); fall back to `--- a/…`
  // for deletions where the post-image is /dev/null.
  const plus = /^\+\+\+\s+b\/(.+)$/m.exec(block);
  if (plus) return plus[1].trim();
  const minus = /^---\s+a\/(.+)$/m.exec(block);
  if (minus) return minus[1].trim();
  // Last resort: `diff --git a/<path> b/<path>` on the header.
  const hdr = /^diff --git a\/(\S+)\s+b\/\S+/m.exec(block);
  return hdr ? hdr[1].trim() : null;
}

/**
 * Tiny glob → RegExp converter supporting `*`, `**`, and `?`. Sufficient
 * for the PR-review skip-list use case (we deliberately do NOT pull in
 * `minimatch` for one tiny utility).
 */
export function globToRegExp(glob: string): RegExp {
  // Escape regex specials EXCEPT `*` and `?` which we'll handle.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Order matters: handle `**/` and `/**` as "zero or more path segments"
  // BEFORE the bare `**` → `.*` rule, so `**/dist/**` matches `dist/x` (no
  // leading prefix) AND `a/b/dist/x`.
  const pattern = escaped
    .replace(/\*\*\//g, "<<DSLASH>>")
    .replace(/\/\*\*/g, "<<SLASHDS>>")
    .replace(/\*\*/g, "<<DOUBLESTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/<<DSLASH>>/g, "(?:.*/)?")
    .replace(/<<SLASHDS>>/g, "(?:/.*)?")
    .replace(/<<DOUBLESTAR>>/g, ".*");
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `pattern` has all regex metacharacters escaped before glob tokens are expanded into bounded classes; the anchored result is linear-time, so no injection or ReDoS is possible.
  return new RegExp(`^${pattern}$`);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
