/**
 * Issue #769 — the sentence a user reads when a re-synthesis was NOT allowed to
 * replace the analysis's requirement set. It must say the existing set was kept
 * (nothing was lost) and why, so a Regenerate that "did nothing" is explained.
 */
import { describe, expect, it } from "vitest";
import {
  describeRequirementReplacementWithheld,
  type RequirementReplacementWithheld,
} from "./analysis.js";

function withheld(
  overrides: Partial<RequirementReplacementWithheld> = {},
): RequirementReplacementWithheld {
  return {
    reason: "reviewed-work",
    existingCount: 25,
    reviewedCount: 3,
    proposedCount: 30,
    at: "2026-10-02T00:37:14.000Z",
    ...overrides,
  };
}

describe("describeRequirementReplacementWithheld", () => {
  it("says the reviewed set was kept, how much review work protected it, and what was discarded", () => {
    const message = describeRequirementReplacementWithheld(withheld());
    expect(message).toContain("kept the existing 25 requirements");
    expect(message).toContain("3 of them carry review work");
    expect(message).toContain("30 newly synthesized requirements were not applied");
  });

  it("singularises one reviewed requirement and one proposed requirement", () => {
    const message = describeRequirementReplacementWithheld(
      withheld({ existingCount: 1, reviewedCount: 1, proposedCount: 1 }),
    );
    expect(message).toContain("kept the existing 1 requirement ");
    expect(message).toContain("1 of them carries review work");
    expect(message).toContain("1 newly synthesized requirement was not applied");
  });

  it("explains a degraded synthesis was refused rather than allowed to overwrite a good set", () => {
    const message = describeRequirementReplacementWithheld(
      withheld({ reason: "degraded-synthesis", reviewedCount: 0 }),
    );
    expect(message).toContain("degraded");
    expect(message).toContain("kept the existing 25 requirements");
    expect(message).not.toContain("review work");
  });
});
