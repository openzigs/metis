/**
 * Epic #517 (#520) — SAML request-id cache for `validateInResponseTo` replay
 * protection.
 *
 * Background. `@node-saml/node-saml` v5 implements SAML replay/`InResponseTo`
 * protection through a {@link CacheProvider}: when it mints an AuthnRequest it
 * `saveAsync(requestId, instant)`s the request id; when the IdP's Response comes
 * back it `getAsync(InResponseTo)` — a miss (unknown / expired) is rejected — and
 * then `removeAsync(InResponseTo)` so the id is single-use. A *replayed* Response
 * carries an `InResponseTo` that was already removed on first use, so the second
 * presentation misses and is rejected. (See node-saml `saml.js`:
 * `mustValidateInResponseTo` -> save on generate, get+remove on validate.)
 *
 * Why a NEW cache (and not the #542 `SSOStateStore`). The #542 store is
 * *consume-once*: its `consume()` deletes-on-read in a single step. node-saml's
 * `CacheProvider` contract is different and cannot be expressed with that store:
 * it needs a NON-destructive `getAsync` followed by a SEPARATE `removeAsync`,
 * plus `saveAsync` that returns `null` when the key already exists, plus
 * createdAt-based expiry (`requestIdExpirationPeriodMs`). So we implement the
 * library's real interface here. We DO honour #542's intent — the multi-replica
 * fix — by giving the Postgres backend the SAME shared-Postgres design #542 uses
 * (the `DATABASE_URL`-scheme-selected Prisma adapter from #539, a self-managed
 * UNLOGGED table created behind an advisory lock, no Prisma schema migration).
 * The #542 `SSOStatePayload.mode: "saml"` reservation marked exactly this work.
 *
 * Why this matters in production. METIS now runs multiple replicas (Epic #518).
 * node-saml's bundled `InMemoryCacheProvider` is per-process — its own docs say
 * it is NOT sufficient behind a load balancer: the AuthnRequest can be generated
 * on pod A and the Response validated on pod B, where the request id was never
 * saved, so EITHER every login fails (`always`) OR replay protection silently
 * does nothing for the cross-pod case. The {@link PostgresSamlRequestIdCache}
 * backend (selected by `SAML_REQUEST_ID_CACHE_BACKEND=postgres`) shares the id
 * across pods so `validateInResponseTo` works cluster-wide.
 *
 * Security. The stored value is a non-secret timestamp string (`instant`) keyed
 * by the high-entropy request id; nothing sensitive is logged. Writes use
 * parameterised queries only (OWASP A03). Single-use + TTL bound the replay
 * window (OWASP A07).
 */
import type { CacheItem, CacheProvider } from "@node-saml/passport-saml";

/**
 * Default request-id TTL (ms). Mirrors node-saml's own 8h default for
 * `requestIdExpirationPeriodMs`; an AuthnRequest older than this can no longer be
 * matched, bounding the replay window and keeping the table small. Exported so
 * the provider and the Postgres backend agree on one value.
 */
export const DEFAULT_REQUEST_ID_EXPIRATION_MS = 8 * 60 * 60 * 1000;

/** Internal stored record: the value plus the ms-epoch it was created. */
interface CacheRecord {
  value: string;
  createdAt: number;
}

/**
 * In-memory {@link CacheProvider} matching node-saml's contract exactly, but with
 * an injectable clock for deterministic tests. Per-process — correct only for
 * single-replica dev/local (same caveat as node-saml's own bundled provider).
 *
 * Contract (verified against node-saml v5.1.0 `inmemory-cache-provider.js`):
 *  - `saveAsync(key, value)` stores `{createdAt: now, value}` and returns the
 *    {@link CacheItem} ONLY if the key was absent; returns `null` if it already
 *    exists (so a duplicate request id never silently overwrites its timestamp).
 *  - `getAsync(key)` returns the stored value, or `null` if absent/expired
 *    (expired entries are dropped lazily).
 *  - `removeAsync(key)` deletes the key (single-use consume) and returns the
 *    removed key, or `null` if absent.
 */
export class InMemorySamlRequestIdCache implements CacheProvider {
  private readonly entries = new Map<string, CacheRecord>();

  constructor(
    private readonly expirationMs: number = DEFAULT_REQUEST_ID_EXPIRATION_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const nowMs = this.now();
    this.dropIfExpired(key, nowMs);
    if (this.entries.has(key)) return null;
    const record: CacheRecord = { value, createdAt: nowMs };
    this.entries.set(key, record);
    return { value: record.value, createdAt: record.createdAt };
  }

  async getAsync(key: string): Promise<string | null> {
    const nowMs = this.now();
    this.dropIfExpired(key, nowMs);
    return this.entries.get(key)?.value ?? null;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key == null) return null;
    if (!this.entries.has(key)) return null;
    this.entries.delete(key);
    return key;
  }

  /** Drop one key if its TTL has elapsed (lazy expiry on access). */
  private dropIfExpired(key: string, nowMs: number): void {
    const entry = this.entries.get(key);
    if (entry && nowMs >= entry.createdAt + this.expirationMs) {
      this.entries.delete(key);
    }
  }
}

export type SamlRequestIdCacheBackend = "memory" | "postgres";

/** Process-wide singleton for the Postgres backend (one connection/setup). */
let postgresSingleton: CacheProvider | undefined;

/**
 * Factory indirection so this module stays free of a static import of the
 * Postgres backend (which pulls in the Prisma client). The real factory is
 * injected at startup by the module that owns Prisma. Until injected, selecting
 * `postgres` fails LOUD rather than silently degrading to per-process — a silent
 * degrade would re-introduce the cross-replica replay-protection gap this fixes.
 */
let postgresCacheFactory: () => CacheProvider = () => {
  throw new Error(
    "SAML_REQUEST_ID_CACHE_BACKEND=postgres selected but the Postgres SAML " +
      "request-id cache factory was not registered. Ensure " +
      "saml-request-id-cache-postgres.ts is imported at startup.",
  );
};

/** Register the Postgres-backed cache factory (called once at startup). */
export function __setPostgresSamlRequestIdCacheFactory(factory: () => CacheProvider): void {
  postgresCacheFactory = factory;
  postgresSingleton = undefined;
}

/** Test helper — drop the resolved singleton so the next resolve rebuilds it. */
export function __resetSamlRequestIdCache(): void {
  postgresSingleton = undefined;
}

/**
 * Resolve the SAML request-id cache backend from config.
 *
 * - `memory` (DEFAULT) — a fresh {@link InMemorySamlRequestIdCache}. Per-process;
 *   correct only for single-replica dev/local.
 * - `postgres` — the cluster-shared backend (process-wide singleton so one
 *   connection/table-bootstrap is reused). REQUIRED for multi-replica so the
 *   request id saved on the AuthnRequest pod is visible on the Response pod.
 *
 * Unknown values fall back to `memory` (fail-safe: a typo degrades to
 * per-process rather than crashing the SAML routes).
 */
export function resolveSamlRequestIdCache(env: NodeJS.ProcessEnv = process.env): CacheProvider {
  const backend = (env.SAML_REQUEST_ID_CACHE_BACKEND ?? "memory").trim().toLowerCase();
  switch (backend) {
    case "postgres":
      postgresSingleton ??= postgresCacheFactory();
      return postgresSingleton;
    default:
      return new InMemorySamlRequestIdCache();
  }
}
