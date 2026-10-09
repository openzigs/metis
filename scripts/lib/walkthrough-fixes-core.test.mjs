import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FIX_STATUSES,
  carryForward,
  checkFix,
  collectFixes,
  confirmedOpenIssues,
  fixLine,
  isRelevantPath,
  isRuntimeDependencyBump,
  lookupPhase,
  orderFixes,
  parseFirstParentLog,
  parseFixesDoc,
  parsePhaseMap,
  relevanceReason,
  renderScopeComment,
} from "./walkthrough-fixes-core.mjs";
import { parseFlags, runFixesSince } from "./walkthrough-fixes-cli.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SINCE = "aaaaaaa1";
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** @param {Array<[string, string, string]>} commits sha, subject, body */
const logText = (commits) => commits.map(([h, s, b]) => `${h}\x1f${s}\x1f${b}\x1e\n`).join("");

/**
 * A fixture repository: first-parent commits, each PR's metadata and files, each issue.
 *
 * @param {{
 *   commits: Array<[string, string, string]>,
 *   prs: Record<number, { title?: string, author?: string, labels?: string[], closes?: number[] }>,
 *   files: Record<string, string[]>,
 *   issues?: Record<number, { title: string, labels?: string[], state?: string }>,
 * }} repo
 */
function fakeIo(repo) {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    git: (/** @type {string[]} */ args) => {
      calls.push(["git", ...args]);
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      if (args[0] === "log") return logText(repo.commits);
      if (args[0] === "diff-tree") return `${(repo.files[args.at(-1) ?? ""] ?? []).join("\n")}\n`;
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    gh: (/** @type {string[]} */ args) => {
      calls.push(["gh", ...args]);
      const n = Number(args[2]);
      if (args[0] === "pr") {
        const pr = repo.prs[n];
        return JSON.stringify({
          number: n,
          title: pr.title ?? `PR ${n}`,
          author: { login: pr.author ?? "mgcronin" },
          labels: (pr.labels ?? []).map((name) => ({ name })),
          closingIssuesReferences: (pr.closes ?? []).map((number) => ({ number })),
        });
      }
      const issue = repo.issues?.[n];
      if (!issue) throw new Error(`no issue ${n}`);
      return JSON.stringify({
        title: issue.title,
        labels: (issue.labels ?? []).map((name) => ({ name })),
        state: issue.state ?? "OPEN",
      });
    },
  };
}

const MAP = {
  issues: { 939: { wave: "F", phase: "J1.4", check: "Approval flows through" } },
  prs: { 960: { wave: "C", phase: "9" }, 966: { skip: "Walkthrough tooling" } },
};

describe("isRelevantPath", () => {
  it.each([
    ["ui/src/app/(app)/projects/[id]/publish/page.tsx", true],
    ["ui/src/app/api/health/route.ts", true],
    ["server/src/routes/projects.ts", true],
    ["server/src/lib/spec-kit/plan.ts", true],
    ["server/src/lib/impact-analysis/stages.ts", true],
    ["server/src/lib/ai/providers/anthropic.ts", false],
    ["ui/src/components/chat/panel.tsx", false],
    ["docs/walkthroughs/TEST_PLAN.md", false],
    ["server/src/lib/analysis-helpers.ts", false],
    ["server/src/routes/analysis-approval.test.ts", false],
    ["server/src/lib/spec-kit/__tests__/plan.ts", false],
    ["ui/src/app/(app)/chat/page.spec.tsx", false],
  ])("%s → %s", (file, expected) => {
    expect(isRelevantPath(file)).toBe(expected);
  });
});

describe("relevanceReason", () => {
  it("prefers the PR label, then a closing issue's label, then a file", () => {
    const files = ["server/src/routes/x.ts"];
    expect(relevanceReason({ labels: ["e2e-walkthrough"], issueLabels: [], files })).toBe(
      "PR labelled e2e-walkthrough",
    );
    expect(
      relevanceReason({ labels: [], issueLabels: [["bug"], ["e2e-walkthrough"]], files }),
    ).toBe("closing issue labelled e2e-walkthrough");
    expect(relevanceReason({ labels: [], issueLabels: [], files })).toBe(
      "touches server/src/routes/x.ts",
    );
    expect(relevanceReason({ labels: ["bug"], issueLabels: [["bug"]], files: ["README.md"] })).toBe(
      null,
    );
  });
});

describe("parseFirstParentLog", () => {
  it("reads sha, subject, body and the trailing PR number", () => {
    const text = logText([
      ["abc123", "fix: thing (#949)", "body line\n"],
      ["def456", "chore: direct push", ""],
    ]);
    expect(parseFirstParentLog(text)).toEqual([
      { sha: "abc123", subject: "fix: thing (#949)", body: "body line\n", pr: 949 },
      { sha: "def456", subject: "chore: direct push", body: "", pr: null },
    ]);
    expect(parseFirstParentLog("")).toEqual([]);
  });
});

describe("isRuntimeDependencyBump", () => {
  it("is true only for a production dependency", () => {
    expect(isRuntimeDependencyBump("  dependency-type: direct:production\n")).toBe(true);
    expect(isRuntimeDependencyBump("  dependency-type: direct:development\n")).toBe(false);
  });
});

describe("parsePhaseMap", () => {
  it("accepts the committed map", () => {
    const text = fs.readFileSync(
      path.join(repoRoot, "docs/walkthroughs/fix-phase-map.json"),
      "utf8",
    );
    const { map, errors } = parsePhaseMap(text);
    expect(errors).toEqual([]);
    expect(map?.issues["939"]).toMatchObject({ wave: "F" });
  });

  it("accepts a skip entry and rejects a skip with other fields or no reason", () => {
    expect(parsePhaseMap(JSON.stringify({ prs: { 1: { skip: "Tooling" } } })).errors).toEqual([]);
    expect(
      parsePhaseMap(JSON.stringify({ prs: { 1: { skip: "x", wave: "A" }, 2: { skip: " " } } }))
        .errors,
    ).toEqual([
      'fix-phase-map.json prs.1: a "skip" entry takes no other field',
      'fix-phase-map.json prs.2: "skip" must be a non-empty reason',
    ]);
  });

  it("rejects bad JSON, a non-object, unknown keys, bad waves and non-numeric keys", () => {
    expect(parsePhaseMap("{").errors).toEqual(["fix-phase-map.json: not valid JSON"]);
    expect(parsePhaseMap("[]").errors).toEqual(["fix-phase-map.json: expected a JSON object"]);
    const { map, errors } = parsePhaseMap(
      JSON.stringify({
        extra: 1,
        prs: [],
        issues: {
          abc: { wave: "A", phase: "1" },
          1: { wave: "Z", phase: "", check: "", other: true },
          2: "B",
        },
      }),
    );
    expect(map).toBeNull();
    expect(errors).toEqual([
      'fix-phase-map.json: unknown field "extra"',
      'fix-phase-map.json issues.1: unknown field "other"',
      'fix-phase-map.json issues.1: "wave" must be one of A, B, C, D, E, F, BA',
      'fix-phase-map.json issues.1: "phase" must be a non-empty string',
      'fix-phase-map.json issues.1: "check" must be a non-empty string when present',
      "fix-phase-map.json issues.2: expected a JSON object",
      "fix-phase-map.json issues.abc: key must be a positive number",
      'fix-phase-map.json: "prs" must be an object keyed by number',
    ]);
  });
});

describe("lookupPhase", () => {
  it("places by the first mapped closing issue, then by PR", () => {
    expect(lookupPhase(MAP, { pr: 1, issues: [5, 939] })).toEqual(MAP.issues[939]);
    expect(lookupPhase(MAP, { pr: 960, issues: [5] })).toEqual(MAP.prs[960]);
    expect(lookupPhase(MAP, { pr: 1, issues: [] })).toBeNull();
  });
});

describe("checkFix", () => {
  const base = { pr: 1, issues: [2], wave: "A", phase: "1", check: "x" };

  it("requires evidence for every status but not-exercised", () => {
    /** @type {string[]} */
    const errors = [];
    expect(checkFix({ ...base, status: "confirmed" }, "f", { withStatus: true }, errors)).toBe(
      false,
    );
    expect(errors).toEqual(['f: "evidence" (a step id) is required when "status" is "confirmed"']);
    expect(checkFix({ ...base, status: "not-exercised" }, "f", { withStatus: true }, [])).toBe(
      true,
    );
    expect(
      checkFix({ ...base, status: "regressed", evidence: "b-8-1" }, "f", { withStatus: true }, []),
    ).toBe(true);
  });

  it("rejects every malformed field", () => {
    /** @type {string[]} */
    const errors = [];
    checkFix(
      {
        pr: 0,
        issues: [-1],
        wave: "G",
        phase: "",
        check: 3,
        status: "done",
        evidence: "",
        carried: "x",
        y: 1,
      },
      "f",
      { withStatus: true },
      errors,
    );
    expect(errors).toEqual([
      'f: unknown field "y"',
      'f: "pr" must be a positive PR number',
      'f: "issues" must be an array of positive issue numbers',
      'f: "wave" must be one of A, B, C, D, E, F, BA',
      'f: "phase" must be a non-empty string',
      'f: "check" must be a non-empty string',
      'f: "carried" must be one of confirmed, partial, regressed, not-exercised when present',
      'f: "status" must be one of confirmed, partial, regressed, not-exercised',
      'f: "evidence" must be a step id when present',
    ]);
    expect(checkFix("x", "f", { withStatus: false }, errors)).toBe(false);
    expect(errors.at(-1)).toBe("f: expected a JSON object");
    // Without a status, status and evidence are unknown fields.
    /** @type {string[]} */
    const plain = [];
    checkFix({ ...base, status: "confirmed" }, "f", { withStatus: false }, plain);
    expect(plain).toEqual(['f: unknown field "status"']);
  });
});

describe("carryForward", () => {
  it("keeps everything not confirmed, marked with its last status", () => {
    const fixes = FIX_STATUSES.map((status, i) => ({
      pr: i + 1,
      issues: [10 + i],
      wave: "B",
      phase: "8",
      check: `c${i}`,
      status,
      evidence: "s",
    }));
    expect(carryForward({ fixes })).toEqual([
      { pr: 2, issues: [11], wave: "B", phase: "8", check: "c1", carried: "partial" },
      { pr: 3, issues: [12], wave: "B", phase: "8", check: "c2", carried: "regressed" },
      { pr: 4, issues: [13], wave: "B", phase: "8", check: "c3", carried: "not-exercised" },
    ]);
    expect(carryForward(null)).toEqual([]);
    expect(carryForward({})).toEqual([]);
  });
});

describe("collectFixes", () => {
  const repo = {
    commits: /** @type {Array<[string, string, string]>} */ ([
      ["c1", "fix: approval (#950)", ""],
      ["c2", "feat: docs (#960)", ""],
      ["c3", "chore: unrelated (#961)", ""],
      ["c4", "chore(deps): Bump x (#962)", "  dependency-type: direct:production\n"],
      ["c5", "chore(deps-dev): Bump y (#963)", "  dependency-type: direct:development\n"],
      ["c6", "feat: new page (#964)", ""],
      ["c7", "hotfix pushed straight to main", ""],
      ["c8", "fix: labelled only (#965)", ""],
      ["c9", "feat: walkthrough tooling (#966)", ""],
      ["c10", "test: a route test (#967)", ""],
    ]),
    prs: {
      950: { closes: [939] },
      960: { title: "Docs gen tweak" },
      961: {},
      962: { author: "app/dependabot", title: "Bump x" },
      963: { author: "dependabot[bot]", title: "Bump y" },
      964: { title: "New page", closes: [970] },
      965: { labels: ["e2e-walkthrough"], closes: [939] },
      966: {},
      967: {},
    },
    files: {
      c1: ["server/src/lib/analysis/approve.ts"],
      c2: ["server/src/lib/docs-gen/run.ts"],
      c3: ["README.md"],
      c6: ["ui/src/app/(app)/projects/[id]/new/page.tsx"],
      c8: ["docs/x.md"],
      c9: ["server/src/routes/walkthrough.ts"],
      c10: ["server/src/routes/projects.test.ts"],
    },
    issues: {
      939: { title: "Approving does not approve" },
      970: { title: "Add a page", labels: ["enhancement"] },
    },
  };

  it("classifies, places and carries forward, dropping nothing silently", () => {
    const io = fakeIo(repo);
    const doc = collectFixes({
      since: SINCE,
      map: MAP,
      io,
      previousRun: {
        fixes: [
          { pr: 900, issues: [800], wave: "A", phase: "2", check: "old", status: "partial" },
          { pr: 901, issues: [], wave: "A", phase: "2", check: "done", status: "confirmed" },
          // Re-merged work this run supersedes: the fresh entry wins.
          { pr: 960, issues: [], wave: "C", phase: "9", check: "stale", status: "regressed" },
        ],
      },
    });
    expect(doc).toEqual({
      since: SINCE,
      head: HEAD,
      fixes: [
        { pr: 900, issues: [800], wave: "A", phase: "2", check: "old", carried: "partial" },
        { pr: 960, issues: [], wave: "C", phase: "9", check: "Docs gen tweak" },
        { pr: 950, issues: [939], wave: "F", phase: "J1.4", check: "Approval flows through" },
        { pr: 965, issues: [939], wave: "F", phase: "J1.4", check: "Approval flows through" },
      ],
      unmapped: [
        {
          pr: 964,
          issues: [970],
          title: "New page",
          reason: "touches ui/src/app/(app)/projects/[id]/new/page.tsx",
        },
      ],
      excluded: [{ pr: 966, issues: [], reason: "Walkthrough tooling" }],
      dependabot: [
        { pr: 962, title: "Bump x", runtime: true },
        { pr: 963, title: "Bump y", runtime: false },
      ],
      skipped: [961, 967],
      noPr: ["c7 hotfix pushed straight to main"],
    });
    // The log is first-parent over since..HEAD, and each issue is fetched once.
    expect(io.calls).toContainEqual([
      "git",
      "log",
      "--first-parent",
      "--format=%H%x1f%s%x1f%b%x1e",
      `${SINCE}..HEAD`,
    ]);
    expect(io.calls.filter((c) => c[1] === "issue" && c[3] === "939")).toHaveLength(1);
  });

  it("uses the closing issue's title as the check when the map gives none", () => {
    const doc = collectFixes({
      since: SINCE,
      map: { issues: { 939: { wave: "B", phase: "8" } }, prs: {} },
      io: fakeIo(repo),
    });
    expect(doc.fixes.find((f) => f.pr === 950)?.check).toBe("Approving does not approve");
  });

  it("refuses a non-SHA since or head, so nothing reaches git as an option", () => {
    const io = fakeIo(repo);
    expect(() => collectFixes({ since: "--output=/tmp/x", map: MAP, io })).toThrow(
      /--since must be a commit SHA/,
    );
    expect(() => collectFixes({ since: SINCE, head: "main", map: MAP, io })).toThrow(
      /--head must be a commit SHA/,
    );
    expect(io.calls).toEqual([]);
  });

  it("names the PR when gh returns something that is not JSON", () => {
    const io = { ...fakeIo(repo), gh: () => "not json" };
    expect(() => collectFixes({ since: SINCE, map: MAP, io })).toThrow(
      "gh returned invalid JSON for PR #950",
    );
  });
});

describe("parseFixesDoc", () => {
  const doc = {
    since: SINCE,
    head: HEAD,
    fixes: [{ pr: 1, issues: [], wave: "A", phase: "1", check: "x" }],
    unmapped: [],
    excluded: [],
    dependabot: [],
    skipped: [],
    noPr: [],
  };

  it("accepts a written doc", () => {
    expect(parseFixesDoc(JSON.stringify(doc))).toEqual({ doc, errors: [] });
  });

  it("rejects malformed docs", () => {
    expect(parseFixesDoc("x").errors).toEqual(["fixes.json: not valid JSON"]);
    expect(parseFixesDoc("1").errors).toEqual(["fixes.json: expected a JSON object"]);
    expect(
      parseFixesDoc(
        JSON.stringify({
          ...doc,
          since: "HEAD~3",
          extra: 1,
          fixes: [doc.fixes[0], doc.fixes[0]],
          unmapped: {},
        }),
      ).errors,
    ).toEqual([
      'fixes.json: unknown field "extra"',
      'fixes.json: "since" must be a commit SHA',
      "fixes.json fixes[1]: duplicate PR #1",
      'fixes.json: "unmapped" must be an array',
    ]);
    expect(parseFixesDoc(JSON.stringify({ ...doc, fixes: null })).errors).toEqual([
      'fixes.json: "fixes" must be an array',
    ]);
  });
});

describe("renderScopeComment and fixLine", () => {
  it("groups by wave in run order and lists runtime bumps", () => {
    const text = renderScopeComment(
      {
        since: SINCE,
        head: HEAD,
        fixes: [
          { pr: 7, issues: [], wave: "F", phase: "J2.1", check: "Impact names every writer" },
          {
            pr: 5,
            issues: [939, 940],
            wave: "B",
            phase: "8",
            check: "Approve",
            carried: "partial",
          },
        ],
        unmapped: [],
        excluded: [],
        dependabot: [
          { pr: 8, title: "Bump x", runtime: true },
          { pr: 9, title: "Bump y", runtime: false },
        ],
        skipped: [],
        noPr: [],
      },
      { run: 5 },
    );
    expect(text).toContain("## Walkthrough run 5: fixes to verify");
    expect(text).toContain("METIS `bbbbbbbb`, PRs merged since `aaaaaaa1`");
    expect(text.indexOf("### Wave B (1)")).toBeLessThan(text.indexOf("### Wave F (1)"));
    expect(text).toContain(
      "- PR #5 (closes #939, #940), Phase 8: Approve *Carried forward: partial last run.*",
    );
    expect(text).toContain("- PR #8: Bump x");
    expect(text).not.toContain("Bump y");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("says so when there is nothing to verify", () => {
    const text = renderScopeComment(
      {
        since: SINCE,
        head: HEAD,
        fixes: [],
        unmapped: [],
        excluded: [{ pr: 952, issues: [948], reason: "Tooling" }],
        dependabot: [],
        skipped: [],
        noPr: [],
      },
      { run: 6 },
    );
    expect(text).toContain("No fixes to verify.");
    expect(text).toContain("### Not verified by a wave (1)\n\n- PR #952: Tooling");
    expect(text).not.toContain("Runtime dependency");
  });

  it("orders by wave then PR", () => {
    const f = (/** @type {number} */ pr, /** @type {string} */ wave) => ({
      pr,
      issues: [],
      wave,
      phase: "1",
      check: "c",
    });
    expect(orderFixes([f(3, "BA"), f(2, "A"), f(1, "A"), f(4, "F")]).map((x) => x.pr)).toEqual([
      1, 2, 4, 3,
    ]);
    expect(fixLine(f(1, "A"))).toBe("- PR #1, Phase 1: c");
  });
});

describe("confirmedOpenIssues", () => {
  it("lists confirmed issues gh reports OPEN, once each", () => {
    const io = fakeIo({
      commits: [],
      prs: {},
      files: {},
      issues: { 939: { title: "a" }, 940: { title: "b", state: "CLOSED" }, 941: { title: "c" } },
    });
    const run = {
      fixes: [
        { status: "confirmed", issues: [940, 939] },
        { status: "confirmed", issues: [939] },
        { status: "partial", issues: [941] },
      ],
    };
    expect(confirmedOpenIssues(run, io)).toEqual([939]);
    expect(confirmedOpenIssues({}, io)).toEqual([]);
  });
});

describe("runFixesSince (CLI)", () => {
  const mapText = JSON.stringify(MAP);
  const prevRun = JSON.stringify({
    metisSha: SINCE,
    fixes: [
      {
        pr: 900,
        issues: [800],
        wave: "A",
        phase: "2",
        check: "old",
        status: "partial",
        evidence: "a-2-1",
      },
    ],
  });

  /** @param {Record<string, string>} files @param {Parameters<typeof fakeIo>[0]} [repo] */
  function cliIo(files, repo) {
    const base = fakeIo(
      repo ?? {
        commits: [
          ["c1", "fix: approval (#950)", ""],
          ["c6", "feat: page (#964)", ""],
        ],
        prs: { 950: { closes: [939] }, 964: { title: "New page" } },
        files: { c1: ["server/src/routes/a.ts"], c6: ["server/src/routes/b.ts"] },
        issues: { 939: { title: "t" } },
      },
    );
    /** @type {Record<string, string>} */
    const written = {};
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    return {
      written,
      out,
      err,
      io: {
        ...base,
        readFile: (/** @type {string} */ f) => {
          if (!(f in files)) throw new Error(`ENOENT ${f}`);
          return files[f];
        },
        writeFile: (/** @type {string} */ f, /** @type {string} */ t) => {
          written[f] = t;
        },
        log: (/** @type {string} */ m) => out.push(m),
        error: (/** @type {string} */ m) => err.push(m),
      },
    };
  }

  it("takes --since from the previous run, writes fixes.json and the scope comment", () => {
    const t = cliIo({ "prev.json": prevRun, "map.json": mapText });
    const code = runFixesSince(
      [
        "--previous",
        "prev.json",
        "--map",
        "map.json",
        "--out",
        "fixes.json",
        "--comment",
        "scope.md",
        "--run",
        "5",
      ],
      t.io,
    );
    expect(code).toBe(0);
    const doc = JSON.parse(t.written["fixes.json"]);
    expect(doc.since).toBe(SINCE);
    expect(doc.fixes.map((/** @type {{ pr: number }} */ f) => f.pr)).toEqual([900, 950]);
    expect(doc.unmapped).toHaveLength(1);
    expect(t.written["scope.md"]).toContain("## Walkthrough run 5");
    expect(t.out[0]).toContain("2 fix(es) to verify (1 carried forward");
    expect(t.err.join("\n")).toContain("PR #964: New page — touches server/src/routes/b.ts");
  });

  it("reports runtime bumps and PR-less commits", () => {
    const t = cliIo(
      { "map.json": mapText },
      {
        commits: [
          ["c4", "chore(deps): Bump x (#962)", "dependency-type: direct:production"],
          ["c7", "direct", ""],
        ],
        prs: { 962: { author: "app/dependabot", title: "Bump x", closes: [] } },
        files: {},
      },
    );
    expect(runFixesSince(["--since", SINCE, "--map", "map.json", "--out", "f.json"], t.io)).toBe(0);
    expect(t.out).toContain("Runtime dependency bump: PR #962 Bump x");
    expect(t.out).toContain("First-parent commit with no PR number: c7 direct");
    expect(t.err).toEqual([]);
  });

  it("returns 2 on bad arguments", () => {
    const t = cliIo({});
    expect(runFixesSince(["--bogus"], t.io)).toBe(2);
    expect(runFixesSince(["--out"], t.io)).toBe(2);
    expect(runFixesSince(["--since", SINCE], t.io)).toBe(2);
    expect(runFixesSince(["--out", "f", "--comment", "c"], t.io)).toBe(2);
    expect(runFixesSince(["--out", "f"], t.io)).toBe(2);
    expect(t.err.at(-1)).toContain("--since is required");
    expect(parseFlags(["--out", "--since"]).error).toBe("--out needs a value");
  });

  it("returns 1 on an invalid map or previous run.json, writing nothing", () => {
    const t = cliIo({ "map.json": "{", "prev.json": '{"bogus":1}' });
    expect(runFixesSince(["--since", SINCE, "--map", "map.json", "--out", "f"], t.io)).toBe(1);
    expect(t.err.at(-1)).toContain("invalid map.json");
    expect(runFixesSince(["--previous", "prev.json", "--out", "f"], t.io)).toBe(1);
    expect(t.err.at(-1)).toContain('unknown field "bogus"');
    expect(t.written).toEqual({});
  });

  it("--close-list prints confirmed issues still open", () => {
    const run = JSON.stringify({
      fixes: [
        {
          pr: 1,
          issues: [939],
          wave: "B",
          phase: "8",
          check: "c",
          status: "confirmed",
          evidence: "b-1",
        },
      ],
    });
    const t = cliIo({ "run.json": run, "empty.json": "{}" });
    expect(runFixesSince(["--close-list", "run.json"], t.io)).toBe(0);
    expect(t.out.at(-1)).toContain("  #939");
    expect(runFixesSince(["--close-list", "empty.json"], t.io)).toBe(0);
    expect(t.out.at(-1)).toBe("No confirmed issue is still open.");
  });
});
