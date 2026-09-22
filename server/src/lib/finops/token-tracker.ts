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
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { computeCostCents, resolveRate } from "./provider-rates.js";

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
}

export interface RecordUsageResult {
  totalTokens: number;
  /** `null` = the model is UNPRICED (#22) — unknown spend, not zero spend. */
  costCents: number | null;
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

/**
 * Record a usage event. Returns the canonical token totals + computed cost
 * synchronously; the durable insert + Socket.IO emit run on a microtask.
 */
export function recordUsage(input: RecordUsageInput): RecordUsageResult {
  const inputTokens = sanitize(input.inputTokens);
  const outputTokens = sanitize(input.outputTokens);
  const cacheReadTokens = sanitize(input.cacheReadTokens);
  const cacheWriteTokens = sanitize(input.cacheWriteTokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  // #22 — the single pricing source; `null` for a model METIS has no price for.
  const rate = resolveRate(input.provider, input.model);
  const costCents = computeCostCents(rate, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });

  if (totalTokens === 0) {
    return { totalTokens, costCents };
  }

  pending += 1;
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
    }).finally(() => {
      pending -= 1;
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

  return { totalTokens, costCents };
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
