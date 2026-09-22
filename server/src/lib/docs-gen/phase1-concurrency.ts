/**
 * #25 — Phase-1 (per-module fact extraction) concurrency.
 *
 * Phase 1 used to walk the module list in fixed batches (`Promise.allSettled`
 * over `slice(i, i + N)`), so every batch waited for its SLOWEST module before
 * the next one started — one large module idled the other N-1 slots — and the
 * limit was a bare `process.env` read the admin UI could not see or change.
 * This keeps N extractions in flight at all times and reads the limit from the
 * config registry (db → env), so it can be tuned without a restart.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";

/** Registry key for the Phase-1 concurrency limit. */
export const PHASE1_CONCURRENCY_KEY = "DOCS_GEN_PHASE1_CONCURRENCY";

/**
 * Default in-flight Phase-1 extractions. Unchanged from the batch loop it
 * replaces (3): the bound exists for gateways with request-rate or idle-timeout
 * limits, and a provider that allows more (DeepSeek documents a 500-request
 * concurrency limit for deepseek-v4-pro) is one registry setting away.
 */
export const DEFAULT_PHASE1_CONCURRENCY = 3;

/** Upper bound on the setting — well above any gateway's useful parallelism. */
export const MAX_PHASE1_CONCURRENCY = 64;

/**
 * The configured Phase-1 concurrency, clamped to `1..MAX_PHASE1_CONCURRENCY`.
 * A missing, non-numeric or non-positive value falls back to the default.
 */
export function resolvePhase1Concurrency(config: ConfigService = getConfigService()): number {
  const raw = config.getNumber(PHASE1_CONCURRENCY_KEY, DEFAULT_PHASE1_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PHASE1_CONCURRENCY;
  return Math.min(Math.floor(raw), MAX_PHASE1_CONCURRENCY);
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight, starting the next
 * item the moment any call settles. Results are returned IN INPUT ORDER as
 * `PromiseSettledResult`s, so one failure never aborts the rest — the same
 * contract as the `Promise.allSettled` batches this replaces.
 */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onSettled?: (completed: number, total: number) => void,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      completed += 1;
      onSettled?.(completed, items.length);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
