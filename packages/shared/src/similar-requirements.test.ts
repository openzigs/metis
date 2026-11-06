import { describe, expect, it } from "vitest";
import {
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
