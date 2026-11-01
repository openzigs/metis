/**
 * #1621 — the portfolio assessment input schema: defaults and refusals.
 */
import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_ASSESSMENT_LIMITS,
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

  // #1647 — the parts of one assessment must agree, and every list is bounded.
  describe("cross-part consistency and size caps", () => {
    const base = {
      statement: "S",
      scope: "all-accessible" as const,
      productIds: ["p1", "p2"],
      createdById: "u",
    };
    const issues = (input: object) => {
      const res = portfolioAssessmentInputSchema.safeParse({ ...base, ...input });
      return res.success ? [] : res.error.issues.map((i) => i.path.join("."));
    };

    it("accepts rows under the products it assessed", () => {
      expect(
        issues({
          products: [{ productId: "p1", coverage: "covers" }],
          repos: [{ productId: "p2", repoConnectionId: "r", verdict: "implemented" }],
        }),
      ).toEqual([]);
    });

    it("refuses a product row or repo verdict under a product it did not assess", () => {
      expect(
        issues({
          products: [
            { productId: "p1", coverage: "covers" },
            { productId: "p9", coverage: "covers" },
          ],
          repos: [{ productId: "p8", repoConnectionId: "r", verdict: "implemented" }],
        }),
      ).toEqual(["products.1.productId", "repos.0.productId"]);
    });

    it("refuses a product-scoped assessment of more than one product", () => {
      expect(issues({ scope: "product" })).toEqual(["productIds"]);
      expect(issues({ scope: "product", productIds: ["p1"] })).toEqual([]);
    });

    it("refuses lists past their caps", () => {
      const many = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
      expect(issues({ productIds: many(PORTFOLIO_ASSESSMENT_LIMITS.products + 1) })).toEqual([
        "productIds",
      ]);
      expect(
        issues({
          repos: Array.from({ length: PORTFOLIO_ASSESSMENT_LIMITS.repos + 1 }, (_, i) => ({
            productId: "p1",
            repoConnectionId: `r${i}`,
            verdict: "implemented",
          })),
        }),
      ).toEqual(["repos"]);
      expect(
        portfolioAssessmentProductInputSchema.safeParse({
          productId: "p",
          coverage: "covers",
          edgeIds: many(2_001),
        }).success,
      ).toBe(false);
      expect(
        portfolioAssessmentRepoInputSchema.safeParse({
          productId: "p",
          repoConnectionId: "r",
          verdict: "implemented",
          citations: Array.from({ length: 501 }, () => ({})),
        }).success,
      ).toBe(false);
    });
  });
});
