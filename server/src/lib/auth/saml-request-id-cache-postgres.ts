/**
 * Epic #517 (#520) — Postgres-backed shared SAML request-id cache.
 *
 * This is the **production / multi-replica** backend for
 * `SAML_REQUEST_ID_CACHE_BACKEND=postgres`. It makes SAML `validateInResponseTo`
 * replay protection work across N replicas: node-saml saves the AuthnRequest id
 * when it mints the request (possibly on pod A) and looks it up + removes it when
 * the IdP Response is validated (possibly on pod B). With node-saml's per-process
 * bundled cache, pod B never saw the id — so either every cross-pod login fails
 * (`always`) or the replay check is a no-op. Persisting the id to the shared
 * Postgres fixes that cluster-wide.
 *
 * Why Postgres (and not Redis/Valkey): identical to the #542 SSO-state-store and
 * #541 rate-limit-store rationale — #539 already gives every replica a *shared*
 * Postgres via the `DATABASE_URL`-scheme-selected Prisma adapter, so reusing it
 * drops a whole failure domain. Request-id volume (one tiny row per in-flight
 * login, lived for the seconds between redirect and ACS) is trivial for Postgres.
 *
 * Contract. This implements node-saml's `CacheProvider` (NOT the #542
 * consume-once `SSOStateStore`, whose delete-on-read cannot express node-saml's
 * separate get-then-remove flow):
 *   - `saveAsync(key, value)` inserts the row; `ON CONFLICT DO NOTHING` so a
 *     duplicate id returns `null` (mirrors the in-memory provider — no silent
 *     overwrite of an existing id's timestamp).
 *   - `getAsync(key)` is a NON-destructive read that returns the value only when
 *     the row is non-expired (createdAt + TTL > now); expired/unknown -> null.
 *   - `removeAsync(key)` is the single-use consume: `DELETE` the row so a replayed
 *     Response carrying the same `InResponseTo` misses on its `getAsync`.
 *
 * Storage — a self-managed table created idempotently at first use, matching the
 * #542 SSO-state and #541 rate-limit tables:
 *   - SAML *infrastructure*, not a domain model: intentionally NOT in
 *     `schema.prisma` (keeps it out of the dual-schema parity guard and the
 *     migration history). `CREATE TABLE IF NOT EXISTS` runs once per process
 *     behind a transaction-scoped advisory lock (the bare IF NOT EXISTS is not
 *     concurrency-safe — two replicas racing the first create collide on
 *     `pg_type`).
 *   - UNLOGGED: not crash-safe / not replicated — exactly right for ephemeral,
 *     seconds-lived request ids. Losing it on a crash just fails the handful of
 *     logins mid-flight (the user retries) and skips WAL.
 *
 * Security. The stored `value` is node-saml's non-secret `instant` timestamp
 * string keyed by the high-entropy request id; nothing sensitive is logged. All
 * writes use parameterised queries (OWASP A03). Single-use delete + TTL bound the
 * replay window (OWASP A07).
 */
import type { CacheItem, CacheProvider } from "@node-saml/passport-saml";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";

import {
  DEFAULT_REQUEST_ID_EXPIRATION_MS,
  __setPostgresSamlRequestIdCacheFactory,
} from "./saml-request-id-cache.js";

/** Self-managed cache table. Quoted, fixed identifier — never interpolated. */
const TABLE = "saml_request_id_cache";

/**
 * Fixed advisory-lock id guarding the concurrent table create. Arbitrary but
 * stable per table, distinct from the #541/#542 lock ids so the creates don't
 * serialize each other. A literal int constant, never user input.
 */
const TABLE_LOCK_ID = 520_000_001;

/** Probability (per save) of running the opportunistic expired-row prune. */
const PRUNE_PROBABILITY = 0.05;

/**
 * Postgres-backed node-saml {@link CacheProvider}. Reuses the shared Prisma
 * client (and thus the shared Postgres connection pool) by default.
 */
export class PostgresSamlRequestIdCache implements CacheProvider {
  private readonly db: PrismaClient;
  private readonly expirationMs: number;
  private readonly now: () => number;
  /** Lazily-run, memoised table bootstrap (one DDL per process). */
  private ensured: Promise<void> | undefined;

  constructor(
    db: PrismaClient = defaultPrisma,
    expirationMs: number = DEFAULT_REQUEST_ID_EXPIRATION_MS,
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.expirationMs = expirationMs;
    this.now = now;
  }

  /**
   * Idempotently create the UNLOGGED cache table (once per process). Serialized
   * with a transaction-scoped advisory lock; a residual duplicate-object error
   * (another replica won the race) is treated as benign.
   */
  private ensureTable(): Promise<void> {
    this.ensured ??= this.db
      .$executeRawUnsafe(
        `DO $$
         BEGIN
           PERFORM pg_advisory_xact_lock(${TABLE_LOCK_ID});
           CREATE UNLOGGED TABLE IF NOT EXISTS "${TABLE}" (
             "request_id" TEXT   NOT NULL PRIMARY KEY,
             "value"      TEXT   NOT NULL,
             "created_at" BIGINT NOT NULL
           );
         EXCEPTION WHEN duplicate_table OR duplicate_object THEN
           NULL;
         END $$;`,
      )
      .then(() => undefined)
      .catch((err) => {
        // Reset the memo so a transient failure can be retried on the next call.
        this.ensured = undefined;
        throw err;
      });
    return this.ensured;
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await this.ensureTable();
    const createdAt = this.now();

    // Drop a pre-existing EXPIRED row for this id first so a stale id can be
    // re-minted (matches the in-memory provider's dropIfExpired-on-save).
    await this.db
      .$executeRaw`DELETE FROM "saml_request_id_cache" WHERE "request_id" = ${key} AND "created_at" + ${this.expirationMs} <= ${createdAt}`;

    // Insert; ON CONFLICT DO NOTHING -> a still-live duplicate id is a no-op.
    const inserted = await this.db.$executeRaw`
      INSERT INTO "saml_request_id_cache" ("request_id", "value", "created_at")
      VALUES (${key}, ${value}, ${createdAt})
      ON CONFLICT ("request_id") DO NOTHING
    `;

    // Opportunistic prune of fully-expired rows from abandoned logins — keeps the
    // table bounded without a scheduler. Fire-and-forget; never blocks a save.
    if (Math.random() < PRUNE_PROBABILITY) {
      void this.db
        .$executeRaw`DELETE FROM "saml_request_id_cache" WHERE "created_at" + ${this.expirationMs} <= ${createdAt}`.catch(
        () => {
          /* prune is best-effort */
        },
      );
    }

    // `$executeRaw` returns the affected row count: 1 = inserted, 0 = duplicate.
    return inserted > 0 ? { value, createdAt } : null;
  }

  async getAsync(key: string): Promise<string | null> {
    await this.ensureTable();
    const nowMs = this.now();

    const rows = await this.db.$queryRaw<Array<{ value: string; created_at: bigint | number }>>`
      SELECT "value", "created_at" FROM "saml_request_id_cache" WHERE "request_id" = ${key}
    `;
    const row = rows[0];
    if (!row) return null;
    // Lazy expiry: an expired id is treated as absent (rejected upstream).
    if (Number(row.created_at) + this.expirationMs <= nowMs) return null;
    return row.value;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key == null) return null;
    await this.ensureTable();

    // Single-use consume: deleting the row means a replayed Response carrying the
    // same InResponseTo misses on its getAsync and is rejected.
    const deleted = await this.db
      .$executeRaw`DELETE FROM "saml_request_id_cache" WHERE "request_id" = ${key}`;
    return deleted > 0 ? key : null;
  }

  /** Test helper — drop all rows. */
  async reset(): Promise<void> {
    await this.db.$executeRawUnsafe(`TRUNCATE TABLE "${TABLE}"`).catch(() => {
      /* table may not exist yet */
    });
  }
}

/**
 * Register the Postgres cache factory with the resolver seam. Importing this
 * module (done at server startup) wires `SAML_REQUEST_ID_CACHE_BACKEND=postgres`
 * to {@link PostgresSamlRequestIdCache} without the resolver statically depending
 * on the Prisma client.
 */
export function registerPostgresSamlRequestIdCache(db: PrismaClient = defaultPrisma): void {
  __setPostgresSamlRequestIdCacheFactory(() => new PostgresSamlRequestIdCache(db));
}
