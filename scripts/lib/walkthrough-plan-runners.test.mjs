import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parsePhaseMap } from "./walkthrough-fixes-core.mjs";

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

  /**
   * A minimal tree: `app.ts` source (or none), the given page files, and an
   * empty plan, so only the route walk and page listing decide the outcome.
   *
   * @param {string} name @param {string | null} appSource @param {string[]} pages
   */
  const tree = (name, appSource, pages) => {
    const root = path.join(tmp, name);
    fs.mkdirSync(path.join(root, "ui", "src", "app"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs", "walkthroughs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "walkthroughs", "TEST_PLAN.md"), "no references\n");
    if (appSource !== null) {
      fs.mkdirSync(path.join(root, "server", "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "server", "src", "app.ts"), appSource);
    }
    for (const page of pages) {
      const file = path.join(root, "ui", "src", "app", ...page.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export default function P() { return null; }\n");
    }
    return root;
  };
  const HEALTH_APP = 'export function createApp() {\n  app.get("/api/health", h);\n}\n';

  it("fails with pages but zero routes", () => {
    const { status, output } = run(DRIFT, ["--root", tree("pages-only", null, ["page.tsx"])]);
    expect(output).toContain("found 0 API route(s)");
    expect(output).toContain("and 1 page(s)");
    expect(status).toBe(1);
  });

  it("fails with routes but zero pages", () => {
    const { status, output } = run(DRIFT, ["--root", tree("routes-only", HEALTH_APP, [])]);
    expect(output).toContain("found 1 API route(s)");
    expect(output).toContain("and 0 page(s)");
    expect(status).toBe(1);
  });

  it("passes a tree with routes and pages and nothing unfollowable", () => {
    const { status, output } = run(DRIFT, ["--root", tree("minimal", HEALTH_APP, ["page.tsx"])]);
    expect(output).toContain("Every API route and page the plan names exists.");
    expect(status).toBe(0);
  });

  it("fails on a mount into a relative import the walk cannot follow", () => {
    const app = [
      'import { lostRouter } from "./routes/lost.js";',
      "export function createApp() {",
      '  app.get("/api/health", h);',
      '  app.use("/api/lost", lostRouter());',
      "}",
      "",
    ].join("\n");
    const { status, output } = run(DRIFT, ["--root", tree("lost-mount", app, ["page.tsx"])]);
    expect(output).toContain("could not follow");
    expect(output).toContain("server/src/app.ts: /api/lost → lostRouter");
    expect(output).not.toContain("Every API route and page the plan names exists.");
    expect(status).toBe(1);
  });

  it("passes a package-middleware mount and a waived relative mount", () => {
    const app = [
      'import cors from "cors";',
      'import { lostRouter } from "./routes/lost.js";',
      "export function createApp() {",
      '  app.get("/api/health", h);',
      '  app.use("/api/public", cors({ origin: "*" }));',
      '  app.use("/api/lost", lostRouter()); // drift-check: skip',
      "}",
      "",
    ].join("\n");
    const { status, output } = run(DRIFT, ["--root", tree("waived-mount", app, ["page.tsx"])]);
    expect(output).not.toContain("could not follow");
    expect(status).toBe(0);
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

  it("does not trigger on a registration edited in place, through a real git diff", () => {
    git(["checkout", "-q", "-b", "inplace", "main"]);
    try {
      write(
        "server/src/routes/x.ts",
        'export function xRouter() {\n  r.get("/a", requireAuth, renamedHandler);\n}\n',
      );
      git(["commit", "-q", "-am", "middleware"]);
      const { status, output } = gate();
      expect(output).toContain("0 trigger(s), verdict=not-required");
      expect(status).toBe(0);
    } finally {
      git(["checkout", "-q", "feature"]);
    }
  });

  it("sees a path-only edit on a multi-line registration, whose open call is unchanged", () => {
    const multi = (/** @type {string} */ p) =>
      `export function xRouter() {\n  r.get("/a", h);\n  r.post(\n    "${p}",\n    h,\n  );\n}\n`;
    git(["checkout", "-q", "-b", "multi-base", "main"]);
    try {
      write("server/src/routes/x.ts", multi("/old"));
      git(["commit", "-q", "-am", "multi-line base"]);
      git(["checkout", "-q", "-b", "multi-path"]);
      write("server/src/routes/x.ts", multi("/new"));
      git(["commit", "-q", "-am", "rename path only"]);
      const { status, output } = gate({}, ["--base", "multi-base"]);
      expect(output).toContain('route removed in server/src/routes/x.ts: "/old",');
      expect(output).toContain('route added in server/src/routes/x.ts: "/new",');
      expect(status).toBe(1);
    } finally {
      git(["checkout", "-q", "feature"]);
    }
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

describe("Spec Kit issue export (S21) instructions after #936", () => {
  const read = (/** @type {string} */ rel) =>
    fs.readFileSync(path.join(repoRoot, ...rel.split("/")), "utf8");
  const docs = [
    "docs/walkthroughs/TEST_PLAN.md",
    ".github/skills/e2e-walkthrough/SKILL.md",
    ".github/skills/e2e-walkthrough/briefs/wave-d.md",
  ];

  it("no longer tells a run to expect or record a 501 against #936", () => {
    for (const rel of docs) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/501 until #936/);
      expect(text, rel).not.toMatch(/501 against #936/);
    }
  });

  // #1172 — #953 landed (run 9): Publish is enabled after the dry run. The docs must stop
  // saying it stays disabled, and must keep the cap, the sandbox and the throwaway feature,
  // narrowed to one task through #993's export picker (or a 1-task `tasks.md`).
  it("says Publish is enabled since #953, within the 2-issue cap, in the sandbox, one task via the picker", () => {
    for (const rel of docs) {
      const line = read(rel)
        .split(/\n(?=- |\| |\n)/)
        .find((para) => para.includes("#953"));
      expect(line, rel).toBeDefined();
      expect(line, rel).not.toMatch(/stays disabled|cannot publish until #953/);
      expect(line, rel).toMatch(/Publish is\s+enabled/);
      expect(line, rel).toMatch(/target\s+repo/);
      expect(line, rel).toMatch(/2-issue cap/);
      expect(line, rel).toMatch(/throwaway\s+feature/);
      expect(line, rel).toMatch(/one task in the\s+export picker/);
      expect(line, rel).toMatch(/#993/);
      expect(line, rel).toMatch(/cut `tasks\.md` to 1 task/);
      expect(line, rel).toContain("openzigs/flux-v2");
    }
  });

  it("treats the page's no-client reason as a failure, quoting what the page actually shows", () => {
    const page = read("ui/src/app/(authed)/projects/[id]/spec-kit/page.tsx");
    expect(page).toContain("Publishing issues to GitHub is not available on this server yet.");
    const plan = read("docs/walkthroughs/TEST_PLAN.md");
    const row = plan.split("\n").find((l) => l.startsWith("| S21 |"));
    expect(row).toContain("Publishing issues to GitHub is not available on this server yet");
    expect(row).toMatch(/no live issue client: a FAIL/);
  });

  it("names the picker the page actually renders", () => {
    const page = read("ui/src/app/(authed)/projects/[id]/spec-kit/page.tsx");
    expect(page).toContain('data-testid="spec-kit-export-tasks"');
    const row = read("docs/walkthroughs/TEST_PLAN.md")
      .split("\n")
      .find((l) => l.startsWith("| S21 |"));
    expect(row).toContain("spec-kit-export-tasks");
  });

  // #1172 review — issue-sync's toggleCheckbox never ticks a table row: close writes a
  // `closed via` marker and reopen swaps it for `<!-- open -->`. Only a bullet is (un)ticked.
  it("describes S24 sync as the code does: bullets tick, table rows get markers", () => {
    const sync = read("server/src/lib/spec-kit/issue-sync.ts");
    expect(sync).toContain('"<!-- open -->"');
    expect(sync).toContain("<!-- closed via ${ref} -->");
    const s24 = read("docs/walkthroughs/TEST_PLAN.md")
      .split("\n")
      .find((l) => l.startsWith("| S24 |"));
    const brief = read(".github/skills/e2e-walkthrough/briefs/wave-d.md")
      .split(/\n(?=- )/)
      .find((p) => p.startsWith("- **S24**"));
    for (const [rel, text] of [
      ["TEST_PLAN.md S24", s24],
      ["wave-d.md S24", brief],
    ]) {
      expect(text, rel).toBeDefined();
      expect(text, rel).toMatch(/table-form(\*\*)? row is never\s+ticked/);
      expect(text, rel).toContain("<!-- open -->");
      expect(text, rel).not.toMatch(/reopen (must )?untick(s)? (it|the task)\b/);
    }
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

  it("the drift core's comments name test files that exist", () => {
    const core = fs.readFileSync(
      path.join(scriptsDir, "lib", "walkthrough-plan-drift-core.mjs"),
      "utf8",
    );
    const named = [...core.matchAll(/[\w./-]*walkthrough-plan-[\w-]+\.test\.mjs/g)].map((m) =>
      m[0].replace(/^scripts\//, ""),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const rel of named) {
      const file = rel.includes("/") ? rel : `lib/${rel}`;
      expect(fs.existsSync(path.join(scriptsDir, ...file.split("/"))), rel).toBe(true);
    }
  });

  it("runs each walkthrough step even when the changelog step before it failed", () => {
    /** @param {string} name */
    const step = (name) => {
      const start = job.indexOf(`- name: ${name}`);
      const next = job.indexOf("- name:", start + 1);
      return job.slice(start, next >= 0 ? next : job.length);
    };
    for (const name of [
      "Walkthrough test plan drift check",
      "Walkthrough test plan updated for route/page changes",
    ]) {
      expect(job).toContain(`- name: ${name}`);
      expect(step(name)).toMatch(/^\s+if: \$\{\{ !cancelled\(\) \}\}$/m);
    }
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

// #1177 — the analyst journey is the core of the run and the developer side a smoke test.
// These pin the shape across the plan, the briefs, the map and the results template, so a
// later edit to one cannot quietly drift from the others.
describe("Run shape: analyst first, developer smoke test (#1177)", () => {
  const read = (/** @type {string} */ rel) =>
    fs.readFileSync(path.join(repoRoot, ...rel.split("/")), "utf8");
  const plan = read("docs/walkthroughs/TEST_PLAN.md");
  const SMOKE = ["S2", "S4", "S6", "S7", "S21"];

  it("marks every Spec Kit row outside the smoke set optional, and none inside it", () => {
    const rows = plan.split("\n").filter((l) => /^\| S\d+[a-z]? \|/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(24);
    for (const row of rows) {
      const id = /** @type {RegExpMatchArray} */ (row.match(/^\| (S\d+[a-z]?) \|/))[1];
      const step = row.split("|")[2];
      expect(/\*\(Optional/.test(step), id).toBe(!SMOKE.includes(id));
    }
    expect(plan).toMatch(/Smoke set \(#1177\): S2, S4, S6, S7 and S21/);
  });

  it("runs two developer requests in wave E and keeps the other four as optional", () => {
    expect(plan).toMatch(/Wave E runs two of them \(#1177\): #4478 and #4386/);
    expect(plan).toMatch(/#4511, #4336, #4479 and #4456 are \*\(optional\)\*/);
    const waveE = read(".github/skills/e2e-walkthrough/briefs/wave-e.md");
    expect(waveE).toMatch(/Run \*\*two\*\* requests: \*\*#4478\*\*/);
    expect(waveE).not.toMatch(/For each of the six developer requests/);
    expect(waveE).not.toMatch(/twenty-four rows in all/);
  });

  it("makes wave G conditional on a Spec Kit or impact change, with the command to decide", () => {
    const g = plan.slice(plan.indexOf("## Wave G"));
    expect(g).toMatch(/only when the release under test touches Spec Kit or impact analysis/);
    expect(g).toContain("server/src/lib/spec-kit");
    expect(g).toContain("server/src/lib/impact-analysis");
    expect(g).toMatch(/skipped: no Spec Kit or impact change since/);
  });

  it("gives J1 operator-run or operator-approved second-user steps, never a workaround", () => {
    expect(plan).toMatch(/### Second-user steps \(operator-run or operator-approved\)/);
    for (const step of ["J1.4a", "J1.4b", "J1.4c"]) {
      const row = plan.split("\n").find((l) => l.startsWith(`| ${step} |`));
      expect(row, step).toBeDefined();
      expect(row, step).toMatch(/\[2nd user/);
    }
    const waveF = read(".github/skills/e2e-walkthrough/briefs/wave-f.md");
    expect(waveF).toContain("{{SECOND_USER_MODE}}");
    expect(waveF).toContain("{{J1_RESUME_AT}}");
    expect(waveF).toMatch(/Operator steps pending/);
    expect(waveF).toMatch(/never act as\s+them through the API or SQL/);
  });

  it("checks the BRD's Word and PDF by URL and makes the Jira publish conditional on #1176", () => {
    expect(plan).toMatch(/Fetch the BRD's exports by URL, never by clicking Download/);
    expect(plan).toContain("?format=docx");
    expect(plan).toContain("?format=pdf");
    const j17 = plan.split("\n").find((l) => l.startsWith("| J1.7 |"));
    expect(j17).toMatch(/Word and PDF exports are fetched by URL and opened/);
    expect(j17).toMatch(/sign-off rubric/);
    const j18a = plan.split("\n").find((l) => l.startsWith("| J1.8a |"));
    expect(j18a).toMatch(/Conditional on #1176/);
    expect(j18a).toMatch(/skipped: no sandbox Jira \(#1176\)/);
  });

  it("puts the analyst journey first in the results template and marks what stops comparing", () => {
    const template = read("docs/walkthroughs/RESULTS_TEMPLATE.md");
    const at = (/** @type {string} */ heading) => template.indexOf(heading);
    expect(at("### Analyst journey")).toBeGreaterThan(0);
    for (const later of [
      "### Journeys (wave F)",
      "### Developer smoke test",
      "### Fixes since the previous run",
      "### Per-phase evidence",
      "### Run-to-run comparison",
    ]) {
      expect(at(later), later).toBeGreaterThan(at("### Analyst journey"));
    }
    const lines = template.slice(at("### Run-to-run comparison")).split("\n");
    const start = lines.findIndex((l) => l.startsWith("| Measure | Run 2 baseline |"));
    expect(lines[start]).toContain("Comparable with runs 1 to 9?");
    const end = lines.findIndex((l, i) => i > start && !l.startsWith("|"));
    const cells = (/** @type {string} */ l) => l.split("|").length;
    for (const row of lines.slice(start, end)) expect(cells(row), row).toBe(cells(lines[start]));
  });

  it("maps #1177 as walkthrough tooling and no longer asks wave E for six requests", () => {
    const { map, errors } = parsePhaseMap(read("docs/walkthroughs/fix-phase-map.json"));
    expect(errors).toEqual([]);
    expect(map?.issues["1177"]).toHaveProperty("skip");
    for (const [issue, entry] of Object.entries(map?.issues ?? {})) {
      if ("wave" in entry && entry.wave === "E") {
        expect(entry.check ?? "", issue).not.toMatch(/six (developer )?requests/);
      }
    }
  });
});
