/**
 * #1097 — the absolute link confidence, the plural rule fix folded in from the
 * review of PR #1227, and the relative floor kept for searchers that report no
 * confidence.
 */
import { describe, expect, it } from "vitest";
import {
  COSINE_CALIBRATED_MODELS,
  LEXICAL_CONFIDENCE_MODEL,
  RELATIVE_MIN_CONFIDENCE,
  linkConfidence,
  mapRequirementToCode,
  sameWord,
  sharedNameTermCount,
  singularForms,
  type CodeSymbolCandidate,
  type CodeSymbolSearcher,
} from "./requirement-code-mapping.js";

describe("singularForms — '-es' only where English writes it (review of PR #1227)", () => {
  it.each([
    ["notes", "not"],
    ["ones", "on"],
    ["news", "new"],
    ["uses", "use"],
    ["sets", "set"],
  ])("%s is not the word %s", (plural, word) => {
    expect(singularForms(plural)).not.toContain(word);
    expect(sameWord(plural, word)).toBe(false);
  });

  it.each([
    ["statuses", "status"],
    ["boxes", "box"],
    ["quizzes", "quizz"],
    ["matches", "match"],
    ["wishes", "wish"],
    ["notes", "note"],
    ["users", "user"],
    ["entries", "entry"],
  ])("%s is still the word %s", (plural, word) => {
    expect(sameWord(plural, word)).toBe(true);
  });

  it("keeps a long stopword as a form: the subject rules read `users` as the stopword `user`", () => {
    expect(singularForms("users")).toEqual(["users", "user"]);
    expect(singularForms("settings")).toEqual(["settings", "setting"]);
  });
});

describe("linkConfidence — absolute, from the link's own evidence", () => {
  it("rises with every shared word, and stops counting after three", () => {
    const at = (n: number) => linkConfidence({ sharedNameTerms: n });
    expect(at(0)).toBeLessThan(at(1));
    expect(at(1)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(3));
    expect(at(4)).toBe(at(3));
    expect(at(-1)).toBe(at(0));
  });

  it("is the logistic of the committed lexical model", () => {
    const m = LEXICAL_CONFIDENCE_MODEL;
    const expected = 1 / (1 + Math.exp(-(m.intercept + m.perSharedTerm * 2)));
    expect(linkConfidence({ sharedNameTerms: 2 })).toBeCloseTo(expected, 3);
  });

  it("rises with the cosine when one is given, and ignores a missing or non-finite one", () => {
    const near = linkConfidence({ sharedNameTerms: 1, cosine: 0.7 });
    const far = linkConfidence({ sharedNameTerms: 1, cosine: 0.55 });
    expect(near).toBeGreaterThan(far);
    expect(linkConfidence({ sharedNameTerms: 1, cosine: null })).toBe(
      linkConfidence({ sharedNameTerms: 1 }),
    );
    expect(linkConfidence({ sharedNameTerms: 1, cosine: Number.NaN })).toBe(
      linkConfidence({ sharedNameTerms: 1 }),
    );
  });

  it("stays in (0, 1) and is rounded to three decimals", () => {
    for (const shared of [0, 1, 2, 3]) {
      for (const cosine of [0, 0.5, 0.8, 1]) {
        const c = linkConfidence({ sharedNameTerms: shared, cosine });
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        expect(Math.round(c * 1000) / 1000).toBe(c);
      }
    }
  });

  it("is calibrated on the default embedding model", () => {
    expect(COSINE_CALIBRATED_MODELS.has("Alibaba-NLP/gte-modernbert-base")).toBe(true);
  });
});

describe("sharedNameTermCount", () => {
  it("counts distinct query words the name uses, singular or plural", () => {
    const forms = new Set(["flush", "all", "sessions", "session"]);
    expect(sharedNameTermCount(forms, ["terminate", "sessions", "session", "button"])).toBe(2);
    expect(sharedNameTermCount(forms, ["sessions", "sessions"])).toBe(1);
    expect(sharedNameTermCount(forms, [])).toBe(0);
  });
});

describe("mapRequirementToCode — a searcher with no confidence keeps the relative scale", () => {
  const searcher = (cands: Array<Omit<CodeSymbolCandidate, "filePath" | "name" | "kind">>) =>
    ({
      async search() {
        return cands.map((c) => ({ ...c, filePath: "a.ts", name: "x", kind: "function" }));
      },
    }) as CodeSymbolSearcher;

  it("normalizes to the best hit and applies the pre-#1097 relative floor", async () => {
    const matches = await mapRequirementToCode(
      { id: "r", title: "anything", body: "" },
      "p",
      {},
      {
        searcher: searcher([
          { symbolId: "a", qualifiedName: "a", score: 10 },
          { symbolId: "b", qualifiedName: "b", score: 2 }, // 0.2 of the best: under 0.3
        ]),
      },
    );
    expect(matches.map((m) => [m.codeSymbolId, m.confidence])).toEqual([["a", 1]]);
    expect(RELATIVE_MIN_CONFIDENCE).toBe(0.3);
  });

  it("is absolute only when EVERY candidate carries a confidence", async () => {
    const matches = await mapRequirementToCode(
      { id: "r", title: "anything", body: "" },
      "p",
      {},
      {
        searcher: searcher([
          { symbolId: "a", qualifiedName: "a", score: 10, confidence: 0.2 },
          { symbolId: "b", qualifiedName: "b", score: 5 },
        ]),
      },
    );
    expect(matches.map((m) => m.confidence)).toEqual([1, 0.5]);
  });
});
