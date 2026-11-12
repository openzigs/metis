import { describe, expect, it } from "vitest";
import { openQuestionCount } from "./analysis-open-questions.js";

const on = { enhancement: { enableClarification: true, enableWebResearch: false } };

describe("openQuestionCount (#2348)", () => {
  it("is the remaining ambiguity count of a run that asked for clarification", () => {
    expect(openQuestionCount({ ...on, structuredRequirements: { totalAmbiguities: 12 } })).toBe(12);
  });

  it("is 0 when clarification ran and nothing is left or nothing was stored", () => {
    expect(openQuestionCount({ ...on, structuredRequirements: { totalAmbiguities: 0 } })).toBe(0);
    expect(openQuestionCount(on)).toBe(0);
    expect(openQuestionCount({ ...on, structuredRequirements: { totalAmbiguities: "3" } })).toBe(0);
  });

  it("has no count when clarification was not asked for", () => {
    expect(
      openQuestionCount({
        enhancement: { enableClarification: false },
        structuredRequirements: { totalAmbiguities: 4 },
      }),
    ).toBeUndefined();
    expect(openQuestionCount({ structuredRequirements: { totalAmbiguities: 4 } })).toBeUndefined();
  });

  it("has no count when structured extraction failed (#1081)", () => {
    expect(
      openQuestionCount({
        ...on,
        structuredExtractionFailure: { reason: "unparseable", at: "x" },
        structuredRequirements: { totalAmbiguities: 4 },
      }),
    ).toBeUndefined();
  });

  it("has no count for missing or non-object metadata", () => {
    expect(openQuestionCount(null)).toBeUndefined();
    expect(openQuestionCount(undefined)).toBeUndefined();
    expect(openQuestionCount("{}")).toBeUndefined();
  });
});
