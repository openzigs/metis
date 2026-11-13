/**
 * #2236 — what makes two clarifying questions the same question across
 * analyses of a project.
 */
import { describe, expect, it } from "vitest";
import {
  clarificationKey,
  normaliseForKey,
  paragraphSimilarity,
  SAME_PARAGRAPH_THRESHOLD,
  sourceSlot,
  specKitClarificationKey,
} from "./clarification-key.js";

const citation = {
  documentId: "doc-1",
  headingPath: ["4 Accounts", "4.2 Passwords"],
  quote: "Passwords must be at least 8 characters.",
};

describe("#2236 — clarificationKey", () => {
  it("normalises case, punctuation and whitespace", () => {
    expect(normaliseForKey("  Does  'customer' mean…  the HOLDER? ")).toBe(
      "does customer mean the holder",
    );
    expect(normaliseForKey(undefined)).toBe("");
  });

  it("keys a cited question on its paragraph and field, not the model's wording", () => {
    const a = clarificationKey({
      question: "How long must a password be?",
      ambiguityField: "length",
      citation,
    });
    const b = clarificationKey({
      question: "What is the minimum password length?",
      ambiguityField: "Length",
      requirementTitle: "Another title entirely",
      citation: { ...citation, quote: "passwords must be at least 8 characters" },
    });
    expect(a).toBe(b);
    // A different field of the same paragraph is a different question.
    expect(clarificationKey({ question: "x", ambiguityField: "charset", citation })).not.toBe(a);
  });

  it("changes the key when the paragraph changes", () => {
    const before = clarificationKey({ question: "q", ambiguityField: "length", citation });
    const after = clarificationKey({
      question: "q",
      ambiguityField: "length",
      citation: { ...citation, quote: "Passwords must be at least 12 characters." },
    });
    expect(after).not.toBe(before);
  });

  it("keys an uncited question on its requirement title and field", () => {
    const a = clarificationKey({
      question: "Q one?",
      ambiguityField: "scope",
      requirementTitle: "Export orders",
    });
    const b = clarificationKey({
      question: "Q two?",
      ambiguityField: "scope",
      requirementTitle: "export ORDERS",
    });
    expect(a).toBe(b);
    expect(
      clarificationKey({
        question: "Q one?",
        ambiguityField: "scope",
        requirementTitle: "Import orders",
      }),
    ).not.toBe(a);
  });

  it("#2310 — keys an uncited question within its analysis: same-titled requirements elsewhere do not share it", () => {
    const asked = (analysisId: string, question = "Q one?") =>
      clarificationKey({
        question,
        ambiguityField: "scope",
        requirementTitle: "Export orders",
        analysisId,
      });
    expect(asked("a1")).toBe(asked("a1", "Q two?"));
    expect(asked("a2")).not.toBe(asked("a1"));
    // No title either: the question, within the analysis.
    const bare = (analysisId: string) =>
      clarificationKey({ question: "Which orders?", analysisId });
    expect(bare("a2")).not.toBe(bare("a1"));
    // A cited question is still the paragraph's, whichever analysis asked it.
    const cited = (analysisId: string) =>
      clarificationKey({
        question: "Q?",
        ambiguityField: "scope",
        requirementTitle: "Export orders",
        analysisId,
        citation: { headingPath: [], quote: "Orders are exported nightly." },
      });
    expect(cited("a2")).toBe(cited("a1"));
  });

  it("keys a governing question on its rules (in any order) and its question", () => {
    const a = clarificationKey({
      question: "Will cards be exported?",
      governing: { ruleIds: ["r2", "r1"] },
    });
    const b = clarificationKey({
      question: "will cards be exported",
      governing: { ruleIds: ["r1", "r2"] },
    });
    expect(a).toBe(b);
    expect(
      clarificationKey({ question: "Will cards be exported?", governing: { ruleIds: ["r1"] } }),
    ).not.toBe(a);
  });

  it("falls back to the question when there is nothing better", () => {
    expect(clarificationKey({ question: "Who approves?" })).toBe(
      clarificationKey({ question: "who approves" }),
    );
  });

  it("keys a Spec Kit question on its feature and question", () => {
    expect(clarificationKey({ question: "Q?", specKitFeature: "001-x" })).toBe(
      specKitClarificationKey("001-x", "q"),
    );
    expect(specKitClarificationKey(null, "Q?")).not.toBe(specKitClarificationKey("001-x", "Q?"));
  });
});

describe("#2236 — sourceSlot", () => {
  it("is the same for a changed paragraph in the same place, and null without a document", () => {
    const slot = sourceSlot({ citation, ambiguityField: "length" });
    expect(slot).not.toBeNull();
    expect(
      sourceSlot({ citation: { ...citation, quote: "changed" }, ambiguityField: "length" }),
    ).toBe(slot);
    expect(sourceSlot({ citation, ambiguityField: "charset" })).not.toBe(slot);
    expect(
      sourceSlot({ citation: { ...citation, documentId: undefined }, ambiguityField: "x" }),
    ).toBeNull();
    expect(sourceSlot({ ambiguityField: "x" })).toBeNull();
  });
});

describe("#2236 — paragraphSimilarity", () => {
  it("reads an edited paragraph as the same one and a sibling paragraph as another", () => {
    const original = "Passwords must be long enough for customer accounts.";
    expect(
      paragraphSimilarity(
        original,
        "Passwords must be long enough for customer accounts, or use a passkey.",
      ),
    ).toBeGreaterThanOrEqual(SAME_PARAGRAPH_THRESHOLD);
    expect(
      paragraphSimilarity(original, "Service accounts rotate their credentials every quarter."),
    ).toBeLessThan(SAME_PARAGRAPH_THRESHOLD);
    expect(paragraphSimilarity("", original)).toBe(0);
    expect(paragraphSimilarity(original, original)).toBe(1);
  });
});
