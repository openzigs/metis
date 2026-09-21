import { describe, expect, it } from "vitest";

import {
  COMMIT_MESSAGE,
  EVAL_RESULTS_BRANCH,
  checkoutPlan,
  fetchPlan,
  publishPlan,
  remoteHasBranch,
} from "./eval-results-branch-core.mjs";

/**
 * Unit tests for #1382's eval-results branch plumbing.
 *
 * `remoteHasBranch` is the one with teeth: `git ls-remote` exits 0 with empty output
 * when nothing matches, so reading the exit code would take the bootstrap arm every
 * single night and `worktree add --orphan -b` would fail on the branch that already
 * exists. Everything downstream is argument vectors, asserted so a silent edit to one
 * (a dropped `-B`, a push to the wrong ref) cannot land unreviewed.
 */

describe("remoteHasBranch", () => {
  it("is true when ls-remote names the branch", () => {
    expect(remoteHasBranch(`abc123\trefs/heads/${EVAL_RESULTS_BRANCH}\n`)).toBe(true);
  });

  it("is false for the EMPTY output ls-remote gives on no match", () => {
    // The whole reason this function exists: `ls-remote` exits 0 either way.
    expect(remoteHasBranch("")).toBe(false);
    expect(remoteHasBranch(null)).toBe(false);
    expect(remoteHasBranch(undefined)).toBe(false);
  });

  it("does not match a branch whose name merely ENDS with the same word", () => {
    expect(remoteHasBranch("abc123\trefs/heads/old-eval-results\n")).toBe(false);
  });

  it("does not match a tag or a remote-tracking ref of the same name", () => {
    expect(remoteHasBranch(`abc\trefs/tags/${EVAL_RESULTS_BRANCH}\n`)).toBe(false);
  });

  it("finds the branch among several", () => {
    const out = [
      "a\trefs/heads/main",
      "b\trefs/heads/cla-signatures",
      `c\trefs/heads/${EVAL_RESULTS_BRANCH}`,
    ].join("\n");
    expect(remoteHasBranch(out)).toBe(true);
  });
});

describe("fetchPlan", () => {
  it("writes the remote-tracking ref through an EXPLICIT refspec", () => {
    // Without the refspec, `--depth=1` updates FETCH_HEAD only and leaves
    // `origin/eval-results` absent — `worktree add ... origin/eval-results` then
    // dies with `invalid reference`. This is a measured failure, not a theory.
    expect(fetchPlan()).toEqual([
      "fetch",
      "--depth=1",
      "origin",
      `+refs/heads/${EVAL_RESULTS_BRANCH}:refs/remotes/origin/${EVAL_RESULTS_BRANCH}`,
    ]);
  });

  it("names the destination remote-tracking ref checkoutPlan then reads", () => {
    const [, , , refspec] = fetchPlan();
    const destination = refspec.split(":")[1].replace("refs/remotes/", "");
    expect(checkoutPlan({ dir: "eval-results", remoteHasBranch: true })[0]).toContain(destination);
  });
});

describe("checkoutPlan", () => {
  it("resets a stale local branch to the remote when the branch exists", () => {
    // `-B`, not `-b`: a self-hosted runner keeps last night's local branch, and a
    // plain `-b` would either fail or silently diverge from the published history.
    expect(checkoutPlan({ dir: "eval-results", remoteHasBranch: true })).toEqual([
      ["worktree", "add", "-B", "eval-results", "eval-results", "origin/eval-results"],
    ]);
  });

  it("bootstraps an ORPHAN branch on the very first run", () => {
    // Not `worktree add -b` off HEAD: that would seed the branch with the whole of
    // `main`, in a directory meant to hold nothing but envelopes.
    expect(checkoutPlan({ dir: "eval-results", remoteHasBranch: false })).toEqual([
      ["worktree", "add", "--orphan", "-b", "eval-results", "eval-results"],
    ]);
  });
});

describe("publishPlan", () => {
  it("stages, commits with the nightly subject, and pushes to the branch ref", () => {
    expect(publishPlan()).toEqual([
      ["add", "-A", "."],
      ["commit", "-m", COMMIT_MESSAGE],
      ["push", "origin", `HEAD:refs/heads/${EVAL_RESULTS_BRANCH}`],
    ]);
  });

  it("keeps [skip ci] in the subject so an envelope commit does not trigger CI", () => {
    expect(COMMIT_MESSAGE).toContain("[skip ci]");
  });

  it("does NOT allow an empty commit", () => {
    // The guard has already proved there is something new. An `--allow-empty` here
    // would turn "the eval wrote nothing" back into a green push of nothing.
    expect(publishPlan().flat()).not.toContain("--allow-empty");
  });
});
