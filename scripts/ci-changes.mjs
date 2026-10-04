#!/usr/bin/env node
/**
 * #844 — decide which conditional `ci.yml` work this run needs, and export it as
 * job outputs (`postgres`, `images`) for `postgres-adapter` and the `api` image
 * steps. The rules and their reasoning live in `lib/ci-changes-core.mjs`.
 *
 * On a `pull_request` run, `actions/checkout` checks out the PR's MERGE commit,
 * whose first parent is the base branch tip. `git diff HEAD^1 HEAD` is therefore
 * exactly what the PR changes against the base it would merge into; the checkout
 * needs `fetch-depth: 2` to have that parent. Anything else — no merge commit,
 * a missing parent, git failing — leaves the paths unknown, and unknown runs
 * everything (fail-open, see the core module).
 *
 * Env: GITHUB_EVENT_NAME, GITHUB_HEAD_REF, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.
 * Outside Actions it prints the decision and writes nothing.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { classifyChanges, formatOutputs } from "./lib/ci-changes-core.mjs";

/** @param {string[]} args */
const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** @returns {string[] | null} the PR's changed paths, or null when unknowable */
function prChangedPaths() {
  try {
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
    if (parents.length !== 3) {
      console.log(
        `::warning::HEAD is not a merge commit (${parents.length - 1} parent(s)); running everything`,
      );
      return null;
    }
    return git(["diff", "--name-only", "HEAD^1", "HEAD"])
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`::warning::could not compute the changed paths (${detail}); running everything`);
    return null;
  }
}

const eventName = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
const headRef = process.env.GITHUB_HEAD_REF ?? "";
const files = eventName === "pull_request" ? prChangedPaths() : [];

const result = classifyChanges({ eventName, files, headRef });

for (const [name, decision] of Object.entries(result)) {
  console.log(`${name}: ${decision.run ? "RUN" : "SKIP"} — ${decision.reason}`);
}
if (files !== null && eventName === "pull_request") {
  console.log(`${files.length} changed path(s)`);
}

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, formatOutputs(result));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = Object.entries(result)
    .map(([name, d]) => `| \`${name}\` | ${d.run ? "run" : "**skipped**"} | ${d.reason} |`)
    .join("\n");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Conditional CI work (#844)\n\n| Work | Decision | Why |\n|---|---|---|\n${rows}\n`,
  );
}
