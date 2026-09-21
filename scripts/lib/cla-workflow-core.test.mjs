import { describe, expect, it } from "vitest";

import {
  CLA_ACTION,
  PAT_ENV_VAR,
  PAT_REQUIRING_INPUTS,
  auditClaWorkflow,
  extractClaStep,
  formatReport,
  isClean,
} from "./cla-workflow-core.mjs";

/**
 * A workflow shaped like the real one: one step, a folded scalar in `with:` whose
 * body contains colons and blank lines, and a comment line at key indentation.
 *
 * @param {{inputs?: string[], env?: string[]}} [opts]
 * @returns {string}
 */
function workflow(opts = {}) {
  const inputs = opts.inputs ?? [];
  const env = opts.env ?? ["GITHUB_TOKEN"];
  return [
    "name: CLA",
    "on:",
    "  pull_request_target:",
    "    types: [opened]",
    "jobs:",
    "  cla:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - name: CLA Assistant`,
    `        uses: ${CLA_ACTION}@ca4a40a7d1004f18d9960b404b97e5f30a505a08 # v2.6.1`,
    "        env:",
    ...env.map((name) => `          ${name}: \${{ secrets.${name} }}`),
    "        with:",
    "          # Signatures live on a dedicated branch.",
    "          branch: cla-signatures",
    "          path-to-signatures: signatures/version1/cla.json",
    ...inputs.map((name) => `          ${name}: something`),
    "          custom-notsigned-prcomment: >-",
    "            Thanks for the pull request. METIS asks contributors to sign a CLA.",
    "",
    "",
    "            remote-organization-name: this line is prose, not a key.",
    "          allowlist: dependabot[bot]",
  ].join("\n");
}

describe("extractClaStep", () => {
  it("reads the step's own with: and env: keys", () => {
    const step = extractClaStep(workflow());
    expect(step.found).toBe(true);
    expect(step.envKeys).toEqual(["GITHUB_TOKEN"]);
    expect(step.withKeys).toEqual([
      "branch",
      "path-to-signatures",
      "custom-notsigned-prcomment",
      "allowlist",
    ]);
  });

  it("does not mistake a folded scalar's body for an input key", () => {
    // The fixture's comment body literally contains `remote-organization-name:`.
    const step = extractClaStep(workflow());
    expect(step.withKeys).not.toContain("remote-organization-name");
  });

  it("reports the step as absent when the action is not used", () => {
    const step = extractClaStep("name: CLA\njobs:\n  cla:\n    steps:\n      - run: true\n");
    expect(step).toEqual({ found: false, withKeys: [], envKeys: [] });
  });

  it("ignores the action named inside a comment", () => {
    const text = `# uses: ${CLA_ACTION}@deadbeef\nname: CLA\n`;
    expect(extractClaStep(text).found).toBe(false);
  });

  it("stops at the next step rather than absorbing its inputs", () => {
    const text = [
      "    steps:",
      `      - uses: ${CLA_ACTION}@deadbeef`,
      "        env:",
      "          GITHUB_TOKEN: x",
      "        with:",
      "          branch: cla-signatures",
      "      - uses: actions/checkout@v5",
      "        with:",
      "          remote-organization-name: openzigs",
    ].join("\n");
    const step = extractClaStep(text);
    // The offending key belongs to a DIFFERENT step. Absorbing it would make the
    // gate fire on something it cannot be right about.
    expect(step.withKeys).toEqual(["branch"]);
  });

  it("does not treat a tab-indented line as a key", () => {
    // Tabs are not valid YAML indentation. Treating one as indent 0 would end the
    // step early or, worse, promote a nested line to a key.
    const text = [
      "    steps:",
      `      - uses: ${CLA_ACTION}@deadbeef`,
      "        with:",
      "\tremote-organization-name: openzigs",
      "          branch: cla-signatures",
    ].join("\n");
    expect(extractClaStep(text).withKeys).not.toContain("remote-organization-name");
  });
});

describe("auditClaWorkflow", () => {
  it("passes a step that sets neither remote-storage input", () => {
    const result = auditClaWorkflow(workflow());
    expect(result.findings).toEqual([]);
    expect(isClean(result)).toBe(true);
  });

  it.each(PAT_REQUIRING_INPUTS)("fails on %s with only GITHUB_TOKEN", (input) => {
    const result = auditClaWorkflow(workflow({ inputs: [input] }));
    expect(isClean(result)).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("pat-input-without-token");
    expect(result.findings[0].detail).toContain(input);
  });

  it("fails once per offending input when both are set", () => {
    const result = auditClaWorkflow(workflow({ inputs: [...PAT_REQUIRING_INPUTS] }));
    expect(result.findings.map((f) => f.kind)).toEqual([
      "pat-input-without-token",
      "pat-input-without-token",
    ]);
  });

  it("allows remote storage when the token really is supplied", () => {
    const result = auditClaWorkflow(
      workflow({ inputs: [...PAT_REQUIRING_INPUTS], env: ["GITHUB_TOKEN", PAT_ENV_VAR] }),
    );
    expect(isClean(result)).toBe(true);
  });

  it("fails closed when the step has been renamed out from under it", () => {
    const renamed = workflow().replace(CLA_ACTION, "some-fork/github-action");
    const result = auditClaWorkflow(renamed);
    expect(isClean(result)).toBe(false);
    expect(result.findings[0].kind).toBe("no-cla-step");
  });

  it("fails closed when the workflow could not be read", () => {
    const result = auditClaWorkflow(null);
    expect(isClean(result)).toBe(false);
    expect(result.findings[0].kind).toBe("no-cla-step");
  });
});

describe("formatReport", () => {
  it("names the file and the storage decision when clean", () => {
    const report = formatReport(auditClaWorkflow(workflow()), ".github/workflows/cla.yml");
    expect(report).toContain(".github/workflows/cla.yml");
    expect(report).toContain("same-repository");
  });

  it("names every finding when dirty", () => {
    const result = auditClaWorkflow(workflow({ inputs: [...PAT_REQUIRING_INPUTS] }));
    const report = formatReport(result, ".github/workflows/cla.yml");
    expect(report).toContain("2 problem(s)");
    for (const input of PAT_REQUIRING_INPUTS) expect(report).toContain(input);
  });
});
