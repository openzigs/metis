/**
 * #1621 — the portfolio assessment input schema: defaults and refusals.
 */
import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_ASSESSMENT_LIMITS,
  PORTFOLIO_ASSESSMENT_MAX_PRODUCTS,
  PORTFOLIO_COVERAGES,
  PORTFOLIO_DEGRADED_REASON,
  PORTFOLIO_RESOURCE_GROUPS,
  createPortfolioAssessmentSchema,
  portfolioAssessmentInputSchema,
  portfolioAssessmentProductInputSchema,
  portfolioAssessmentRepoInputSchema,
  portfolioModifierText,
  portfolioNamedInProse,
  portfolioRestrictedNote,
  portfolioRestrictedRule,
  portfolioResourceGroup,
  portfolioResourceLists,
} from "./portfolio-assessment.js";
import { PRODUCT_RESOURCE_KINDS } from "./product-docs.js";

describe("#1689 — product names in prose", () => {
  it("joins the last name with 'and', and caps the list at three, then 'N more'", () => {
    expect(portfolioNamedInProse(["A"])).toBe("A");
    expect(portfolioNamedInProse(["A", "B"])).toBe("A and B");
    expect(portfolioNamedInProse(["A", "B", "C"])).toBe("A, B and C");
    expect(portfolioNamedInProse(["A", "B", "C", "D"])).toBe("A, B, C and 1 more");
    expect(portfolioNamedInProse(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });

  it("counts a nameless product instead of naming it", () => {
    expect(portfolioNamedInProse([null, "Two"])).toBe("Two and 1 more");
    expect(portfolioNamedInProse([null, null, "A", "B", "C"])).toBe("A, B, C and 2 more");
    expect(portfolioNamedInProse([null])).toBe("a product");
    expect(portfolioNamedInProse([null], { sentenceStart: true })).toBe("A product");
    expect(portfolioNamedInProse([null, null, null])).toBe("3 products");
    expect(portfolioNamedInProse([null, null], { sentenceStart: true })).toBe("2 products");
  });
});

describe("#1689 — the rule a run relabelled restricted products by", () => {
  const detail = (restrictedRule: unknown) => ({ impact: { restrictedRule } });

  it("reads the two known rules, and anything else as none recorded", () => {
    expect(portfolioRestrictedRule(detail("walk"))).toBe("walk");
    expect(portfolioRestrictedRule(detail("adjacent"))).toBe("adjacent");
    expect(portfolioRestrictedRule(detail("other"))).toBeNull();
    expect(portfolioRestrictedRule({ impact: {} })).toBeNull();
    expect(portfolioRestrictedRule({})).toBeNull();
    expect(portfolioRestrictedRule(null)).toBeNull();
  });

  it("says why each one is not known, and only the current rule claims a path", () => {
    expect(portfolioRestrictedNote("walk")).toMatch(/^The change may reach it through/);
    expect(portfolioRestrictedNote("adjacent")).toContain("older rule");
    expect(portfolioRestrictedNote("adjacent")).toContain("connected to it");
    expect(portfolioRestrictedNote(null)).toContain("before METIS looked for a connection");
    for (const rule of ["adjacent", null] as const) {
      expect(portfolioRestrictedNote(rule)).not.toContain("may reach it through");
    }
  });
});

describe("#1673 — the wording the page and the export share", () => {
  it("accepts a restricted impact kind on a product row", () => {
    expect(
      portfolioAssessmentProductInputSchema.parse({
        productId: "p",
        coverage: "not-covered",
        impactKind: "restricted",
      }).impactKind,
    ).toBe("restricted");
  });

  it("puts each severity modifier into words, and an unknown one as stored", () => {
    expect(portfolioModifierText({ kind: "breaking-contract" })).toBe(
      "+1 step because the provider's latest contract version made a breaking change",
    );
    expect(portfolioModifierText({ kind: "low-confidence", confidence: 0.4 })).toBe(
      "−1 step for low confidence (0.4)",
    );
    expect(portfolioModifierText({ kind: "low-confidence" })).toBe(
      "−1 step for low confidence (unknown)",
    );
    expect(portfolioModifierText({ kind: "future-kind" })).toBe("future-kind");
  });

  it("gives every resource kind its own heading, and an unknown one a fallback", () => {
    expect(PRODUCT_RESOURCE_KINDS.map((k) => portfolioResourceGroup(k))).toEqual([
      "Databases",
      "Tables and columns",
      "Topics",
      "Identity providers",
      "Buckets",
    ]);
    expect(new Set(Object.values(PORTFOLIO_RESOURCE_GROUPS)).size).toBe(
      PRODUCT_RESOURCE_KINDS.length,
    );
    expect(portfolioResourceGroup("queue")).toBe("Other resources");
  });

  it("groups a hop's resources by kind, not every one under tables (#1673)", () => {
    const orders = {
      schemaName: "public",
      objectName: "orders",
      objectType: "table",
      usageClass: "reads",
    };
    expect(portfolioResourceLists({ kind: "identity-provider", name: "okta" }, [])).toEqual([
      { heading: "Identity providers", items: [{ name: "okta", detail: null }] },
    ]);
    expect(portfolioResourceLists({ kind: "bucket", name: "exports" }, [])[0].heading).toBe(
      "Buckets",
    );
    expect(portfolioResourceLists({ kind: "queue", name: "jobs" }, [])).toEqual([
      { heading: "Other resources", items: [{ name: "jobs", detail: "queue" }] },
    ]);
    // A database resource and the tables both ends use: two lists, databases first.
    expect(portfolioResourceLists({ kind: "database", name: "main" }, [orders])).toEqual([
      { heading: "Databases", items: [{ name: "main", detail: null }] },
      {
        heading: "Tables and columns",
        items: [{ name: "public.orders", detail: "table, reads" }],
      },
    ]);
    // The resource is not listed twice when the classifications already name it.
    expect(portfolioResourceLists({ kind: "table", name: "orders" }, [orders])).toEqual([
      {
        heading: "Tables and columns",
        items: [{ name: "public.orders", detail: "table, reads" }],
      },
    ]);
    expect(portfolioResourceLists(null, [])).toEqual([]);
  });

  it("names every degraded reason the report writes", () => {
    expect(Object.keys(PORTFOLIO_DEGRADED_REASON).sort()).toEqual([
      "model-empty",
      "model-error",
      "model-offline",
      "model-unavailable",
      "model-unparseable",
      "post-check-rejected",
    ]);
  });
});

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
      report: null,
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

    it("#1623 — accepts a downstream product reached outside the scope, and only that", () => {
      expect(
        issues({
          products: [
            { productId: "p1", coverage: "partial", impactKind: "direct-change" },
            { productId: "p9", coverage: "restricted", impactKind: "downstream-consumer" },
          ],
        }),
      ).toEqual([]);
      expect(
        issues({
          products: [{ productId: "p9", coverage: "not-checked", impactKind: "direct-change" }],
        }),
      ).toEqual(["products.0.productId"]);
      // It has no repo verdicts: those stay under the products assessed.
      expect(
        issues({
          products: [
            { productId: "p9", coverage: "not-checked", impactKind: "downstream-consumer" },
          ],
          repos: [{ productId: "p9", repoConnectionId: "r", verdict: "implemented" }],
        }),
      ).toEqual(["repos.0.productId"]);
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

describe("createPortfolioAssessmentSchema (#1625)", () => {
  const ok = (v: unknown) => createPortfolioAssessmentSchema.safeParse(v).success;

  it("takes exactly one of statement and requirementId", () => {
    expect(ok({ statement: "Reset by email", scope: "all-accessible" })).toBe(true);
    expect(ok({ requirementId: "r1", scope: "all-accessible" })).toBe(true);
    expect(ok({ scope: "all-accessible" })).toBe(false);
    expect(ok({ statement: "s", requirementId: "r1", scope: "all-accessible" })).toBe(false);
  });

  it("bounds the statement and the products", () => {
    expect(ok({ statement: " ", scope: "all-accessible" })).toBe(false);
    expect(ok({ statement: "x".repeat(8_001), scope: "all-accessible" })).toBe(false);
    // #1657 — an all-accessible scope names no product: a list it would ignore is refused.
    expect(PORTFOLIO_ASSESSMENT_MAX_PRODUCTS).toBe(1);
    expect(ok({ statement: "s", scope: "all-accessible", productIds: [] })).toBe(true);
    expect(ok({ statement: "s", scope: "all-accessible", productIds: ["p1"] })).toBe(false);
  });

  it('a "product" scope names exactly one product; an unknown field is refused', () => {
    expect(ok({ statement: "s", scope: "product" })).toBe(false);
    expect(ok({ statement: "s", scope: "product", productIds: [] })).toBe(false);
    expect(ok({ statement: "s", scope: "product", productIds: ["p1"] })).toBe(true);
    expect(ok({ statement: "s", scope: "product", productIds: ["p1", "p2"] })).toBe(false);
    expect(ok({ statement: "s", scope: "all-accessible", extra: true })).toBe(false);
    expect(ok({ statement: "s", scope: "everything" })).toBe(false);
  });

  it("#1623 — a host product: any for all-accessible, only its own for a product scope", () => {
    expect(ok({ statement: "s", scope: "all-accessible", hostProductId: "p9" })).toBe(true);
    expect(ok({ statement: "s", scope: "product", productIds: ["p1"], hostProductId: "p1" })).toBe(
      true,
    );
    expect(ok({ statement: "s", scope: "product", productIds: ["p1"], hostProductId: "p2" })).toBe(
      false,
    );
    expect(ok({ statement: "s", scope: "all-accessible", hostProductId: "" })).toBe(false);
  });
});
