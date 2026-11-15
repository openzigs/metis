/**
 * #2235 — the deterministic selection of which clarifying questions a round asks.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_QUESTIONS_PER_ROUND,
  QUESTION_CANDIDATES_PER_ROUND,
  ambiguitiesToQuestion,
  citationFor,
  holdsWord,
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

describe("holdsWord (#2235)", () => {
  it("matches a whole word, in any script, and not inside another word", () => {
    expect(holdsWord("pages load fast.", "fast")).toBe(true);
    expect(holdsWord("fast", "fast")).toBe(true);
    expect(holdsWord("served at breakfast.", "fast")).toBe(false);
    expect(holdsWord("fastest route", "fast")).toBe(false);
    expect(holdsWord("breakfast, then fast", "fast")).toBe(true);
    expect(holdsWord("schnellste schnell", "schnell")).toBe(true);
    expect(holdsWord("éfast", "fast")).toBe(false);
    expect(holdsWord("\u{1F600}fast", "fast")).toBe(true);
    expect(holdsWord("\u{1D400}fast", "fast")).toBe(false);
    expect(holdsWord("fast2", "fast")).toBe(false);
    expect(holdsWord("anything", "")).toBe(false);
  });

  it("treats the term as text, not a pattern", () => {
    expect(holdsWord("costs 5 (approx.) now", "(approx.)")).toBe(true);
    expect(holdsWord("costs 5 xapproxy now", "(approx.)")).toBe(false);
    expect(holdsWord("a".repeat(50_000) + "!", "a*a*a*b")).toBe(false);
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

describe("ambiguitiesToQuestion (#2534)", () => {
  const req = (
    id: string,
    fields: string[],
    priority: StructuredRequirement["priority"] = "should-have",
  ) => ({
    id,
    priority,
    ambiguities: fields.map((field) => ({ field, description: "", suggestedQuestion: "" })),
  });

  it("chooses every open ambiguity when there are fewer than the cap", () => {
    const chosen = ambiguitiesToQuestion([req("r1", ["a", "b"]), req("r2", ["c"])], new Set());
    expect([...chosen]).toEqual(["r1:a", "r2:c", "r1:b"]);
  });

  it("chooses at most QUESTION_CANDIDATES_PER_ROUND of hundreds, three times the round's cap", () => {
    expect(QUESTION_CANDIDATES_PER_ROUND).toBe(3 * MAX_QUESTIONS_PER_ROUND);
    // The size of the clinic-booking FRD: 61 requirements, 243 open ambiguities.
    const many = Array.from({ length: 61 }, (_, i) => req(`r${i}`, ["a", "b", "c", "d"]));
    const chosen = ambiguitiesToQuestion(many, new Set());
    expect(chosen.size).toBe(QUESTION_CANDIDATES_PER_ROUND);
    // One per requirement, in document order, before any requirement's second.
    expect([...chosen]).toEqual(
      Array.from({ length: QUESTION_CANDIDATES_PER_ROUND }, (_, i) => `r${i}:a`),
    );
  });

  it("takes each requirement's next ambiguity in turn once each has given one", () => {
    const chosen = ambiguitiesToQuestion(
      [req("r1", ["a", "b", "c"]), req("r2", ["d"]), req("r3", ["e", "f"])],
      new Set(),
      { cap: 5 },
    );
    expect([...chosen]).toEqual(["r1:a", "r2:d", "r3:e", "r1:b", "r3:f"]);
  });

  it("leads with the ticked items, then ranks by priority, then by document order", () => {
    const chosen = ambiguitiesToQuestion(
      [
        req("nice", ["a"], "nice-to-have"),
        req("should", ["a"]),
        req("must", ["a"], "must-have"),
        req("ticked", ["a"], "nice-to-have"),
        // A priority the model made up ranks as should-have.
        req("odd", ["a"], "urgent" as StructuredRequirement["priority"]),
      ],
      new Set(),
      { askFirst: new Set(["ticked"]) },
    );
    expect([...chosen]).toEqual(["ticked:a", "must:a", "should:a", "odd:a", "nice:a"]);
  });

  it("never chooses an addressed ambiguity, and moves on to what is still open", () => {
    const chosen = ambiguitiesToQuestion(
      [req("r1", ["a", "b"]), req("r2", ["a", "a"])],
      new Set(["r1:a", "r2:a"]),
    );
    // #2451 — the second "a" of r2 has its own key.
    expect([...chosen]).toEqual(["r1:b", "r2:a#2"]);
  });

  it("chooses nothing when nothing is open", () => {
    expect(ambiguitiesToQuestion([req("r1", ["a"])], new Set(["r1:a"])).size).toBe(0);
    expect(ambiguitiesToQuestion([], new Set()).size).toBe(0);
  });
});
