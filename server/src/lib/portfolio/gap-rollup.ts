/**
 * Epic #1608 (#1622) — the roll-up rules of the portfolio gap analysis. Pure
 * and LLM-free: per-repo verdicts become a product's coverage, and product
 * coverages become the portfolio verdict.
 *
 * Repo -> product (first match wins):
 *   1. no repo the caller can read                    -> `not-checked`
 *   2. every criterion implemented by some repo       -> `covers`
 *   3. some criterion implemented by some repo        -> `partial`
 *   4. every repo `gap-confirmed`, none hidden        -> `not-covered`
 *   5. otherwise                                      -> `not-checked`
 *
 * Rule 2 is "any repo `implemented` and no criterion missing": a repo that is
 * `implemented` met every criterion, and two repos that each meet half of
 * them cover the product between them. Rule 3 is wider than "a repo is
 * `implemented` or `partial`": a repo that met one criterion and could not
 * verify another is `could-not-verify` on its own (#1610 rule 4), yet the
 * criterion it met is grounded evidence the product partly covers it. Rule 4 is the only way to `not-covered`:
 * one repo we could not verify (budget, no index, a failed search) or could
 * not read leaves the product `not-checked`, never "it is not there" (NFR-2).
 *
 * Product -> portfolio: any `covers` -> `implemented`; else any `partial` ->
 * `partial`; else every product `not-covered` -> `gap-confirmed` ("nothing in
 * the portfolio covers this"); else `could-not-verify`. A `restricted` or
 * `not-checked` product therefore stops a portfolio from reading as a gap.
 */
import type { FindingVerdict, PortfolioCoverage, RequirementVerdict } from "@metis/shared";

/** A repo's verdict as the product roll-up reads it. */
export interface RepoVerdictInput {
  verdict: RequirementVerdict;
  /** One verdict per criterion, index-aligned with the assessment's criteria. */
  criteria: readonly FindingVerdict[];
}

/** Why a product was not checked. */
export type ProductNotCheckedReason = "no-repos" | "repos-restricted" | "could-not-verify";

export interface ProductCoverageResult {
  coverage: PortfolioCoverage;
  reason: ProductNotCheckedReason | null;
}

/**
 * A product's coverage from its readable repos' verdicts. `hiddenRepos` counts
 * the product's repos the caller cannot read (#1258): they were not checked,
 * so they cannot back a "not covered".
 */
export function rollUpProductCoverage(
  repos: readonly RepoVerdictInput[],
  criteriaCount: number,
  hiddenRepos = 0,
): ProductCoverageResult {
  if (repos.length === 0) {
    return { coverage: "not-checked", reason: hiddenRepos > 0 ? "repos-restricted" : "no-repos" };
  }
  const covered = Array.from({ length: criteriaCount }, (_, i) =>
    repos.some((r) => r.criteria[i] === "implemented"),
  );
  if (criteriaCount > 0 && covered.every(Boolean)) return { coverage: "covers", reason: null };
  if (covered.some(Boolean)) {
    return { coverage: "partial", reason: null };
  }
  if (repos.every((r) => r.verdict === "gap-confirmed")) {
    return hiddenRepos > 0
      ? { coverage: "not-checked", reason: "repos-restricted" }
      : { coverage: "not-covered", reason: null };
  }
  return { coverage: "not-checked", reason: "could-not-verify" };
}

/** The portfolio verdict from every product in scope. */
export function rollUpPortfolioVerdict(
  coverages: readonly PortfolioCoverage[],
): RequirementVerdict {
  if (coverages.includes("covers")) return "implemented";
  if (coverages.includes("partial")) return "partial";
  if (coverages.length > 0 && coverages.every((c) => c === "not-covered")) return "gap-confirmed";
  return "could-not-verify";
}

/**
 * The portfolio verdict in the vocabulary `PortfolioAssessment.portfolioVerdict`
 * stores (#1621: `PORTFOLIO_COVERAGES`). One to one, so it reads back without loss.
 */
const STORED_VERDICT: Record<RequirementVerdict, PortfolioCoverage> = {
  implemented: "covers",
  partial: "partial",
  "gap-confirmed": "not-covered",
  "could-not-verify": "not-checked",
};

export function storedPortfolioVerdict(verdict: RequirementVerdict): PortfolioCoverage {
  return STORED_VERDICT[verdict];
}

/** The inverse of {@link storedPortfolioVerdict}; null for a value it never writes. */
export function portfolioVerdictFromStored(
  stored: PortfolioCoverage | null,
): RequirementVerdict | null {
  const hit = (Object.keys(STORED_VERDICT) as RequirementVerdict[]).find(
    (v) => STORED_VERDICT[v] === stored,
  );
  return hit ?? null;
}
