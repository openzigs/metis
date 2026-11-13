/**
 * #2436 — `PATCH /api/projects/:id/review-gate` carries the approval gate, the
 * self-approval switch, or both; never neither, and never an unknown key.
 */
import { describe, expect, it } from "vitest";
import { reviewGateConfigSchema } from "../src/publishing.js";

describe("reviewGateConfigSchema (#2436)", () => {
  it("accepts either setting alone, or both", () => {
    for (const body of [
      { requireApprovedReview: true },
      { allowSelfApproval: false },
      { requireApprovedReview: false, allowSelfApproval: true },
    ]) {
      expect(reviewGateConfigSchema.parse(body)).toEqual(body);
    }
  });

  it("refuses an empty body, an unknown key and a non-boolean", () => {
    for (const body of [{}, { allowSelfApprovals: true }, { allowSelfApproval: "yes" }]) {
      expect(reviewGateConfigSchema.safeParse(body).success).toBe(false);
    }
  });
});
