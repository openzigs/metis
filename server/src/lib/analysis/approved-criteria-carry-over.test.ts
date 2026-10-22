import { describe, expect, it } from "vitest";
import {
  KEPT_APPROVED_CRITERIA_REASON,
  REVISED_APPROVED_CRITERIA_REASON,
  planCriteriaCarryOver,
} from "./approved-criteria-carry-over.js";

const APPROVED = ["Installs as a single binary.", "A page renders in under 200 ms."];

describe("planCriteriaCarryOver (#1389)", () => {
  it("keeps the approved criteria when the re-synthesis gave none", () => {
    expect(planCriteriaCarryOver(JSON.stringify(APPROVED), [])).toEqual({
      initial: [],
      final: APPROVED,
      reason: KEPT_APPROVED_CRITERIA_REASON,
    });
  });

  it("takes revised criteria, starting from the approved ones so the change is versioned", () => {
    expect(planCriteriaCarryOver(JSON.stringify(APPROVED), ["Starts in one second."])).toEqual({
      initial: APPROVED,
      final: ["Starts in one second."],
      reason: REVISED_APPROVED_CRITERIA_REASON,
    });
  });

  it("treats a strict subset as a revision, not as a keep", () => {
    expect(planCriteriaCarryOver(JSON.stringify(APPROVED), [APPROVED[0]!]).reason).toBe(
      REVISED_APPROVED_CRITERIA_REASON,
    );
  });

  it("records nothing when the criteria did not change", () => {
    expect(planCriteriaCarryOver(JSON.stringify(APPROVED), [...APPROVED])).toEqual({
      initial: APPROVED,
      final: APPROVED,
      reason: null,
    });
  });

  it("records nothing when there was no earlier row, or it had no criteria", () => {
    for (const approved of [null, "[]", "not json"]) {
      expect(planCriteriaCarryOver(approved, ["New."])).toEqual({
        initial: ["New."],
        final: ["New."],
        reason: null,
      });
      expect(planCriteriaCarryOver(approved, [])).toEqual({ initial: [], final: [], reason: null });
    }
  });

  it("does not alias the caller's array", () => {
    const fresh = ["New."];
    const plan = planCriteriaCarryOver(null, fresh);
    plan.final.push("mutated");
    expect(fresh).toEqual(["New."]);
  });
});
