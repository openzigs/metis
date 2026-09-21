#!/usr/bin/env node
/**
 * Fail the build if the CLA workflow is configured in a way that cannot sign anyone.
 *
 * Runs as part of `pnpm lint`, beside the NUL (#1215), company-identifier (#1373) and
 * licence-metadata (#1296) gates.
 *
 * What it asserts that nothing else does: `.github/workflows/cla.yml` does not set
 * `remote-organization-name` or `remote-repository-name` without also supplying
 * `PERSONAL_ACCESS_TOKEN`. Those inputs do not mean "which repository is this" — they
 * mean "store the signature file in a DIFFERENT repository" — and setting either one
 * puts every signature read and write on a PAT client, which fails closed with
 * `core.setFailed` when no token is present. The reasoning and the evidence from the
 * pinned action's source are in `lib/cla-workflow-core.mjs`.
 *
 * Nothing else in this repository exercises the signing path: the action runs only on
 * a real pull request, so the breakage is otherwise invisible until an outside
 * contributor tries to sign.
 *
 * Usage:
 *   node scripts/verify-cla-workflow.mjs
 *
 * Exit codes: 0 clean, 1 a problem was found or the workflow could not be read.
 */
import { readFileSync } from "node:fs";

import { auditClaWorkflow, formatReport, isClean } from "./lib/cla-workflow-core.mjs";
import { chdirToRepoRoot } from "./lib/repo-root.mjs";

const WORKFLOW_PATH = ".github/workflows/cla.yml";

chdirToRepoRoot("verify-cla-workflow");

/**
 * Read the workflow.
 *
 * An unreadable or absent file yields `null`, which the audit treats as a FAILURE
 * rather than a skip — a gate that passes because its subject is missing is the
 * fail-open shape #1168 measured four times in one week.
 *
 * @returns {string | null}
 */
function readWorkflow() {
  try {
    return readFileSync(WORKFLOW_PATH, "utf8");
  } catch {
    return null;
  }
}

const result = auditClaWorkflow(readWorkflow());
const report = formatReport(result, WORKFLOW_PATH);

if (isClean(result)) {
  console.log(report);
  process.exit(0);
}

console.error(report);
process.exit(1);
