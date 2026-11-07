import { describe, expect, it } from "vitest";
import {
  BORROW_CITATIONS_MAX_MAPPING_IDS,
  borrowCitationsSchema,
  SIMILAR_REQUIREMENTS_DEFAULT_LIMIT,
  SIMILAR_REQUIREMENTS_MAX_TEXT,
  similarRequirementsDraftSchema,
  similarRequirementsLimitSchema,
} from "./similar-requirements.js";

describe("similar requirements request schemas (#1837)", () => {
  it("accepts draft text with criteria and a limit", () => {
    expect(
      similarRequirementsDraftSchema.parse({
        text: "  Export invoices  ",
        acceptanceCriteria: ["CSV"],
        limit: "3",
      }),
    ).toEqual({ text: "Export invoices", acceptanceCriteria: ["CSV"], limit: 3 });
  });

  it.each([
    ["empty text", { text: "   " }],
    ["oversized text", { text: "x".repeat(SIMILAR_REQUIREMENTS_MAX_TEXT + 1) }],
    ["too many criteria", { text: "t", acceptanceCriteria: Array(31).fill("c") }],
    ["an unknown field", { text: "t", other: 1 }],
    ["a limit past the cap", { text: "t", limit: 21 }],
  ])("refuses %s", (_name, body) => {
    expect(similarRequirementsDraftSchema.safeParse(body).success).toBe(false);
  });

  it("defaults the limit", () => {
    expect(similarRequirementsLimitSchema.parse(undefined)).toBe(
      SIMILAR_REQUIREMENTS_DEFAULT_LIMIT,
    );
    expect(similarRequirementsLimitSchema.safeParse("0").success).toBe(false);
  });
});

describe("borrow-citations request schema (#1839)", () => {
  it("accepts an origin id, with or without a subset of its links", () => {
    expect(borrowCitationsSchema.parse({ fromRequirementId: " req_1 " })).toEqual({
      fromRequirementId: "req_1",
    });
    expect(
      borrowCitationsSchema.parse({ fromRequirementId: "req-1", mappingIds: ["m1", "m2"] }),
    ).toEqual({ fromRequirementId: "req-1", mappingIds: ["m1", "m2"] });
  });

  it.each([
    ["no origin", {}],
    ["an empty origin", { fromRequirementId: "" }],
    ["an origin that is not an id", { fromRequirementId: "a'; DROP TABLE x;--" }],
    ["an empty subset", { fromRequirementId: "r", mappingIds: [] }],
    [
      "too many mapping ids",
      {
        fromRequirementId: "r",
        mappingIds: Array.from({ length: BORROW_CITATIONS_MAX_MAPPING_IDS + 1 }, (_, i) => `m${i}`),
      },
    ],
    ["an unknown key", { fromRequirementId: "r", source: "analysis-grounding" }],
  ])("rejects %s", (_label, body) => {
    expect(borrowCitationsSchema.safeParse(body).success).toBe(false);
  });
});
