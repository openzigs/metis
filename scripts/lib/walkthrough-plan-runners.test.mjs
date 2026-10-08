import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runner-level tests for the two #948 gates. The cores take their inputs as
 * arguments, so no core test can notice a runner that reads the wrong plan,
 * diffs against the wrong ref, or passes when it found no routes at all. These
 * spawn the real scripts.
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(scriptsDir);
const DRIFT = path.join(scriptsDir, "walkthrough", "check-test-plan.mjs");
const GATE = "verify-walkthrough-plan.mjs";

/** @param {string} script @param {string[]} args @param {{ cwd?: string, env?: Record<string, string> }} [opts] */
function run(script, args, opts = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      WALKTHROUGH_PR_LABELS: "",
      WALKTHROUGH_PR_AUTHOR: "",
      WALKTHROUGH_BASE_REF: "",
      ...opts.env,
    },
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** @type {string} */
let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walkthrough-plan-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("check-test-plan.mjs (drift)", () => {
  it("passes the real TEST_PLAN.md against the real tree, with every mount resolved", () => {
    const { status, output } = run(DRIFT, []);
    expect(output).not.toContain("could not follow");
    expect(output).toContain("Every API route and page the plan names exists.");
    expect(status).toBe(0);
  });

  it("fails a plan naming a dead route and a dead page, with their lines", () => {
    const plan = path.join(tmp, "dead.md");
    fs.writeFileSync(
      plan,
      "# Plan\n`GET /api/health`\n`/projects/:id/test-coverage/connections`\n`PUT /api/projects/:id/budget`\n",
    );
    const { status, output } = run(DRIFT, ["--plan", plan]);
    expect(status).toBe(1);
    expect(output).toMatch(/dead\.md:3\s+page \/projects\/:id\/test-coverage\/connections/);
    expect(output).toMatch(/dead\.md:4\s+API +PUT \/api\/projects\/:id\/budget/);
    expect(output).not.toMatch(/dead\.md:2/);
  });

  it("fails when the plan cannot be read", () => {
    const { status, output } = run(DRIFT, ["--plan", path.join(tmp, "missing.md")]);
    expect(status).toBe(1);
    expect(output).toContain("cannot read");
  });

  it("fails rather than passing when it finds no routes or pages", () => {
    const root = path.join(tmp, "empty-root");
    fs.mkdirSync(path.join(root, "ui", "src", "app"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs", "walkthroughs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "walkthroughs", "TEST_PLAN.md"), "no references\n");
    const { status, output } = run(DRIFT, ["--root", root]);
    expect(status).toBe(1);
    expect(output).toContain("Both must be non-empty");
  });

  it("fails when the app directory is missing", () => {
    const root = path.join(tmp, "no-app");
    fs.mkdirSync(path.join(root, "docs", "walkthroughs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "walkthroughs", "TEST_PLAN.md"), "x\n");
    const { status, output } = run(DRIFT, ["--root", root]);
    expect(status).toBe(1);
    expect(output).toContain("cannot list ui/src/app");
  });
});

describe("verify-walkthrough-plan.mjs (PR gate)", () => {
  /** @type {string} */
  let fixture;

  /** @param {string[]} args */
  const git = (args) => execFileSync("git", args, { cwd: fixture, stdio: "pipe" });

  /** @param {string} rel @param {string} contents */
  const write = (rel, contents) => {
    const target = path.join(fixture, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };

  /** @param {Record<string, string>} [env] @param {string[]} [args] */
  const gate = (env = {}, args = []) =>
    run(path.join(fixture, "scripts", GATE), args, { cwd: fixture, env });

  beforeAll(() => {
    fixture = path.join(tmp, "gate");
    fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(scriptsDir, GATE), path.join(fixture, "scripts", GATE));
    fs.cpSync(path.join(scriptsDir, "lib"), path.join(fixture, "scripts", "lib"), {
      recursive: true,
    });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    write("server/src/routes/x.ts", 'export function xRouter() {\n  r.get("/a", h);\n}\n');
    write("docs/walkthroughs/TEST_PLAN.md", "# Plan\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    git(["checkout", "-q", "-b", "feature"]);
    write(
      "server/src/routes/x.ts",
      'export function xRouter() {\n  r.get("/a", h);\n  r.post(\n    "/b",\n  );\n}\n',
    );
    git(["commit", "-q", "-am", "add route"]);
  });

  it("fails a branch that adds a route without touching the plan", () => {
    const { status, output } = gate();
    expect(status).toBe(1);
    expect(output).toContain('route added in server/src/routes/x.ts: "/b",');
    expect(output).toContain("no-walkthrough-impact");
  });

  it("passes with the waiver label, read from the environment or the flag", () => {
    expect(gate({ WALKTHROUGH_PR_LABELS: "testing\nno-walkthrough-impact" }).status).toBe(0);
    expect(gate({}, ["--labels", "a,no-walkthrough-impact"]).status).toBe(0);
  });

  it("passes for dependabot", () => {
    expect(gate({ WALKTHROUGH_PR_AUTHOR: "dependabot[bot]" }).status).toBe(0);
  });

  it("fails on an unresolvable base ref instead of skipping", () => {
    const { status, output } = gate({}, ["--base", "no-such-ref"]);
    expect(status).toBe(1);
    expect(output).toContain("could not resolve a base ref");
  });

  it("fails when neither origin/main nor main exists and no base is given", () => {
    const orphan = path.join(tmp, "no-main");
    fs.mkdirSync(path.join(orphan, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(scriptsDir, GATE), path.join(orphan, "scripts", GATE));
    fs.cpSync(path.join(scriptsDir, "lib"), path.join(orphan, "scripts", "lib"), {
      recursive: true,
    });
    const g = (/** @type {string[]} */ args) =>
      execFileSync("git", args, { cwd: orphan, stdio: "pipe" });
    g(["init", "-q", "-b", "trunk"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(orphan, "a.txt"), "a\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "only"]);
    const { status, output } = run(path.join(orphan, "scripts", GATE), [], { cwd: orphan });
    expect(status).toBe(1);
    expect(output).toContain("could not resolve a base ref");
  });

  it("passes once the plan changes on the branch", () => {
    write("docs/walkthroughs/TEST_PLAN.md", "# Plan\n- `POST /api/b`\n");
    git(["commit", "-q", "-am", "plan"]);
    const { status, output } = gate();
    expect(output).toContain("verdict=plan-updated");
    expect(status).toBe(0);
  });
});

describe("CI wiring (#948)", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const job = (() => {
    const lines = workflow.split("\n");
    const start = lines.findIndex((line) => /^ {2}changelog:\s*$/.test(line));
    const after = lines.findIndex((line, i) => i > start && /^ {2}\S.*:\s*$/.test(line));
    return lines.slice(start, after >= 0 ? after : lines.length).join("\n");
  })();

  it("runs both walkthrough gates in the full-fetch changelog job", () => {
    expect(job).toContain("fetch-depth: 0");
    expect(job).toContain("node scripts/walkthrough/check-test-plan.mjs");
    expect(job).toContain("node scripts/verify-walkthrough-plan.mjs");
  });

  it("reads labels from the API at run time and the author from the PR record", () => {
    expect(job).toMatch(
      /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/pulls\/\$\{PR_NUMBER\}" --jq '\.labels\[\]\.name'/,
    );
    expect(job).toContain("export WALKTHROUGH_PR_LABELS");
    expect(job).toMatch(
      /WALKTHROUGH_PR_AUTHOR:\s*\$\{\{ github\.event\.pull_request\.user\.login \}\}/,
    );
    expect(job).toMatch(/pull-requests: read/);
  });

  it("the PR template carries the test-plan checkbox", () => {
    const template = fs.readFileSync(
      path.join(repoRoot, ".github", "pull_request_template.md"),
      "utf8",
    );
    expect(template).toMatch(
      /- \[ \] User-facing feature added or changed → .*TEST_PLAN\.md.* updated \(or N\/A/,
    );
  });
});
