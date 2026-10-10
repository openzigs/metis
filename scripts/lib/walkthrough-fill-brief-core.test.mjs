import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BRIEF_WAVES,
  fillBriefs,
  fillTemplate,
  parseState,
  renderFixesForWave,
  runFillBrief,
} from "./walkthrough-fill-brief-core.mjs";

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(scriptsDir);
const BRIEFS = path.join(repoRoot, ".github", "skills", "e2e-walkthrough", "briefs");
const RUNNER = path.join(scriptsDir, "walkthrough", "fill-brief.mjs");

const fix = (/** @type {number} */ pr, /** @type {string} */ wave, extra = {}) => ({
  pr,
  issues: [pr + 1000],
  wave,
  phase: "1",
  check: `check ${pr}`,
  ...extra,
});

const doc = (/** @type {object} */ over = {}) => ({
  since: "aaaaaaa",
  head: "bbbbbbb",
  fixes: [fix(1, "A"), fix(2, "F"), fix(3, "A")],
  unmapped: [],
  excluded: [],
  dependabot: [],
  skipped: [],
  noPr: [],
  ...over,
});

describe("parseState", () => {
  it("accepts placeholders and required PRs", () => {
    expect(
      parseState(JSON.stringify({ placeholders: { RUN_NUMBER: "5" }, requiredPrs: [952] })),
    ).toEqual({
      state: { placeholders: { RUN_NUMBER: "5" }, requiredPrs: [952] },
      errors: [],
    });
    expect(parseState(JSON.stringify({ placeholders: {} })).state?.requiredPrs).toEqual([]);
  });

  it("rejects malformed state, and refuses to let it set the generated list", () => {
    expect(parseState("{").errors).toEqual(["state: not valid JSON"]);
    expect(parseState("[]").errors).toEqual(["state: expected a JSON object"]);
    expect(parseState(JSON.stringify({ placeholders: [] })).errors).toEqual([
      'state: "placeholders" must be an object',
    ]);
    expect(
      parseState(
        JSON.stringify({
          extra: 1,
          placeholders: { lower: "x", FIXES_TO_VERIFY: "hand-written", EMPTY: " " },
          requiredPrs: ["952"],
        }),
      ).errors,
    ).toEqual([
      'state: unknown field "extra"',
      "state placeholders.lower: key must be UPPER_SNAKE",
      "state placeholders.FIXES_TO_VERIFY: generated from fixes.json, do not set it",
      "state placeholders.EMPTY: value must be a non-empty string",
      'state: "requiredPrs" must be an array of positive PR numbers',
    ]);
  });
});

describe("renderFixesForWave", () => {
  it("lists only that wave, ordered by PR", () => {
    expect(renderFixesForWave(doc().fixes, "A")).toBe(
      "- PR #1 (closes #1001), Phase 1: check 1\n- PR #3 (closes #1003), Phase 1: check 3",
    );
    expect(renderFixesForWave(doc().fixes, "BA")).toBe("None in this wave.");
  });
});

describe("fillTemplate", () => {
  it("fills known keys and reports the rest once each", () => {
    expect(fillTemplate("{{A}} {{B}} {{B}} {{a_1}}", { A: "x" })).toEqual({
      text: "x {{B}} {{B}} {{a_1}}",
      missing: ["B", "a_1"],
    });
    // A key inherited from Object.prototype is not a value.
    expect(fillTemplate("{{toString}}", {}).missing).toEqual(["toString"]);
  });
});

describe("fillBriefs", () => {
  const state = { placeholders: { RUN_NUMBER: "5" }, requiredPrs: [1] };

  it("fills each brief with its own wave's fixes", () => {
    const { outputs, errors } = fillBriefs({
      briefs: {
        "wave-a.md": "Run {{RUN_NUMBER}}: {{FIXES_TO_VERIFY}}",
        "wave-f.md": "{{FIXES_TO_VERIFY}}",
      },
      state,
      fixesDoc: doc(),
    });
    expect(errors).toEqual([]);
    expect(outputs["wave-a.md"]).toContain("Run 5:");
    expect(outputs["wave-a.md"]).toContain("PR #3");
    expect(outputs["wave-a.md"]).not.toContain("PR #2");
    expect(outputs["wave-f.md"]).toContain("PR #2");
  });

  it("refuses unmapped PRs, a missing required PR, an unknown brief and unfilled keys", () => {
    const { outputs, errors } = fillBriefs({
      briefs: { "wave-z.md": "x", "wave-b.md": "{{PROJECT_ID}}" },
      state: { placeholders: {}, requiredPrs: [1, 99] },
      fixesDoc: doc({ unmapped: [{ pr: 7, issues: [], title: "t", reason: "touches x" }] }),
    });
    expect(outputs).toEqual({});
    expect(errors).toEqual([
      "fixes.json: PR #7 is relevant but placed in no wave (touches x)",
      "required PR #99 is missing from fixes.json fixes[]",
      "wave-b.md: unfilled placeholder {{PROJECT_ID}}",
      "wave-z.md: no wave for this brief; add it to BRIEF_WAVES",
    ]);
  });

  it("with waves, fills and checks only those briefs but keeps run-wide checks", () => {
    const briefs = {
      "wave-a.md": "{{RUN_NUMBER}} {{FIXES_TO_VERIFY}}",
      "wave-b.md": "{{PROJECT_ID}}",
    };
    const only = fillBriefs({ briefs, state, fixesDoc: doc(), waves: ["A"] });
    expect(only.errors).toEqual([]);
    expect(Object.keys(only.outputs)).toEqual(["wave-a.md"]);
    const all = fillBriefs({ briefs, state, fixesDoc: doc() });
    expect(all.errors).toEqual(["wave-b.md: unfilled placeholder {{PROJECT_ID}}"]);
    const wide = fillBriefs({
      briefs: { ...briefs, "wave-z.md": "x" },
      state: { placeholders: { RUN_NUMBER: "5" }, requiredPrs: [99] },
      fixesDoc: doc({ unmapped: [{ pr: 7, issues: [], title: "t", reason: "r" }] }),
      waves: ["A"],
    });
    expect(wide.errors).toEqual([
      "fixes.json: PR #7 is relevant but placed in no wave (r)",
      "required PR #99 is missing from fixes.json fixes[]",
      "wave-z.md: no wave for this brief; add it to BRIEF_WAVES",
    ]);
  });

  it("knows a wave for every committed brief", () => {
    for (const name of fs.readdirSync(BRIEFS)) expect(BRIEF_WAVES[name], name).toBeDefined();
    expect(BRIEF_WAVES["wave-f.md"]).toBe("F");
    expect(BRIEF_WAVES["wave-g.md"]).toBe("G");
    expect(Object.values(BRIEF_WAVES)).toEqual(["A", "B", "C", "D", "E", "F", "G", "BA"]);
  });
});

describe("runFillBrief", () => {
  /** @param {Record<string, string>} files */
  function io(files) {
    /** @type {Record<string, string>} */
    const written = {};
    /** @type {string[]} */
    const err = [];
    /** @type {string[]} */
    const out = [];
    return {
      written,
      err,
      out,
      io: {
        readFile: (/** @type {string} */ f) => {
          if (!(f in files)) throw new Error(`ENOENT ${f}`);
          return files[f];
        },
        listDir: (/** @type {string} */ d) =>
          Object.keys(files)
            .filter((f) => path.dirname(f) === d)
            .map((f) => path.basename(f)),
        writeFile: (/** @type {string} */ f, /** @type {string} */ t) => {
          written[f] = t;
        },
        mkdir: () => {},
        log: (/** @type {string} */ m) => out.push(m),
        error: (/** @type {string} */ m) => err.push(m),
      },
    };
  }
  const state = JSON.stringify({ placeholders: { RUN_NUMBER: "5" } });

  it("writes every brief when all checks pass", () => {
    const t = io({
      "s.json": state,
      "f.json": JSON.stringify(doc()),
      "b/wave-a.md": "{{RUN_NUMBER}} {{FIXES_TO_VERIFY}}",
      "b/notes.txt": "ignored",
    });
    expect(
      runFillBrief(["--state", "s.json", "--fixes", "f.json", "--out", "o", "--briefs", "b"], t.io),
    ).toBe(0);
    expect(Object.keys(t.written)).toEqual([path.join("o", "wave-a.md")]);
    expect(t.out).toEqual(["Filled 1 brief(s) into o."]);
  });

  it("writes nothing when any brief is refused", () => {
    const t = io({
      "s.json": state,
      "f.json": JSON.stringify(doc()),
      "b/wave-a.md": "{{RUN_NUMBER}}",
      "b/wave-b.md": "{{MISSING}}",
    });
    expect(
      runFillBrief(["--state", "s.json", "--fixes", "f.json", "--out", "o", "--briefs", "b"], t.io),
    ).toBe(1);
    expect(t.written).toEqual({});
    expect(t.err[0]).toContain("wave-b.md: unfilled placeholder {{MISSING}}");
  });

  it("--wave writes only the named waves and rejects unknown waves or a flag as a value", () => {
    const t = io({
      "s.json": state,
      "f.json": JSON.stringify(doc()),
      "b/wave-a.md": "{{RUN_NUMBER}}",
      "b/wave-b.md": "{{PROJECT_ID}}",
    });
    const base = ["--state", "s.json", "--fixes", "f.json", "--out", "o", "--briefs", "b"];
    expect(runFillBrief([...base, "--wave", "A"], t.io)).toBe(0);
    expect(Object.keys(t.written)).toEqual([path.join("o", "wave-a.md")]);
    expect(runFillBrief([...base, "--wave", "B"], t.io)).toBe(1);
    expect(runFillBrief([...base, "--wave", "Z"], t.io)).toBe(2);
    expect(t.err.at(-1)).toContain("unknown wave Z");
    expect(runFillBrief(["--state", "--fixes", "f.json", "--out", "o"], t.io)).toBe(2);
  });

  it("refuses invalid inputs, an empty briefs dir and bad arguments", () => {
    const t = io({
      "s.json": "{",
      "f.json": "{}",
      "good.json": state,
      "doc.json": JSON.stringify(doc()),
    });
    expect(runFillBrief(["--state", "s.json", "--fixes", "f.json", "--out", "o"], t.io)).toBe(1);
    expect(t.err.at(-1)).toContain("state: not valid JSON");
    expect(
      runFillBrief(
        ["--state", "good.json", "--fixes", "doc.json", "--out", "o", "--briefs", "none"],
        t.io,
      ),
    ).toBe(1);
    expect(t.err.at(-1)).toContain("no briefs in none");
    expect(runFillBrief(["--state", "missing.json", "--fixes", "f.json", "--out", "o"], t.io)).toBe(
      1,
    );
    expect(t.err.at(-1)).toContain("ENOENT missing.json");
    expect(runFillBrief(["--state"], t.io)).toBe(2);
    expect(runFillBrief(["--nope", "x"], t.io)).toBe(2);
    expect(runFillBrief(["--state", "s.json"], t.io)).toBe(2);
    expect(t.written).toEqual({});
  });
});

describe("fill-brief.mjs (runner, real briefs)", () => {
  /** @type {string} */
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fill-brief-"));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fills every committed brief from a complete state, and refuses an incomplete one", () => {
    const keys = new Set();
    for (const name of fs.readdirSync(BRIEFS)) {
      const text = fs.readFileSync(path.join(BRIEFS, name), "utf8");
      for (const m of text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)) keys.add(m[1]);
    }
    keys.delete("FIXES_TO_VERIFY");
    const placeholders = Object.fromEntries([...keys].map((k) => [k, `value-of-${k}`]));
    const fixesPath = path.join(tmp, "fixes.json");
    fs.writeFileSync(fixesPath, JSON.stringify(doc()));
    const statePath = path.join(tmp, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ placeholders }));
    const out = path.join(tmp, "out");

    const ok = spawnSync(
      process.execPath,
      [RUNNER, "--state", statePath, "--fixes", fixesPath, "--out", out, "--briefs", BRIEFS],
      {
        encoding: "utf8",
      },
    );
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    const waveF = fs.readFileSync(path.join(out, "wave-f.md"), "utf8");
    expect(waveF).toContain("PR #2");
    expect(waveF).not.toMatch(/\{\{/);
    const waveG = fs.readFileSync(path.join(out, "wave-g.md"), "utf8");
    expect(waveG).not.toMatch(/\{\{/);

    // --wave G fills only the optional wave G brief, with its own fixes (#1043).
    fs.writeFileSync(fixesPath, JSON.stringify(doc({ fixes: [fix(1, "A"), fix(5, "G")] })));
    const outG = path.join(tmp, "out-g");
    const onlyG = spawnSync(
      process.execPath,
      [
        RUNNER,
        "--state",
        statePath,
        "--fixes",
        fixesPath,
        "--out",
        outG,
        "--briefs",
        BRIEFS,
        "--wave",
        "G",
      ],
      { encoding: "utf8" },
    );
    expect(onlyG.stderr).toBe("");
    expect(onlyG.status).toBe(0);
    expect(fs.readdirSync(outG)).toEqual(["wave-g.md"]);
    const filledG = fs.readFileSync(path.join(outG, "wave-g.md"), "utf8");
    expect(filledG).toContain("PR #5");
    expect(filledG).not.toContain("PR #1,");
    fs.writeFileSync(fixesPath, JSON.stringify(doc()));

    const partial = { ...placeholders };
    delete partial.RUN_NUMBER;
    fs.writeFileSync(statePath, JSON.stringify({ placeholders: partial }));
    const bad = spawnSync(
      process.execPath,
      [
        RUNNER,
        "--state",
        statePath,
        "--fixes",
        fixesPath,
        "--out",
        path.join(tmp, "out2"),
        "--briefs",
        BRIEFS,
      ],
      {
        encoding: "utf8",
      },
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("unfilled placeholder {{RUN_NUMBER}}");
    expect(fs.existsSync(path.join(tmp, "out2"))).toBe(false);
  });
});
