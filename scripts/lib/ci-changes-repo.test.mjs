import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { POSTGRES_PATTERNS, matchesAny } from "./ci-changes-core.mjs";
import { splitJobs } from "./ci-test-ownership-core.mjs";

/**
 * #844 — the wiring that makes `ci.yml`'s path gate and e2e sharding safe. Each
 * assertion pins a property whose loss would be invisible in a green check
 * column: a gated job that skips when its gate breaks, a shard that is dropped,
 * an aggregate that passes over a red shard.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const jobs = splitJobs(workflow);
/** @param {string} name */
const job = (name) => (jobs.get(name) ?? []).join("\n");

/** The step block (from `      - name: <name>` to the next step) of a job. */
function step(/** @type {string} */ jobName, /** @type {string} */ stepName) {
  const lines = jobs.get(jobName) ?? [];
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^ {6}- /.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("the Postgres path list covers what postgres-adapter's suites import (#844)", () => {
  const testsDir = path.join(repoRoot, "server/tests");
  const suites = fs
    .readdirSync(testsDir)
    .filter((f) => /(postgres|pgvector).*\.integration\.test\.ts$/.test(f));

  it("finds the suites (guards against a vacuous pass)", () => {
    expect(suites.length).toBeGreaterThanOrEqual(15);
  });

  it("every direct ../src import of a Postgres integration suite is a gated path", () => {
    const imported = new Set();
    for (const f of suites) {
      const body = fs.readFileSync(path.join(testsDir, f), "utf8");
      for (const m of body.matchAll(/["'](\.\.\/src\/[^"']+)["']/g)) {
        imported.add(path.posix.join("server/tests", m[1]).replace(/\.js$/, ".ts"));
      }
    }
    expect(imported.size).toBeGreaterThan(10);
    const ungated = [...imported].filter((p) => matchesAny([p], POSTGRES_PATTERNS).length === 0);
    expect(ungated).toEqual([]);
  });

  it("every pinned literal source path still exists (a rename would gate nothing)", () => {
    const literals = POSTGRES_PATTERNS.filter((p) => !p.includes("*"));
    const missing = literals.filter((p) => !fs.existsSync(path.join(repoRoot, p)));
    expect(missing).toEqual([]);
  });
});

describe("ci.yml wiring (#844)", () => {
  it("keeps `ci-${{ github.ref }}` + cancel-in-progress for every non-schedule event", () => {
    expect(workflow).toMatch(
      /concurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\$\{\{ github\.event_name == 'schedule' && '-nightly' \|\| '' \}\}\n {2}cancel-in-progress: true/,
    );
  });

  it("runs nightly", () => {
    expect(workflow).toMatch(/\n {2}schedule:\n {4}- cron: "[^"]+"/);
  });

  it("the `changes` job runs the classifier on a depth-2 checkout and exports both outputs", () => {
    const c = job("changes");
    expect(c).toMatch(/fetch-depth: 2/);
    expect(c).toMatch(/run: node scripts\/ci-changes\.mjs/);
    expect(c).toMatch(/postgres: \$\{\{ steps\.classify\.outputs\.postgres \}\}/);
    expect(c).toMatch(/images: \$\{\{ steps\.classify\.outputs\.images \}\}/);
  });

  it("postgres-adapter is gated fail-open: it runs unless `changes` said exactly 'false'", () => {
    const p = job("postgres-adapter");
    expect(p).toMatch(/needs: \[changes\]/);
    expect(p).toMatch(
      /\n {4}if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.postgres != 'false' \}\}/,
    );
  });

  it("api runs even if `changes` failed, and gates every image step fail-open", () => {
    expect(job("api")).toMatch(/\n {4}if: \$\{\{ !cancelled\(\) \}\}/);
    for (const name of [
      "Free runner disk for image builds",
      "Set up Buildx",
      "Build metis-server",
      "Build metis-ui",
      "Build metis-embeddings",
      "Build metis-sql-lineage",
      "Verify image size budget",
      "Smoke-test metis-server (starts, serves /healthz)",
      "Clean up test images",
    ]) {
      expect({
        name,
        gated: step("api", name).includes("needs.changes.outputs.images != 'false'"),
      }).toEqual({ name, gated: true });
    }
  });

  it("does not gate lint, typecheck or the package tests on paths", () => {
    for (const name of ["Lint", "Typecheck", "Test (packages no other job tests)"]) {
      const s = step("api", name);
      expect(s).not.toBe("");
      expect(s).not.toMatch(/\bif:/);
    }
  });

  it("e2e is a 3-shard matrix whose every shard runs its slice of the full suite", () => {
    const e = job("e2e");
    expect(e).toMatch(/shard: \[1, 2, 3\]/);
    expect(e).toMatch(/fail-fast: false/);
    expect(e).toMatch(
      /pnpm --filter @metis\/e2e test --fail-on-flaky-tests --shard=\$\{\{ matrix\.shard \}\}\/3/,
    );
    expect(e).not.toMatch(/\n {4}if:/);
    expect(e).toMatch(/name: playwright-report-shard-\$\{\{ matrix\.shard \}\}/);
    expect(e).toMatch(/name: playwright-traces-shard-\$\{\{ matrix\.shard \}\}/);
  });

  it("e2e-outcome always reports and fails on anything but success", () => {
    const o = job("e2e-outcome");
    expect(o).toMatch(/needs: \[e2e\]/);
    expect(o).toMatch(/\n {4}if: always\(\)/);
    expect(o).toMatch(/E2E_RESULT: \$\{\{ needs\.e2e\.result \}\}/);
    expect(o).toMatch(/if \[ "\$E2E_RESULT" != "success" \]; then[\s\S]*exit 1/);
  });
});
