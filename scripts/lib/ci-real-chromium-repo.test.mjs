import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractPnpmCommands, splitJobs } from "./ci-test-ownership-core.mjs";

/**
 * #456 — the real-Chromium exporter suite runs in CI.
 *
 * PR #451 moved the two exporter tests that need a real PDF / DOCX render into
 * `server/tests/exporters-real-chromium.integration.test.ts`. That suite runs only
 * under `RUN_INTEGRATION_TESTS=1`, and every other `test:integration` step in
 * `ci.yml` names a Postgres suite — so after #451 the tests ran nowhere, and nothing
 * reported it: a suite that never runs leaves the check column green.
 *
 * This test keeps a CI step running it, after a step that installs the Chrome
 * puppeteer launches, with nothing that lets the step fail quietly. The suite itself
 * asserts the PDF / DOCX came back unconditionally, so a Chromium that cannot launch
 * (the exporter then degrades to HTML) turns that step red — measured on #456 with
 * `PUPPETEER_EXECUTABLE_PATH=/nonexistent/chrome`: 2 of 2 tests failed.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUITE = "exporters-real-chromium";
const SUITE_FILE = `server/tests/${SUITE}.integration.test.ts`;

const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const jobs = splitJobs(workflow);

/** Does this pnpm invocation run the server's integration script for the suite? */
const runsSuite = (/** @type {{ dir: string, command: string }} */ c) =>
  /\btest:integration\b/.test(c.command) &&
  new RegExp(`\\b${SUITE}\\b`).test(c.command) &&
  (c.dir === "server" || /--filter[= ]["']?@metis\/server\b/.test(c.command));

/** Does this pnpm invocation install the Chrome that puppeteer launches? */
const installsChrome = (/** @type {{ command: string }} */ c) =>
  /\bpuppeteer\s+browsers\s+install\s+chrome\b/.test(c.command);

/**
 * The step block (its lines) that runs the suite, split at `      - ` step starts.
 * `extractPnpmCommands` sees only command text, so a step `if:` or an `|| true`
 * on the run line is invisible to it (PR #458 review).
 */
function suiteStep(/** @type {string[]} */ lines) {
  /** @type {string[][]} */
  const steps = [];
  for (const line of lines) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length > 0 && /^ {8}/.test(line)) steps[steps.length - 1].push(line);
  }
  return steps.find((step) =>
    step.some((l) => /\btest:integration\b/.test(l) && l.includes(SUITE)),
  );
}

/** Every job whose steps run the suite, with that job's pnpm commands in step order. */
function jobsRunningSuite() {
  return [...jobs]
    .map(([job, lines]) => ({ job, lines, commands: extractPnpmCommands(job, lines) }))
    .filter(({ commands }) => commands.some(runsSuite));
}

describe("CI runs the real-Chromium exporter suite (#456)", () => {
  it("the suite file exists (a renamed file would leave the step matching nothing)", () => {
    expect(fs.existsSync(path.join(repoRoot, SUITE_FILE))).toBe(true);
  });

  it("a CI job runs it through `test:integration`", () => {
    expect(jobsRunningSuite().map((j) => j.job)).not.toEqual([]);
  });

  it("installs puppeteer's Chrome in the same job, before the suite runs", () => {
    for (const { job, commands } of jobsRunningSuite()) {
      const install = commands.findIndex(installsChrome);
      const run = commands.findIndex(runsSuite);
      expect({ job, install: install >= 0, before: install < run }).toEqual({
        job,
        install: true,
        before: true,
      });
    }
  });

  it("runs on every event, with no `if:` on the job or the step (PR #458 review)", () => {
    for (const { job, lines } of jobsRunningSuite()) {
      const step = suiteStep(lines) ?? [];
      expect({
        job,
        jobIf: lines.filter((l) => /^ {4}if:/.test(l)),
        stepIf: step.filter((l) => /^ {6}- if:|^ {8}if:/.test(l)),
      }).toEqual({ job, jobIf: [], stepIf: [] });
    }
  });

  it("does not swallow the suite's exit code (`|| true`, `|| :`) (PR #458 review)", () => {
    for (const { job, lines } of jobsRunningSuite()) {
      const step = suiteStep(lines) ?? [];
      expect({ job, swallowed: step.filter((l) => /\|\|/.test(l)) }).toEqual({
        job,
        swallowed: [],
      });
    }
  });

  it("does not let the step fail quietly (`continue-on-error`)", () => {
    for (const { job, lines } of jobsRunningSuite()) {
      expect({
        job,
        continueOnError: lines.filter((l) => /continue-on-error:\s*true/.test(l)),
      }).toEqual({ job, continueOnError: [] });
    }
  });
});
