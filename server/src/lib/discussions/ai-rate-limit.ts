/**
 * Epic #475 (Phase 3, #485) — per-thread/per-user AI-invocation rate limit.
 *
 * The existing `server/src/middleware/ai-rate-limit.ts` (express-rate-limit)
 * gates the single-user `/api/ai` chat routes per USER. Discussions need a
 * finer dimension — per (thread, user) — because many users share one thread
 * and the cost risk is a single user repeatedly invoking the AI in one room.
 * Rather than bolt a second express middleware onto an SSE handler (awkward to
 * compose), this is a tiny in-memory sliding-window limiter the responder route
 * calls inline BEFORE invoking the provider, so an over-limit request makes no
 * LLM call at all.
 *
 * The window state lives behind the pluggable {@link RateLimitStore}
 * (`rate-limit-store.ts`, #508/#541): the DEFAULT backend is in-memory/per-process
 * (consistent with `presence.ts` and the in-process token-tracker aggregates),
 * and `DISCUSSION_RATE_LIMIT_BACKEND=postgres` selects the shared Postgres-backed
 * store (#541) so the cap holds *cluster-wide* across replicas (with an optional
 * Valkey backend for high scale). The cost-control guarantee (no provider call
 * when over limit) holds regardless.
 * Human↔human messages never reach this code (they don't invoke AI), so they
 * are never rate-limited.
 */
import { resolveRateLimitStore, type RateLimitStore } from "./rate-limit-store.js";

export interface ThreadAIRateLimitConfig {
  /** Max AI invocations per (thread, user) within `windowMs`. */
  max: number;
  /** Sliding-window length in milliseconds. */
  windowMs: number;
}

export interface ThreadAIRateLimitKey {
  threadId: string;
  userId: string;
}

export type ThreadAIRateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; limit: number; retryAfterMs: number };

const DEFAULT_MAX = 10;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute

const intOr = (raw: string | undefined, fallback: number, min = 1): number => {
  if (raw == null || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/**
 * Load the limiter config from env (overridable; sane defaults documented):
 *   - `DISCUSSION_AI_RATE_LIMIT_MAX`       (default 10 invocations)
 *   - `DISCUSSION_AI_RATE_LIMIT_WINDOW_MS` (default 60000 ms)
 */
export function loadThreadAIRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): ThreadAIRateLimitConfig {
  return {
    max: intOr(env.DISCUSSION_AI_RATE_LIMIT_MAX, DEFAULT_MAX),
    windowMs: intOr(env.DISCUSSION_AI_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, 1000),
  };
}

/**
 * The backing store (sliding-window mechanics). Resolved once from config; the
 * default is in-memory/per-process, `DISCUSSION_RATE_LIMIT_BACKEND=shared`
 * selects the process-wide shared-store seam (#508). Module-scoped so the
 * window persists across calls within a process.
 *
 * #60 — resolved on FIRST USE, not at import. A shared backend's factory
 * (`DISCUSSION_RATE_LIMIT_BACKEND=postgres`, production's setting) is registered by
 * `createServer()`, which runs after every module is imported; resolving here made
 * the server exit at import with "the Postgres store factory was not registered".
 */
let store: RateLimitStore | undefined;
const currentStore = (): RateLimitStore => (store ??= resolveRateLimitStore());

function keyOf(k: ThreadAIRateLimitKey): string {
  return `${k.threadId}::${k.userId}`;
}

/**
 * Record + evaluate an AI invocation for (thread, user). When allowed, the
 * current timestamp is recorded and `remaining` budget returned; when denied,
 * nothing is recorded and `retryAfterMs` (time until the oldest in-window hit
 * ages out) is returned so the caller can surface a clear retry hint.
 *
 * Pass `cfg` explicitly (the route loads it once) so this stays a pure-ish,
 * deterministic function that is trivial to fake-timer test.
 */
export async function checkThreadAIRateLimit(
  key: ThreadAIRateLimitKey,
  cfg: ThreadAIRateLimitConfig,
): Promise<ThreadAIRateLimitResult> {
  const now = Date.now();
  const res = await currentStore().hit(keyOf(key), cfg.max, cfg.windowMs, now);

  if (!res.allowed) {
    const oldest = res.oldestTs ?? now;
    const retryAfterMs = Math.max(1, oldest + cfg.windowMs - now);
    return { allowed: false, limit: cfg.max, retryAfterMs };
  }

  return { allowed: true, remaining: cfg.max - res.recentCount };
}

/**
 * Test helper — clear all recorded hits. Also re-resolves the backing store
 * from the current env so a test that sets `DISCUSSION_RATE_LIMIT_BACKEND`
 * picks up the selected backend.
 */
export function __resetThreadAIRateLimiter(): void {
  void store?.reset();
  store = resolveRateLimitStore();
}

/**
 * Inject a specific store (e.g. a shared instance) — used to simulate two
 * replicas sharing one backend in cross-instance tests. Returns the previous
 * store so callers can restore it.
 */
export function __setThreadAIRateLimitStore(next: RateLimitStore): RateLimitStore {
  const prev = currentStore();
  store = next;
  return prev;
}
