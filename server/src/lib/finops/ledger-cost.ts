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
 * The row's unrounded cost in cents, or `null` when it was recorded unpriced
 * (#22 — unknown spend, never $0). Falls back to `costCents` only for a row
 * whose writer set no `costUsd`; the #761 migration backfilled every priced row.
 */
export function ledgerRowCents(row: {
  costCents: number | null;
  costUsd?: number | null;
}): number | null {
  if (typeof row.costUsd === "number" && Number.isFinite(row.costUsd)) return row.costUsd * 100;
  return row.costCents;
}
