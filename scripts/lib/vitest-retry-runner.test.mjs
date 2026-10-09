import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { splitJobs } from "./ci-test-ownership-core.mjs";

/**
 * #964 — the acceptance criterion end to end: a deliberately leaky test (fails
 * on its first attempt, passes on the retry) run by a REAL vitest with the retry
 * reporter, then the REAL runner over the report it wrote. Plus the wiring in
 * `ci.yml` and both vitest configs, which is what makes the check run at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const runner = path.join(repoRoot, "scripts", "vitest-retried-tests.mjs");
const fixture = path.join(here, "fixtures", "vitest-retry");
const vitestBin = path.join(repoRoot, "scripts", "node_modules", "vitest", "vitest.mjs");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-retry-runner-"));
  dirs.push(d);
  return d;
}

/** Env with no inherited GitHub context, so the level is decided by `extra` alone. */
function env(extra) {
  const e = { ...process.env };
  for (const k of ["GITHUB_EVENT_NAME", "VITEST_RETRY_LEVEL", "GITHUB_STEP_SUMMARY"]) delete e[k];
  return { ...e, ...extra };
}

function runRunner(dir, extra = {}) {
  return spawnSync(process.execPath, [runner, ...(dir === null ? [] : [dir])], {
    env: env(extra),
    encoding: "utf8",
  });
}

/** Run the fixture project's vitest on one file, writing reports into `dir`. */
function runFixture(filter, dir) {
  return spawnSync(
    process.execPath,
    [vitestBin, "run", "--config", path.join(fixture, "vitest.config.mjs"), filter],
    { cwd: fixture, env: env({ VITEST_RETRY_REPORT_DIR: dir, CI: "" }), encoding: "utf8" },
  );
}

describe("a leaky test end to end (#964 acceptance)", () => {
  it("passes vitest on retry, and the runner turns it into a nightly failure and a PR warning", () => {
    const dir = tmp();
    const vitest = runFixture("leaky", dir);
    // The leak is invisible to vitest's own exit code: that is the bug.
    expect(vitest.status, vitest.stdout + vitest.stderr).toBe(0);
    expect(vitest.stderr).toContain("1 test(s) passed only after a retry");

    const summary = path.join(dir, "summary.md");
    const nightly = runRunner(dir, { GITHUB_EVENT_NAME: "schedule", GITHUB_STEP_SUMMARY: summary });
    expect(nightly.status).toBe(1);
    // No `line=`: vitest records a test's location only under `includeTaskLocation`,
    // which neither config sets, so the annotation lands on the file.
    expect(nightly.stdout).toMatch(
      /^::error file=scripts\/lib\/fixtures\/vitest-retry\/leaky\.fixture\.mjs,title=.*"leaky > passes only on the second attempt" failed 1 time\(s\)/m,
    );
    expect(nightly.stdout).not.toContain("passes first time");
    expect(fs.readFileSync(summary, "utf8")).toContain("**fails this run**");

    const pr = runRunner(dir, { GITHUB_EVENT_NAME: "pull_request" });
    expect(pr.status).toBe(0);
    expect(pr.stdout).toMatch(/^::warning file=scripts\/lib\/fixtures\/vitest-retry\/leaky/m);
  }, 60_000);

  it("flags nothing for a test that passes first time, even on the nightly", () => {
    const dir = tmp();
    const vitest = runFixture("clean", dir);
    expect(vitest.status, vitest.stdout + vitest.stderr).toBe(0);
    const nightly = runRunner(dir, { GITHUB_EVENT_NAME: "schedule" });
    expect(nightly.status).toBe(0);
    expect(nightly.stdout).not.toMatch(/^::/m);
    expect(nightly.stdout).toContain("No test passed only after a retry (1 report(s) read)");
  }, 60_000);
});

describe("vitest-retried-tests.mjs fails closed on a broken wiring", () => {
  it("exits 2 with no directory argument", () => {
    const r = runRunner(null);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("usage:");
  });

  it("exits 2 when the directory does not exist or holds no report", () => {
    expect(runRunner(path.join(tmp(), "absent")).status).toBe(2);
    const empty = runRunner(tmp());
    expect(empty.status).toBe(2);
    expect(empty.stdout).toContain("No vitest retry report");
  });

  it("exits 2 on a malformed report or an unknown level", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "x.json"), "{}");
    expect(runRunner(dir).stdout).toContain("retried");
    expect(runRunner(dir).status).toBe(2);
    fs.writeFileSync(path.join(dir, "x.json"), JSON.stringify({ retried: [] }));
    expect(runRunner(dir, { VITEST_RETRY_LEVEL: "loud" }).status).toBe(2);
    expect(runRunner(dir, { VITEST_RETRY_LEVEL: "error" }).status).toBe(0);
  });
});

describe("wiring (#964)", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const jobs = splitJobs(workflow);

  it.each([
    ["server", "server-tests", "Test server (SQLite client)"],
    ["ui", "ui-tests", "Test UI"],
  ])(
    "the %s job reports retries from its unit-test step and then runs the runner",
    (job, id, name) => {
      const body = (jobs.get(job) ?? []).join("\n");
      const testStep = body.slice(body.indexOf(`- name: ${name}`));
      expect(testStep).toMatch(
        new RegExp(
          `^- name: ${name.replace(/[()]/g, "\\$&")}\\n {8}id: ${id}\\n {8}working-directory: \\w+\\n {8}env:\\n {10}VITEST_RETRY_REPORT_DIR: \\$\\{\\{ runner\\.temp \\}\\}/vitest-retry\\n {8}run: pnpm test\\n`,
        ),
      );
      const check = body.slice(body.indexOf("- name: Flag tests that passed only after a retry"));
      expect(check).toMatch(
        new RegExp(
          `^- name: Flag tests that passed only after a retry\\n {8}if: \\$\\{\\{ !cancelled\\(\\) && steps\\.${id}\\.conclusion != 'skipped' \\}\\}\\n {8}env:\\n {10}VITEST_RETRY_REPORT_DIR: \\$\\{\\{ runner\\.temp \\}\\}/vitest-retry\\n {8}run: node scripts/vitest-retried-tests\\.mjs "\\$VITEST_RETRY_REPORT_DIR"\\n?`,
        ),
      );
      // Last in the job: a nightly failure here must not skip any other step.
      expect(check.match(/- name:/g)).toHaveLength(1);
    },
  );

  it.each(["server/vitest.config.ts", "ui/vitest.config.ts"])(
    "%s registers the retry reporter beside default",
    (file) => {
      const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
      expect(src).toMatch(
        /reporters: \[\s*"default",\s*[^\]]*\.\.\/scripts\/lib\/vitest-retry-reporter\.mjs"/,
      );
    },
  );
});
