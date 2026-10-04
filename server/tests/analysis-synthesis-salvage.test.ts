/**
 * #751 — salvage the complete prefix of a synthesis reply that was cut off at
 * the output cap. The parser is structural: it must not be fooled by braces,
 * brackets or the word "requirements" inside string values, and it must never
 * return the element that was being written when the cap fired.
 */
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
