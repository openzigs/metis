import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CRITERIA_MAX_ITEMS,
  ACCEPTANCE_CRITERION_MAX_LENGTH,
  capAcceptanceCriteria,
} from "../src/acceptance-criteria-fallback.js";

describe("#990 — capAcceptanceCriteria fits a list to the PUT bounds", () => {
  it("leaves a list within the bounds untouched", () => {
    expect(capAcceptanceCriteria(["one", "two"])).toEqual({
      criteria: ["one", "two"],
      trimmed: false,
    });
  });

  it("drops items past the maximum and reports it", () => {
    const list = Array.from({ length: ACCEPTANCE_CRITERIA_MAX_ITEMS + 1 }, (_, i) => `c${i}`);
    const { criteria, trimmed } = capAcceptanceCriteria(list);
    expect(criteria).toEqual(list.slice(0, ACCEPTANCE_CRITERIA_MAX_ITEMS));
    expect(trimmed).toBe(true);
  });

  it("shortens an over-long item and reports it", () => {
    const { criteria, trimmed } = capAcceptanceCriteria([
      "x".repeat(ACCEPTANCE_CRITERION_MAX_LENGTH + 1),
    ]);
    expect(criteria[0]).toHaveLength(ACCEPTANCE_CRITERION_MAX_LENGTH);
    expect(trimmed).toBe(true);
  });

  it("an item of exactly the maximum length is not trimmed", () => {
    const exact = "x".repeat(ACCEPTANCE_CRITERION_MAX_LENGTH);
    expect(capAcceptanceCriteria([exact])).toEqual({ criteria: [exact], trimmed: false });
  });
});
