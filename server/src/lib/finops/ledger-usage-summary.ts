/**
 * Issue #1007 — ONE definition of a set of ledger rows' tokens and re-priced
 * cost, for every surface that shows a run's figures.
 *
 * Three surfaces showed three numbers for one run: the run lists read the
 * `totalTokens` column written when the run finished (0 while it ran, and blind
 * to spend after it), the analysis header summed the ledger's `totalTokens`
 * (which counts cache reads), and the walkthrough's ledger query summed input +
 * output (which does not). All of them now go through
 * {@link summariseLedgerRows}, which reports both figures by name:
 *
 *   • `withoutCache` — fresh input + output: the tokens billed at the input and
 *     output rates.
 *   • `withCache`    — the same plus cache reads and cache writes: the full
 *     prompt and output, each cached token counted once.
 *
 * Counts are made disjoint per REQUEST before they are summed
 * (`ledgerTierShares`), with a summed row split into the requests it lists
 * (`ledgerRowSummedRequests`, #1080), so the tokens and the cost come from the
 * same decomposition.
 */
import type { LedgerTokens } from "@metis/shared";
import { prisma } from "../prisma.js";
import { normalizeCents } from "./ledger-cost.js";
import { computeCostCentsExact, getRate, tierRate, type TokenRate } from "./provider-rates.js";
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
}

export interface LedgerUsageSummary {
  /** Unrounded cost in cents at the current rate card; unpriced models add none (#22). */
  exactCents: number;
  tokens: LedgerTokens;
}

/**
 * Sum ledger rows into tokens (with and without cache) and a cost, grouped by
 * (provider, model) at the current rate card and left UNROUNDED (#977).
 * Unpriced models add tokens, no cost (#22).
 *
 * #1080 — a model priced by prompt length (Claude Haiku 5.5) bills each
 * REQUEST in one tier, so a row's tier is decided from that row's own prompt
 * before it is summed: the groups are (provider, model, tier). Deciding it on
 * the summed tokens would bill a run of many small requests at the long-prompt
 * prices. A row is not always one request — a chat turn that ran a tool loop is
 * one row summing its requests — so such a row is split into the requests it
 * lists (`requestTokens`) first.
 */
export function summariseLedgerRows(rows: readonly LedgerUsageRow[]): LedgerUsageSummary {
  interface Group {
    rate: TokenRate | null;
    longPrompt: boolean;
    freshInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }
  const groups = new Map<string, Group>();
  const rates = new Map<string, TokenRate | null>();
  const tokens: LedgerTokens = { withCache: 0, withoutCache: 0 };
  for (const row of rows) {
    const modelKey = `${row.provider} ${row.model}`;
    let rate = rates.get(modelKey);
    if (rate === undefined) {
      rate = getRate(row.provider, row.model);
      rates.set(modelKey, rate);
    }
    // #264 — make each row's counts disjoint BEFORE summing (the same rule
    // `recordUsage` prices with), so a gateway row's cache reads are not billed
    // again at the input rate, and one row's clamp cannot borrow another's.
    // #1080 — `ledgerTierShares` does that, per request of a summed row.
    for (const share of ledgerTierShares(row.provider, rate, row, ledgerRowSummedRequests(row))) {
      // The canonical total, not the stored `totalTokens`: a row written before
      // #248 stored a gateway total that counted cache reads twice.
      tokens.withCache += share.counts.totalTokens;
      tokens.withoutCache += share.counts.freshInputTokens + share.counts.outputTokens;
      const key = share.longPrompt ? `${modelKey} long-prompt` : modelKey;
      const g = groups.get(key) ?? {
        rate,
        longPrompt: share.longPrompt,
        freshInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      g.freshInputTokens += share.counts.freshInputTokens;
      g.outputTokens += share.counts.outputTokens;
      g.cacheReadTokens += share.counts.cacheReadTokens;
      g.cacheWriteTokens += share.counts.cacheWriteTokens;
      groups.set(key, g);
    }
  }

  let exactCents = 0;
  for (const g of groups.values()) {
    // #22 — an unpriced model has no cost to attribute; its tokens still count.
    if (!g.rate) continue;
    exactCents += computeCostCentsExact(tierRate(g.rate, g.longPrompt), {
      inputTokens: g.freshInputTokens,
      outputTokens: g.outputTokens,
      cacheReadTokens: g.cacheReadTokens,
      cacheWriteTokens: g.cacheWriteTokens,
    });
  }
  return { exactCents: normalizeCents(exactCents), tokens };
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
