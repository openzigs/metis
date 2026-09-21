/**
 * Epic #547 (Phase 4, #554) — per-(workspace, conversation) inbound bridge cap.
 *
 * The AI participant already has a per-(thread,user) cap (`ai-rate-limit.ts`,
 * #485) that bounds LLM cost. But a chatty/abusive Teams channel can still flood
 * METIS with plain (non-@AI) DiscussionMessages: every inbound activity does a
 * link lookup, an identity resolve, an authorization check, and a DB write +
 * realtime fan-out. This module adds a coarse INGEST cap keyed by
 * `(workspaceId, conversationId)` so one channel cannot overwhelm the bridge
 * (DoS / write-amplification — OWASP A04 "Insecure Design" / resource exhaustion).
 *
 * It reuses the SAME pluggable {@link RateLimitStore} seam (#508/#541) the AI
 * limiter uses, so the cap can hold cluster-wide when
 * `DISCUSSION_RATE_LIMIT_BACKEND=postgres`. The key namespace is prefixed
 * (`teams-inbound:`) so it never collides with the AI limiter's per-(thread,user)
 * keys in a shared store.
 *
 * The cap is intentionally PER-CONVERSATION (not per-sender): an abusive channel
 * is the threat, and a sender id is not always reliably present on every activity
 * (e.g. some channel posts). Bounding the conversation bounds the blast radius
 * regardless of how many distinct senders a hostile channel cycles through.
 */
import { resolveRateLimitStore, type RateLimitStore } from "../discussions/rate-limit-store.js";

export interface InboundRateLimitConfig {
  /** Max inbound activities per (workspace, conversation) within `windowMs`. */
  max: number;
  /** Sliding-window length in milliseconds. */
  windowMs: number;
}

export interface InboundRateLimitKey {
  workspaceId: string;
  conversationId: string;
}

export type InboundRateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; limit: number; retryAfterMs: number };

const DEFAULT_MAX = 30;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute

const intOr = (raw: string | undefined, fallback: number, min = 1): number => {
  if (raw == null || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/**
 * Load the inbound limiter config from env (overridable; sane defaults):
 *   - `TEAMS_INBOUND_RATE_LIMIT_MAX`       (default 30 activities)
 *   - `TEAMS_INBOUND_RATE_LIMIT_WINDOW_MS` (default 60000 ms)
 */
export function loadInboundRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): InboundRateLimitConfig {
  return {
    max: intOr(env.TEAMS_INBOUND_RATE_LIMIT_MAX, DEFAULT_MAX),
    windowMs: intOr(env.TEAMS_INBOUND_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, 1000),
  };
}

/**
 * The backing store (sliding-window mechanics). Resolved once from config; the
 * default is in-memory/per-process, and `DISCUSSION_RATE_LIMIT_BACKEND=postgres`
 * makes the cap hold cluster-wide. Module-scoped so the window persists across
 * calls within a process. Shares the seam with the AI limiter — the key prefix
 * keeps the namespaces disjoint.
 */
let store: RateLimitStore = resolveRateLimitStore();

function keyOf(k: InboundRateLimitKey): string {
  return `teams-inbound:${k.workspaceId}::${k.conversationId}`;
}

/**
 * Record + evaluate one inbound activity for (workspace, conversation). When
 * allowed, `now` is recorded and `remaining` budget returned; when denied,
 * nothing is recorded and `retryAfterMs` (time until the oldest in-window hit
 * ages out) is returned. `now` is injected for deterministic tests.
 */
export async function checkInboundRateLimit(
  key: InboundRateLimitKey,
  cfg: InboundRateLimitConfig,
  now: number = Date.now(),
): Promise<InboundRateLimitResult> {
  const res = await store.hit(keyOf(key), cfg.max, cfg.windowMs, now);

  if (!res.allowed) {
    const oldest = res.oldestTs ?? now;
    const retryAfterMs = Math.max(1, oldest + cfg.windowMs - now);
    return { allowed: false, limit: cfg.max, retryAfterMs };
  }

  return { allowed: true, remaining: cfg.max - res.recentCount };
}

/**
 * Test helper — clear all recorded hits and re-resolve the backing store from
 * the current env (so a test that sets `DISCUSSION_RATE_LIMIT_BACKEND` picks up
 * the selected backend).
 */
export function __resetInboundRateLimiter(): void {
  void store.reset();
  store = resolveRateLimitStore();
}

/** Inject a specific store (e.g. a shared instance) for cross-instance tests. */
export function __setInboundRateLimitStore(next: RateLimitStore): RateLimitStore {
  const prev = store;
  store = next;
  return prev;
}
