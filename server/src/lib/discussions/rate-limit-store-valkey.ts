/**
 * Epic #518 (#541) — OPTIONAL Valkey (redis-wire-protocol) rate-limit store.
 *
 * This is the *high-scale* rung of the backend ladder, behind the SAME seam as
 * the Postgres default (see rate-limit-store.ts). It is **not** the default and
 * is **not** a mandatory dependency:
 *
 *   - METIS ships NO redis/valkey client in its dependency tree. This adapter is
 *     written against a tiny structural {@link RedisWireClient} interface so it
 *     compiles with zero new deps. To actually use it in production you install a
 *     redis-wire client (e.g. `iovalkey`/`ioredis`) and pass it in (or register a
 *     factory) — selecting `DISCUSSION_RATE_LIMIT_BACKEND=valkey` without one
 *     fails loud rather than silently degrading to per-process.
 *   - "Valkey", not "Redis": Redis Ltd relicensed Redis in 2024 (RSALv2/SSPL;
 *     Redis 8 → AGPLv3 — not OSI open source). Valkey is the Linux-Foundation BSD
 *     fork, available on AWS as ElastiCache / MemoryDB for Valkey (~20–33% cheaper)
 *     and wire-compatible, so the same client works. Only reach for it if the
 *     Postgres envelope is exceeded or a cache/pub-sub is already in the stack.
 *
 * Algorithm — atomic fixed-window counter via a single server-side EVAL (Lua):
 *   INCR a per-(key, window) counter and set its TTL on first touch, all in one
 *   atomic script so concurrent replicas are serialized by the single-threaded
 *   Valkey command loop. Returns the post-increment count; the cap holds
 *   cluster-wide for the same reason the Postgres upsert does — one shared,
 *   atomically-mutated counter.
 */
import {
  __setValkeyStoreFactory,
  type RateLimitHitResult,
  type RateLimitStore,
} from "./rate-limit-store.js";

/**
 * Minimal structural subset of a redis-wire client (ioredis / iovalkey shaped).
 * Declared locally so this module needs no runtime dependency. A real client
 * satisfies this without modification.
 */
export interface RedisWireClient {
  /** EVAL a Lua script: `eval(script, numkeys, ...keysAndArgs)`. */
  eval(script: string, numkeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** Delete keys (used by reset/tests). */
  del(...keys: string[]): Promise<unknown>;
  /** Optional: enumerate keys for reset (best-effort). */
  keys?(pattern: string): Promise<string[]>;
  /** Optional graceful shutdown. */
  quit?(): Promise<unknown>;
}

/** Key prefix so the limiter's keys are namespaced within a shared Valkey. */
const KEY_PREFIX = "metis:disc:rl:";

/**
 * Atomic fixed-window counter Lua. KEYS[1] = window key; ARGV[1] = window TTL
 * (seconds). INCR, set TTL on first touch, return the new count.
 */
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return c
`;

/** Valkey/redis-wire-protocol backed atomic fixed-window counter store. */
export class ValkeyRateLimitStore implements RateLimitStore {
  constructor(private readonly client: RedisWireClient) {}

  private windowKey(key: string, windowStart: number): string {
    return `${KEY_PREFIX}${key}:${windowStart}`;
  }

  async hit(key: string, max: number, windowMs: number, now: number): Promise<RateLimitHitResult> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const redisKey = this.windowKey(key, windowStart);

    const raw = await this.client.eval(INCR_SCRIPT, 1, redisKey, windowMs);
    const count = Number(raw ?? 0);

    if (count > max) {
      return { allowed: false, recentCount: count, oldestTs: windowStart };
    }
    return { allowed: true, recentCount: count };
  }

  async reset(): Promise<void> {
    if (typeof this.client.keys === "function") {
      const keys = await this.client.keys(`${KEY_PREFIX}*`);
      if (keys.length > 0) await this.client.del(...keys);
    }
  }

  async close(): Promise<void> {
    await this.client.quit?.();
  }
}

/**
 * Register the optional Valkey store factory with the resolver seam. Pass a
 * redis-wire client (or a builder) — the resolver only invokes it when
 * `DISCUSSION_RATE_LIMIT_BACKEND=valkey` is selected.
 */
export function registerValkeyRateLimitStore(
  build: (env: NodeJS.ProcessEnv) => RedisWireClient,
): void {
  __setValkeyStoreFactory((env) => new ValkeyRateLimitStore(build(env)));
}
