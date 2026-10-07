import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { splitJobs } from "./ci-test-ownership-core.mjs";

/**
 * #848 — the `nightly-report` wiring in `ci.yml`, and the runner spawned for real
 * against a local stand-in for the GitHub REST API.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const jobs = splitJobs(workflow);
const report = (jobs.get("nightly-report") ?? []).join("\n");

describe("ci.yml nightly-report wiring (#848)", () => {
  it("exists", () => {
    expect(report).not.toBe("");
  });

  it("needs every other job, so none can fail the nightly unreported", () => {
    const block = report.match(/\n {4}needs:\n((?: {6}- [A-Za-z0-9_-]+\n)+)/);
    expect(block).not.toBeNull();
    const needs = [...(block?.[1] ?? "").matchAll(/- ([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const others = [...jobs.keys()].filter((j) => j !== "nightly-report");
    expect(others.length).toBeGreaterThanOrEqual(10);
    expect([...needs].sort()).toEqual([...others].sort());
  });

  it("runs only on schedule, and even when a needed job failed or was cancelled", () => {
    expect(report).toMatch(/\n {4}if: \$\{\{ always\(\) && github\.event_name == 'schedule' \}\}/);
  });

  it("holds issues: write at job level only; the workflow default stays read-only", () => {
    expect(report).toMatch(
      /\n {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}actions: read\n/,
    );
    const top = workflow.slice(0, workflow.indexOf("\njobs:"));
    expect(top).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(top).not.toMatch(/issues: write/);
    const elsewhere = [...jobs.entries()].filter(
      ([name, lines]) => name !== "nightly-report" && lines.join("\n").includes("issues: write"),
    );
    expect(elsewhere).toEqual([]);
  });

  it("passes the needs context and token through env, never interpolated into run:", () => {
    expect(report).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    expect(report).toMatch(/NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
    expect(report).toMatch(/run: node scripts\/ci-nightly-report\.mjs\n?/);
    const runLines = report.split("\n").filter((l) => /^\s+run:/.test(l));
    expect(runLines.every((l) => !l.includes("${{"))).toBe(true);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = [...report.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});

const runner = path.resolve(repoRoot, "scripts/ci-nightly-report.mjs");
const execFileAsync = promisify(execFile);

/** @type {http.Server | null} */
let server = null;
afterEach(async () => {
  if (server) await new Promise((r) => /** @type {http.Server} */ (server).close(r));
  server = null;
});

/**
 * A local GitHub API double. Records every request; answers from `routes`.
 * @param {(method: string, url: string) => { status: number, body?: unknown }} route
 */
async function startApi(route) {
  /** @type {Array<{ method: string, url: string, body: any }>} */
  const calls = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? JSON.parse(raw) : undefined,
      });
      const hit = route(req.method ?? "", req.url ?? "");
      res.writeHead(hit.status, { "Content-Type": "application/json" });
      res.end(hit.status === 204 ? undefined : JSON.stringify(hit.body ?? {}));
    });
  });
  await new Promise((r) =>
    /** @type {http.Server} */ (server).listen(0, "127.0.0.1", () => r(null)),
  );
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { calls, apiUrl: `http://127.0.0.1:${addr.port}` };
}

/** @param {Record<string, string>} env */
async function runRunner(env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [runner], {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (error) {
    const e = /** @type {{ code: number, stdout: string }} */ (error);
    return { code: e.code, stdout: e.stdout };
  }
}

const baseEnv = (/** @type {string} */ apiUrl) => ({
  GH_TOKEN: "t",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "42",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: apiUrl,
  GITHUB_SHA: "abc",
});

describe("ci-nightly-report runner (#848)", () => {
  it("red nightly, no open issue: opens one naming the failing shard", async () => {
    const { calls, apiUrl } = await startApi((method, url) => {
      if (url.startsWith("/repos/o/r/actions/runs/42/jobs")) {
        return {
          status: 200,
          body: { jobs: [{ name: "e2e (2/3)", conclusion: "failure" }] },
        };
      }
      if (method === "GET" && url.startsWith("/repos/o/r/issues?"))
        return { status: 200, body: [] };
      if (method === "GET" && url === "/repos/o/r/labels/ci-nightly") return { status: 404 };
      if (method === "POST" && url === "/repos/o/r/labels") return { status: 201 };
      if (method === "POST" && url === "/repos/o/r/issues")
        return { status: 201, body: { number: 9 } };
      return { status: 500 };
    });
    const res = await runRunner({
      ...baseEnv(apiUrl),
      NEEDS_JSON: JSON.stringify({ e2e: { result: "failure" }, api: { result: "success" } }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("created issue #9");
    const created = calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues");
    expect(created?.body.body).toContain("https://github.com/o/r/actions/runs/42");
    expect(created?.body.body).toContain("- `e2e (2/3)`");
    expect(created?.body.labels).toEqual(["ci-nightly"]);
  });

  it("green nightly, jobs API down: still closes the open issue", async () => {
    const { calls, apiUrl } = await startApi((method, url) => {
      if (url.startsWith("/repos/o/r/actions/")) return { status: 403 };
      if (method === "GET" && url.startsWith("/repos/o/r/issues?")) {
        return { status: 200, body: [{ number: 4 }] };
      }
      if (method === "POST" && url === "/repos/o/r/issues/4/comments") return { status: 201 };
      if (method === "PATCH" && url === "/repos/o/r/issues/4") return { status: 200 };
      return { status: 500 };
    });
    const res = await runRunner({
      ...baseEnv(apiUrl),
      NEEDS_JSON: JSON.stringify({ api: { result: "success" } }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("::warning::could not list");
    expect(res.stdout).toContain("closed issue #4");
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("exits 1 on unreadable input rather than passing silently", async () => {
    const res = await runRunner({ ...baseEnv("http://127.0.0.1:9"), NEEDS_JSON: "not json" });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("::error title=nightly report failed::");
  });
});
