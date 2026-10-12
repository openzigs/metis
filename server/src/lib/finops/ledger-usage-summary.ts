/**
 * Issue #1007 — ONE definition of a set of ledger rows' tokens and cost, for
 * every surface that shows a run's figures.
 *
 * TOKENS. Three surfaces showed three numbers for one run: the run lists read
 * the `totalTokens` column written when the run finished (0 while it ran, and
 * blind to spend after it), the analysis header summed the ledger's
 * `totalTokens` (which counts cache reads), and the walkthrough's ledger query
 * summed input + output (which does not). All of them now go through
 * {@link summariseLedgerRows}, which reports both figures by name:
 *
 *   • `withoutCache` — fresh input + output: the tokens billed at the input and
 *     output rates.
 *   • `withCache`    — the same plus cache reads and cache writes: the full
 *     prompt and output, each cached token counted once.
 *
 * Counts are made disjoint per REQUEST before they are summed
 * (`ledgerTierShares`), with a summed row split into the requests it lists
 * (`ledgerRowSummedRequests`, #1080).
 *
 * COST. The cost is the STORED ledger cost (`ledgerRowCents`: `costUsd`, or
 * `costCents` for a row from before #761) — what the call was priced at when
 * it was recorded, each request in its own price tier (`recordUsage`, #1080).
 * It is the figure the usage pages, the budget and the analysis header already
 * sum, so `/runs`, a run's page, the chat-turn table and the header cannot
 * disagree. A row recorded UNPRICED (#22) adds its tokens to `unpricedTokens`
 * and no cost: unknown spend is said to be unknown. This used to re-price the
 * rows at today's rate card instead, which put a second figure under the same
 * "Cost" header whenever a rate had changed since, and silently priced rows
 * the ledger holds as unpriced (review of #1112).
 */
import type { LedgerTokens } from "@metis/shared";
import { prisma } from "../prisma.js";
import { ledgerRowCents, normalizeCents } from "./ledger-cost.js";
import { getRate, type TokenRate } from "./provider-rates.js";
import { ledgerRowSummedRequests, ledgerTierShares } from "./token-tracker.js";

/** The ledger columns {@link summariseLedgerRows} reads. */
export const LEDGER_USAGE_SELECT = {
  provider: true,
  model: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  requestTokens: true,
  costCents: true,
  costUsd: true,
} as const;

export interface LedgerUsageRow {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** #1080 — the requests a summed row is made of (`ledgerRowSummedRequests`). */
  requestTokens?: string | null;
  costCents: number | null;
  costUsd?: number | null;
}

export interface LedgerUsageSummary {
  /** Unrounded STORED cost of the priced rows, in cents (#977). */
  exactCents: number;
  tokens: LedgerTokens;
  /** With-cache tokens of the rows recorded without a price (#22). */
  unpricedTokens: number;
  /** Ledger rows summed. */
  rows: number;
  /** Of {@link rows}, those recorded with a price. */
  pricedRows: number;
  /** Model requests: a summed row counts each request it lists (#1080). */
  requests: number;
}

/**
 * The summary's cost in USD, as every surface words it: `0` for no rows,
 * `null` when there are rows and none was priced (unknown, never $0), and
 * otherwise the stored cost of the priced rows.
 */
export function summaryCostUsd(summary: LedgerUsageSummary): number | null {
  if (summary.rows === 0) return 0;
  return summary.pricedRows > 0 ? summary.exactCents / 100 : null;
}

/**
 * Sum ledger rows into tokens (with and without cache), the stored cost of the
 * priced rows (UNROUNDED, #977) and the tokens of the unpriced ones (#22).
 *
 * The rate card is read for one thing only: `ledgerTierShares` needs to know
 * whether the model has a prompt-length tier to split a summed row by. It does
 * not change a token count, and no cost is derived from it here.
 */
export function summariseLedgerRows(rows: readonly LedgerUsageRow[]): LedgerUsageSummary {
  const rates = new Map<string, TokenRate | null>();
  const tokens: LedgerTokens = { withCache: 0, withoutCache: 0 };
  let exactCents = 0;
  let unpricedTokens = 0;
  let pricedRows = 0;
  let requests = 0;
  for (const row of rows) {
    const modelKey = `${row.provider} ${row.model}`;
    let rate = rates.get(modelKey);
    if (rate === undefined) {
      rate = getRate(row.provider, row.model);
      rates.set(modelKey, rate);
    }
    const summed = ledgerRowSummedRequests(row);
    requests += summed?.length ?? 1;
    // #264 — make each row's counts disjoint BEFORE summing (the same rule
    // `recordUsage` records with), so a gateway row's cache reads are not
    // counted twice, and one row's clamp cannot borrow another's.
    let withCache = 0;
    for (const share of ledgerTierShares(row.provider, rate, row, summed)) {
      // The canonical total, not the stored `totalTokens`: a row written before
      // #248 stored a gateway total that counted cache reads twice.
      withCache += share.counts.totalTokens;
      tokens.withoutCache += share.counts.freshInputTokens + share.counts.outputTokens;
    }
    tokens.withCache += withCache;
    const cents = ledgerRowCents(row);
    if (cents === null) unpricedTokens += withCache;
    else {
      exactCents += cents;
      pricedRows += 1;
    }
  }
  return {
    exactCents: normalizeCents(exactCents),
    tokens,
    unpricedTokens,
    rows: rows.length,
    pricedRows,
    requests,
  };
}

const SUMMARY_CACHE_MAX = 256;
const summaryCache = new Map<string, { signature: string; summary: LedgerUsageSummary }>();

/**
 * One session's summary for a reader that POLLS (the analysis header, every
 * 2.5 s while a run goes). `signature` is anything that changes when the
 * session's rows do — the ledger is append-only, so its row count and stored
 * total are enough, and the caller has both from an aggregate it runs anyway.
 * The rows are loaded only when the signature moved; an unchanged session costs
 * no row read. At most {@link SUMMARY_CACHE_MAX} sessions are remembered, per
 * process; a miss is only a re-read.
 */
export async function sessionLedgerSummary(
  projectId: string,
  sessionId: string,
  signature: string,
): Promise<LedgerUsageSummary> {
  const key = `${projectId} ${sessionId}`;
  const hit = summaryCache.get(key);
  if (hit?.signature === signature) return hit.summary;
  const rows = await prisma.tokenUsage.findMany({
    where: { projectId, sessionId },
    select: LEDGER_USAGE_SELECT,
  });
  const summary = summariseLedgerRows(rows);
  summaryCache.delete(key);
  summaryCache.set(key, { signature, summary });
  if (summaryCache.size > SUMMARY_CACHE_MAX) {
    summaryCache.delete(summaryCache.keys().next().value as string);
  }
  return summary;
}

/** Test seam: forget every remembered summary. */
export function clearSessionLedgerSummaryCache(): void {
  summaryCache.clear();
}

/**
 * The ledger tokens of each of a PROJECT's sessions, from one read. A session
 * with no ledger rows has no entry. Scoped to `projectId` as well as the
 * session ids, so a session id from another project matches nothing.
 */
export async function sessionLedgerTokens(
  projectId: string,
  sessionIds: readonly string[],
): Promise<Map<string, LedgerTokens>> {
  const out = new Map<string, LedgerTokens>();
  if (sessionIds.length === 0) return out;
  const rows = await prisma.tokenUsage.findMany({
    where: { projectId, sessionId: { in: [...sessionIds] } },
    select: { ...LEDGER_USAGE_SELECT, sessionId: true },
  });
  const bySession = new Map<string, LedgerUsageRow[]>();
  for (const row of rows) {
    if (row.sessionId === null) continue;
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }
  for (const [sessionId, list] of bySession) out.set(sessionId, summariseLedgerRows(list).tokens);
  return out;
}
