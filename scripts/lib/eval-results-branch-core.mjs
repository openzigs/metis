/**
 * Issue #1382 — where the nightly eval envelopes live now that `main` does not hold
 * them, and the git argument vectors that put them there.
 *
 * ## The decision
 *
 * ADR 0012 (#1333) made the nightly envelopes TRACKED, because `drift-alert` reads
 * accumulated history week-over-week and a workflow artifact expires. That reasoning
 * is unchanged. What changed is that #1308 decided `eval-results/` does not ship and
 * #1382 implemented it, so the envelopes can no longer live on `main`.
 *
 * They live on a dedicated orphan branch instead — the pattern `cla.yml` already uses
 * for `cla-signatures`, for the same reason: recording an append never touches the
 * default branch's history. The branch keeps every property ADR 0012 rejected
 * artifacts for (it does not expire, it accumulates, it is a git object the harness
 * can read) and drops the one property #1308 objected to (~365 files a year on the
 * branch that gets published).
 *
 * ## Why the working directory is a WORKTREE, not a copy
 *
 * The nightly checks the branch out AT `eval-results/`, so the directory the eval
 * writer already targets is simultaneously the branch's working tree. Two things fall
 * out of that and both matter:
 *
 *  - `drift-alert` needs no new code. `loadAllRuns` reads `<cwd>/eval-results`, which
 *    now contains the branch's accumulated history exactly as it used to contain
 *    `main`'s.
 *  - `scripts/eval-results-commit-guard.mjs` needs no new arms. Run against the
 *    worktree, its three failure modes keep their exact #1333 meanings — `ignored`
 *    (an ignore rule on the branch would discard the envelope), `unchanged` (only
 *    history is present, this run wrote nothing) and `missing` — rather than being
 *    replaced by a weaker question.
 *
 * A plain copy would have forced both of those to be re-derived, and a re-derived
 * guard is how the #1333 defect would come back.
 */

/** The branch the nightly envelopes accumulate on. */
export const EVAL_RESULTS_BRANCH = "eval-results";

/** Commit subject for a nightly append. Kept out of the workflow so it is testable. */
export const COMMIT_MESSAGE = "chore(eval): nightly domain eval results [skip ci]";

/**
 * Argument vector to fetch the branch, creating its remote-tracking ref.
 *
 * The refspec is EXPLICIT and not optional. `git fetch --depth=1 origin eval-results`
 * updates `FETCH_HEAD` only — it leaves `refs/remotes/origin/eval-results` absent, and
 * the `worktree add` below then dies with `invalid reference: origin/eval-results`.
 * Measured, not assumed: that is exactly how the first end-to-end run failed.
 *
 * @param {{ branch?: string, depth?: number }} [input]
 * @returns {string[]}
 */
export function fetchPlan({ branch = EVAL_RESULTS_BRANCH, depth = 1 } = {}) {
  return [
    "fetch",
    `--depth=${depth}`,
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ];
}

/**
 * Argument vector to check the branch out at `dir`, given whether it already exists
 * on the remote.
 *
 * Both arms produce a worktree at `dir` whose HEAD is the branch. The bootstrap arm
 * uses `--orphan` so the first ever run does not inherit `main`'s whole tree into a
 * directory that is supposed to hold nothing but envelopes.
 *
 * @param {{ dir: string, remoteHasBranch: boolean, branch?: string }} input
 * @returns {string[][]} git argument vectors, in order
 */
export function checkoutPlan({ dir, remoteHasBranch, branch = EVAL_RESULTS_BRANCH }) {
  if (remoteHasBranch) {
    // `-B` so a stale local branch from a previous run on a persistent self-hosted
    // runner is reset to the remote rather than silently diverging from it.
    return [["worktree", "add", "-B", branch, dir, `origin/${branch}`]];
  }
  return [["worktree", "add", "--orphan", "-b", branch, dir]];
}

/**
 * Argument vectors to publish whatever is in the worktree.
 *
 * `add -A` because an envelope is a new file and a re-run may amend one; the guard has
 * already proved there is something new, so an empty commit here is a real failure and
 * is deliberately not suppressed with `--allow-empty` or a `|| true`.
 *
 * @param {{ branch?: string }} [input]
 * @returns {string[][]}
 */
export function publishPlan({ branch = EVAL_RESULTS_BRANCH } = {}) {
  return [
    ["add", "-A", "."],
    ["commit", "-m", COMMIT_MESSAGE],
    ["push", "origin", `HEAD:refs/heads/${branch}`],
  ];
}

/**
 * Does `git ls-remote --heads origin <branch>` output name the branch?
 *
 * `ls-remote` exits 0 with EMPTY output when nothing matches, so the exit code alone
 * cannot answer this — reading it that way would take the bootstrap arm every night
 * and `worktree add --orphan -b` would then fail on the existing branch.
 *
 * @param {string} stdout
 * @param {string} [branch]
 * @returns {boolean}
 */
export function remoteHasBranch(stdout, branch = EVAL_RESULTS_BRANCH) {
  return String(stdout ?? "")
    .split("\n")
    .some((line) => line.trim().endsWith(`refs/heads/${branch}`));
}
