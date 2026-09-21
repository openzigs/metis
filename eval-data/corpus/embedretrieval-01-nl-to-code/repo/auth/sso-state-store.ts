/**
 * Epic #518 (#542) — pluggable SSO transaction-state store.
 *
 * Background. SSO login is a two-leg flow: the *initiate* leg (`GET
 * /auth/oidc/login`) mints per-transaction state — the PKCE `codeVerifier`, the
 * OIDC `nonce`, and the CSRF `state` value — and stashes it; the *callback* leg
 * (`GET /auth/oidc/callback`) looks that state back up by `state` to finish the
 * PKCE + nonce verification. `sso.ts` originally held this in a module-scoped
 * `Map<string, …>` (`oidcSessions`). That is **in-memory / per-process**: under
 * a multi-replica deployment (EKS HPA, a load balancer in front of N pods) the
 * initiate request can land on replica A and the callback on replica B. Replica
 * B has no entry for that `state`, so the lookup misses and the login fails
 * intermittently — the bug #542 fixes.
 *
 * This module extracts the store behind a {@link SSOStateStore} seam with the
 * same consume-once + TTL semantics the Map had, and adds a cluster-safe
 * {@link PostgresSSOStateStore} (in sso-state-store-postgres.ts) selected by
 * `SSO_STATE_BACKEND=postgres`. It mirrors the #541 rate-limit-store design:
 * a self-managed table created idempotently behind an advisory lock, reusing the
 * shared Postgres from #539's `DATABASE_URL`-scheme-selected Prisma adapter — no
 * new managed service, no Prisma schema migration.
 *
 * Backend ladder (selected by `SSO_STATE_BACKEND`):
 *
 *   - `memory`  — DEFAULT. {@link InMemorySSOStateStore}; a module-private Map.
 *                 Per-process — correct only for single-replica dev/local.
 *   - `postgres`— **production / multi-replica setting.** {@link PostgresSSOStateStore}:
 *                 a self-managed table keyed by `state`, with an atomic
 *                 `DELETE … RETURNING` consume so a `state` can be redeemed at
 *                 most once across the whole cluster (replay-safe), and a stored
 *                 `expires_at` so expired entries are rejected and pruned.
 *
 * Unknown values fall back to the in-memory default (fail-safe: a typo degrades
 * to per-process rather than crashing the auth routes). Selecting `postgres`
 * without a registered factory fails loud — silently degrading to per-process
 * would re-introduce the very cross-replica bug this change fixes.
 *
 * Security note. The stored payload (`codeVerifier`, `nonce`) is sensitive: it
 * is the PKCE secret and the nonce that bind the callback to the initiate leg.
 * It is keyed by the high-entropy `state` value, never logged, consumed exactly
 * once, and expired on a short TTL — preserving the OIDC `state`+`nonce` and
 * PKCE verification the in-memory version provided.
 */

/** The per-transaction SSO state stashed at initiate and read back at callback. */
export interface SSOStatePayload {
  /** PKCE code_verifier — secret; verified against the code_challenge at callback. */
  codeVerifier: string;
  /** OIDC nonce — bound into the ID token and checked at callback. */
  nonce: string;
  /**
   * SSO mode this state belongs to. Lets one store serve OIDC today and SAML
   * (`InResponseTo`/request-id, Epic #517) later without colliding key spaces.
   */
  mode: "oidc" | "saml";
}

/** Internal stored record: the payload plus its absolute expiry (ms epoch). */
interface StoredEntry {
  payload: SSOStatePayload;
  expiresAt: number;
}

/**
 * A replica-safe, consume-once SSO transaction-state store.
 *
 * - {@link put} stashes `payload` under `state` with a TTL.
 * - {@link consume} atomically reads-and-deletes the entry for `state`, so a
 *   given `state` can be redeemed at most once (replay protection) and is gone
 *   afterwards. Returns `null` for unknown / already-consumed / expired state.
 *
 * Both are async because the cluster-safe backend (Postgres) is I/O-bound; the
 * in-memory backend resolves synchronously.
 */
export interface SSOStateStore {
  /**
   * Stash `payload` under the CSRF `state` key, expiring after `ttlMs`.
   * @param now current time (ms epoch) — injected for deterministic tests.
   */
  put(state: string, payload: SSOStatePayload, ttlMs: number, now?: number): Promise<void>;
  /**
   * Atomically read-and-delete the entry for `state`. Returns the payload iff a
   * non-expired entry existed; `null` otherwise (unknown / consumed / expired).
   * The delete is part of the same atomic step so concurrent callbacks racing
   * the same `state` cannot both succeed (single-use).
   * @param now current time (ms epoch) — injected for deterministic tests.
   */
  consume(state: string, now?: number): Promise<SSOStatePayload | null>;
  /** Clear all state (test helper / fresh deploy). */
  reset(): Promise<void>;
  /** Release any backend resources (connections). No-op for in-memory backends. */
  close?(): Promise<void>;
}

/**
 * Default backend: a module-private `Map<state, StoredEntry>`. In-memory and
 * per-process — two separate instances never share state, which is exactly the
 * single-replica dev/local behaviour the original `oidcSessions` Map had.
 *
 * Consume-once is enforced by deleting on read; expiry is enforced lazily on
 * `consume` (an expired hit returns `null` and is removed) and opportunistically
 * swept on `put` so the map cannot grow without bound from abandoned logins.
 */
export class InMemorySSOStateStore implements SSOStateStore {
  private readonly entries = new Map<string, StoredEntry>();

  async put(
    state: string,
    payload: SSOStatePayload,
    ttlMs: number,
    now = Date.now(),
  ): Promise<void> {
    this.sweep(now);
    this.entries.set(state, { payload, expiresAt: now + ttlMs });
  }

  async consume(state: string, now = Date.now()): Promise<SSOStatePayload | null> {
    const entry = this.entries.get(state);
    if (!entry) return null;
    // Consume-once: delete regardless of expiry so a stale entry can't linger
    // and a redeemed one can't be replayed.
    this.entries.delete(state);
    if (entry.expiresAt <= now) return null;
    return entry.payload;
  }

  async reset(): Promise<void> {
    this.entries.clear();
  }

  /** Drop entries whose TTL has elapsed. Cheap; bounds the map size. */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export type SSOStateBackend = "memory" | "postgres";

/** Process-wide singleton for the Postgres backend (one connection/setup). */
let postgresSingleton: SSOStateStore | undefined;

/**
 * Resolve the SSO-state store backend from config. The cross-replica backend
 * (`postgres`) is returned as a process-wide singleton so a single
 * connection/table-bootstrap is reused; `memory` returns a fresh per-call
 * instance (intentional per-process isolation — and per-process is all the
 * default is for).
 *
 * Unknown values fall back to the in-memory default (fail-safe).
 */
export function resolveSSOStateStore(env: NodeJS.ProcessEnv = process.env): SSOStateStore {
  const backend = (env.SSO_STATE_BACKEND ?? "memory").trim().toLowerCase();
  switch (backend) {
    case "postgres":
      postgresSingleton ??= createPostgresSSOStateStore();
      return postgresSingleton;
    default:
      return new InMemorySSOStateStore();
  }
}

/**
 * Factory indirection so {@link resolveSSOStateStore} stays free of a static
 * import of the Postgres store (which pulls in the Prisma client). The real
 * factory is injected at runtime by the module that owns the Prisma client.
 * Until injected, fail loud rather than silently degrade to per-process — that
 * would re-introduce the cross-replica login bug #542 fixes.
 */
let postgresStoreFactory: () => SSOStateStore = () => {
  throw new Error(
    "SSO_STATE_BACKEND=postgres selected but the Postgres SSO-state store factory " +
      "was not registered. Ensure sso-state-store-postgres.ts is imported at startup.",
  );
};

function createPostgresSSOStateStore(): SSOStateStore {
  return postgresStoreFactory();
}

/** Register the Postgres-backed store factory (called once at startup). */
export function __setPostgresSSOStateStoreFactory(factory: () => SSOStateStore): void {
  postgresStoreFactory = factory;
  postgresSingleton = undefined;
}

/** Test helper — drop the resolved singleton so the next resolve rebuilds it. */
export function __resetSSOStateStore(): void {
  void postgresSingleton?.reset();
  postgresSingleton = undefined;
}
