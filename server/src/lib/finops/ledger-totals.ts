/**
 * #977 — token and cost totals over a slice of the `token_usages` ledger,
 * summed in the database.
 *
 * Cost is the unrounded ledger cost (`costUsd`, with the `costCents` fallback
 * for rows an older writer left without one — the aggregate form of
 * `ledgerRowCents`, #761/#868), returned in USD so a view rounds it once, to
 * its display precision. Unpriced rows (#22) add tokens, never dollars.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { LEGACY_COST_ROW_WHERE, UNPRICED_ROW_WHERE, sumLedgerCents } from "./ledger-cost.js";

export interface LedgerTotals {
  /** Every token in the slice, priced or not. */
  totalTokens: number;
  /**
   * Unrounded cost of the PRICED rows, in USD. `null` when the slice has rows
   * and none was priced (unknown spend, never $0); `0` for an empty slice.
   */
  costUsd: number | null;
  /** Tokens from rows recorded without a price. */
  unpricedTokens: number;
  /** Ledger rows (model calls) in the slice. */
  calls: number;
}

/** Sum the ledger rows matching `where`. Three grouped reads; no rows are loaded. */
export async function sumLedgerUsage(where: Prisma.TokenUsageWhereInput): Promise<LedgerTotals> {
  const [all, legacy, unpriced] = await Promise.all([
    prisma.tokenUsage.aggregate({
      where,
      _sum: { totalTokens: true, costUsd: true },
      _count: { _all: true },
    }),
    prisma.tokenUsage.aggregate({
      where: { AND: [where, LEGACY_COST_ROW_WHERE] },
      _sum: { costCents: true },
    }),
    prisma.tokenUsage.aggregate({
      where: { AND: [where, UNPRICED_ROW_WHERE] },
      _sum: { totalTokens: true },
      _count: { _all: true },
    }),
  ]);
  const calls = all._count._all;
  const unpricedCalls = unpriced._count._all;
  const anyPriced = calls > unpricedCalls;
  return {
    totalTokens: all._sum.totalTokens ?? 0,
    costUsd:
      calls === 0
        ? 0
        : anyPriced
          ? sumLedgerCents(all._sum.costUsd, legacy._sum.costCents) / 100
          : null,
    unpricedTokens: unpriced._sum.totalTokens ?? 0,
    calls,
  };
}
