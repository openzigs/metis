#!/usr/bin/env node
/**
 * Issue #1382 — mount and publish the nightly eval-results branch.
 *
 * ```bash
 * node scripts/eval-results-branch.mjs checkout   # before the eval runs
 * node scripts/eval-results-branch.mjs publish    # after the commit guard passes
 * ```
 *
 * `eval-results/` is untracked on `main` since #1382, so the nightly's accumulated
 * drift history lives on the dedicated `eval-results` branch instead (ADR 0015).
 * `checkout` mounts that branch AS the `eval-results/` directory, which is what lets
 * `drift-alert` keep reading `<cwd>/eval-results` and lets the #1333 commit guard keep
 * all three of its failure arms. `publish` commits whatever the eval wrote and pushes
 * it back.
 *
 * Every failure is loud and non-zero. There is no "branch missing, carry on" path:
 * a nightly that cannot read its own history compares today's F1 against nothing and
 * reports WITHIN_THRESHOLD, which is the #1333 defect wearing a different hat.
 *
 * See `lib/eval-results-branch-core.mjs` for the argument vectors and why the working
 * directory is a worktree rather than a copy.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { EVAL_RESULTS_DIR } from "./lib/eval-results-commit-core.mjs";
import {
  EVAL_RESULTS_BRANCH,
  checkoutPlan,
  fetchPlan,
  publishPlan,
  remoteHasBranch,
} from "./lib/eval-results-branch-core.mjs";
import { chdirToRepoRoot } from "./lib/repo-root.mjs";

/**
 * Run git, or die with its own diagnosis.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, capture?: boolean }} [opts]
 * @returns {string}
 */
function git(args, { cwd, capture = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = capture ? (result.stderr ?? "").trim() : "";
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout ?? "";
}

function checkout() {
  const dir = EVAL_RESULTS_DIR;

  // A self-hosted runner reuses its workspace, so a worktree from last night can
  // still be registered against a path `actions/checkout` has since cleaned. Prune
  // first, then clear the path, so `worktree add` never meets a stale record.
  git(["worktree", "prune"]);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  const exists = remoteHasBranch(
    git(["ls-remote", "--heads", "origin", EVAL_RESULTS_BRANCH], { capture: true }),
  );
  if (exists) git(fetchPlan());

  for (const args of checkoutPlan({ dir, remoteHasBranch: exists })) git(args);

  const count = exists
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length
    : 0;
  console.log(
    exists
      ? `eval-results: mounted branch "${EVAL_RESULTS_BRANCH}" at ${dir}/ (${count} top-level envelope(s) of history)`
      : `eval-results: branch "${EVAL_RESULTS_BRANCH}" does not exist yet — created it empty at ${dir}/`,
  );
}

function publish() {
  const dir = path.resolve(EVAL_RESULTS_DIR);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `${EVAL_RESULTS_DIR}/ does not exist — run \`eval-results-branch.mjs checkout\` first.`,
    );
  }
  for (const args of publishPlan()) git(args, { cwd: dir });
  console.log(`eval-results: pushed to "${EVAL_RESULTS_BRANCH}"`);
}

const command = process.argv[2];
chdirToRepoRoot("eval-results-branch");

try {
  if (command === "checkout") checkout();
  else if (command === "publish") publish();
  else {
    process.stderr.write(`usage: eval-results-branch.mjs <checkout|publish>\n`);
    process.exit(2);
  }
} catch (err) {
  process.stderr.write(`eval-results-branch ${command}: ${(err && err.message) || err}\n`);
  process.exit(1);
}
