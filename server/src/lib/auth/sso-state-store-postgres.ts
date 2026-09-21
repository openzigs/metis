/**
 * Epic #518 (#542) — Postgres-backed shared SSO transaction-state store.
 *
 * This is the **production / multi-replica** backend for `SSO_STATE_BACKEND=postgres`.
 * It makes the SSO initiate→callback handshake survive load balancing across N
 * replicas: the per-transaction state (PKCE `codeVerifier`, OIDC `nonce`) is
 * written to shared Postgres on initiate and read back on the callback, so the
 * callback succeeds no matter which pod it lands on. Without it, a callback that
 * hits a different pod than the initiate has no entry and the login fails (#542).
 *
 * Why Postgres (and not Redis/Valkey): identical to the #541 rate-limit-store
 * rationale — #539 already gives every replica a *shared* Postgres via the
 * `DATABASE_URL`-scheme-selected Prisma adapter, so reusing it drops a whole
 * failure domain. SSO-transaction volume (one row per in-flight login, lived for
 * seconds) is trivial for Postgres.
 *
 * Consume-once (replay protection). The callback redeems a `state` with a single
 * `DELETE … RETURNING` statement: Postgres takes a row lock, deletes the row, and
 * returns the payload in ONE atomic round trip. Two concurrent callbacks racing
 * the same `state` are serialized by that row lock — exactly one gets the row
 * back, the other gets zero rows (treated as unknown/already-consumed). This
 * preserves the single-use property the in-memory `delete`-on-read gave, now
 * cluster-wide.
 *
 * TTL / expiry. Each row stores an absolute `expires_at` (ms epoch). The consume
 * step deletes the row regardless of expiry (so a stale entry can't linger or be
 * replayed) but returns the payload only when `expires_at > now`; an expired hit
 * returns `null` and is rejected by the caller. Expired rows from abandoned
 * logins are pruned opportunistically (a bounded DELETE on a fraction of calls)
 * so the table stays tiny without a background job — the store TTL replaces the
 * old 10-minute in-process cleanup sweep in sso.ts.
 *
 * Storage — a self-managed table created idempotently at first use:
 *   - It is SSO *infrastructure*, not a domain model, so it is intentionally NOT
 *     in `schema.prisma` (keeps it out of the dual-schema parity guard and the
 *     migration history, matching the #541 counter table). `CREATE TABLE IF NOT
 *     EXISTS` runs once per process behind an advisory lock.
 *   - UNLOGGED: not crash-safe / not replicated, which is exactly right for
 *     ephemeral, seconds-lived login state — losing it on a crash just fails the
 *     handful of logins mid-flight at that instant (the user retries). It also
 *     skips WAL, making writes cheaper.
 *
 * Secrets. `codeVerifier`/`nonce` are persisted (they must be — the callback pod
 * needs them) but are NEVER logged here, are keyed by the high-entropy `state`,
 * and are deleted on first read / TTL. The columns are written via parameterised
 * queries only (no string interpolation of user input — OWASP A03).
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";

import {
  __setPostgresSSOStateStoreFactory,
  type SSOStatePayload,
  type SSOStateStore,
} from "./sso-state-store.js";

/** Self-managed state table. Quoted, fixed identifier — never interpolated. */
const TABLE = "sso_transaction_state";

/**
 * Fixed advisory-lock id guarding the concurrent table create. Arbitrary but
 * stable per table; a literal int constant, never user input. (Distinct from the
 * #541 rate-limit table's lock id so the two creates don't serialize each other.)
 */
const TABLE_LOCK_ID = 542_000_001;

/** Probability (per put) of running the opportunistic expired-row prune. */
const PRUNE_PROBABILITY = 0.05;

/**
 * Postgres-backed consume-once SSO-state store. Reuses the shared Prisma client
 * (and thus the shared Postgres connection pool) by default.
 */
export class PostgresSSOStateStore implements SSOStateStore {
  private readonly db: PrismaClient;
  /** Lazily-run, memoised table bootstrap (one DDL per process). */
  private ensured: Promise<void> | undefined;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Idempotently create the UNLOGGED state table (once per process).
   *
   * `CREATE TABLE IF NOT EXISTS` is NOT concurrency-safe in Postgres: two
   * replicas racing the first create collide on `pg_type` with a 23505 unique
   * violation (the existence check and the type insert are not atomic). We
   * serialize the create with a transaction-scoped advisory lock (a fixed,
   * arbitrary lock id for this table) so exactly one create runs at a time, and
   * treat a residual duplicate-object error as benign.
   */
  private ensureTable(): Promise<void> {
    this.ensured ??= this.db
      .$executeRawUnsafe(
        `DO $$
         BEGIN
           PERFORM pg_advisory_xact_lock(${TABLE_LOCK_ID});
           CREATE UNLOGGED TABLE IF NOT EXISTS "${TABLE}" (
             "state"         TEXT    NOT NULL PRIMARY KEY,
             "mode"          TEXT    NOT NULL,
             "code_verifier" TEXT    NOT NULL,
             "nonce"         TEXT    NOT NULL,
             "expires_at"    BIGINT  NOT NULL
           );
         EXCEPTION WHEN duplicate_table OR duplicate_object THEN
           -- Another replica won the race; the table already exists.
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

  async put(
    state: string,
    payload: SSOStatePayload,
    ttlMs: number,
    now: number = Date.now(),
  ): Promise<void> {
    await this.ensureTable();
    const expiresAt = now + ttlMs;

    // Upsert: a fresh initiate for the same (astronomically unlikely) `state`
    // overwrites — the latest initiate wins, matching the Map's set() semantics.
    await this.db.$executeRaw`
      INSERT INTO "sso_transaction_state"
        ("state", "mode", "code_verifier", "nonce", "expires_at")
      VALUES (${state}, ${payload.mode}, ${payload.codeVerifier}, ${payload.nonce}, ${expiresAt})
      ON CONFLICT ("state")
      DO UPDATE SET
        "mode" = EXCLUDED."mode",
        "code_verifier" = EXCLUDED."code_verifier",
        "nonce" = EXCLUDED."nonce",
        "expires_at" = EXCLUDED."expires_at"
    `;

    // Opportunistic prune of fully-expired rows from abandoned logins — keeps the
    // table bounded without a scheduler. Fire-and-forget; never blocks a put.
    if (Math.random() < PRUNE_PROBABILITY) {
      void this.db
        .$executeRaw`DELETE FROM "sso_transaction_state" WHERE "expires_at" <= ${now}`.catch(() => {
        /* prune is best-effort */
      });
    }
  }

  async consume(state: string, now: number = Date.now()): Promise<SSOStatePayload | null> {
    await this.ensureTable();

    // Atomic consume-once: delete the row and return its payload in ONE statement.
    // The row lock Postgres takes serializes concurrent callbacks racing the same
    // `state` — exactly one wins the row, so a `state` is redeemable at most once
    // cluster-wide (replay protection).
    const rows = await this.db.$queryRaw<
      Array<{ mode: string; code_verifier: string; nonce: string; expires_at: bigint | number }>
    >`
      DELETE FROM "sso_transaction_state"
      WHERE "state" = ${state}
      RETURNING "mode", "code_verifier", "nonce", "expires_at"
    `;

    const row = rows[0];
    if (!row) return null; // unknown or already-consumed

    // Reject expired state (the row is already deleted by the DELETE above).
    if (Number(row.expires_at) <= now) return null;

    return {
      mode: row.mode === "saml" ? "saml" : "oidc",
      codeVerifier: row.code_verifier,
      nonce: row.nonce,
    };
  }

  async reset(): Promise<void> {
    // Best-effort: only meaningful once the table exists.
    await this.db.$executeRawUnsafe(`TRUNCATE TABLE "${TABLE}"`).catch(() => {
      /* table may not exist yet */
    });
  }
}

/**
 * Register the Postgres store factory with the resolver seam. Importing this
 * module (done at server startup) wires `SSO_STATE_BACKEND=postgres` to
 * {@link PostgresSSOStateStore} without the resolver statically depending on the
 * Prisma client.
 */
export function registerPostgresSSOStateStore(db: PrismaClient = defaultPrisma): void {
  __setPostgresSSOStateStoreFactory(() => new PostgresSSOStateStore(db));
}
