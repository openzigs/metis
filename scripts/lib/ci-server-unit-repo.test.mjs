import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { splitJobs } from "./ci-test-ownership-core.mjs";

/**
 * #1411 — the SQLite server unit suite runs sharded in `server-unit`, not as one step
 * of `server`. As a single step it took 709-1040 s and pushed `server` to within a
 * minute or two of its 20-minute cap (PR #1408's run was cancelled at 20m20s with no
 * test failing). A dropped leg would lose a third of the suite with every check still
 * green, and the step moving back into `server` would bring the timeout back, so both
 * are pinned here. Same shape as `postgres-unit` (#1365).
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

describe("server-unit shards the SQLite server unit suite (#1411)", () => {
  const u = job("server-unit");

  it("exists (guards against a vacuous pass)", () => {
    expect(u).not.toBe("");
  });

  it("has string legs 1/N..N/N that together cover every shard exactly once", () => {
    const m = u.match(/\n {8}shard: \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const legs = [...String(m?.[1]).matchAll(/"(\d+)\/(\d+)"/g)].map((x) => [
      Number(x[1]),
      Number(x[2]),
    ]);
    // Every entry is a quoted "i/N" string, so the check names read `server-unit (i/N)`.
    expect(String(m?.[1]).split(",").length).toBe(legs.length);
    const total = legs[0]?.[1];
    expect(legs.length).toBeGreaterThanOrEqual(3);
    expect(legs.every(([, n]) => n === total)).toBe(true);
    expect(legs.map(([i]) => i)).toEqual(Array.from({ length: total }, (_, k) => k + 1));
  });

  it("lets every leg finish and prints no matrix-built name", () => {
    expect(u).toMatch(/\n {6}fail-fast: false/);
    expect(u).not.toMatch(/\n {4}name:/);
  });

  it("is not path-gated: it runs on every event, as the `server` step it replaced did", () => {
    expect(u).not.toMatch(/\n {4}if:/);
    expect(u).not.toMatch(/\n {4}needs:/);
  });

  it("runs the suite with this leg's --shard, after building the shared package", () => {
    const run = step("server-unit", "Test server (SQLite client)");
    expect(run).toMatch(/working-directory: server/);
    expect(run).toMatch(/run: pnpm test --shard=\$\{\{ matrix\.shard \}\}$/m);
    const lines = (jobs.get("server-unit") ?? []).map((l) => l.trim());
    const build = lines.indexOf("- name: Build shared packages");
    const test = lines.indexOf("- name: Test server (SQLite client)");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(build);
  });

  it("keeps a 15-minute cap: add a leg rather than raise it", () => {
    expect(u).toMatch(/\n {4}timeout-minutes: 15\n/);
  });

  it("the nightly report waits on it", () => {
    expect(job("nightly-report")).toMatch(/\n {6}- server-unit\n/);
  });
});

describe("`server` no longer runs the unit suite (#1411)", () => {
  const s = job("server");

  it("has no `pnpm test` step, so the suite cannot run twice or bring the timeout back", () => {
    expect(s).not.toBe("");
    expect(s).not.toMatch(/run: pnpm test(\s|$)/m);
  });

  it("still runs the real-Chromium exporter suite", () => {
    expect(s).toMatch(/run: pnpm test:integration exporters-real-chromium/);
  });
});
