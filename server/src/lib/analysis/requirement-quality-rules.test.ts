/**
 * #2235 — the deterministic GtWR lexical rules run over a requirement's source
 * text before any model is asked about it.
 */
import { describe, expect, it } from "vitest";
import {
  QUALITY_RULES,
  findQualityFlags,
  qualityFlagAmbiguities,
  qualityFlagField,
} from "./requirement-quality-rules.js";

describe("findQualityFlags (#2235)", () => {
  it("flags a vague term (GtWR R7) with its offsets in the source", () => {
    const text = "The search page shall load fast for every customer.";
    const flags = findQualityFlags(text);
    expect(flags).toEqual([
      {
        rule: "R7",
        term: "fast",
        start: text.indexOf("fast"),
        end: text.indexOf("fast") + 4,
      },
    ]);
    expect(text.slice(flags[0]!.start, flags[0]!.end)).toBe("fast");
  });

  it("flags an escape clause (R8), an open-ended clause (R9) and a TBD placeholder", () => {
    const text = "Where possible the export shall include name, address, etc. The limit is TBD.";
    const rules = findQualityFlags(text).map((f) => `${f.rule}:${f.term}`);
    expect(rules).toEqual(["R8:Where possible", "R9:etc.", "TBD:TBD"]);
  });

  it("matches a multi-word phrase across line breaks and keeps the source's own words", () => {
    const text = "Reports, including but not\nlimited to sales, shall be kept.";
    const [flag] = findQualityFlags(text);
    expect(flag?.rule).toBe("R9");
    expect(flag?.term).toBe("including but not\nlimited to");
  });

  it("matches whole words only", () => {
    // "fastest", "breakfast" and "someone" contain a listed term but are not it.
    expect(findQualityFlags("The fastest breakfast for someone.")).toEqual([]);
  });

  it("reports a repeated term once per rule", () => {
    const flags = findQualityFlags("It must be fast. Search must be fast too. FAST.");
    expect(flags).toHaveLength(1);
  });

  it("prefers the longest phrase at a position", () => {
    // "as much as possible" (R8) and "possible" are not both reported.
    const flags = findQualityFlags("Cache as much as possible.");
    expect(flags.map((f) => f.term)).toEqual(["as much as possible"]);
  });

  it("returns nothing for clean or empty text", () => {
    expect(findQualityFlags("")).toEqual([]);
    expect(findQualityFlags("The system shall lock an account after 5 failed sign-ins.")).toEqual(
      [],
    );
  });

  it("orders flags by their position in the source", () => {
    const flags = findQualityFlags("TBD: the page shall be user-friendly, if necessary.");
    expect(flags.map((f) => f.rule)).toEqual(["TBD", "R7", "R8"]);
  });

  it("skips a match that Unicode case folding made but no listed phrase is", () => {
    // The `iu` flags let "ſ" (long s) match "s", but "ſome" is not the phrase "some".
    expect(findQualityFlags("ſome orders")).toEqual([]);
  });
});

describe("qualityFlagAmbiguities (#2235)", () => {
  it("turns each flag into an ambiguity naming its rule and characteristic", () => {
    const [a] = qualityFlagAmbiguities(findQualityFlags("Search shall be fast."));
    expect(a).toMatchObject({ field: "R7:fast", rule: "R7", term: "fast", suggestedQuestion: "" });
    expect(a?.description).toContain('"fast"');
    expect(a?.description).toContain("INCOSE GtWR R7");
    expect(a?.description).toContain("§5.2.5");
  });

  it("credits a placeholder to ISO/IEC/IEEE 29148, not to a GtWR rule", () => {
    const [a] = qualityFlagAmbiguities(findQualityFlags("The limit is to be\nconfirmed."));
    expect(a).toMatchObject({ field: "TBD:to be confirmed", term: "to be confirmed" });
    expect(a?.description).toContain('Placeholder "to be confirmed" (ISO/IEC/IEEE 29148)');
    expect(a?.description).not.toContain("GtWR");
  });

  it("names the field by rule and lower-cased term, so it is stable across rounds", () => {
    expect(qualityFlagField({ rule: "R8", term: "If  Necessary" })).toBe("R8:if necessary");
  });

  it("describes every rule it can raise", () => {
    for (const rule of Object.values(QUALITY_RULES)) {
      expect(rule.label.length).toBeGreaterThan(0);
      expect(rule.characteristics.length).toBeGreaterThan(0);
    }
  });
});
