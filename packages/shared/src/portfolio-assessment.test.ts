/**
 * #1621 — the portfolio assessment input schema: defaults and refusals.
 */
import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_COVERAGES,
  portfolioAssessmentInputSchema,
  portfolioAssessmentProductInputSchema,
  portfolioAssessmentRepoInputSchema,
} from "./portfolio-assessment.js";

describe("portfolio assessment schemas", () => {
  it("fills the defaults an engine may leave out", () => {
    expect(
      portfolioAssessmentInputSchema.parse({
        statement: "  Export invoices  ",
        scope: "product",
        productIds: ["p"],
        createdById: "u",
      }),
    ).toEqual({
      statement: "Export invoices",
      sourceRequirementId: null,
      sourceProjectId: null,
      scope: "product",
      productIds: ["p"],
      status: "pending",
      portfolioVerdict: null,
      summary: "",
      costUsd: 0,
      createdById: "u",
      products: [],
      repos: [],
    });
    expect(
      portfolioAssessmentProductInputSchema.parse({ productId: "p", coverage: "covers" }),
    ).toEqual({
      productId: "p",
      coverage: "covers",
      impactKind: "none",
      via: null,
      edgeIds: [],
      severity: null,
      baSummary: "",
      technicalDetail: {},
    });
    expect(
      portfolioAssessmentRepoInputSchema.parse({
        productId: "p",
        repoConnectionId: "r",
        verdict: "partial",
      }),
    ).toEqual({ productId: "p", repoConnectionId: "r", verdict: "partial", citations: [] });
  });

  it("refuses values outside the vocabularies and unknown keys", () => {
    expect(PORTFOLIO_COVERAGES).toContain("restricted");
    for (const bad of [
      { productId: "p", coverage: "mostly" },
      { productId: "p", coverage: "covers", impactKind: "sideways" },
      { productId: "p", coverage: "covers", extra: 1 },
    ]) {
      expect(portfolioAssessmentProductInputSchema.safeParse(bad).success).toBe(false);
    }
    expect(
      portfolioAssessmentRepoInputSchema.safeParse({
        productId: "p",
        repoConnectionId: "r",
        verdict: "probably",
      }).success,
    ).toBe(false);
  });
});
