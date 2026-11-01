/**
 * #1622 — every roll-up rule of the portfolio gap analysis, one case each.
 */
import { describe, expect, it } from "vitest";
import { PORTFOLIO_COVERAGES, REQUIREMENT_VERDICTS, type PortfolioCoverage } from "@metis/shared";
import {
  portfolioVerdictFromStored,
  hadNothingToCheck,
  rollUpPortfolio,
  rollUpPortfolioVerdict,
  rollUpProductCoverage,
  storedPortfolioVerdict,
  type RepoVerdictInput,
} from "./gap-rollup.js";

const implemented: RepoVerdictInput = {
  verdict: "implemented",
  criteria: ["implemented", "implemented"],
};
const firstHalf: RepoVerdictInput = {
  verdict: "partial",
  criteria: ["implemented", "gap-confirmed"],
};
const secondHalf: RepoVerdictInput = {
  verdict: "partial",
  criteria: ["gap-confirmed", "implemented"],
};
const gap: RepoVerdictInput = {
  verdict: "gap-confirmed",
  criteria: ["gap-confirmed", "gap-confirmed"],
};
const unknown: RepoVerdictInput = {
  verdict: "could-not-verify",
  criteria: ["could-not-verify", "could-not-verify"],
};

describe("rollUpProductCoverage", () => {
  it("covers: a repo implements every criterion, whatever the others say", () => {
    expect(rollUpProductCoverage([implemented, gap, unknown], 2)).toEqual({
      coverage: "covers",
      reason: null,
    });
  });

  it("covers: two repos meet every criterion between them", () => {
    expect(rollUpProductCoverage([firstHalf, secondHalf], 2).coverage).toBe("covers");
  });

  it("partial: some criterion met, another missing everywhere", () => {
    expect(rollUpProductCoverage([firstHalf, gap], 2)).toEqual({
      coverage: "partial",
      reason: null,
    });
  });

  it("partial: an implemented repo whose other criterion no repo could verify", () => {
    const halfVerified: RepoVerdictInput = {
      verdict: "could-not-verify",
      criteria: ["implemented", "could-not-verify"],
    };
    // The repo's own verdict is could-not-verify; the criterion it met still counts.
    expect(rollUpProductCoverage([halfVerified], 2).coverage).toBe("partial");
    expect(rollUpProductCoverage([firstHalf, unknown], 2).coverage).toBe("partial");
  });

  it("not-covered: every repo a confirmed gap", () => {
    expect(rollUpProductCoverage([gap, gap], 2)).toEqual({
      coverage: "not-covered",
      reason: null,
    });
  });

  it("not-checked: one unverified repo stops a gap", () => {
    expect(rollUpProductCoverage([gap, unknown], 2)).toEqual({
      coverage: "not-checked",
      reason: "could-not-verify",
    });
  });

  it("not-checked: every repo could not be verified", () => {
    expect(rollUpProductCoverage([unknown], 2)).toEqual({
      coverage: "not-checked",
      reason: "could-not-verify",
    });
  });

  it("not-checked: a hidden repo stops a gap, and does not stop a cover", () => {
    expect(rollUpProductCoverage([gap], 2, 1)).toEqual({
      coverage: "not-checked",
      reason: "repos-restricted",
    });
    expect(rollUpProductCoverage([implemented], 2, 1).coverage).toBe("covers");
  });

  it("not-checked: no repo at all, or none the caller can read", () => {
    expect(rollUpProductCoverage([], 2)).toEqual({ coverage: "not-checked", reason: "no-repos" });
    expect(rollUpProductCoverage([], 2, 3)).toEqual({
      coverage: "not-checked",
      reason: "repos-restricted",
    });
  });

  it("no criteria covers nothing", () => {
    expect(rollUpProductCoverage([{ verdict: "gap-confirmed", criteria: [] }], 0).coverage).toBe(
      "not-covered",
    );
  });
});

describe("rollUpPortfolioVerdict", () => {
  it("any covers is implemented", () => {
    expect(rollUpPortfolioVerdict(["not-covered", "covers", "partial", "restricted"])).toBe(
      "implemented",
    );
  });

  it("else any partial is partial", () => {
    expect(rollUpPortfolioVerdict(["not-covered", "partial", "not-checked"])).toBe("partial");
  });

  it("every product not covered is a confirmed gap", () => {
    expect(rollUpPortfolioVerdict(["not-covered", "not-covered"])).toBe("gap-confirmed");
  });

  it("a restricted or unchecked product stops a confirmed gap", () => {
    expect(rollUpPortfolioVerdict(["not-covered", "restricted"])).toBe("could-not-verify");
    expect(rollUpPortfolioVerdict(["not-covered", "not-checked"])).toBe("could-not-verify");
  });

  it("an empty scope cannot be verified", () => {
    expect(rollUpPortfolioVerdict([])).toBe("could-not-verify");
  });
});

describe("rollUpPortfolio (#1677)", () => {
  const p = (coverage: PortfolioCoverage, reason: string | null = null) => ({ coverage, reason });

  it("leaves a product with no repos out, so the rest can confirm a gap", () => {
    expect(rollUpPortfolio([p("not-covered"), p("not-checked", "no-repos")])).toBe("gap-confirmed");
    expect(
      rollUpPortfolio([
        p("not-checked", "no-repos"),
        p("not-covered"),
        p("not-checked", "no-repos"),
      ]),
    ).toBe("gap-confirmed");
  });

  it("keeps a product whose repos could not be read or verified", () => {
    expect(rollUpPortfolio([p("not-covered"), p("not-checked", "repos-restricted")])).toBe(
      "could-not-verify",
    );
    expect(rollUpPortfolio([p("not-covered"), p("not-checked", "could-not-verify")])).toBe(
      "could-not-verify",
    );
    expect(rollUpPortfolio([p("not-covered"), p("restricted")])).toBe("could-not-verify");
  });

  it("only products with no repos is not a gap", () => {
    expect(rollUpPortfolio([p("not-checked", "no-repos")])).toBe("could-not-verify");
  });

  it("still reads covers and partial through an empty product", () => {
    expect(rollUpPortfolio([p("covers"), p("not-checked", "no-repos")])).toBe("implemented");
    expect(rollUpPortfolio([p("partial"), p("not-checked", "no-repos")])).toBe("partial");
  });

  it("nothing to check is not-checked with the no-repos reason only", () => {
    expect(hadNothingToCheck(p("not-checked", "no-repos"))).toBe(true);
    expect(hadNothingToCheck(p("not-covered", "no-repos"))).toBe(false);
    expect(hadNothingToCheck(p("not-checked", "repos-restricted"))).toBe(false);
  });
});

describe("stored portfolio verdict", () => {
  it("round-trips every verdict through the stored vocabulary", () => {
    for (const v of REQUIREMENT_VERDICTS) {
      const stored = storedPortfolioVerdict(v);
      expect(PORTFOLIO_COVERAGES).toContain(stored);
      expect(portfolioVerdictFromStored(stored)).toBe(v);
    }
  });

  it("reads a value it never writes as null", () => {
    expect(portfolioVerdictFromStored("restricted")).toBeNull();
    expect(portfolioVerdictFromStored(null)).toBeNull();
  });
});
