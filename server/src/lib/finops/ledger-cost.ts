/**
 * #761 — the ONE way to read a `token_usages` row's cost.
 *
 * `costCents` is an integer rounded per row at insert, so a call costing a
 * fraction of a cent records 0 and a sum of them under-reports spend (#706 run
 * 3: 999¢ recorded against $9.84 computed). `costUsd` holds the unrounded cost.
 * Every reader sums what this returns and rounds once, at the edge.
 */

/** The cost columns a reader must select to call {@link ledgerRowCents}. */
export const LEDGER_COST_SELECT = { costCents: true, costUsd: true } as const;

/**
 * Precision, in cents, that a ledger cost is carried at: one millionth of a
 * cent. Far below anything a provider bills, far above IEEE-754 noise.
 */
const CENTS_SCALE = 1e6;

/**
 * #868 review — drop binary floating-point noise from a cents value. `0.07 *
 * 100` is `7.000000000000001`, and a `Math.ceil` at the edge (the month-end
 * projection) turned that exact 7¢ into 8¢ — or, pro-rated x31 on day 1, an
 * exact 217¢ into 218¢. Rounding to {@link CENTS_SCALE} keeps every real
 * sub-cent fraction (#761) and removes only the noise. Safe to 2^53 / 1e6 ≈
 * 9e9 cents, i.e. ~$90M, per value.
 */
export function normalizeCents(cents: number): number {
  return Math.round(cents * CENTS_SCALE) / CENTS_SCALE;
}

/**
 * #868 review — the `where` fragment selecting rows whose writer set
 * `costCents` but no `costUsd`: an old-version replica still serving after
 * `migrate deploy` during a rolling deploy, or any writer that predates #761.
 * An aggregate reader (`_sum: { costUsd }`) skips these rows, so it must run a
 * second `_sum: { costCents }` over this filter and add it through
 * {@link sumLedgerCents} — the aggregate form of {@link ledgerRowCents}'
 * fallback. Both NULL is unpriced and matches neither query (#22).
 */
export const LEGACY_COST_ROW_WHERE = { costUsd: null, costCents: { not: null } } as const;

/** Rows recorded UNPRICED (#22): neither cost column set. Unknown spend, never $0. */
export const UNPRICED_ROW_WHERE = { costUsd: null, costCents: null } as const;

/**
 * Combine a `_sum.costUsd` over priced rows with a `_sum.costCents` over
 * {@link LEGACY_COST_ROW_WHERE} rows into one unrounded cents total — exactly
 * what summing {@link ledgerRowCents} over every row would give.
 */
export function sumLedgerCents(
  costUsdSum: number | null | undefined,
  legacyCostCentsSum: number | null | undefined,
): number {
  const usd = typeof costUsdSum === "number" && Number.isFinite(costUsdSum) ? costUsdSum : 0;
  return normalizeCents(usd * 100 + (legacyCostCentsSum ?? 0));
}

/**
 * The row's unrounded cost in cents, or `null` when it was recorded unpriced
 * (#22 — unknown spend, never $0). Falls back to `costCents` only for a row
 * whose writer set no `costUsd`; the #761 migration backfilled every priced row.
 */
export function ledgerRowCents(row: {
  costCents: number | null;
  costUsd?: number | null;
}): number | null {
  if (typeof row.costUsd === "number" && Number.isFinite(row.costUsd)) {
    return normalizeCents(row.costUsd * 100);
  }
  return row.costCents;
}
