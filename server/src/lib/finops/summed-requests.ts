/**
 * #1080 — the requests a SUMMED usage row is made of.
 *
 * A `token_usages` / `ai_token_usages` row is NOT always one model request: a
 * chat turn that runs a tool loop, a discussion reply and a failed-turn row
 * record every request of the turn as ONE row holding their sum. A model priced
 * by prompt length (Claude Haiku 5.5) bills each REQUEST in one tier, so such a
 * row must be priced request by request, never from its summed counts: four
 * 30,000-token requests cost 1.4 cents, and 7 cents priced as one
 * 120,000-token request.
 *
 * Kept apart from `token-tracker.ts` (which writes the ledger) so the per-user
 * tracker in `lib/ai/token-tracker.ts` can use the same rule.
 */
import { createChildLogger } from "../logger.js";
import type { StoredTokenCounts } from "./token-tracker.js";

const log = createChildLogger("finops-summed-requests");

/** One model request's token counts, in the provider's own convention. */
export interface RequestTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

/**
 * A turn's model calls (`TokenUsage` field names) in the project ledger's field
 * names, for `recordUsage({ requests })`.
 */
export function ledgerRequests(
  calls: ReadonlyArray<{
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  }>,
): RequestTokenCounts[] {
  return calls.map((c) => ({
    inputTokens: c.promptTokens,
    outputTokens: c.completionTokens,
    cacheReadTokens: c.cacheReadTokens,
    cacheWriteTokens: c.cacheWriteTokens,
  }));
}

const sanitize = (n: unknown): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.min(Math.max(0, Math.trunc(n)), Number.MAX_SAFE_INTEGER);
};

const COUNT_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

/**
 * The requests a SUMMED row is made of, or `null` when the row is one request:
 * fewer than two were given, or they do not add up to `total` (then nothing
 * says which tokens belong to which request, and the row is priced as one —
 * the behaviour before #1080).
 */
export function summedRequests(
  total: StoredTokenCounts,
  requests: readonly RequestTokenCounts[] | null | undefined,
): StoredTokenCounts[] | null {
  if (!requests || requests.length < 2) return null;
  const clean = requests.map((r) => ({
    inputTokens: sanitize(r.inputTokens),
    outputTokens: sanitize(r.outputTokens),
    cacheReadTokens: sanitize(r.cacheReadTokens),
    cacheWriteTokens: sanitize(r.cacheWriteTokens),
  }));
  const addsUp = COUNT_KEYS.every((k) => clean.reduce((n, r) => n + r[k], 0) === total[k]);
  if (!addsUp) {
    log.debug("A summed usage row's requests do not add up to it; priced as one request", {
      requests: clean.length,
    });
    return null;
  }
  return clean;
}

/** #1080 — the `token_usages.requestTokens` value for a summed row's requests. */
export function encodeRequestTokens(requests: readonly StoredTokenCounts[]): string {
  return JSON.stringify(requests.map((r) => COUNT_KEYS.map((k) => r[k])));
}

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * #1080 — the requests a stored `token_usages` row sums, from its
 * `requestTokens` column; `null` when the row is one request (the column is
 * NULL — every row written before #1080 and every single-request row) or the
 * value is not what {@link encodeRequestTokens} writes. Never throws.
 */
export function ledgerRowRequests(row: {
  requestTokens?: string | null;
}): StoredTokenCounts[] | null {
  if (!row.requestTokens) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.requestTokens);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  const out: StoredTokenCounts[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== COUNT_KEYS.length || !entry.every(isCount)) {
      return null;
    }
    const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = entry as number[];
    out.push({
      inputTokens: inputTokens!,
      outputTokens: outputTokens!,
      cacheReadTokens: cacheReadTokens!,
      cacheWriteTokens: cacheWriteTokens!,
    });
  }
  return out;
}

/**
 * #1080 — {@link ledgerRowRequests}, held to the same rule the writer applies:
 * the stored list counts only when it adds up to the row's own columns.
 * Readers that re-price from stored tokens use THIS, so a list that no longer
 * matches its row (a hand edit, a bad restore, a backfill of the token
 * columns) prices the row as one request instead of replacing its counts.
 */
export function ledgerRowSummedRequests(
  row: StoredTokenCounts & { requestTokens?: string | null },
): StoredTokenCounts[] | null {
  return summedRequests(row, ledgerRowRequests(row));
}
