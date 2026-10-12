/**
 * Per-project token + cost telemetry tracker (Epic #164).
 *
 * Distinct from the existing `lib/ai/token-tracker.ts` which feeds the
 * per-user/per-day rollup table. This one writes to the new `TokenUsage`
 * model (one row per provider call) and emits a `usage:tick` event to the
 * `project:{id}` Socket.IO room so the UI usage page updates live.
 *
 * The recorder is non-blocking: persistence runs on a microtask. Failures
 * are logged but never surface to the caller — accounting must never crash
 * a chat run.
 */
import { conventionForProvider, normalizeTokenUsage } from "../ai/cache-verification.js";
import type { UsageProvider } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import {
  computeCostCents,
  computeCostCentsExact,
  isLongPrompt,
  resolveRate,
  tierRate,
  type TokenRate,
} from "./provider-rates.js";
import {
  encodeRequestTokens,
  ledgerRowRequests,
  summedRequests,
  type RequestTokenCounts,
} from "./summed-requests.js";

export { encodeRequestTokens, ledgerRowRequests, summedRequests, type RequestTokenCounts };

const log = createChildLogger("finops-token-tracker");

export interface RecordUsageInput {
  projectId: string;
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** #792 — the user the call is billed to, when the caller knows one. */
  userId?: string;
  /** #792 — the pipeline step that spent the tokens, for "by agent step". */
  agentStep?: string;
  /**
   * #1080 — for a caller that records the SUM of several model requests as one
   * row (a chat turn that ran a tool loop, a discussion reply): each request's
   * own counts, which must add up to the counts above. The row is then priced
   * request by request and stores them ({@link summedRequests}). Omit it when
   * the counts above are one request's.
   */
  requests?: readonly RequestTokenCounts[];
}

export interface RecordUsageResult {
  totalTokens: number;
  /** `null` = the model is UNPRICED (#22) — unknown spend, not zero spend. */
  costCents: number | null;
  /**
   * #761 — the call's unrounded cost in USD (`null` when unpriced). `costCents`
   * rounds to the cent, so a sub-cent call reads 0 there; this does not.
   */
  costUsd: number | null;
  /**
   * Settles once the row is written (or the write failed — `persist` logs and
   * swallows). Never rejects. #724 — lets a caller that reads `token_usages`
   * back (a run's cost) wait for its own writes instead of racing them.
   */
  persisted: Promise<void>;
}

// Socket emitter — set via `setUsageEmitter()` so we don't pull a transitive
// dep on the Socket.IO server type from the FinOps unit tests.
type Emitter = (
  projectId: string,
  payload: {
    projectId: string;
    sessionId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCents: number | null;
    ts: number;
  },
) => void;

let emitter: Emitter | null = null;

export function setUsageEmitter(fn: Emitter | null): void {
  emitter = fn;
}

let pending = 0;
export function getPendingUsageWrites(): number {
  return pending;
}

const sanitize = (n: unknown): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.min(Math.max(0, Math.trunc(n)), Number.MAX_SAFE_INTEGER);
};

/** The four token counts a `token_usages` row stores, in the provider's own convention. */
export interface StoredTokenCounts {
  /** The provider-reported prompt count — see {@link canonicalTokenCounts}. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One call's tokens with every token in exactly one bucket. */
export interface CanonicalTokenCounts {
  /** Uncached input, billed at the input rate. */
  freshInputTokens: number;
  outputTokens: number;
  /** Billed at the cache-read rate. */
  cacheReadTokens: number;
  /** Billed at the cache-write rate. Always 0 on the OpenAI-compatible convention. */
  cacheWriteTokens: number;
  /** Full prompt + output, each cached token counted once. */
  totalTokens: number;
}

/**
 * #179 / #248 / #264 — the ONE place `token_usages` counts are made disjoint.
 * `recordUsage`, the agent-run cost (`replay/runs-service.ts`) and the budget
 * ceiling's re-pricing (`budget-enforcer.ts`) all go through here, so the three
 * cannot disagree about a call.
 *
 * `inputTokens` is stored AS REPORTED (#248 decision): on native `anthropic`
 * it excludes the cache fields; on every OpenAI-compatible provider (the
 * Bedrock gateway, `openai`, `azure`, local runtimes) the prompt count already
 * INCLUDES the cache reads, so the fresh share is the prompt minus the reads.
 *
 * Cache writes on the OpenAI-compatible convention (#264 decision): priced at 0
 * as a SEPARATE line, because whatever a provider charges to write the cache is
 * inside `prompt_tokens` and is therefore already billed, once, at the input
 * rate. No METIS OpenAI-compatible client reads a write field today (they
 * record `cacheWriteTokens: 0`). What this leaves unbilled is only a write
 * PREMIUM over the input rate — including on the Bedrock gateway, whose Claude
 * models charge 1.25x the input rate to write, so every gateway cache write is
 * under-billed by 0.25x. That premium cannot be priced (#282): the gateway
 * (aws-samples/bedrock-access-gateway, upstream 144c4bc) discards Bedrock's
 * `cacheWriteInputTokens` and returns no write field, and its
 * `prompt_tokens` combines fresh, read and written input, so nothing separates the
 * writes. Pricing it needs a provider that reports writes, and the fresh share
 * to subtract them.
 */
export function canonicalTokenCounts(
  provider: string,
  counts: StoredTokenCounts,
): CanonicalTokenCounts {
  const normalized = normalizeTokenUsage(
    {
      promptTokens: counts.inputTokens,
      completionTokens: counts.outputTokens,
      totalTokens: 0,
      cacheReadTokens: counts.cacheReadTokens,
      cacheWriteTokens: counts.cacheWriteTokens,
    },
    conventionForProvider(provider as UsageProvider),
  );
  const outputTokens = sanitize(counts.outputTokens);
  return {
    freshInputTokens: normalized.freshInputTokens,
    outputTokens,
    cacheReadTokens: normalized.cacheReadTokens,
    cacheWriteTokens: normalized.cacheWriteTokens,
    totalTokens: normalized.totalPromptTokens + outputTokens,
  };
}

/** Price canonical counts; `null` when the model is unpriced (#22). */
export function priceCanonicalTokens(
  rate: TokenRate | null,
  counts: CanonicalTokenCounts,
): number | null {
  return computeCostCents(rate, canonicalCostUsage(counts));
}

/**
 * #761 — {@link priceCanonicalTokens} without the per-call rounding to the
 * cent: the unrounded cost in cents, or `null` when the model is unpriced.
 */
export function priceCanonicalTokensExact(
  rate: TokenRate | null,
  counts: CanonicalTokenCounts,
): number | null {
  return rate === null ? null : computeCostCentsExact(rate, canonicalCostUsage(counts));
}

function canonicalCostUsage(counts: CanonicalTokenCounts) {
  return {
    inputTokens: counts.freshInputTokens,
    outputTokens: counts.outputTokens,
    cacheReadTokens: counts.cacheReadTokens,
    cacheWriteTokens: counts.cacheWriteTokens,
  };
}

/** The tokens of a row that bill in one price tier of its model. */
export interface TierShare {
  /** True for the share from requests over the rate's prompt-length threshold. */
  longPrompt: boolean;
  counts: CanonicalTokenCounts;
}

/**
 * #1080 — a row's tokens as the share each price tier bills. One share, the
 * whole row, when the rate has no prompt-length tier or the row is one request
 * (`requests` null) — so every other model is priced exactly as before. For a
 * summed row on a tiered rate, each request is put in the tier ITS prompt falls
 * in and the tiers are summed apart.
 */
export function ledgerTierShares(
  provider: string,
  rate: TokenRate | null,
  counts: StoredTokenCounts,
  requests: readonly StoredTokenCounts[] | null,
): TierShare[] {
  if (!rate?.longPrompt || !requests) {
    const canonical = canonicalTokenCounts(provider, counts);
    return [
      {
        longPrompt: rate !== null && isLongPrompt(rate, canonicalCostUsage(canonical)),
        counts: canonical,
      },
    ];
  }
  const shares = new Map<boolean, CanonicalTokenCounts>();
  for (const request of requests) {
    // #264 — each request's counts are made disjoint BEFORE summing.
    const c = canonicalTokenCounts(provider, request);
    const longPrompt = isLongPrompt(rate, canonicalCostUsage(c));
    const s = shares.get(longPrompt);
    shares.set(
      longPrompt,
      s
        ? {
            freshInputTokens: s.freshInputTokens + c.freshInputTokens,
            outputTokens: s.outputTokens + c.outputTokens,
            cacheReadTokens: s.cacheReadTokens + c.cacheReadTokens,
            cacheWriteTokens: s.cacheWriteTokens + c.cacheWriteTokens,
            totalTokens: s.totalTokens + c.totalTokens,
          }
        : c,
    );
  }
  return [...shares].map(([longPrompt, c]) => ({ longPrompt, counts: c }));
}

/**
 * #1080 — the unrounded cost in cents of a row's tokens, each request in its
 * own price tier ({@link ledgerTierShares}); `null` when the model is unpriced
 * (#22). THE way to price a row from its tokens: `recordUsage`, and every
 * reader that re-prices a stored row.
 */
export function priceLedgerTokensExact(
  provider: string,
  rate: TokenRate | null,
  counts: StoredTokenCounts,
  requests: readonly StoredTokenCounts[] | null,
): number | null {
  if (rate === null) return null;
  return ledgerTierShares(provider, rate, counts, requests).reduce(
    (cents, share) =>
      cents +
      computeCostCentsExact(tierRate(rate, share.longPrompt), canonicalCostUsage(share.counts)),
    0,
  );
}

/**
 * Record a usage event. Returns the canonical token totals + computed cost
 * synchronously; the durable insert + Socket.IO emit run on a microtask.
 */
export function recordUsage(input: RecordUsageInput): RecordUsageResult {
  const inputTokens = sanitize(input.inputTokens);
  const outputTokens = sanitize(input.outputTokens);
  const cacheReadTokens = sanitize(input.cacheReadTokens);
  const cacheWriteTokens = sanitize(input.cacheWriteTokens);
  // #179 — price the fresh (uncached) input, not the reported prompt count,
  // exactly as `estimateUsageCostUsd` does for `ai_token_usages`, so the two
  // usage tables agree on one call. #248 — and count each token once.
  const canonical = canonicalTokenCounts(input.provider, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
  const totalTokens = canonical.totalTokens;
  // #22 — the single pricing source; `null` for a model METIS has no price for.
  // #761 — priced ONCE, unrounded; `costCents` is the same figure to the cent.
  // #1080 — a row that sums several requests is priced request by request.
  const stored = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  const requests = summedRequests(stored, input.requests);
  const exactCents = priceLedgerTokensExact(
    input.provider,
    resolveRate(input.provider, input.model),
    stored,
    requests,
  );
  const costCents = exactCents === null ? null : Math.round(exactCents);
  const costUsd = exactCents === null ? null : exactCents / 100;

  if (totalTokens === 0) {
    return { totalTokens, costCents, costUsd, persisted: Promise.resolve() };
  }

  pending += 1;
  let settle!: () => void;
  const persisted = new Promise<void>((res) => {
    settle = res;
  });
  queueMicrotask(() => {
    void persist({
      projectId: input.projectId,
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costCents,
      costUsd,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.agentStep ? { agentStep: input.agentStep } : {}),
      ...(requests ? { requestTokens: encodeRequestTokens(requests) } : {}),
    }).finally(() => {
      pending -= 1;
      settle();
    });
  });

  if (emitter) {
    try {
      emitter(input.projectId, {
        projectId: input.projectId,
        sessionId: input.sessionId,
        provider: input.provider,
        model: input.model,
        inputTokens,
        outputTokens,
        totalTokens,
        costCents,
        ts: Date.now(),
      });
    } catch (err) {
      log.warn("usage:tick emit failed", { error: (err as Error).message });
    }
  }

  return { totalTokens, costCents, costUsd, persisted };
}

/** Awaitable variant for tests. */
export async function recordUsageAndFlush(input: RecordUsageInput): Promise<RecordUsageResult> {
  const r = recordUsage(input);
  while (pending > 0) {
    await new Promise<void>((res) => setImmediate(res));
  }
  return r;
}

async function persist(row: {
  projectId: string;
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costCents: number | null;
  costUsd: number | null;
  userId?: string;
  agentStep?: string;
  requestTokens?: string;
}): Promise<void> {
  try {
    await prisma.tokenUsage.create({ data: row });
  } catch (err) {
    log.error("TokenUsage persist failed", {
      projectId: row.projectId,
      provider: row.provider,
      error: (err as Error).message,
    });
  }
}
