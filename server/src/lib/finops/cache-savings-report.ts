/**
 * #1277 — the prompt-cache savings report: for each `agentStep` × provider ×
 * model pair in `token_usages`, the cache read and write tokens and the NET
 * saving in USD — what the same input tokens would have cost uncached, minus
 * what they cost with caching:
 *
 *   uncached = (fresh input + cache reads + cache writes) × input price
 *   actual   = fresh input × input price
 *            + cache reads × cache-read price
 *            + cache writes × cache-write price (2× input for the 1-hour TTL)
 *
 * Output tokens bill the same either way, so they are left out. A negative
 * saving means caching cost more than not caching: the write surcharge (1.25×
 * for a 5-minute write on Claude) was paid and too little was read back.
 *
 * Prices come from `provider-rates.ts` (the built-in list and `MODEL_PRICES`),
 * never from a second table here. A model with no write price (DeepSeek) bills
 * a write at its input price, which is no surcharge. A row is priced request by
 * request through its `requestTokens` (#1080), in each request's own tier.
 *
 * Pure: the caller reads the rows (read-only — `server/scripts/
 * cache-savings-report.ts` opens SQLite with `readOnly: true` and prints
 * {@link CACHE_SAVINGS_SQL} for Postgres).
 */
import type { ConfigService } from "../config/config-service.js";
import { canonicalTokenCounts, type StoredTokenCounts } from "./token-tracker.js";
import { isLongPrompt, resolveRate, tierRate, type TokenRate } from "./provider-rates.js";
import { ledgerRowSummedRequests } from "./summed-requests.js";
import type { PromptCacheTtl } from "../ai/prompt-cache-ttl.js";

/** The `token_usages` columns the report reads. */
export interface LedgerCacheRow extends StoredTokenCounts {
  agentStep: string | null;
  provider: string;
  model: string;
  requestTokens: string | null;
}

/** One `agentStep` × provider × model line of the report. */
export interface CacheSavingsLine {
  /** `(none)` for rows written without a step. */
  agentStep: string;
  provider: string;
  model: string;
  calls: number;
  /** FRESH (uncached) input tokens, whatever the provider's convention. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Reads over every input token (fresh + read + write); 0 with no input. */
  readShare: number;
  /** `null` when any row of the pair is unpriced: unknown, never zero. */
  uncachedUsd: number | null;
  actualUsd: number | null;
  netSavingUsd: number | null;
}

export interface CacheSavingsOptions {
  /** Pricing config (`MODEL_PRICES`). Defaults to the process config. */
  config?: ConfigService;
  /**
   * The cache TTL the writes were made with. The ledger does not record it;
   * `ANTHROPIC_PROMPT_CACHE_TTL` (`prompt-cache-ttl.ts`) was `5m` unless set.
   */
  ttl?: PromptCacheTtl;
}

const NO_STEP = "(none)";

/** Input-side cost in cents of one request, uncached and as billed. */
function priceRequest(
  rate: TokenRate,
  counts: { fresh: number; read: number; write: number },
  ttl: PromptCacheTtl,
): { uncached: number; actual: number } {
  const flat = tierRate(
    rate,
    isLongPrompt(rate, {
      inputTokens: counts.fresh,
      outputTokens: 0,
      cacheReadTokens: counts.read,
      cacheWriteTokens: counts.write,
    }),
  );
  const input = flat.inputPer1k;
  const read = flat.cacheReadPer1k ?? input;
  const write = ttl === "1h" ? input * 2 : (flat.cacheWritePer1k ?? input);
  return {
    uncached: ((counts.fresh + counts.read + counts.write) * input) / 1000,
    actual: (counts.fresh * input + counts.read * read + counts.write * write) / 1000,
  };
}

/** Aggregate ledger rows into report lines, worst net saving first. */
export function summarizeCacheSavings(
  rows: readonly LedgerCacheRow[],
  opts: CacheSavingsOptions = {},
): CacheSavingsLine[] {
  const ttl = opts.ttl ?? "5m";
  const rates = new Map<string, TokenRate | null>();
  const rateOf = (provider: string, model: string): TokenRate | null => {
    const key = `${provider}\u0000${model}`;
    if (!rates.has(key)) {
      // `env: {}` — a row is priced by the model it recorded. The CURRENT
      // ANTHROPIC_BASE_URL says nothing about where an older row was served.
      rates.set(
        key,
        resolveRate(provider, model, { env: {}, ...(opts.config ? { config: opts.config } : {}) }),
      );
    }
    return rates.get(key)!;
  };

  const lines = new Map<
    string,
    CacheSavingsLine & { uncachedCents: number; actualCents: number; priced: boolean }
  >();
  for (const row of rows) {
    const agentStep = row.agentStep ?? NO_STEP;
    const key = `${agentStep}\u0000${row.provider}\u0000${row.model}`;
    let line = lines.get(key);
    if (!line) {
      line = {
        agentStep,
        provider: row.provider,
        model: row.model,
        calls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        readShare: 0,
        uncachedUsd: null,
        actualUsd: null,
        netSavingUsd: null,
        uncachedCents: 0,
        actualCents: 0,
        priced: true,
      };
      lines.set(key, line);
    }
    line.calls += 1;
    const rate = rateOf(row.provider, row.model);
    if (rate === null) line.priced = false;
    for (const request of ledgerRowSummedRequests(row) ?? [row]) {
      const c = canonicalTokenCounts(row.provider, request);
      const counts = {
        fresh: c.freshInputTokens,
        read: c.cacheReadTokens,
        write: c.cacheWriteTokens,
      };
      line.inputTokens += counts.fresh;
      line.cacheReadTokens += counts.read;
      line.cacheWriteTokens += counts.write;
      if (rate !== null) {
        const cost = priceRequest(rate, counts, ttl);
        line.uncachedCents += cost.uncached;
        line.actualCents += cost.actual;
      }
    }
  }

  return [...lines.values()]
    .map(({ uncachedCents, actualCents, priced, ...line }) => {
      const prompt = line.inputTokens + line.cacheReadTokens + line.cacheWriteTokens;
      return {
        ...line,
        readShare: prompt > 0 ? line.cacheReadTokens / prompt : 0,
        uncachedUsd: priced ? uncachedCents / 100 : null,
        actualUsd: priced ? actualCents / 100 : null,
        netSavingUsd: priced ? (uncachedCents - actualCents) / 100 : null,
      };
    })
    .sort(
      (a, b) =>
        (a.netSavingUsd ?? 0) - (b.netSavingUsd ?? 0) ||
        a.agentStep.localeCompare(b.agentStep) ||
        a.model.localeCompare(b.model),
    );
}

const int = (n: number) => n.toLocaleString("en-US");
const usd = (n: number | null) =>
  n === null ? "n/a" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(4)}`;

/** The report as a markdown table, with a total over the priced lines. */
export function formatCacheSavingsTable(lines: readonly CacheSavingsLine[]): string {
  const header = [
    "| agentStep | provider | model | calls | fresh input | cache read | cache write | read share | uncached | actual | net saving |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const body = lines.map(
    (l) =>
      `| ${l.agentStep} | ${l.provider} | ${l.model} | ${int(l.calls)} | ${int(l.inputTokens)} | ${int(l.cacheReadTokens)} | ${int(l.cacheWriteTokens)} | ${(l.readShare * 100).toFixed(1)}% | ${usd(l.uncachedUsd)} | ${usd(l.actualUsd)} | ${usd(l.netSavingUsd)} |`,
  );
  const priced = lines.filter((l) => l.netSavingUsd !== null);
  const sum = (f: (l: CacheSavingsLine) => number) => priced.reduce((n, l) => n + f(l), 0);
  const total = `| **total** | | | ${int(sum((l) => l.calls))} | ${int(sum((l) => l.inputTokens))} | ${int(sum((l) => l.cacheReadTokens))} | ${int(sum((l) => l.cacheWriteTokens))} | | ${usd(sum((l) => l.uncachedUsd!))} | ${usd(sum((l) => l.actualUsd!))} | ${usd(sum((l) => l.netSavingUsd!))} |`;
  const unpriced = lines.length - priced.length;
  return [
    ...header,
    ...body,
    total,
    ...(unpriced > 0
      ? ["", `${unpriced} unpriced pair(s) are listed with n/a and left out of the total.`]
      : []),
  ].join("\n");
}

/**
 * The token sums of the report as one read-only query, for a database the
 * script cannot open itself (Postgres). It does not price: pricing needs each
 * row's tier, so run the script against SQLite, or price these sums by hand.
 * Quoted identifiers, so the same text runs on SQLite and Postgres.
 */
export const CACHE_SAVINGS_SQL = `SELECT "agentStep", provider, model,
       COUNT(*) AS calls,
       SUM("inputTokens") AS input_tokens,
       SUM("cacheReadTokens") AS cache_read_tokens,
       SUM("cacheWriteTokens") AS cache_write_tokens
FROM token_usages
GROUP BY "agentStep", provider, model
ORDER BY SUM("cacheWriteTokens") DESC, SUM("inputTokens") DESC;`;
