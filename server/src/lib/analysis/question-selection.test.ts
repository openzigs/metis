/**
 * #2235 — the deterministic selection of which clarifying questions a round asks.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_QUESTIONS_PER_ROUND,
  citationFor,
  selectQuestionsToAsk,
  type GeneratedQuestion,
} from "./question-selection.js";
import type { StructuredRequirement } from "./types/requirements.js";

let n = 0;
const q = (
  requirementId: string,
  ambiguityField: string,
  extra: Partial<GeneratedQuestion> = {},
): GeneratedQuestion => ({
  id: `q${++n}`,
  requirementId,
  ambiguityField,
  question: `${requirementId} ${ambiguityField}?`,
  context: "",
  ...extra,
});

describe("selectQuestionsToAsk (#2235)", () => {
  it("leads with the ticked items, then ranks by impact, then by the requirement's priority", () => {
    const priorities: Record<string, StructuredRequirement["priority"]> = {
      must: "must-have",
      nice: "nice-to-have",
    };
    const { ask } = selectQuestionsToAsk(
      [
        q("nice", "a", { impact: "high" }),
        q("must", "b", { impact: "high" }),
        q("other", "c", { impact: "low" }),
        q("ticked", "d", { impact: "low" }),
        q("other", "e"),
      ],
      { askFirst: new Set(["ticked"]), priorityOf: (id) => priorities[id] },
    );
    expect(ask.map((x) => x.ambiguityField)).toEqual(["d", "b", "a", "e", "c"]);
  });

  it("keeps the generated order when nothing tells the questions apart", () => {
    const { ask } = selectQuestionsToAsk([q("r", "a"), q("r", "b"), q("r", "c")]);
    expect(ask.map((x) => x.ambiguityField)).toEqual(["a", "b", "c"]);
  });

  it("asks one question per ambiguity", () => {
    const { ask, setAside } = selectQuestionsToAsk([
      q("r", "a"),
      q("r", "a", { uncertainty: "unanswerable" }),
      q("r", "", {}),
      q("r", "", {}),
    ]);
    expect(ask).toHaveLength(3);
    expect(setAside).toEqual([]);
  });

  it("sets aside only an explicit `divergent: false`, keeping the readings and citation", () => {
    const citation = { headingPath: ["2"], quote: "Q" };
    const { ask, setAside } = selectQuestionsToAsk([
      q("r", "a", { divergent: false, options: ["x", "y"], citation }),
      q("r", "b", { divergent: true }),
      q("r", "c"),
    ]);
    expect(ask.map((x) => x.ambiguityField)).toEqual(["b", "c"]);
    expect(setAside).toEqual([
      {
        requirementId: "r",
        ambiguityField: "a",
        question: "r a?",
        context: "",
        reason: "same-outcome",
        options: ["x", "y"],
        citation,
      },
    ]);
  });

  it("caps the round at MAX_QUESTIONS_PER_ROUND and returns the rest as not asked", () => {
    const all = Array.from({ length: MAX_QUESTIONS_PER_ROUND + 2 }, (_, i) => q("r", `f${i}`));
    const { ask, notAsked } = selectQuestionsToAsk(all);
    expect(ask).toHaveLength(MAX_QUESTIONS_PER_ROUND);
    expect(notAsked.map((x) => x.ambiguityField)).toEqual([
      `f${MAX_QUESTIONS_PER_ROUND}`,
      `f${MAX_QUESTIONS_PER_ROUND + 1}`,
    ]);
    expect(selectQuestionsToAsk(all, { cap: 1 }).ask).toHaveLength(1);
  });
});

describe("citationFor (#2235)", () => {
  const sources = [
    { ref: "REQ-001", headingPath: ["1"], quote: "Orders are listed." },
    { ref: "REQ-002", filename: "f.docx", headingPath: ["2"], quote: "Lists load\nFAST." },
  ];
  const req = {
    sources,
    ambiguities: [
      { field: "R7:fast", description: "", suggestedQuestion: "", term: "fast" },
      { field: "scope", description: "", suggestedQuestion: "" },
    ],
  };

  it("cites the paragraph that holds a flagged term", () => {
    expect(citationFor(req, "R7:fast")).toEqual({
      filename: "f.docx",
      headingPath: ["2"],
      quote: "Lists load\nFAST.",
    });
  });

  it("matches the flagged term as a whole word, not inside another word", () => {
    const r = {
      sources: [
        { ref: "A", headingPath: ["1"], quote: "Served at breakfast." },
        { ref: "B", headingPath: ["2"], quote: "Pages load fast." },
      ],
      ambiguities: [{ field: "R7:fast", description: "", suggestedQuestion: "", term: "fast" }],
    };
    expect(citationFor(r, "R7:fast")?.quote).toBe("Pages load fast.");
  });

  it("cites the first paragraph for any other ambiguity", () => {
    expect(citationFor(req, "scope")).toEqual({ headingPath: ["1"], quote: "Orders are listed." });
  });

  it("cites nothing for a requirement with no verified source", () => {
    expect(citationFor({ ambiguities: [] }, "scope")).toBeUndefined();
    expect(citationFor(undefined, "scope")).toBeUndefined();
  });
});
