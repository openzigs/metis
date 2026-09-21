#!/usr/bin/env node
/**
 * Issue #1333 — gate the nightly domain eval's commit-back step.
 *
 * Run from the repository root, immediately before the publish step:
 *
 * ```bash
 * node scripts/eval-results-commit-guard.mjs
 * ```
 *
 * Exits 0 when every output the nightly must produce is present on disk AND
 * git will accept it; exits 1 — loudly, with the offending paths — otherwise.
 *
 * ## Why this is not `git status --porcelain eval-results`
 *
 * That was the old guard, and it is the bug. `--porcelain` does not list
 * ignored files, so once `eval-results/` was gitignored (#983) a freshly
 * written envelope produced an empty string, the step printed "No new domain
 * eval results to commit" and exited 0 — every night for five weeks, green,
 * committing nothing. This script asks git the question that includes ignored
 * paths (`--ignored=matching`) and cross-checks it against a walk of the
 * writer's actual output directory, so "the writer produced nothing" and "the
 * writer produced something git would throw away" are both failures with
 * distinct messages, and neither can read as success.
 *
 * ## Where it asks, since #1382
 *
 * `eval-results/` is no longer tracked on `main`; the nightly checks the
 * `eval-results` BRANCH out at that path and publishes there instead (ADR 0015).
 * So the guard asks the WORKTREE about its own contents when one is mounted, and
 * the outer repository otherwise. The three arms are unchanged and still mean what
 * #1333 made them mean — `ignored` now also catches the workflow having skipped the
 * checkout step, which would otherwise be the new way to commit nothing quietly.
 *
 * The decision logic lives in `lib/eval-results-commit-core.mjs` and is unit
 * tested; this file is the I/O shell, covered by the subprocess arms in
 * `lib/eval-results-commit-guard-runner.test.mjs`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  EVAL_RESULTS_DIR,
  classifyNightlyEvalOutputs,
  expandStatusEntries,
  formatClassificationReport,
  parsePorcelainEntries,
} from "./lib/eval-results-commit-core.mjs";

const repoRoot = process.cwd();

/**
 * Every file under `eval-results/`, as repository-relative POSIX paths.
 *
 * The walk is what makes an ignored file visible at all: git collapses an
 * ignored directory to one entry, so without the disk listing there is nothing
 * to expand that entry over.
 *
 * @param {string} absDir
 * @param {string} relPrefix
 * @returns {string[]}
 */
function walk(absDir, relPrefix) {
  /** @type {string[]} */
  const out = [];
  let dirents;
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirents) {
    const rel = `${relPrefix}/${dirent.name}`;
    if (dirent.isDirectory()) out.push(...walk(path.join(absDir, dirent.name), rel));
    else if (dirent.isFile()) out.push(rel);
  }
  return out;
}

const resultsAbs = path.join(repoRoot, EVAL_RESULTS_DIR);

/**
 * Is `eval-results/` its own git worktree, or just a directory in this repository?
 *
 * Since #1382 the nightly checks the `eval-results` BRANCH out at that path, so the
 * directory the writer targets is also the branch's working tree. Asking the outer
 * repository about it would get one collapsed `!!` line — `eval-results/` is blanket
 * ignored on `main` now — and every envelope would read as discarded. Asking the
 * worktree gets `??` for a new envelope and nothing for unchanged history, which is
 * what keeps all three of #1333's arms meaning what they meant.
 *
 * Returns `null` when the path is not a worktree root, which includes the case the
 * workflow forgot the checkout step. That case must fail loudly rather than be
 * papered over — see the `ignored` arm.
 *
 * @returns {string | null}
 */
function resultsWorktreeRoot() {
  if (!fs.existsSync(resultsAbs)) return null;
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resultsAbs,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const top = (result.stdout ?? "").trim();
  return top && path.resolve(top) === path.resolve(resultsAbs) ? top : null;
}

/**
 * `git status` over the nightly's output, as `{ code, path }` records whose paths are
 * always repository-relative (`eval-results/...`) whichever repository answered.
 *
 * @returns {{ code: string, path: string }[]}
 */
function statusEntries() {
  const worktree = resultsWorktreeRoot();
  const args = ["status", "--porcelain", "--ignored=matching", "--untracked-files=all", "--"];
  const result = spawnSync("git", [...args, worktree ? "." : EVAL_RESULTS_DIR], {
    cwd: worktree ?? repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.error ? String(result.error) : ""}`.trim();
    // Never fail open: an unreadable git state is exactly the condition under
    // which a "nothing to do" default would hide a real problem.
    throw new Error(`git status failed (exit ${result.status}): ${detail || "no output"}`);
  }

  const entries = parsePorcelainEntries(result.stdout ?? "");
  // A worktree reports paths relative to ITS root, so re-anchor them on the
  // repository root the disk walk uses. Without this every path misses its match
  // and the guard reports `missing` for an envelope that is right there.
  return worktree
    ? entries.map((entry) => ({ ...entry, path: `${EVAL_RESULTS_DIR}/${entry.path}` }))
    : entries;
}

function emit(report, ok) {
  const heading = ok
    ? "### Nightly eval-results commit guard — OK"
    : "### Nightly eval-results commit guard — FAILED";
  const block = `${heading}\n\n\`\`\`\n${report}\n\`\`\`\n`;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      fs.appendFileSync(summaryPath, `${block}\n`);
    } catch {
      // A summary that cannot be written must not change the verdict.
    }
  }
  if (ok) {
    process.stdout.write(`${report}\n`);
  } else {
    process.stderr.write(`${report}\n`);
    process.stderr.write(
      "::error title=eval-results commit guard::The nightly produced nothing committable " +
        `under ${EVAL_RESULTS_DIR}/. See the step log — a silently skipped commit is the ` +
        "defect this guard exists to prevent (#1333).\n",
    );
  }
}

function main() {
  const foundPaths = walk(resultsAbs, EVAL_RESULTS_DIR)
    // `.git` is the worktree's gitfile, not an eval output.
    .filter((rel) => rel !== `${EVAL_RESULTS_DIR}/.git`)
    .sort();
  const statusByPath = expandStatusEntries({ entries: statusEntries(), foundPaths });
  const classification = classifyNightlyEvalOutputs({ foundPaths, statusByPath });
  const ok = classification.verdict === "COMMIT";
  emit(formatClassificationReport(classification), ok);
  process.exit(ok ? 0 : 1);
}

try {
  main();
} catch (err) {
  process.stderr.write(`eval-results commit guard failed: ${(err && err.message) || err}\n`);
  process.exit(1);
}
