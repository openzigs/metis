/**
 * Epic #475 follow-up (#508) → Epic #518 (#541) — pluggable rate-limit store.
 *
 * Background. The mention-notification limiter (`notify.ts`, #489) and the
 * per-(thread,user) AI-invocation limiter (`ai-rate-limit.ts`, #485) each owned
 * a private module-scoped `Map<string, number[]>`. That is **in-memory /
 * per-process**: under a multi-replica deployment (EKS HPA) the per-(thread,user)
 * cap is enforced per process, so the effective ceiling scales with replica
 * count — the cap becomes Nx (the residual risk accepted in the OWASP review,
 * ARCHITECTURE §19.1).
 *
 * #508 extracted the sliding-window mechanics behind a {@link RateLimitStore}
 * interface and shipped an in-memory default plus a process-local "shared" seam.
 * **#541 (this change)** makes the seam enforce the cap *genuinely cluster-wide*
 * by adding a {@link PostgresRateLimitStore} that runs the count-and-evaluate
 * step as a single atomic SQL statement against the shared Postgres now available
 * via #539's `DATABASE_URL`-scheme-selected Prisma adapter. A redis-wire-protocol
 * ({@link ValkeyRateLimitStore}) adapter is provided behind the same seam but is
 * **optional and not the default** — it only loads its client if explicitly
 * selected, so the default production path adds no new mandatory managed service.
 *
 * Backend ladder (selected by `DISCUSSION_RATE_LIMIT_BACKEND`):
 *
 *   - `memory`  — DEFAULT. {@link InMemoryRateLimitStore}; sliding-window log in a
 *                 module-private map. Per-process — correct only for single-replica
 *                 dev/local. Two separate instances never share state.
 *   - `shared`  — process-wide {@link InMemoryRateLimitStore} singleton. A purely
 *                 in-process seam retained for backward-compat / simulated-replica
 *                 tests; NOT cluster-safe on its own.
 *   - `postgres`— **production setting.** {@link PostgresRateLimitStore}: an atomic
 *                 windowed-counter row (`INSERT … ON CONFLICT … DO UPDATE`) keyed by
 *                 `(key, window_start)` in a self-managed UNLOGGED table. Reuses the
 *                 shared Prisma/Postgres connection — no extra failure domain. The
 *                 cap holds across every replica because the increment is one atomic
 *                 statement on one shared row.
 *   - `valkey`  — optional high-scale backend (ElastiCache/MemoryDB for Valkey, BSD,
 *                 Redis-wire-compatible — NOT Redis Ltd's relicensed Redis). Behind
 *                 the same seam; client is lazily/optionally loaded so it is never a
 *                 mandatory dependency of the default path.
 *
 * Async interface. Postgres and Valkey are I/O-bound, so the store contract is
 * **async** ({@link RateLimitStore.hit} returns a `Promise`). The in-memory
 * backends wrap their synchronous logic in resolved promises (the shared
 * {@link evaluateWindow} is still exported for the sync unit tests).
 */

/** The outcome of recording-and-evaluating one hit against a key's window. */
export interface RateLimitHitResult {
  /** True when the hit was within the cap (and was recorded). */
  allowed: boolean;
  /**
   * Number of hits in the window AFTER this call. When allowed, this includes
   * the just-recorded hit (so `max - recentCount` is the remaining budget).
   * When denied, this is the saturated count (>= `max`), and nothing was
   * recorded.
   */
  recentCount: number;
  /**
   * Timestamp (ms epoch) of the OLDEST hit still in the window (sliding-window
   * backends) or the window's start (fixed-window/counter backends), present
   * only when denied — callers use it to compute `retryAfterMs` (when the
   * window frees a slot). Undefined when allowed.
   */
  oldestTs?: number;
}

/**
 * A windowed rate-limit counter store. {@link hit} atomically evaluates the cap
 * for `key` and (when under the cap) records `now`, returning whether the hit
 * was allowed. Async because cross-replica backends (Postgres/Valkey) are
 * I/O-bound; in-memory backends resolve synchronously.
 */
export interface RateLimitStore {
  /**
   * Evaluate `key`'s window and record `now` iff under `max`.
   * @param key      opaque per-(thread,user) key
   * @param max      cap per window
   * @param windowMs window length (ms)
   * @param now      current time (ms epoch) — injected for deterministic tests
   */
  hit(key: string, max: number, windowMs: number, now: number): Promise<RateLimitHitResult>;
  /** Clear all recorded state (test helper / fresh deploy). */
  reset(): Promise<void>;
  /** Release any backend resources (connections). No-op for in-memory backends. */
  close?(): Promise<void>;
}

/**
 * Core sliding-window evaluation shared by the in-memory backends: prune
 * timestamps older than the window, then either deny (window saturated) or
 * record `now`. Mutates `recent` in place when recording and returns the list
 * to persist. Exported for the synchronous unit tests.
 */
export function evaluateWindow(
  recent: number[],
  max: number,
  windowMs: number,
  now: number,
): { result: RateLimitHitResult; persist: number[] } {
  const windowStart = now - windowMs;
  const pruned = recent.filter((ts) => ts > windowStart);

  if (pruned.length >= max) {
    return {
      result: { allowed: false, recentCount: pruned.length, oldestTs: pruned[0] },
      persist: pruned,
    };
  }
  pruned.push(now);
  return {
    result: { allowed: true, recentCount: pruned.length },
    persist: pruned,
  };
}

/**
 * Default backend: a module-private `Map<string, number[]>` of per-key
 * timestamps (sliding-window log). In-memory and per-process — two separate
 * instances never share state. This is the original limiter mechanics.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();

  /** Synchronous core — used directly by the sync unit tests. */
  hitSync(key: string, max: number, windowMs: number, now: number): RateLimitHitResult {
    const { result, persist } = evaluateWindow(this.hits.get(key) ?? [], max, windowMs, now);
    this.hits.set(key, persist);
    return result;
  }

  async hit(key: string, max: number, windowMs: number, now: number): Promise<RateLimitHitResult> {
    return this.hitSync(key, max, windowMs, now);
  }

  async reset(): Promise<void> {
    this.hits.clear();
  }
}

/**
 * Process-local "shared" seam (`DISCUSSION_RATE_LIMIT_BACKEND=shared`).
 *
 * Behaviourally identical to {@link InMemoryRateLimitStore}, but resolved as a
 * process-wide singleton ({@link resolveRateLimitStore}) so every limiter call
 * site in ONE process shares one window-state object. Retained for backward
 * compatibility and for tests that simulate two replicas by sharing one
 * instance — but it does NOT cross process boundaries, so it is not
 * cluster-safe in a real multi-replica deployment. Use `postgres` for that.
 */
export class SharedRateLimitStore extends InMemoryRateLimitStore {}

export type RateLimitBackend = "memory" | "shared" | "postgres" | "valkey";

/** Process-wide singleton for the in-process shared backend. */
let sharedSingleton: SharedRateLimitStore | undefined;
/** Process-wide singleton for the Postgres backend (one connection/setup). */
let postgresSingleton: RateLimitStore | undefined;
/** Process-wide singleton for the optional Valkey backend. */
let valkeySingleton: RateLimitStore | undefined;

/**
 * Resolve the rate-limit store backend from config. Cross-replica backends
 * (`postgres`, `valkey`) are returned as process-wide singletons so a single
 * connection/setup is reused; `memory` returns a fresh per-call instance
 * (intentional per-process isolation); `shared` returns one in-process
 * singleton.
 *
 * Unknown values fall back to the in-memory default (fail-safe: a typo never
 * silently disables limiting — it just degrades to per-process).
 */
export function resolveRateLimitStore(env: NodeJS.ProcessEnv = process.env): RateLimitStore {
  const backend = (env.DISCUSSION_RATE_LIMIT_BACKEND ?? "memory").trim().toLowerCase();
  switch (backend) {
    case "shared":
      sharedSingleton ??= new SharedRateLimitStore();
      return sharedSingleton;
    case "postgres":
      // Lazy import avoids loading the Prisma-backed store (and its DB types) in
      // the common memory-backend path / pure-logic unit tests.
      postgresSingleton ??= createPostgresRateLimitStore();
      return postgresSingleton;
    case "valkey":
      valkeySingleton ??= createValkeyRateLimitStore(env);
      return valkeySingleton;
    default:
      return new InMemoryRateLimitStore();
  }
}

/**
 * Factory indirection so {@link resolveRateLimitStore} stays free of a static
 * import of the Postgres store (which pulls in the Prisma client). Overridable
 * in tests via {@link __setPostgresStoreFactory}.
 */
let postgresStoreFactory: () => RateLimitStore = () => {
  // Local require-style dynamic import kept synchronous via a thin wrapper class
  // is not possible with ESM; instead the real factory is injected at runtime by
  // the module that owns the Prisma client. Until injected, fail loud rather than
  // silently degrade to per-process (which would defeat the cluster-wide cap).
  throw new Error(
    "DISCUSSION_RATE_LIMIT_BACKEND=postgres selected but the Postgres store factory " +
      "was not registered. Ensure rate-limit-store-postgres.ts is imported at startup.",
  );
};
let valkeyStoreFactory: (env: NodeJS.ProcessEnv) => RateLimitStore = () => {
  throw new Error(
    "DISCUSSION_RATE_LIMIT_BACKEND=valkey selected but the optional Valkey store factory " +
      "was not registered (and no redis-protocol client is installed). Install a Valkey/" +
      "redis-wire client and register the factory, or use the default `postgres` backend.",
  );
};

function createPostgresRateLimitStore(): RateLimitStore {
  return postgresStoreFactory();
}
function createValkeyRateLimitStore(env: NodeJS.ProcessEnv): RateLimitStore {
  return valkeyStoreFactory(env);
}

/** Register the Postgres-backed store factory (called once at startup). */
export function __setPostgresStoreFactory(factory: () => RateLimitStore): void {
  postgresStoreFactory = factory;
  postgresSingleton = undefined;
}
/** Register the optional Valkey store factory. */
export function __setValkeyStoreFactory(factory: (env: NodeJS.ProcessEnv) => RateLimitStore): void {
  valkeyStoreFactory = factory;
  valkeySingleton = undefined;
}

/** Test helper — drop the shared singleton so the next resolve rebuilds it. */
export function __resetSharedRateLimitStore(): void {
  void sharedSingleton?.reset();
  sharedSingleton = undefined;
  void postgresSingleton?.reset();
  postgresSingleton = undefined;
  void valkeySingleton?.reset();
  valkeySingleton = undefined;
}
