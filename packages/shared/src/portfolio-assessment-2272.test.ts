/**
 * #2272 — what a portfolio check did not check, the requirements it checked,
 * and the impact tiers: the wording and rules the page and the export share.
 */
import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_IMPACT_TIERS,
  PORTFOLIO_IMPACT_TIER_LABEL,
  PORTFOLIO_LIKELY_CONFIDENCE,
  PORTFOLIO_MAX_REQUIREMENTS,
  PORTFOLIO_VERIFIED_CONFIDENCE,
  portfolioImpactTier,
  portfolioNotCheckedText,
  portfolioRequirementCoverage,
  type PortfolioCoverage,
  type PortfolioImpactKind,
} from "./portfolio-assessment.js";

describe("#2272 — what a check did not check", () => {
  it("says why, in words the page and the export share", () => {
    expect(portfolioNotCheckedText({ reason: "over-limit", count: null })).toBe(
      `Not checked: one check takes ${PORTFOLIO_MAX_REQUIREMENTS} requirements, and this one is past them.`,
    );
    expect(portfolioNotCheckedText({ reason: "text-cut", count: 1_234 })).toBe(
      "Not checked in full: the last 1,234 characters of this text are past what one check reads.",
    );
    expect(portfolioNotCheckedText({ reason: "text-cut", count: 1 })).toContain(
      "the last 1 character of this text is past",
    );
    expect(portfolioNotCheckedText({ reason: "section-unread", count: null })).toBe(
      "Not checked: the model could not read this section of the document.",
    );
    expect(portfolioNotCheckedText({ reason: "quote-not-found", count: 2 })).toBe(
      "Not checked: 2 statements were dropped because their quote is not in the document.",
    );
    expect(portfolioNotCheckedText({ reason: "quote-not-found", count: 1 })).toContain(
      "1 statement was dropped because its quote",
    );
    expect(portfolioNotCheckedText({ reason: "budget", count: 3 })).toBe(
      "Not checked in 3 repositories: the check's budget ran out first.",
    );
    expect(portfolioNotCheckedText({ reason: "budget", count: 1 })).toContain("in 1 repository:");
  });

  it("lists each requirement checked with the products found implementing it", () => {
    const criteria = (coveredBy: string[][]) => ({
      criteria: coveredBy.map((c, i) => ({ criterion: `R${i + 1}`, coveredBy: c })),
    });
    expect(
      portfolioRequirementCoverage([
        { productId: "p1", technicalDetail: criteria([["rc-1"], [], ["rc-2"]]) },
        // A restricted row carries no criteria, nor does one reached outside the scope.
        { productId: "p2", technicalDetail: {} },
        { productId: "p3", technicalDetail: criteria([[], ["rc-9"], ["rc-8"]]) },
        { productId: "p4", technicalDetail: { criteria: "not a list" } },
        { productId: "p5", technicalDetail: { criteria: [null, { criterion: 7 }] } },
      ]),
    ).toEqual([
      { requirement: "R1", coveredBy: ["p1"] },
      { requirement: "R2", coveredBy: ["p3"] },
      { requirement: "R3", coveredBy: ["p1", "p3"] },
    ]);
    expect(portfolioRequirementCoverage([{ productId: "p1", technicalDetail: {} }])).toEqual([]);
  });
});

describe("#2272 — impact tiers", () => {
  const hop = (confidence: unknown, origin = "detected") => ({ confidence, origin });
  const row = (
    impactKind: PortfolioImpactKind,
    technicalDetail: Record<string, unknown> = {},
    coverage: PortfolioCoverage = "not-checked",
  ) => ({ impactKind, technicalDetail, coverage });
  const path = (...hops: unknown[]) => ({ impact: { hops } });

  it("a product the change does not reach has no tier", () => {
    expect(portfolioImpactTier(row("none"))).toBeNull();
  });

  it("a restricted product, a withheld path or no readable path needs review", () => {
    expect(portfolioImpactTier(row("restricted"))).toBe("needs-review");
    expect(portfolioImpactTier(row("downstream-consumer", path(hop(0.9)), "restricted"))).toBe(
      "needs-review",
    );
    expect(
      portfolioImpactTier(row("downstream-consumer", { ...path(hop(0.9)), impactWithheld: true })),
    ).toBe("needs-review");
    expect(portfolioImpactTier(row("downstream-consumer"))).toBe("needs-review");
    expect(portfolioImpactTier(row("downstream-consumer", path()))).toBe("needs-review");
    expect(portfolioImpactTier(row("downstream-consumer", path(hop("high"))))).toBe("needs-review");
  });

  it("a product that must change is verified when its code was found, else likely", () => {
    expect(portfolioImpactTier(row("direct-change", {}, "covers"))).toBe("verified");
    expect(portfolioImpactTier(row("direct-change", {}, "partial"))).toBe("verified");
    expect(portfolioImpactTier(row("direct-change", {}, "not-covered"))).toBe("likely");
    expect(portfolioImpactTier(row("direct-change", {}, "not-checked"))).toBe("likely");
  });

  it("a downstream product is as sure as its weakest detected hop", () => {
    const tier = (...hops: unknown[]) =>
      portfolioImpactTier(row("downstream-consumer", path(...hops)));
    expect(tier(hop(PORTFOLIO_VERIFIED_CONFIDENCE), hop(0.95))).toBe("verified");
    expect(tier(hop(0.95), hop(PORTFOLIO_VERIFIED_CONFIDENCE - 0.01))).toBe("likely");
    expect(tier(hop(PORTFOLIO_LIKELY_CONFIDENCE))).toBe("likely");
    expect(tier(hop(0.9), hop(PORTFOLIO_LIKELY_CONFIDENCE - 0.01))).toBe("possible");
    // An edge a person declared or overrode is not a guess, whatever its confidence.
    expect(tier(hop(0.1, "declared"), hop(0.2, "overridden"))).toBe("verified");
    expect(tier(hop(0.1, "declared"), hop(0.6))).toBe("likely");
  });

  it("labels every tier", () => {
    expect(PORTFOLIO_IMPACT_TIERS.map((t) => PORTFOLIO_IMPACT_TIER_LABEL[t])).toEqual([
      "Verified by graph path",
      "Likely",
      "Possible",
      "Needs review",
    ]);
  });
});
