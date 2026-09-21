/**
 * Epic #518 (#541) — Postgres-backed shared rate-limit store.
 *
 * This is the **production** backend for `DISCUSSION_RATE_LIMIT_BACKEND=postgres`.
 * It enforces the per-(thread,user) AI-invocation cap *cluster-wide* across N
 * replicas by counting hits in shared Postgres rather than in per-process memory.
 *
 * Why Postgres (and not Redis/Valkey by default):
 *   - #539 already gives every replica a *shared* Postgres via the
 *     `DATABASE_URL`-scheme-selected Prisma adapter. Reusing it drops a whole
 *     failure domain — no dedicated cache to provision, secure, and pay for.
 *   - Our AI-invocation volume is orders of magnitude below the ~10–15k req/s/node
 *     a single Postgres handles for this kind of atomic upsert.
 *   - Redis Ltd relicensed Redis in 2024 (RSALv2/SSPL; Redis 8 → AGPLv3). The
 *     open-source successor is Valkey — offered as a *high-scale optional* backend
 *     (see rate-limit-store.ts), never the mandatory default.
 *
 * Algorithm — atomic fixed-window counter (`INSERT … ON CONFLICT … DO UPDATE`):
 *
 *   The window for a hit is the fixed bucket `floor(now / windowMs)`. Each hit is
 *   a single statement that inserts-or-increments the counter row keyed by
 *   `(bucket_key, window_start)` and returns the post-increment count in ONE
 *   round trip. Because the upsert is atomic at the row level, two replicas
 *   incrementing the same row are serialized by Postgres — the returned count is
 *   globally consistent, so the cap holds cluster-wide. A hit is "allowed" iff its
 *   returned count is `<= max`; an over-cap hit still increments (idempotent —
 *   the count saturates) but the caller treats it as denied and makes no LLM call.
 *
 *   Trade-off vs the in-memory sliding-window *log*: this is a fixed (tumbling)
 *   window, so up to `2*max` hits can occur across a window boundary. That is the
 *   standard, cheap distributed-counter trade-off and is acceptable for a cost-
 *   guard cap; a true distributed sliding-window log would need a row-per-hit and
 *   a far more expensive query. `retryAfterMs` is computed from the window end.
 *
 * Storage — a self-managed UNLOGGED table created idempotently at first use:
 *   - It is rate-limit *infrastructure*, not a domain model, so it is intentionally
 *     NOT in `schema.prisma` (keeps it out of the dual-schema parity guard and the
 *     migration history). `CREATE TABLE IF NOT EXISTS` runs once per process.
 *   - UNLOGGED: not crash-safe / not replicated, which is exactly right for
 *     ephemeral counters — losing them on crash just resets a few windows. It also
 *     skips WAL, making the upsert cheaper.
 *   - Expired rows are pruned opportunistically (a bounded DELETE on a small
 *     fraction of calls) so the table stays tiny without a background job.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";

import {
  __setPostgresStoreFactory,
  type RateLimitHitResult,
  type RateLimitStore,
} from "./rate-limit-store.js";

/** UNLOGGED counter table. Quoted, fixed identifier — never interpolated. */
const TABLE = "discussion_rate_limit_window";

/**
 * Fixed advisory-lock id guarding the concurrent table create (see
 * {@link PostgresRateLimitStore.ensureTable}). Arbitrary but stable per table;
 * a literal int constant, never user input.
 */
const TABLE_LOCK_ID = 541_000_001;

/** Probability (per hit) of running the opportunistic expired-row prune. */
const PRUNE_PROBABILITY = 0.02;

/**
 * Postgres-backed atomic fixed-window counter store. Reuses the shared Prisma
 * client (and thus the shared Postgres connection pool) by default.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  private readonly db: PrismaClient;
  /** Lazily-run, memoised table bootstrap (one DDL per process). */
  private ensured: Promise<void> | undefined;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Idempotently create the UNLOGGED counter table (once per process).
   *
   * `CREATE TABLE IF NOT EXISTS` is NOT concurrency-safe in Postgres: two
   * replicas racing the first create collide on `pg_type` with a 23505 unique
   * violation (the existence check and the type insert are not atomic). We
   * serialize the create with a transaction-scoped advisory lock (a fixed,
   * arbitrary lock id for this table) so exactly one create runs at a time, and
   * treat a residual duplicate-object error (23505 / 42P07) as benign.
   */
  private ensureTable(): Promise<void> {
    this.ensured ??= this.db
      .$executeRawUnsafe(
        `DO $$
         BEGIN
           PERFORM pg_advisory_xact_lock(${TABLE_LOCK_ID});
           CREATE UNLOGGED TABLE IF NOT EXISTS "${TABLE}" (
             "bucket_key"   TEXT    NOT NULL,
             "window_start" BIGINT  NOT NULL,
             "window_end"   BIGINT  NOT NULL,
             "count"        INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY ("bucket_key", "window_start")
           );
         EXCEPTION WHEN duplicate_table OR duplicate_object THEN
           -- Another replica won the race; the table already exists.
           NULL;
         END $$;`,
      )
      .then(() => undefined)
      .catch((err) => {
        // Reset the memo so a transient failure can be retried on the next hit.
        this.ensured = undefined;
        throw err;
      });
    return this.ensured;
  }

  async hit(key: string, max: number, windowMs: number, now: number): Promise<RateLimitHitResult> {
    await this.ensureTable();

    const windowStart = Math.floor(now / windowMs) * windowMs;
    const windowEnd = windowStart + windowMs;

    // Atomic upsert: insert the row with count=1, or increment the existing
    // count, returning the post-increment value. The row-level lock Postgres
    // takes on the conflicting row serializes concurrent replicas, so `count`
    // is globally consistent across the cluster.
    const rows = await this.db.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "discussion_rate_limit_window"
        ("bucket_key", "window_start", "window_end", "count")
      VALUES (${key}, ${windowStart}, ${windowEnd}, 1)
      ON CONFLICT ("bucket_key", "window_start")
      DO UPDATE SET "count" = "discussion_rate_limit_window"."count" + 1
      RETURNING "count"
    `;

    // `count` may come back as a JS number or a bigint depending on the driver.
    const count = Number(rows[0]?.count ?? 0);

    // Opportunistic prune of windows that have fully elapsed — keeps the table
    // bounded without a scheduler. Fire-and-forget; failure never blocks a hit.
    if (Math.random() < PRUNE_PROBABILITY) {
      void this.db
        .$executeRaw`DELETE FROM "discussion_rate_limit_window" WHERE "window_end" <= ${now}`.catch(
        () => {
          /* prune is best-effort */
        },
      );
    }

    if (count > max) {
      // Over the cap. The increment already happened (idempotent saturation);
      // the caller denies and makes no LLM call. Retry frees when this fixed
      // window ends.
      return { allowed: false, recentCount: count, oldestTs: windowStart };
    }
    return { allowed: true, recentCount: count };
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
 * module (done at server startup) wires `DISCUSSION_RATE_LIMIT_BACKEND=postgres`
 * to {@link PostgresRateLimitStore} without the resolver statically depending on
 * the Prisma client.
 */
export function registerPostgresRateLimitStore(db: PrismaClient = defaultPrisma): void {
  __setPostgresStoreFactory(() => new PostgresRateLimitStore(db));
}
