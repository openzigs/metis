/**
 * #2302 — `pnpm eval:impact-tiers`: how often a symbol (or table) of each
 * Impact Analysis tier is one the change really touched, so the tier
 * thresholds (`impactSymbolTier`, `impactTableTier` in `@metis/shared`) are
 * fixed against a measurement rather than a guess.
 *
 * Two readings, both deterministic (no model):
 *
 * - `localization` — #1751's held-out corpora (#1753): production's seeding
 *   (`resolveChangeSeeds`, arm A0) per item, each edit candidate and related
 *   hit tiered as the engine stores it (edit candidates `direct` at depth 0,
 *   the rest `related` at depth 1). A hit: its file is one the fix edited.
 * - `impact-recall` — the engine (`computeProjectImpact`) over the
 *   impact-recall corpora, every affected symbol and table tiered. A hit: the
 *   symbol or table is in the requirement's labels.
 *
 * Neither corpus labels the blast radius: the localization corpora carry no
 * graph edges, and impact-recall labels the code to edit. A caller's hit rate
 * is therefore how often it is itself a file to edit, not whether it is
 * affected; the report says so.
 *
 * This module is pure: the CLI (`scripts/eval-impact-tiers.ts`) does the I/O.
 */
import { IMPACT_TIERS, IMPACT_TIER_LABEL, impactSymbolTier, type ImpactTier } from "@metis/shared";

/** One tiered row the run produced, and whether it was right. */
export interface TierObservation {
  /** Which reading: `localization/<corpus>` or `impact-recall/<corpus>/<symbols|tables>`. */
  source: string;
  tier: ImpactTier;
  hit: boolean;
}

/** One cell of the report. */
export interface TierPrecisionRow {
  source: string;
  tier: ImpactTier;
  count: number;
  hits: number;
  /** hits / count; null when the tier is empty. */
  precision: number | null;
}

/** A seeded symbol, as `resolveChangeSeeds` returns it. */
interface SeedMatch {
  codeSymbolId: string | null;
  filePath: string;
  confidence: number;
}

/**
 * A0's seeding, tiered as the engine stores it: edit candidates are `direct`
 * at depth 0; related hits and schema seeds are `related` at depth 1
 * (`assignImpactRoles`, `impact-analysis-engine.ts`).
 */
export function seedTierObservations(
  source: string,
  seeds: {
    editCandidates: readonly SeedMatch[];
    related: readonly SeedMatch[];
    schemaSeeds: readonly SeedMatch[];
  },
  isHit: (filePath: string) => boolean,
): TierObservation[] {
  const edit = seeds.editCandidates.map((m) => ({ m, relation: "direct" as const, depth: 0 }));
  const rest = [...seeds.related, ...seeds.schemaSeeds].map((m) => ({
    m,
    relation: "related" as const,
    depth: 1,
  }));
  return [...edit, ...rest].map(({ m, relation, depth }) => ({
    source,
    tier: impactSymbolTier({
      codeSymbolId: m.codeSymbolId,
      relation,
      depth,
      confidence: m.confidence,
    }),
    hit: isHit(m.filePath),
  }));
}

/** Per source, per tier (in tier order, empty tiers included): count, hits and precision. */
export function tierPrecision(observations: readonly TierObservation[]): TierPrecisionRow[] {
  const sources = [...new Set(observations.map((o) => o.source))];
  return sources.flatMap((source) =>
    IMPACT_TIERS.map((tier) => {
      const cell = observations.filter((o) => o.source === source && o.tier === tier);
      const hits = cell.filter((o) => o.hit).length;
      return {
        source,
        tier,
        count: cell.length,
        hits,
        precision: cell.length === 0 ? null : hits / cell.length,
      };
    }),
  );
}

/** The report as a Markdown table. */
export function tierPrecisionMarkdown(rows: readonly TierPrecisionRow[]): string {
  const lines = [
    "| Reading | Tier | Rows | Hits | Hit rate |",
    "|---|---|---:|---:|---:|",
    ...rows.map(
      (r) =>
        `| ${r.source} | ${IMPACT_TIER_LABEL[r.tier]} | ${r.count} | ${r.hits} | ${
          r.precision === null ? "—" : r.precision.toFixed(2)
        } |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
