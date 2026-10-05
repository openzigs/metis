/**
 * #751 — salvage the complete prefix of a synthesis reply that was cut off at
 * the output cap. The parser is structural: it must not be fooled by braces,
 * brackets or the word "requirements" inside string values, and it must never
 * return the element that was being written when the cap fired.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { salvageSynthesisPrefix } from "../src/lib/analysis/synthesis-salvage.js";

const req = (title: string, extra: Record<string, unknown> = {}) => ({
  type: "bug",
  title,
  body: "b",
  priority: "high",
  labels: [],
  evidenceFindingIndexes: [0],
  acceptanceCriteria: ["x"],
  ...extra,
});

describe("salvageSynthesisPrefix", () => {
  it("returns every complete element before the cut and drops the partial one", () => {
    const full = JSON.stringify({ summary: "s", requirements: [req("A"), req("B"), req("C")] });
    const cut = full.slice(0, full.indexOf('"C"') + 2);
    const out = salvageSynthesisPrefix(cut);
    expect(out.summary).toBe("s");
    expect(out.requirements.map((r) => (r as { title: string }).title)).toEqual(["A", "B"]);
    expect(out.complete).toBe(false);
  });

  it("reports complete=true for a whole, well-formed object", () => {
    const full = JSON.stringify({ summary: "s", requirements: [req("A")] });
    const out = salvageSynthesisPrefix(full);
    expect(out.complete).toBe(true);
    expect(out.requirements).toHaveLength(1);
  });

  it("is not fooled by structural characters and escaped quotes inside strings", () => {
    const tricky = req('Fix "requirements": [ { } ] parsing', {
      body: 'a } ] \\" { [ "requirements": [] \\\\',
    });
    const full = JSON.stringify({
      summary: 'has "requirements": [ and } inside',
      requirements: [tricky, req("Next")],
    });
    const cut = full.slice(0, full.lastIndexOf('"Next"') + 3);
    const out = salvageSynthesisPrefix(cut);
    expect(out.summary).toBe('has "requirements": [ and } inside');
    expect(out.requirements).toEqual([tricky]);
  });

  it("reads through a markdown fence and prose preamble", () => {
    const body = JSON.stringify({ summary: "s", requirements: [req("A"), req("B")] });
    const cut = "Here you go:\n```json\n" + body.slice(0, body.indexOf('"B"'));
    const out = salvageSynthesisPrefix(cut);
    expect(out.requirements).toHaveLength(1);
  });

  it("salvages requirements when summary comes after them, and skips unknown keys", () => {
    const full = `{"note": {"a": [1, 2, "x"]}, "count": 3, "ok": true, "requirements": [${JSON.stringify(req("A"))}], "summary": "late"}`;
    const out = salvageSynthesisPrefix(full);
    expect(out.requirements).toHaveLength(1);
    expect(out.summary).toBe("late");
    expect(out.complete).toBe(true);
  });

  it("returns nothing for a reply cut before the array, or with no JSON at all", () => {
    expect(salvageSynthesisPrefix('{"summary": "abc').requirements).toEqual([]);
    expect(salvageSynthesisPrefix('{"summary": "abc').summary).toBeUndefined();
    expect(salvageSynthesisPrefix("").requirements).toEqual([]);
    expect(salvageSynthesisPrefix("no json here").requirements).toEqual([]);
    expect(salvageSynthesisPrefix('{"summary": "a", "requirements": ').requirements).toEqual([]);
    expect(salvageSynthesisPrefix('{"summary": "a", "requirements": "nope"}').requirements).toEqual(
      [],
    );
  });

  it("skips an element that is complete but not valid JSON, keeping its neighbours", () => {
    const raw = `{"summary": "s", "requirements": [${JSON.stringify(req("A"))}, {"title": 'bad'}, ${JSON.stringify(req("C"))}`;
    const out = salvageSynthesisPrefix(raw);
    expect(out.requirements.map((r) => (r as { title: string }).title)).toEqual(["A", "C"]);
  });

  it("stops at a malformed key rather than guessing", () => {
    const out = salvageSynthesisPrefix(
      `{summary: "s", "requirements": [${JSON.stringify(req("A"))}]}`,
    );
    expect(out.requirements).toEqual([]);
  });
});

/**
 * #868 review — the scanner must always make progress. A stray closer of the
 * wrong kind (`}` inside the array, `]` inside the object) used to hit the
 * primitive branch, which returned its own start index, so `scanRequirements`
 * spun forever and pinned the event loop. A synchronous infinite loop cannot be
 * interrupted from inside the same thread, so the cases run in a child process
 * with a hard kill: a regression fails the test instead of hanging the suite.
 */
describe("salvageSynthesisPrefix — unbalanced closers terminate", () => {
  const HANG_CASES = [
    '{"summary":"s","requirements":[{"title":"a"}}',
    '{"requirements":[{"t":1}, }',
    '{"requirements":[}',
    '{"requirements":[ } ]}',
    '{"requirements":[{"t":1},}]}',
    '{"requirements":[{"t":1}}}}}}',
    '{"summary":"s",]',
    '{"summary": ]}',
    '{"summary": }',
    '{"a": , "requirements":[{"t":1}]}',
    '{"requirements":[{"t":1}],]',
    '{"requirements":[[}',
  ];

  it("returns promptly (well under 1 s) for every unbalanced closer", () => {
    const modUrl = new URL("../src/lib/analysis/synthesis-salvage.ts", import.meta.url).href;
    const script = `
      const { salvageSynthesisPrefix } = await import(${JSON.stringify(modUrl)});
      const cases = JSON.parse(process.argv[1]);
      const out = cases.map((c) => {
        const t = performance.now();
        const r = salvageSynthesisPrefix(c);
        return { ms: performance.now() - t, n: r.requirements.length };
      });
      process.stdout.write(JSON.stringify(out));
    `;
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(HANG_CASES)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 8_000,
        killSignal: "SIGKILL",
      },
    );
    // A hang is killed by the timeout: signal SIGKILL, status null.
    expect(res.signal, res.stderr).toBeNull();
    expect(res.status, res.stderr).toBe(0);
    const results = JSON.parse(res.stdout) as { ms: number; n: number }[];
    expect(results).toHaveLength(HANG_CASES.length);
    for (const r of results) expect(r.ms).toBeLessThan(1_000);
  }, 15_000);

  it("keeps the whole elements before a stray closer and never reports complete", () => {
    const a = salvageSynthesisPrefix('{"summary":"s","requirements":[{"title":"a"}}');
    expect(a.requirements).toEqual([{ title: "a" }]);
    expect(a.summary).toBe("s");
    expect(a.complete).toBe(false);
    const b = salvageSynthesisPrefix('{"requirements":[{"t":1}, }');
    expect(b.requirements).toEqual([{ t: 1 }]);
    expect(b.complete).toBe(false);
  });

  it("does not report a missing value as a complete object", () => {
    expect(salvageSynthesisPrefix('{"summary": }').complete).toBe(false);
    expect(salvageSynthesisPrefix('{"a": , "requirements":[{"t":1}]}').complete).toBe(false);
  });
});
