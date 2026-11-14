/**
 * #2302 — how sure Impact Analysis is about each affected symbol and table, in
 * the same words as the portfolio check's impact tiers (#2272): verified by
 * graph path, likely, possible, needs review. The portfolio check's fifth tier,
 * `found-in-code`, is a product's code verdict and has no counterpart here.
 *
 * Derived deterministically from what a run stored: no model call, no read of
 * anything but the row. The page and the Markdown export (and so the Jira
 * publish) call these same functions, so they cannot disagree.
 *
 * The thresholds were measured before they were fixed (`pnpm eval:impact-tiers`,
 * #1751's held-out localization corpora and the impact-recall corpora); the
 * numbers are in `docs/USER_GUIDE.md` next to the rule.
 */
import type { ImpactAffectedRelation } from "./impact.js";
import {
  PORTFOLIO_IMPACT_TIER_LABEL,
  PORTFOLIO_LIKELY_CONFIDENCE,
  PORTFOLIO_VERIFIED_CONFIDENCE,
} from "./portfolio-assessment.js";
import type { ImpactAffectedTableView } from "./schema-impact.js";

export const IMPACT_TIERS = ["verified", "likely", "possible", "needs-review"] as const;
export type ImpactTier = (typeof IMPACT_TIERS)[number];

/** The portfolio check's labels, so one tier reads the same on both pages. */
export const IMPACT_TIER_LABEL: Readonly<Record<ImpactTier, string>> = {
  verified: PORTFOLIO_IMPACT_TIER_LABEL.verified,
  likely: PORTFOLIO_IMPACT_TIER_LABEL.likely,
  possible: PORTFOLIO_IMPACT_TIER_LABEL.possible,
  "needs-review": PORTFOLIO_IMPACT_TIER_LABEL["needs-review"],
};

/**
 * Relations that can be verified by graph path: call, import and dependency
 * edges walked from a file to edit (`blast-radius.ts`), whose confidence is the
 * seed's times each edge's weight and the per-hop decay — an absolute strength.
 *
 * Deliberately not here, though also reached through stored structure:
 * - `data-writer` — its confidence is its RANK among the run's lineage writers
 *   (`0.4 + 0.4 * points / best`, `data-path-writers.ts`), so the best writer of
 *   every run is 0.8 whatever the evidence, and the evidence that would verify it
 *   is not stored on the row. At most likely.
 * - `data-model` — a table's definition, stored at a fixed 0.6
 *   (`DATA_MODEL_CONFIDENCE`), so always likely.
 * `direct` and `related` are search hits.
 */
export const IMPACT_GRAPH_RELATIONS: readonly ImpactAffectedRelation[] = [
  "caller",
  "importer",
  "dependency",
];

/**
 * A graph-reached symbol at least this sure, at most
 * {@link IMPACT_VERIFIED_MAX_DEPTH} hops out, is verified by graph path. Its
 * confidence is the seed's times each edge's weight and the per-hop decay
 * (`blast-radius.ts`), so this is the portfolio check's rule: every hop strong.
 */
export const IMPACT_VERIFIED_CONFIDENCE = PORTFOLIO_VERIFIED_CONFIDENCE;
/** One hop: a direct caller (or importer, or dependency) of a file to edit. */
export const IMPACT_VERIFIED_MAX_DEPTH = 1;
/**
 * At or above this a symbol (or an unjudged table) is likely, below it
 * possible. The measurement: edit candidates at or above it hit a file the
 * change edited about twice as often as those below it.
 */
export const IMPACT_LIKELY_CONFIDENCE = PORTFOLIO_LIKELY_CONFIDENCE;

/** What {@link impactSymbolTier} reads from a stored affected symbol. */
export interface ImpactTierSymbol {
  codeSymbolId: string | null;
  relation: ImpactAffectedRelation;
  depth: number;
  confidence: number;
}

/**
 * #2302 — one affected symbol's tier.
 *
 * - `needs-review` — the target does not resolve to the code graph (no code
 *   symbol behind the row: a later ingest replaced it, or it never resolved),
 *   or its confidence is not a number.
 * - `verified` — reached along a graph edge ({@link IMPACT_GRAPH_RELATIONS}),
 *   at most one hop out, at confidence {@link IMPACT_VERIFIED_CONFIDENCE} or
 *   more. It verifies the path from a file to edit, not that file.
 * - `likely` / `possible` — otherwise by confidence, against
 *   {@link IMPACT_LIKELY_CONFIDENCE}. A search match (`direct`), a lineage
 *   writer and a table's definition are never verified, and a `related` symbol, retrieved but below the edit cut and
 *   never a claim that it changes, is at most possible.
 */
export function impactSymbolTier(symbol: ImpactTierSymbol): ImpactTier {
  if (symbol.codeSymbolId === null || !Number.isFinite(symbol.confidence)) return "needs-review";
  if (symbol.relation === "related") return "possible";
  if (
    IMPACT_GRAPH_RELATIONS.includes(symbol.relation) &&
    symbol.depth <= IMPACT_VERIFIED_MAX_DEPTH &&
    symbol.confidence >= IMPACT_VERIFIED_CONFIDENCE
  ) {
    return "verified";
  }
  return symbol.confidence >= IMPACT_LIKELY_CONFIDENCE ? "likely" : "possible";
}

/**
 * #2302 — one affected table's (or column's, or routine's) tier: its relevance
 * tier (#936) mapped into the four words.
 *
 * - `needs-review` — the table or column is not in the live schema
 *   (`table-not-found` / `column-not-found`), or the confidence is not a number.
 * - `likely` ← `likely`; `possible` ← `possible` and `unlikely` (the
 *   low-confidence bucket, listed under its own heading).
 * - Not judged (the relevance filter did not run): by confidence, as a symbol.
 *
 * Never `verified`: the stored row does not keep the code path the table was
 * reached through, so there is no path to show.
 */
export function impactTableTier(
  table: Pick<ImpactAffectedTableView, "reconciliation" | "relevanceTier" | "confidence">,
): ImpactTier {
  if (
    table.reconciliation === "table-not-found" ||
    table.reconciliation === "column-not-found" ||
    !Number.isFinite(table.confidence)
  ) {
    return "needs-review";
  }
  if (table.relevanceTier === "likely") return "likely";
  if (table.relevanceTier === "possible" || table.relevanceTier === "unlikely") return "possible";
  return table.confidence >= IMPACT_LIKELY_CONFIDENCE ? "likely" : "possible";
}
