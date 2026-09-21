/**
 * #679 (epic #672) — a cluster-safe `express-rate-limit` Store.
 *
 * Every security limiter (auth, AI, connectors, jira, products, MCP admin,
 * scheduler, sandbox, uploads, the GitHub-issues webhook, …) was built with no
 * `store:` option, so `express-rate-limit` defaulted to a per-PROCESS MemoryStore:
 * under a multi-replica deploy the effective cap became `max × N replicas` per
 * window, largely defeating credential-stuffing / DoS throttling (OWASP A05).
 *
 * This backs those limiters with the SAME cluster-safe {@link RateLimitStore}
 * seam the discussion limiters already use (memory / shared / postgres / valkey,
 * selected by `DISCUSSION_RATE_LIMIT_BACKEND`; the Postgres factory is registered
 * at startup in `server.ts`). With `postgres`/`valkey` the increment is one atomic
 * statement on one shared row, so the cap holds cluster-wide.
 *
 * Fields are ECMAScript #private so the class stays structurally assignable to
 * `express-rate-limit`'s `Store` (whose index signature makes TS soft-`private`
 * members conflict).
 */
import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";
import { resolveRateLimitStore, type RateLimitStore } from "../lib/discussions/rate-limit-store.js";

const DEFAULT_WINDOW_MS = 60_000;

// A cap the windowed-counter backends never reach, so `hit` degrades to a pure
// increment-and-count: express-rate-limit itself owns the comparison against the
// real `max` of each limiter. (The backend `hit` always records and returns the
// post-increment count; passing this max just means it never self-denies.)
const NEVER_EXCEEDED_MAX = Number.MAX_SAFE_INTEGER;

export class ClusterRateLimitStore implements Store {
  /** Tells express-rate-limit the keys are NOT process-local (shared backend). */
  readonly localKeys = false;

  readonly #prefix: string;
  // Resolution is DEFERRED to the first request: these limiters are constructed at
  // module-import time, which for the `postgres` backend runs before
  // `registerPostgresRateLimitStore()` in `server.ts` — resolving eagerly would throw
  // at import. By the first increment() the factory is registered.
  readonly #resolve: () => RateLimitStore;
  // The clock every window decision reads. Injectable so a test can drive window
  // rollover deterministically instead of racing (or sleeping out) wall time —
  // the 15-minute auth window is otherwise untestable (#1288).
  readonly #now: () => number;
  #windowMs = DEFAULT_WINDOW_MS;
  #backing: RateLimitStore | undefined;

  constructor(
    prefix: string,
    resolve: () => RateLimitStore = resolveRateLimitStore,
    now: () => number = Date.now,
  ) {
    this.#prefix = prefix;
    this.#resolve = resolve;
    this.#now = now;
  }

  #store(): RateLimitStore {
    return (this.#backing ??= this.#resolve());
  }

  init(options: Options): void {
    if (Number.isFinite(options.windowMs) && options.windowMs > 0) {
      this.#windowMs = options.windowMs;
    }
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = this.#now();
    const { recentCount } = await this.#store().hit(
      `${this.#prefix}:${key}`,
      NEVER_EXCEEDED_MAX,
      this.#windowMs,
      now,
    );
    const windowEnd = Math.floor(now / this.#windowMs) * this.#windowMs + this.#windowMs;
    return { totalHits: recentCount, resetTime: new Date(windowEnd) };
  }

  // The shared backend is an append-only windowed counter: no single-hit decrement
  // or per-key reset primitive, and entries expire with the window. The security
  // limiters use neither skip*Requests (which would call decrement) nor programmatic
  // resetKey, so both are safe no-ops; resetAll is omitted because it would clear
  // EVERY limiter sharing the backend.
  async decrement(): Promise<void> {}
  async resetKey(): Promise<void> {}
}

/** Overrides for {@link clusterRateLimitStore}; every field is test-only. */
export interface ClusterRateLimitStoreOptions {
  /** Backend resolver. Defaults to the config-selected shared backend. */
  resolve?: () => RateLimitStore;
  /** Clock the window arithmetic reads. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Build a cluster-safe express-rate-limit `Store` for ONE security limiter.
 * `prefix` namespaces the per-IP counters of that limiter on the shared backend
 * so distinct limiters never collide on the same key.
 *
 * Production passes no options: the backend comes from config and the clock is
 * `Date.now`. A test passes both to get a private counter on a clock it owns.
 */
export function clusterRateLimitStore(
  prefix: string,
  options: ClusterRateLimitStoreOptions = {},
): ClusterRateLimitStore {
  return new ClusterRateLimitStore(prefix, options.resolve ?? resolveRateLimitStore, options.now);
}
