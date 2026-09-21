/**
 * The live guard (#1301): is THIS repository's CLA workflow actually usable?
 *
 * `cla-workflow-core.test.mjs` proves the audit fails on each way it can go wrong.
 * This file points it at the real `.github/workflows/cla.yml`, and it was written and
 * watched go red on the state that shipped in PR #1391 — `remote-organization-name:
 * openzigs` and `remote-repository-name: metis`, which read like "this repo" and
 * actually mean "a different repo, reached with a personal access token this workflow
 * does not supply". That red run is the only evidence this test can fail here.
 *
 * Nothing else in the repository exercises the signing path: `lint`, `typecheck`,
 * `test` and every CI job are silent about it, and the action only runs on a real
 * pull request. Without this test the breakage surfaces the day an outside
 * contributor tries to sign, and not one day earlier.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PAT_ENV_VAR,
  PAT_REQUIRING_INPUTS,
  auditClaWorkflow,
  extractClaStep,
  formatReport,
  isClean,
} from "./cla-workflow-core.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_PATH = ".github/workflows/cla.yml";

/** @returns {string | null} */
function readWorkflow() {
  try {
    return readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
  } catch {
    return null;
  }
}

const text = readWorkflow();
const result = auditClaWorkflow(text);

describe("the repository's CLA workflow", () => {
  it("is clean under the gate", () => {
    expect(formatReport(result, WORKFLOW_PATH)).toContain("same-repository");
    expect(isClean(result)).toBe(true);
  });

  it("still contains the CLA step this gate audits", () => {
    expect(extractClaStep(/** @type {string} */ (text)).found).toBe(true);
  });

  it.each(PAT_REQUIRING_INPUTS)("does not set %s", (input) => {
    expect(result.withKeys).not.toContain(input);
  });

  it("supplies no PERSONAL_ACCESS_TOKEN, so the two inputs above must stay absent", () => {
    // Stated as an assertion rather than a comment: if a token is ever added, this
    // fails and whoever added it has to come here and say why, which is the moment
    // to reconsider a long-lived personal token on a `pull_request_target` workflow.
    expect(result.envKeys).not.toContain(PAT_ENV_VAR);
  });
});
