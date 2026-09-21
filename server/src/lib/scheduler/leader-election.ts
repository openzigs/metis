/**
 * Issue #544 (Epic #518) — distributed leader election + per-fire job-window
 * locking for the in-process scheduler and the scattered background jobs.
 *
 * The problem. Under HPA every replica runs `bootstrapScheduler().start()` AND a
 * handful of `setInterval`-based jobs (FinOps forecast/alert/chargeback, the
 * refresh-token revocation pruner, MCP idle / cold-start reapers, the SLA
 * deadline checker). On `N` pods each of those fires `N` times per due instant —
 * wasted compute and racing side effects. (Socket ping/pong and per-server MCP
 * health probes are intentionally per-pod and are NOT gated — see the PR's job
 * inventory.)
 *
 * The fix — one shared primitive, applied at the entry points:
 *
 *   1. {@link LeaderElector} — lease-based leader election. Exactly one pod holds
 *      a named lease (default `"scheduler"`) in a self-managed UNLOGGED
 *      `cluster_leader_lease` row. The leader renews it on a timer; followers
 *      probe on the same timer and take over the moment the lease TTL lapses
 *      (crash recovery — a dead leader stops renewing, so its lease expires and a
 *      survivor wins). `onChange(isLeader)` lets the caller start the schedulers
 *      when it gains leadership and stop them when it loses it. The cluster-wide
 *      singletons (the central scheduler + the interval jobs) start ONLY on the
 *      leader.
 *
 *   2. {@link withJobWindowLock} — a belt-and-braces per-fire claim for an
 *      individual job occurrence, keyed by `(jobName, window)`. The FIRST caller
 *      to claim the window runs; everyone else skips. This is the same
 *      conditional-claim idea the central `SchedulerService.claimFireSlot`
 *      already uses for DB-backed cron jobs, exposed for the interval jobs and as
 *      a second barrier so a brief two-leader overlap during failover still can't
 *      double-fire a single window.
 *
 * Why a lease table (not a session-scoped `pg_advisory_lock`). The runtime Prisma
 * `pg` adapter (#539) talks to Postgres through a CONNECTION POOL. A session-
 * scoped advisory lock is bound to one backend connection, but Prisma may route
 * the lock and the work over different pooled connections, so the lock would not
 * reliably cover the work — and `pg_advisory_unlock` on the wrong connection is a
 * no-op. A lease row with an absolute `expires_at` is pool-agnostic: acquisition,
 * renewal, and the work are all ordinary statements, and crash recovery is the
 * TTL rather than a TCP disconnect we cannot observe through the pool. This
 * mirrors the self-managed UNLOGGED-table approach proven in #541/#542.
 *
 * Dev / single-replica default. When leader election is disabled (the default) or
 * `DATABASE_URL` is SQLite, {@link resolveLeaderElection} returns an
 * {@link AlwaysLeader} that is leader from `start()` and never drops it — so a
 * lone process behaves EXACTLY as it does today (AC: single-replica unchanged).
 */
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";

const log = createChildLogger("leader-election");

/** Default lease name for the scheduler / background-job leader. */
export const DEFAULT_LOCK_NAME = "scheduler";

/** Default lease TTL — leadership is lost this long after the last renewal. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/** Default renew/probe cadence. MUST be comfortably below the lease TTL. */
export const DEFAULT_RENEW_INTERVAL_MS = 10_000;

/**
 * The two atomic operations a leader-election backend must provide. The Postgres
 * implementation runs each as a single SQL statement (serialized by row locks);
 * tests provide an in-memory fake with the same semantics.
 */
export interface LeaseBackend {
  /**
   * Acquire-or-renew the named lease for `holder`. Returns `true` iff `holder`
   * now owns the lease (because it was free, expired, or already theirs), setting
   * the new `expires_at = now + ttlMs`. Returns `false` when another holder owns a
   * still-valid lease.
   */
  acquireOrRenew(name: string, holder: string, now: number, ttlMs: number): Promise<boolean>;
  /** Release the lease iff still held by `holder` (no-op otherwise). */
  release(name: string, holder: string): Promise<void>;
  /**
   * Claim a single job occurrence keyed by `(name, window)`. Returns `true` for
   * the FIRST caller to claim an un-expired window, `false` for everyone else.
   */
  claimWindow(
    name: string,
    window: string,
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean>;
  /** Test/maintenance helper — clear all lease + window state. */
  reset(): Promise<void>;
}

export interface LeaderElectorOptions {
  backend: LeaseBackend;
  /** Lease name (a cluster may run multiple independent leader groups). */
  lockName?: string;
  /** Stable per-process identity. Defaults to a random UUID. */
  holderId?: string;
  /** Lease TTL in ms. */
  leaseTtlMs?: number;
  /** Renew/probe cadence in ms. */
  renewIntervalMs?: number;
  /** Whether {@link start} arms the renew/probe timer. Off in unit tests. */
  autoRenew?: boolean;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Fired with the new value whenever leadership is gained or lost. */
  onChange?: (isLeader: boolean) => void;
}

/**
 * A leader-election participant. Call {@link start} once at boot; gate the
 * cluster-singleton schedulers on {@link isLeader} via {@link onChange}.
 */
export class LeaderElector {
  private readonly backend: LeaseBackend;
  private readonly lockName: string;
  private readonly holderId: string;
  private readonly leaseTtlMs: number;
  private readonly renewIntervalMs: number;
  private readonly autoRenew: boolean;
  private readonly now: () => number;
  protected readonly onChange?: (isLeader: boolean) => void;

  private leader = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(opts: LeaderElectorOptions) {
    this.backend = opts.backend;
    this.lockName = opts.lockName ?? DEFAULT_LOCK_NAME;
    this.holderId = opts.holderId ?? randomUUID();
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.renewIntervalMs = opts.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
    this.autoRenew = opts.autoRenew ?? true;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
  }

  /** Current cached leadership. */
  isLeader(): boolean {
    return this.leader;
  }

  /** This process's stable holder id (useful for diagnostics / window claims). */
  id(): string {
    return this.holderId;
  }

  /** Attempt one acquire/renew, update the cached flag, and notify on change. */
  async tryAcquire(): Promise<boolean> {
    if (this.stopped) return false;
    let won = false;
    try {
      won = await this.backend.acquireOrRenew(
        this.lockName,
        this.holderId,
        this.now(),
        this.leaseTtlMs,
      );
    } catch (err) {
      // A transient backend error must never *promote* a follower (split-brain)
      // and must drop a stale leader (it can no longer prove it holds the lease).
      log.warn("leader lease probe failed", {
        lockName: this.lockName,
        error: (err as Error).message,
      });
      won = false;
    }
    this.setLeader(won);
    return won;
  }

  /** Acquire once, then (when autoRenew) arm the renew/probe timer. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.tryAcquire();
    if (this.autoRenew && !this.timer) {
      this.timer = setInterval(() => {
        void this.tryAcquire();
      }, this.renewIntervalMs);
      // Never keep the event loop alive on the lease timer alone.
      this.timer.unref?.();
    }
  }

  /** Stop probing and release the lease so a survivor takes over immediately. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.leader) {
      try {
        await this.backend.release(this.lockName, this.holderId);
      } catch (err) {
        log.warn("leader lease release failed (will expire via TTL)", {
          lockName: this.lockName,
          error: (err as Error).message,
        });
      }
    }
    this.setLeader(false);
  }

  private setLeader(next: boolean): void {
    if (next === this.leader) return;
    this.leader = next;
    log.info(next ? "acquired scheduler leadership" : "lost scheduler leadership", {
      lockName: this.lockName,
      holderId: this.holderId,
    });
    try {
      this.onChange?.(next);
    } catch (err) {
      log.error("leader onChange handler threw", { error: (err as Error).message });
    }
  }
}

/**
 * An elector that is always the leader. Used for the single-replica / dev default
 * and for SQLite-backed deployments, where there is exactly one writer and thus
 * no contention — behaviour is identical to today.
 */
export class AlwaysLeader extends LeaderElector {
  constructor(onChange?: (isLeader: boolean) => void) {
    super({ backend: NULL_BACKEND, autoRenew: false, onChange });
  }
  override isLeader(): boolean {
    return true;
  }
  override async tryAcquire(): Promise<boolean> {
    return true;
  }
  override async start(): Promise<void> {
    // Notify the gate that we are (and always will be) leader.
    this.onChange?.(true);
  }
  override async stop(): Promise<void> {
    /* always-leader never releases — a lone process owns everything */
  }
}

/** No-op backend for {@link AlwaysLeader} (never consulted). */
const NULL_BACKEND: LeaseBackend = {
  async acquireOrRenew() {
    return true;
  },
  async release() {},
  async claimWindow() {
    return true;
  },
  async reset() {},
};

export interface JobWindowLockOptions {
  backend: LeaseBackend;
  /** The occurrence key — e.g. an ISO minute/hour/day bucket for this fire. */
  window: string;
  /** Stable per-process identity (the elector's id, typically). */
  holderId: string;
  /** How long the claim is held (≥ the expected job duration). */
  ttlMs?: number;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

export interface JobWindowResult<T> {
  /** True iff THIS caller won the window and ran `fn`. */
  ran: boolean;
  /** `fn`'s return value when it ran. */
  value?: T;
}

/**
 * Run `fn` iff this caller wins the `(jobName, window)` claim — the per-fire
 * single-execution guard. Non-winners return `{ ran: false }` without running
 * `fn`. A thrown `fn` error propagates (the claim is intentionally NOT released:
 * the window is "used", so a retry happens on the next window, never a duplicate
 * within the same one).
 */
export async function withJobWindowLock<T>(
  jobName: string,
  fn: () => Promise<T> | T,
  opts: JobWindowLockOptions,
): Promise<JobWindowResult<T>> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const won = await opts.backend.claimWindow(jobName, opts.window, opts.holderId, now(), ttlMs);
  if (!won) return { ran: false };
  const value = await fn();
  return { ran: true, value };
}

/** Subset of `process.env` (plus a test-only backend injector) this resolver reads. */
export interface ResolveLeaderElectionEnv {
  SCHEDULER_LEADER_ELECTION?: string;
  DATABASE_URL?: string;
  /** Test seam — supply a fake {@link LeaseBackend} instead of the Postgres one. */
  backendFactory?: () => LeaseBackend;
  /** Forwarded onto the real elector. */
  holderId?: string;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  onChange?: (isLeader: boolean) => void;
}

/**
 * Resolve the leader elector for this process from config.
 *
 * - `SCHEDULER_LEADER_ELECTION=postgres` AND a Postgres `DATABASE_URL`
 *   → a real {@link LeaderElector} backed by {@link PostgresLeaseBackend}
 *     (the PRODUCTION multi-replica setting).
 * - anything else (unset/`off`/unknown, or a SQLite `DATABASE_URL`)
 *   → {@link AlwaysLeader} (single-replica / dev — unchanged behaviour).
 *
 * Fail-safe: an unrecognized value degrades to single-process, never to a
 * silently-disabled scheduler.
 */
export function resolveLeaderElection(env: ResolveLeaderElectionEnv = process.env): LeaderElector {
  const mode = (env.SCHEDULER_LEADER_ELECTION ?? "").trim().toLowerCase();
  const dbUrl = env.DATABASE_URL ?? "";
  const isPostgres = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");

  if (mode === "postgres" && isPostgres) {
    const backend = env.backendFactory?.() ?? new PostgresLeaseBackend(defaultPrisma);
    return new LeaderElector({
      backend,
      lockName: DEFAULT_LOCK_NAME,
      holderId: env.holderId,
      leaseTtlMs: env.leaseTtlMs,
      renewIntervalMs: env.renewIntervalMs,
      autoRenew: true,
      onChange: env.onChange,
    });
  }
  // SQLite or election disabled / unknown → lone leader, behaviour unchanged.
  if (mode === "postgres" && !isPostgres) {
    log.info("SCHEDULER_LEADER_ELECTION=postgres ignored: DATABASE_URL is not Postgres", {});
  }
  // Honor a test-injected backend even in the always-leader path is unnecessary;
  // AlwaysLeader needs no backend.
  return new AlwaysLeader(env.onChange);
}

/** Self-managed UNLOGGED lease table. Quoted, fixed identifier — never interpolated. */
const LEASE_TABLE = "cluster_leader_lease";
/** Self-managed UNLOGGED per-fire window-claim table. */
const WINDOW_TABLE = "cluster_job_window";
/** Fixed advisory-lock id guarding the concurrent table creates (distinct from #541/#542). */
const TABLE_LOCK_ID = 544_000_001;
/** Probability (per claim) of opportunistically pruning expired window rows. */
const PRUNE_PROBABILITY = 0.05;

/**
 * Postgres-backed {@link LeaseBackend}. Reuses the shared Prisma client (#539's
 * scheme-selected `pg` adapter) so it adds NO new failure domain — same rationale
 * as the #541 rate-limit and #542 SSO stores.
 *
 * Both operations are single atomic statements:
 *   - acquireOrRenew: `INSERT … ON CONFLICT (lock_name) DO UPDATE … WHERE the row
 *     is free/expired/ours`, returning the row iff WE now hold it. The row lock
 *     Postgres takes on the conflicting row serializes contending replicas, so at
 *     most one wins per instant — leadership is globally consistent.
 *   - claimWindow: `INSERT … ON CONFLICT (lock_name, window) DO NOTHING` — the
 *     first inserter wins the window, all others get zero affected rows. (A
 *     fully-expired prior claim is overwritten so a crashed winner can't wedge a
 *     window forever.)
 */
export class PostgresLeaseBackend implements LeaseBackend {
  private readonly db: PrismaClient;
  private ensured: Promise<void> | undefined;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Idempotently create both UNLOGGED tables (once per process), serialized by a
   * transaction-scoped advisory lock so two replicas racing the first create
   * don't collide on `pg_type` (the same 23505 race #541/#542 guard against).
   */
  private ensureTables(): Promise<void> {
    this.ensured ??= this.db
      .$executeRawUnsafe(
        `DO $$
         BEGIN
           PERFORM pg_advisory_xact_lock(${TABLE_LOCK_ID});
           CREATE UNLOGGED TABLE IF NOT EXISTS "${LEASE_TABLE}" (
             "lock_name"  TEXT   NOT NULL PRIMARY KEY,
             "holder"     TEXT   NOT NULL,
             "expires_at" BIGINT NOT NULL
           );
           CREATE UNLOGGED TABLE IF NOT EXISTS "${WINDOW_TABLE}" (
             "lock_name"  TEXT   NOT NULL,
             "window"     TEXT   NOT NULL,
             "holder"     TEXT   NOT NULL,
             "expires_at" BIGINT NOT NULL,
             PRIMARY KEY ("lock_name", "window")
           );
         EXCEPTION WHEN duplicate_table OR duplicate_object THEN
           NULL;
         END $$;`,
      )
      .then(() => undefined)
      .catch((err) => {
        this.ensured = undefined;
        throw err;
      });
    return this.ensured;
  }

  async acquireOrRenew(name: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
    await this.ensureTables();
    const expiresAt = now + ttlMs;

    // Insert if absent; on conflict take/keep the lease ONLY when it is expired
    // or already ours. `RETURNING` yields a row iff this statement made us the
    // holder. The conditional `WHERE` on the UPDATE is what blocks a follower from
    // stealing a still-valid foreign lease.
    const rows = await this.db.$queryRaw<Array<{ holder: string }>>`
      INSERT INTO "cluster_leader_lease" ("lock_name", "holder", "expires_at")
      VALUES (${name}, ${holder}, ${expiresAt})
      ON CONFLICT ("lock_name") DO UPDATE
        SET "holder" = EXCLUDED."holder", "expires_at" = EXCLUDED."expires_at"
        WHERE "cluster_leader_lease"."expires_at" <= ${now}
           OR "cluster_leader_lease"."holder" = ${holder}
      RETURNING "holder"
    `;
    return rows.length === 1 && rows[0]?.holder === holder;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.ensureTables();
    await this.db.$executeRaw`
      DELETE FROM "cluster_leader_lease"
      WHERE "lock_name" = ${name} AND "holder" = ${holder}
    `;
  }

  async claimWindow(
    name: string,
    window: string,
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    await this.ensureTables();
    const expiresAt = now + ttlMs;

    // First inserter wins the window. On conflict, overwrite ONLY a fully-expired
    // prior claim (so a crashed winner can't wedge the window) — and only then
    // does RETURNING yield our row.
    const rows = await this.db.$queryRaw<Array<{ holder: string }>>`
      INSERT INTO "cluster_job_window" ("lock_name", "window", "holder", "expires_at")
      VALUES (${name}, ${window}, ${holder}, ${expiresAt})
      ON CONFLICT ("lock_name", "window") DO UPDATE
        SET "holder" = EXCLUDED."holder", "expires_at" = EXCLUDED."expires_at"
        WHERE "cluster_job_window"."expires_at" <= ${now}
      RETURNING "holder"
    `;

    if (Math.random() < PRUNE_PROBABILITY) {
      void this.db.$executeRaw`DELETE FROM "cluster_job_window" WHERE "expires_at" <= ${now}`.catch(
        () => {
          /* prune is best-effort */
        },
      );
    }

    return rows.length === 1 && rows[0]?.holder === holder;
  }

  async reset(): Promise<void> {
    await this.ensureTables().catch(() => {});
    await this.db.$executeRawUnsafe(`TRUNCATE TABLE "${LEASE_TABLE}"`).catch(() => {});
    await this.db.$executeRawUnsafe(`TRUNCATE TABLE "${WINDOW_TABLE}"`).catch(() => {});
  }
}
