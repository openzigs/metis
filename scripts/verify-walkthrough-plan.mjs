#!/usr/bin/env node
/**
 * `pnpm walkthrough:verify-pr` — a branch that adds or removes a UI page or a
 * server route must change `docs/walkthroughs/TEST_PLAN.md` or carry the
 * `no-walkthrough-impact` label (#948).
 *
 * Thin I/O glue: it resolves the base ref, asks git for the changed paths and
 * the route-file diff, and hands them to `lib/walkthrough-plan-gate-core.mjs`.
 *
 * Usage:
 *   node scripts/verify-walkthrough-plan.mjs [--base <ref>] [--author <login>] [--labels <a,b>]
 *   WALKTHROUGH_BASE_REF / WALKTHROUGH_PR_AUTHOR / WALKTHROUGH_PR_LABELS do the same.
 *
 * Labels are comma- or newline-separated. CI reads them from the API at run
 * time rather than from the event payload, so re-running the job after adding
 * the label sees it (a re-run replays the original payload).
 *
 * Exit codes:
 *   0  nothing triggered, an exemption applied, the plan changed, or the label is set
 *   1  a trigger with neither, or an unresolvable base ref (a gate that cannot find
 *      its comparison point must not report success)
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TEST_PLAN_PATH,
  WAIVER_LABEL,
  evaluateWalkthroughPlanGate,
  parseNameStatus,
  routeLineChanges,
} from "./lib/walkthrough-plan-gate-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string[]} args @param {{ quiet?: boolean }} [options] */
function git(args, { quiet = false } = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : undefined,
  });
}

/** @param {string} ref */
function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

/** @param {string[]} argv @param {string} flag @param {string} envName */
function option(argv, flag, envName) {
  const i = argv.indexOf(flag);
  const raw = (i >= 0 ? argv[i + 1] : undefined) ?? process.env[envName];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function main() {
  const argv = process.argv.slice(2);
  const explicitBase = option(argv, "--base", "WALKTHROUGH_BASE_REF");
  const base = explicitBase
    ? refExists(explicitBase)
      ? explicitBase
      : null
    : (["origin/main", "main"].find(refExists) ?? null);
  if (base === null) {
    console.error(
      "Walkthrough plan check FAILED: could not resolve a base ref.\n" +
        "  Tried --base, $WALKTHROUGH_BASE_REF, origin/main, main. A shallow clone has no\n" +
        "  origin/main; fetch it or pass --base <ref>.",
    );
    process.exit(1);
  }
  const author = option(argv, "--author", "WALKTHROUGH_PR_AUTHOR");
  const labels = (option(argv, "--labels", "WALKTHROUGH_PR_LABELS") ?? "")
    .split(/[,\n]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const changes = parseNameStatus(git(["diff", "--name-status", "-M", `${base}...HEAD`]));
  const routeChanges = routeLineChanges(
    git(["diff", "-U1", "--no-color", `${base}...HEAD`, "--", "server/src/routes"]),
  );
  const result = evaluateWalkthroughPlanGate({ changes, routeChanges, labels, author });

  console.log(
    `Walkthrough plan: base=${base}, author=${author ?? "(unknown)"}, ` +
      `labels=[${labels.join(", ")}], ${changes.length} changed path(s), ` +
      `${result.triggers.length} trigger(s), verdict=${result.verdict}.`,
  );
  for (const trigger of result.triggers) console.log(`  - ${trigger}`);

  if (!result.ok) {
    console.error(
      `\nWalkthrough plan check FAILED: this branch adds or removes a page or a route, but\n` +
        `does not change ${TEST_PLAN_PATH}.\n` +
        `  Update the plan's phase for the feature, or — if the walkthrough is genuinely\n` +
        `  unaffected — add the label \`${WAIVER_LABEL}\` and re-run this job.`,
    );
    process.exit(1);
  }
}

main();
