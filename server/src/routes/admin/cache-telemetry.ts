/**
 * Issue #699 (epic #696) — read-only admin readout of the in-process
 * prompt-cache hit-ratio aggregator (#390).
 *
 *   GET /api/admin/cache-telemetry → snapshot of every (callType, model) bucket
 *
 * `cache-hit-telemetry.ts` accumulates per-(callType, model) hit ratios in an
 * in-process `CacheHitAggregator` but, by original scoping, had NO way to read
 * them out (no endpoint, no dashboard). This route is that readout — and nothing
 * more: it is a live snapshot of the in-memory aggregator with **no external
 * metrics backend, no persistence, and no alert wiring** (those remain ops
 * follow-ups, per the module header and `docs/OPERATIONS.md` §7.5).
 *
 * OWASP (A01 — broken access control): the aggregator is INTERNAL operational
 * telemetry, so this route is gated to admin readers via
 * `requireAuth` + `requirePermission("admin.read")` — the identical guard the
 * sibling admin routes (`config.ts`, `embeddings.ts`) mount under. An
 * unauthenticated caller gets 401; an authenticated caller without `admin.read`
 * gets 403; neither ever sees the snapshot.
 *
 * OWASP (A09 — sensitive data in telemetry): the model identifiers in the
 * aggregator are ALREADY ARN-redacted at write time (`recordCacheHit` →
 * `redactModelForLog`), so the response can only ever contain safe model IDs and
 * integer token counts — never an API key, `Authorization` header, or a full
 * inference-profile ARN.
 *
 * READS vs WRITES: the OpenAI-compatible gateway path reports cache READS only,
 * so `cacheWriteTokens` is `0` and `readWriteRatio` is `null` on that path. The
 * native Anthropic path additionally reports `cache_creation_input_tokens`,
 * which — when recorded — populates the reads-per-write ratio, the cross-region
 * cache-fragmentation signal called out in epic #696.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/require-permission.js";
import {
  getCacheHitAggregator,
  computeCacheHitRatio,
  computeReadWriteRatio,
  type CacheHitStats,
} from "../../lib/ai/cache-hit-telemetry.js";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

/** One (callType, model) row in the snapshot response. */
interface CacheTelemetryBucketView {
  callType: string;
  model: string;
  calls: number;
  promptTokens: number;
  cacheReadTokens: number;
  /** Cache creation tokens; `0` on the gateway path (reads-only). */
  cacheWriteTokens: number;
  /** Read-based hit ratio in `[0, 1]` (`cacheReadTokens / promptTokens`). */
  hitRatio: number;
  /**
   * Reads-per-write ratio (`cacheReadTokens / cacheWriteTokens`), or `null` when
   * no cache writes were recorded (the gateway path never surfaces creation).
   */
  readWriteRatio: number | null;
}

function toBucketView(s: CacheHitStats): CacheTelemetryBucketView {
  return {
    callType: s.callType,
    model: s.model,
    calls: s.calls,
    promptTokens: s.sumPromptTokens,
    cacheReadTokens: s.sumCacheReadTokens,
    cacheWriteTokens: s.sumCacheWriteTokens,
    hitRatio: s.hitRatio,
    readWriteRatio: computeReadWriteRatio(s.sumCacheReadTokens, s.sumCacheWriteTokens),
  };
}

export function cacheTelemetryRouter(): Router {
  const r = Router();

  // GET /  → live snapshot of every (callType, model) bucket + rolled-up totals.
  r.get(
    "/",
    requireAuth,
    requirePermission("admin.read"),
    (_req: Request, res: Response, next: NextFunction) => {
      try {
        const snapshots = getCacheHitAggregator().allSnapshots();
        const buckets = snapshots.map(toBucketView);

        // Rolled-up totals across every bucket — the fragmentation signal is
        // most meaningful in aggregate. hitRatio/readWriteRatio are recomputed
        // from the summed tokens (not averaged) so they stay weighted correctly.
        const sum = snapshots.reduce(
          (acc, s) => {
            acc.calls += s.calls;
            acc.promptTokens += s.sumPromptTokens;
            acc.cacheReadTokens += s.sumCacheReadTokens;
            acc.cacheWriteTokens += s.sumCacheWriteTokens;
            return acc;
          },
          { calls: 0, promptTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        );

        res.json(
          ok({
            generatedAt: new Date().toISOString(),
            buckets,
            totals: {
              ...sum,
              hitRatio: computeCacheHitRatio(sum.cacheReadTokens, sum.promptTokens),
              readWriteRatio: computeReadWriteRatio(sum.cacheReadTokens, sum.cacheWriteTokens),
            },
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
