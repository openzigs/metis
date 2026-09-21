/**
 * Issue #798 — the reindex lease. Replaces the SESSION-scoped Postgres advisory
 * lock that guarded `reindexProject()` / `discardReindexShadow()` (#100, made
 * load-bearing by #787).
 *
 * ## Why the advisory lock had to go
 *
 * `pg_try_advisory_lock` binds the lock to the BACKEND CONNECTION that took it.
 * Prisma's `PrismaPg` adapter is a connection POOL and only pins a connection
 * inside `$transaction`, so `acquire` (one `$queryRaw`) and `release` (a separate
 * `$executeRaw`) can land on DIFFERENT backends. When they do, `pg_advisory_unlock`
 * returns `false` — a value the old code discarded — and the lock stays held until
 * the pod restarts. Fail-closed, so nothing is corrupted; but every later reindex
 * for that project is refused with 409, and RETRY (the operator's instinct) cannot
 * clear it. On a real Postgres, eight concurrent take/release cycles through the
 * shared pooled client leaked EIGHT locks
 * (`tests/reindex-lease-postgres.integration.test.ts`).
 *
 * This repo already solved this exact bug once: see the header of
 * `src/lib/scheduler/leader-election.ts` (#544), which rejects session advisory
 * locks for precisely this reason in favour of a lease row with an absolute
 * `expires_at`. #520/#541/#542/#544 all ship the same idiom. This is that idiom,
 * applied to the reindex.
 *
 * ## The shape
 *
 *   - A `reindex_lease` row per project: `(lock_name, holder, expires_at, updated_at)`.
 *     Acquisition, renewal, fencing and release are ORDINARY statements, so which
 *     pooled connection serves them is irrelevant — the mechanism is pool-agnostic
 *     (and therefore also safe under PgBouncer transaction pooling, which the old
 *     lock explicitly was not).
 *   - Crash recovery is the TTL, not a TCP disconnect we cannot observe through the
 *     pool. A SIGKILLed holder stops renewing; its lease lapses; the next attempt
 *     wins. No pod restart.
 *   - `holder` is a FENCING TOKEN (`<podId>:<runId-uuid>`, fresh per attempt). Every
 *     mutating step of a reindex re-proves, atomically, that it still owns the lease
 *     AT THE INSTANT IT MUTATES — see {@link ReindexLease.renew} (per batch, before
 *     the upsert) and {@link ReindexLease.assertHeld} (inside the swap's own SQL
 *     transaction). Without that, a TTL lease would REINTRODUCE #787's data-loss
 *     path: a stalled holder whose lease lapsed could still resurrect a shadow that
 *     was discarded under it and swap a PARTIAL index into the live name.
 *
 * ## Why a SIBLING table and not `cluster_leader_lease`
 *
 * The scheduler's integration test calls `backend.reset()` (TRUNCATE) in
 * `beforeEach`. Sharing one table would couple two unrelated subsystems: a
 * scheduler test could wipe a live reindex lease.
 *
 * ## UNLOGGED: fail-OPEN for new acquirers, fail-CLOSED for the survivor
 *
 * The table is UNLOGGED, so Postgres TRUNCATES it on crash-recovery restart and every
 * lease vanishes. That is CORRECT here — but NOT because the crash takes the holders
 * down with it. It does not. A pod is a separate process with a RECONNECTING pool, so
 * a reindex that was between batches (or, far more likely, awaiting the embeddings
 * sidecar — where it spends most of its life) survives the restart untouched and just
 * gets a fresh connection on its next query. A LIVE, MID-RUN HOLDER WHOSE LEASE ROW HAS
 * BEEN TRUNCATED OUT FROM UNDER IT IS A REACHABLE STATE. Do not assume otherwise.
 *
 * It is safe anyway, and the reason is the mechanism, not the body count:
 *
 *   - FAIL-OPEN for new acquirers: the table is empty, so the next attempt wins the
 *     lease at once. No wedge — which is the bug this module exists to remove.
 *   - FAIL-CLOSED for the survivor: its next per-batch {@link ReindexLease.renew} is an
 *     UPDATE against an empty table → 0 rows → `false` → it aborts BEFORE its upsert;
 *     and if it somehow reached the cut-over anyway,
 *     {@link PostgresReindexLeaseBackend.assertHeld} finds no row → throws.
 *
 * So the guarantee rests entirely on renew/assertHeld reading "my row is gone" as "I am
 * FENCED". DO NOT "harden" either of them to tolerate a missing row by re-inserting it
 * — a plausible-looking robustness tweak (*the table was truncated, just put the row
 * back*) that would hand a stale holder a valid lease and REOPEN #787's partial-cutover
 * data-loss path. Missing row means fenced. Always.
 *
 * UNLOGGED also means no migration and no Prisma model.
 */
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";
import { parsePositiveIntMs, reindexSwapLeaseExtensionMs } from "./reindex-swap-budget.js";
import type { RawSqlExecutor, SwapGuard } from "./vector-store.js";

const log = createChildLogger("reindex-lease");

/** Self-managed UNLOGGED lease table. Quoted, fixed identifier — never interpolated. */
const LEASE_TABLE = "reindex_lease";
/** Fixed advisory-lock id guarding the concurrent table create (distinct from #541/#542/#544). */
const TABLE_LOCK_ID = 798_000_001;

/**
 * Default lease TTL. Generous relative to one embed batch (seconds) so an ordinary
 * GC pause or a slow batch never self-fences, and short enough that a SIGKILLed
 * holder's lease lapses without operator action. The escape hatch (`unlock`) exists
 * for operators who will not wait.
 */
export const DEFAULT_REINDEX_LEASE_TTL_MS = 120_000;
/** Heartbeat cadence. MUST be comfortably below the TTL. */
export const DEFAULT_REINDEX_RENEW_INTERVAL_MS = 30_000;
/**
 * Hard ceiling on the TTL (1 hour). A TTL is the time an operator must WAIT before a
 * dead holder's lease becomes stealable, so an absurd one is a self-inflicted wedge —
 * exactly the failure mode this module exists to remove.
 */
export const MAX_REINDEX_LEASE_TTL_MS = 3_600_000;

/**
 * `REINDEX_LEASE_TTL_MS` override. Strictly parsed — see {@link parsePositiveIntMs}:
 * `REINDEX_LEASE_TTL_MS=2min` must NOT silently become a 2-millisecond TTL (which would
 * make every lease expire instantly and every reindex stealable mid-flight).
 */
export function reindexLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntMs(env.REINDEX_LEASE_TTL_MS, {
    name: "REINDEX_LEASE_TTL_MS",
    fallback: DEFAULT_REINDEX_LEASE_TTL_MS,
    max: MAX_REINDEX_LEASE_TTL_MS,
  });
}

/** The lock name for a project's reindex lease. */
export function reindexLockName(projectId: string): string {
  return `reindex:${projectId}`;
}

/**
 * A fresh fencing token for ONE reindex attempt: `<podId>:<runId-uuid>`.
 *
 * ## The invariant the whole scheme rests on
 *
 * **Every holder value must be globally unique to the attempt that minted it.** That is
 * what rules out ABA, and it is why {@link PostgresReindexLeaseBackend.renew} needs no
 * expiry predicate: `acquire` is the ONLY statement that writes a `holder`, and it is
 * only ever called with a value from here — so no third party can ever put the row back
 * into a state that names US after someone else has held it. A row that still names us
 * therefore PROVES nobody has acquired or released since we did.
 *
 * Feed a STABLE value in (a pod id, a project id, a constant) and that proof evaporates:
 * the row could name "us" because a previous run with the same token put it there, and
 * `renew()` silently stops being a fence. See {@link WithReindexLeaseOptions.holderForTest}.
 */
export function newReindexHolderId(): string {
  const podId = process.env.HOSTNAME?.trim() || "local";
  return `${podId}:${randomUUID()}`;
}

/** A lease row, as stored. */
export interface ReindexLeaseRow {
  lockName: string;
  holder: string;
  expiresAt: number;
  updatedAt: number;
}

/** A lease row, as an OPERATOR sees it. */
export interface ReindexLeaseInfo {
  projectId: string;
  holder: string;
  expiresAt: number;
  updatedAt: number;
  /** Time since the holder last renewed — the "is it alive?" number. */
  ageMs: number;
  /** True when the TTL has lapsed: the holder is gone (or wedged) and it is stealable. */
  expired: boolean;
}

/**
 * Thrown when a reindex/discard cannot take the lease because another holder owns a
 * still-valid one. Mapped to HTTP 409 by the admin routes.
 *
 * Lives here (not in `knowledge-service.ts`) so the lease module has no import cycle;
 * `knowledge-service.ts` re-exports it, so every existing `instanceof` still holds.
 */
export class ReindexConflictError extends Error {
  readonly code = "REINDEX_IN_PROGRESS";
  readonly projectId: string;
  /** The holder that owns the lease, when we could read it. */
  readonly holder?: string;
  constructor(projectId: string, holder?: string) {
    super(`A reindex is already in progress for project ${projectId}`);
    this.name = "ReindexConflictError";
    this.projectId = projectId;
    if (holder !== undefined) this.holder = holder;
  }
}

/**
 * Thrown when a run discovers, at the instant it is about to MUTATE, that it no
 * longer holds the lease it started with — it was FENCED (its lease lapsed and
 * another process stole it, or an operator/archive force-took it).
 *
 * This is the error that preserves #787's guarantee under a TTL lease: a fenced run
 * must abort BEFORE it upserts into the shadow and BEFORE it swaps, so it can never
 * resurrect a shadow that was discarded under it, nor cut a partial index over.
 */
export class ReindexFencedError extends Error {
  readonly code = "REINDEX_FENCED";
  readonly projectId: string;
  readonly holder: string;
  constructor(projectId: string, holder: string) {
    super(
      `This reindex run no longer holds the lease for project ${projectId} ` +
        `(holder ${holder}) — it was fenced. Aborting before any mutation. Re-run it.`,
    );
    this.name = "ReindexFencedError";
    this.projectId = projectId;
    this.holder = holder;
  }
}

/**
 * The atomic operations a lease backend must provide. The Postgres implementation
 * runs each as a single statement (serialized by row locks); tests use an in-memory
 * fake with identical semantics.
 */
export interface ReindexLeaseBackend {
  /**
   * Acquire the lease for `holder` when it is free, EXPIRED, or already ours (or
   * unconditionally when `force`). Returns the row we now hold, or `null` when
   * another holder owns a still-valid lease.
   */
  acquire(
    name: string,
    holder: string,
    now: number,
    ttlMs: number,
    opts?: { force?: boolean },
  ): Promise<ReindexLeaseRow | null>;
  /**
   * Extend our lease. `false` means we were FENCED: the row is gone (someone
   * released it) or its holder is no longer us (someone stole it). Deliberately does
   * NOT require the lease to be un-expired — a row that still names US proves nobody
   * has acquired or released since we did, which is exactly the fencing property.
   */
  renew(name: string, holder: string, now: number, ttlMs: number): Promise<boolean>;
  /** Release iff still held by `holder` (no-op otherwise). */
  release(name: string, holder: string): Promise<void>;
  /** Read the current row, or `null`. */
  read(name: string): Promise<ReindexLeaseRow | null>;
  /**
   * Throw {@link ReindexFencedError} unless `holder` still owns the lease — AND, in the
   * same statement, extend the lease to `extendUntilMs`.
   *
   * On Postgres this is an `UPDATE … WHERE holder = $holder RETURNING holder`, which
   * takes the row's EXCLUSIVE lock, so when it runs inside the caller's transaction
   * (`exec`) a concurrent `acquire` BLOCKS until that transaction commits — closing the
   * check-then-act window between the fence check and the swap it guards. (An `UPDATE`
   * takes the identical lock a `SELECT … FOR UPDATE` would; the blocking is unchanged.)
   *
   * The extension is what makes the swap SURVIVABLE: the fence's own row lock stops the
   * heartbeat from renewing for the duration of the transaction, so without it a swap
   * that outran the TTL would COMMIT with an expired lease and be stolen instantly. See
   * {@link reindexSwapLeaseExtensionMs}. Because the extension is written inside the
   * caller's transaction, it rolls back with the swap — a crashed pod does not keep a
   * long lease.
   */
  assertHeld(
    projectId: string,
    name: string,
    holder: string,
    exec: RawSqlExecutor | undefined,
    extendUntilMs: number,
  ): Promise<void>;
  /** Operator escape hatch: delete the row whoever holds it. Returns what was removed. */
  forceRelease(name: string): Promise<ReindexLeaseRow | null>;
  /** Test/maintenance helper — clear all lease state. */
  reset(): Promise<void>;
}

/**
 * The no-op backend for NON-Postgres runtimes (SQLite dev/test). SQLite is
 * single-writer and single-process, so the in-process `reindexing` Set in
 * {@link KnowledgeService} is the only guard there can be — exactly as before, and
 * exactly as `AlwaysLeader` does for the scheduler.
 */
export class NullReindexLeaseBackend implements ReindexLeaseBackend {
  async acquire(
    name: string,
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<ReindexLeaseRow | null> {
    return { lockName: name, holder, expiresAt: now + ttlMs, updatedAt: now };
  }
  async renew(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {}
  async read(): Promise<ReindexLeaseRow | null> {
    return null;
  }
  async assertHeld(): Promise<void> {}
  async forceRelease(): Promise<ReindexLeaseRow | null> {
    return null;
  }
  async reset(): Promise<void> {}
}

/** True only when the deployment connects to Postgres (unchanged from #100). */
export function isPostgresDatasource(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = env.DATABASE_URL ?? "";
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

/**
 * Resolve the backend for this process: Postgres when the datasource is Postgres,
 * otherwise the no-op. Same gate the advisory lock used, so SQLite behaviour is
 * bit-for-bit unchanged.
 */
export function resolveReindexLeaseBackend(
  env: NodeJS.ProcessEnv = process.env,
): ReindexLeaseBackend {
  return isPostgresDatasource(env)
    ? new PostgresReindexLeaseBackend(defaultPrisma)
    : new NullReindexLeaseBackend();
}

let backendSingleton: ReindexLeaseBackend | null = null;
function backend(): ReindexLeaseBackend {
  backendSingleton ??= resolveReindexLeaseBackend();
  return backendSingleton;
}
/** Test seam — drop the resolved backend (env may have changed). */
export function __resetReindexLeaseBackend(): void {
  backendSingleton = null;
}

/**
 * The FULL fence a mutating reindex step needs, of which {@link SwapGuard} is only the
 * cut-over half: `renew()` re-proves ownership before each batch write, `assertHeld()`
 * re-proves it (transactionally, where the backend can) at the cut-over, and
 * `withHeartbeatPaused` suspends the heartbeat across it.
 *
 * PR #803 review — this interface exists because the SYMBOL corpus is mutated from a
 * different module (`code-graph/symbol-embedding-service.ts`) than the document corpus,
 * and that module must be handed the very same fence rather than merely being CALLED
 * from inside the leased closure. Lexical nesting orders two mutations within one
 * process; it fences neither. Anything that writes to a project's vectors under a
 * reindex takes one of these and re-proves ownership AT THE INSTANT IT MUTATES.
 *
 * {@link ReindexLease} is the only production implementation.
 */
export interface ReindexFence extends SwapGuard {
  readonly projectId: string;
  readonly holder: string;
  /** `false` ⇒ FENCED. The caller must abort BEFORE it mutates anything. */
  renew(): Promise<boolean>;
  /** Run the cut-over with the heartbeat suspended — see {@link ReindexLease.withHeartbeatPaused}. */
  withHeartbeatPaused<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * A held lease, and the FENCE its holder must pass through before every mutation.
 * Implements {@link SwapGuard}, so it can be handed to `VectorStore.swapTable()` and
 * re-checked inside the store's own swap transaction.
 */
export class ReindexLease implements ReindexFence {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fenced = false;
  /** A heartbeat renew is out and has not come back. Stops ticks piling up. */
  private renewInFlight = false;
  /** Reentrant suspend count — see {@link withHeartbeatPaused}. */
  private paused = 0;

  constructor(
    private readonly be: ReindexLeaseBackend,
    readonly projectId: string,
    readonly holder: string,
    private readonly ttlMs: number,
    private readonly renewIntervalMs: number,
    private readonly now: () => number,
  ) {}

  private get name(): string {
    return reindexLockName(this.projectId);
  }

  /**
   * Extend the lease. `false` ⇒ this run has been FENCED and MUST NOT mutate
   * anything (the caller aborts). Called once per embed batch, immediately before
   * the upsert, so a fenced run cannot even recreate the shadow it was told to
   * abandon.
   */
  async renew(): Promise<boolean> {
    if (this.fenced) return false;
    const ok = await this.be.renew(this.name, this.holder, this.now(), this.ttlMs);
    if (!ok) {
      this.fenced = true;
      log.warn("reindex run fenced — its lease is no longer held", {
        projectId: this.projectId,
        holder: this.holder,
      });
    }
    return ok;
  }

  /**
   * Throw {@link ReindexFencedError} unless we still hold the lease — and renew it in the
   * same statement.
   *
   * When `exec` is set we are riding the SWAP's transaction, and the lease must stay valid
   * for as long as that transaction may run (the fence's own row lock prevents the
   * heartbeat from renewing meanwhile). So extend by the swap's whole budget, not the
   * ordinary TTL. Off the swap path the ordinary TTL is right.
   */
  async assertHeld(exec?: RawSqlExecutor): Promise<void> {
    if (this.fenced) throw new ReindexFencedError(this.projectId, this.holder);
    const extendUntilMs = this.now() + (exec ? reindexSwapLeaseExtensionMs() : this.ttlMs);
    await this.be.assertHeld(this.projectId, this.name, this.holder, exec, extendUntilMs);
  }

  /**
   * Run `fn` (the CUT-OVER) with the heartbeat suspended.
   *
   * PR #805 review round 2. The swap's fence holds an exclusive lock on the lease row
   * until the transaction commits, so for that whole window a heartbeat `UPDATE` — issued
   * on a DIFFERENT pooled connection — cannot do anything except block on that lock. It
   * is not merely useless, it is actively harmful: `pg.Pool` defaults to `max: 10` with no
   * `connectionTimeoutMillis` (`lib/prisma.ts`), so each blocked tick parks a pooled
   * connection FOREVER, and on a multi-minute swap the ticks accumulate until the pool is
   * exhausted and every other query in the process — API, scheduler, ingest — queues
   * behind a cut-over that has minutes left to run.
   *
   * So the heartbeat is suspended across the swap, and the lease is instead kept fresh by
   * the fence itself ({@link assertHeld} extends it to cover the transaction's own
   * deadline). Reentrancy-counted rather than a boolean so a nested pause cannot re-arm
   * the ticks early.
   */
  async withHeartbeatPaused<T>(fn: () => Promise<T>): Promise<T> {
    this.paused += 1;
    try {
      return await fn();
    } finally {
      this.paused -= 1;
    }
  }

  /** Arm the heartbeat so a batch that outruns the TTL does not self-fence. */
  startHeartbeat(): void {
    if (this.timer || this.be instanceof NullReindexLeaseBackend) return;
    this.timer = setInterval(() => {
      // Suspended for the duration of the cut-over — see `withHeartbeatPaused`.
      if (this.paused > 0) return;
      // NEVER let ticks pile up. A renew that has not come back is either slow or BLOCKED
      // on the lease row's lock, and firing a second one can only add another blocked
      // pooled connection behind the first. `setInterval` does not wait for an async
      // callback, so without this guard a stalled renew multiplies once per tick until
      // the pool is gone. Defence in depth: `withHeartbeatPaused` should already have
      // stopped the ticks that would block, but this caps the damage at ONE connection
      // for any OTHER cause of a slow renew (a saturated DB, a long lock queue) and for
      // any future caller that forgets to pause.
      if (this.renewInFlight) return;
      this.renewInFlight = true;
      void this.renew()
        .catch(() => {
          /* a transient renew error is retried on the next tick; the fence gates decide */
        })
        .finally(() => {
          this.renewInFlight = false;
        });
    }, this.renewIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Never release a lease we no longer own — that would delete the row belonging
    // to whoever fenced us.
    if (this.fenced) return;
    await this.be.release(this.name, this.holder).catch((err: unknown) => {
      log.warn("reindex lease release failed (it will expire via TTL)", {
        projectId: this.projectId,
        error: (err as Error).message,
      });
    });
  }
}

export interface WithReindexLeaseOptions {
  backend?: ReindexLeaseBackend;
  /**
   * TEST-ONLY. Pin the fencing token so a test can talk about a specific holder.
   *
   * Deliberately NOT called `holder`: production code must never supply one. Correctness
   * requires the token to be UNIQUE PER ATTEMPT (see {@link newReindexHolderId} for why
   * — a stable value makes ABA reachable and turns `renew()` from a fence into a
   * no-op). Leaving it unset is the only safe call, so the unsafe call is spelled in a
   * way nobody copies into prod by accident.
   */
  holderForTest?: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  now?: () => number;
  /** Arm the heartbeat timer. Off for short critical sections (discard, drop). */
  heartbeat?: boolean;
  /**
   * Take the lease UNCONDITIONALLY, fencing whoever holds it. Used ONLY by
   * `dropProject()` (project archive), which must be fail-SAFE rather than
   * fail-closed: an archive cannot be blockable forever by a wedged reindex.
   */
  force?: boolean;
}

/**
 * Run `fn` while holding `projectId`'s reindex lease; release it afterwards.
 *
 * Throws {@link ReindexConflictError} (→ HTTP 409) when another process holds a
 * still-valid lease, unless `force`.
 */
export async function withReindexLease<T>(
  projectId: string,
  fn: (lease: ReindexLease) => Promise<T>,
  opts: WithReindexLeaseOptions = {},
): Promise<T> {
  const be = opts.backend ?? backend();
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? reindexLeaseTtlMs();
  const renewIntervalMs =
    opts.renewIntervalMs ?? Math.max(1_000, Math.min(DEFAULT_REINDEX_RENEW_INTERVAL_MS, ttlMs / 3));
  const holder = opts.holderForTest ?? newReindexHolderId();
  const name = reindexLockName(projectId);

  const row = await be.acquire(name, holder, now(), ttlMs, { force: opts.force === true });
  if (!row) {
    const current = await be.read(name).catch(() => null);
    throw new ReindexConflictError(projectId, current?.holder);
  }

  const lease = new ReindexLease(be, projectId, holder, ttlMs, renewIntervalMs, now);
  if (opts.heartbeat !== false) lease.startHeartbeat();
  try {
    return await fn(lease);
  } finally {
    await lease.stop();
  }
}

function toInfo(projectId: string, row: ReindexLeaseRow, now: number): ReindexLeaseInfo {
  return {
    projectId,
    holder: row.holder,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    ageMs: Math.max(0, now - row.updatedAt),
    expired: row.expiresAt <= now,
  };
}

/**
 * Read a project's lease WITHOUT touching it — the operator's `lock-status`, and
 * what `reindexShadowState()` reports as `inProgress`.
 *
 * Unlike the advisory lock this replaces, the read is a plain `SELECT` from OUR OWN
 * database. The old `pg_locks` read was never scoped to the current database
 * (`pg_locks.database` was absent from its WHERE clause), so a SIBLING METIS database
 * on a shared cluster could make this report a phantom "reindex in progress". With a
 * lease table that bug simply cannot exist.
 */
export async function readReindexLease(
  projectId: string,
  opts: { backend?: ReindexLeaseBackend; now?: () => number } = {},
): Promise<ReindexLeaseInfo | null> {
  const be = opts.backend ?? backend();
  const now = (opts.now ?? Date.now)();
  const row = await be.read(reindexLockName(projectId)).catch((err: unknown) => {
    log.warn("could not read the reindex lease", {
      projectId,
      error: (err as Error).message,
    });
    return null;
  });
  return row ? toInfo(projectId, row, now) : null;
}

/**
 * Operator escape hatch (#798 AC 3): clear a project's lease WITHOUT restarting the
 * pod. Returns the lease that was removed, or `null` if there was none.
 *
 * Safe by construction, which a force-unlock of a session advisory lock was not: any
 * run whose lease is deleted here is FENCED — its next per-batch renew returns false
 * and its pre-swap `assertHeld` throws, so it aborts before mutating anything. The
 * worst an over-eager unlock can cost is a re-run.
 */
export async function forceReleaseReindexLease(
  projectId: string,
  opts: { backend?: ReindexLeaseBackend; now?: () => number } = {},
): Promise<ReindexLeaseInfo | null> {
  const be = opts.backend ?? backend();
  const now = (opts.now ?? Date.now)();
  const row = await be.forceRelease(reindexLockName(projectId));
  if (row) {
    log.warn("reindex lease force-released by an operator", {
      projectId,
      holder: row.holder,
      ageMs: Math.max(0, now - row.updatedAt),
    });
  }
  return row ? toInfo(projectId, row, now) : null;
}

// ---- In-memory backend (unit tests) ---------------------------------------

/**
 * An in-memory {@link ReindexLeaseBackend} with the SAME semantics as the Postgres
 * one. Two `KnowledgeService` instances sharing ONE of these model two pods sharing
 * one database — which is how the multi-replica tests are written.
 */
export class MemoryReindexLeaseBackend implements ReindexLeaseBackend {
  private readonly rows = new Map<string, ReindexLeaseRow>();

  async acquire(
    name: string,
    holder: string,
    now: number,
    ttlMs: number,
    opts: { force?: boolean } = {},
  ): Promise<ReindexLeaseRow | null> {
    const existing = this.rows.get(name);
    const takeable =
      opts.force === true ||
      existing === undefined ||
      existing.expiresAt <= now ||
      existing.holder === holder;
    if (!takeable) return null;
    const row: ReindexLeaseRow = { lockName: name, holder, expiresAt: now + ttlMs, updatedAt: now };
    this.rows.set(name, row);
    return { ...row };
  }

  async renew(name: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
    const existing = this.rows.get(name);
    if (!existing || existing.holder !== holder) return false;
    this.rows.set(name, { ...existing, expiresAt: now + ttlMs, updatedAt: now });
    return true;
  }

  async release(name: string, holder: string): Promise<void> {
    const existing = this.rows.get(name);
    if (existing?.holder === holder) this.rows.delete(name);
  }

  async read(name: string): Promise<ReindexLeaseRow | null> {
    const row = this.rows.get(name);
    return row ? { ...row } : null;
  }

  async assertHeld(
    projectId: string,
    name: string,
    holder: string,
    _exec: RawSqlExecutor | undefined,
    extendUntilMs: number,
  ): Promise<void> {
    const row = this.rows.get(name);
    if (!row || row.holder !== holder) throw new ReindexFencedError(projectId, holder);
    // Mirror the Postgres backend: the fence RENEWS as it proves. Tests that assert a
    // swap keeps its lease alive across the cut-over must see the same thing here.
    this.rows.set(name, { ...row, expiresAt: extendUntilMs, updatedAt: Date.now() });
  }

  async forceRelease(name: string): Promise<ReindexLeaseRow | null> {
    const row = this.rows.get(name);
    this.rows.delete(name);
    return row ? { ...row } : null;
  }

  async reset(): Promise<void> {
    this.rows.clear();
  }

  /**
   * TEST SEAM — age a lease out without a clock. Models the ONE thing a fenced-run
   * test needs to arrange: the holder stopped renewing long enough for the TTL to
   * lapse (a GC pause, a partition, a SIGKILL). The lease is then stealable by anyone,
   * exactly as it would be on Postgres once `expires_at` is in the past.
   */
  expire(name: string): void {
    const row = this.rows.get(name);
    if (row) this.rows.set(name, { ...row, expiresAt: 0 });
  }
}

// ---- Postgres backend ------------------------------------------------------

interface RawLeaseRow {
  holder: string;
  expires_at: bigint | number;
  updated_at: bigint | number;
}

function fromRaw(name: string, row: RawLeaseRow): ReindexLeaseRow {
  return {
    lockName: name,
    holder: row.holder,
    expiresAt: Number(row.expires_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Postgres-backed {@link ReindexLeaseBackend}. Reuses the shared Prisma client
 * (#539's scheme-selected `pg` adapter), so it adds NO new failure domain and no new
 * connection lifecycle to own — the same rationale as #541/#542/#544.
 *
 * Every operation is a SINGLE statement over ordinary rows, which is precisely what
 * makes it immune to the pool-routing bug that killed the advisory lock: it does not
 * matter which backend serves which statement.
 */
export class PostgresReindexLeaseBackend implements ReindexLeaseBackend {
  private readonly db: PrismaClient;
  private ensured: Promise<void> | undefined;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Idempotently create the UNLOGGED table (once per process), serialized by a
   * TRANSACTION-scoped advisory lock so two replicas racing the first create do not
   * collide on `pg_type` (the same 23505 race #541/#542/#544 guard against). A
   * transaction-scoped lock is safe under the pool — it is released at COMMIT by
   * Postgres itself, never by a second statement that might be routed elsewhere.
   */
  private ensureTable(): Promise<void> {
    this.ensured ??= this.db
      .$executeRawUnsafe(
        `DO $$
         BEGIN
           PERFORM pg_advisory_xact_lock(${TABLE_LOCK_ID});
           CREATE UNLOGGED TABLE IF NOT EXISTS "${LEASE_TABLE}" (
             "lock_name"  TEXT   NOT NULL PRIMARY KEY,
             "holder"     TEXT   NOT NULL,
             "expires_at" BIGINT NOT NULL,
             "updated_at" BIGINT NOT NULL
           );
         EXCEPTION WHEN duplicate_table OR duplicate_object THEN
           NULL;
         END $$;`,
      )
      .then(() => undefined)
      .catch((err: unknown) => {
        this.ensured = undefined;
        throw err;
      });
    return this.ensured;
  }

  async acquire(
    name: string,
    holder: string,
    now: number,
    ttlMs: number,
    opts: { force?: boolean } = {},
  ): Promise<ReindexLeaseRow | null> {
    await this.ensureTable();
    const expiresAt = now + ttlMs;

    // Insert if absent; on conflict take the lease ONLY when it is expired or already
    // ours (or unconditionally, for the archive's fail-SAFE force). `RETURNING` yields
    // a row iff this statement made us the holder; the row lock Postgres takes on the
    // conflicting row serializes contending replicas, so at most one wins per instant.
    const rows = opts.force
      ? await this.db.$queryRaw<RawLeaseRow[]>`
          INSERT INTO "reindex_lease" ("lock_name", "holder", "expires_at", "updated_at")
          VALUES (${name}, ${holder}, ${expiresAt}, ${now})
          ON CONFLICT ("lock_name") DO UPDATE
            SET "holder" = EXCLUDED."holder",
                "expires_at" = EXCLUDED."expires_at",
                "updated_at" = EXCLUDED."updated_at"
          RETURNING "holder", "expires_at", "updated_at"`
      : await this.db.$queryRaw<RawLeaseRow[]>`
          INSERT INTO "reindex_lease" ("lock_name", "holder", "expires_at", "updated_at")
          VALUES (${name}, ${holder}, ${expiresAt}, ${now})
          ON CONFLICT ("lock_name") DO UPDATE
            SET "holder" = EXCLUDED."holder",
                "expires_at" = EXCLUDED."expires_at",
                "updated_at" = EXCLUDED."updated_at"
            WHERE "reindex_lease"."expires_at" <= ${now}
               OR "reindex_lease"."holder" = ${holder}
          RETURNING "holder", "expires_at", "updated_at"`;

    const row = rows[0];
    return row && row.holder === holder ? fromRaw(name, row) : null;
  }

  /**
   * Extend our lease — and, far more importantly, PROVE we still hold it. Returns
   * `false` iff we have been fenced, which every caller must treat as "abort before
   * mutating anything".
   *
   * ## Why there is no `expires_at > now` predicate, and why that is safe
   *
   * Matching on `holder` alone is sufficient BECAUSE OF THE UNIQUENESS INVARIANT (see
   * {@link newReindexHolderId}): `acquire` is the ONLY writer of `holder`, and it is
   * only ever called with a freshly-minted `<podId>:<uuid4>`. Nobody else can name us.
   * So a row that still names us cannot have been restored to that state by a third
   * party after someone else held it — which is exactly what would otherwise make this
   * an ABA hazard. A row naming us therefore PROVES no acquire/release has intervened:
   *
   *   - a steal or a force-take (`acquire`) overwrites `holder`  → we match 0 rows;
   *   - `release` is `DELETE … AND holder = $holder`, so it only removes its OWN row;
   *   - `forceRelease` (operator `unlock`) deletes the row       → we match 0 rows;
   *   - the UNLOGGED crash-recovery TRUNCATE empties the table   → we match 0 rows.
   *
   * Every one of those fences us. Adding un-expiry on top would buy NO safety (the fence
   * comes from holder identity, not from the clock) and would cost correctness: it would
   * self-fence a run that merely PAUSED past its TTL with nobody contending.
   *
   * That pairs with {@link ReindexLease.startHeartbeat}, which renews on an independent
   * timer so a slow batch never lapses in the first place. The two are load-bearing FOR
   * EACH OTHER: the heartbeat keeps an ordinary slow run alive, and this no-expiry rule
   * is what lets a run whose EVENT LOOP was blocked past the TTL (so the heartbeat timer
   * never fired) still recover — provided nobody took the lease meanwhile. Tighten
   * either one in isolation and you break the other.
   */
  async renew(name: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
    await this.ensureTable();
    const rows = await this.db.$queryRaw<Array<{ holder: string }>>`
      UPDATE "reindex_lease"
         SET "expires_at" = ${now + ttlMs}, "updated_at" = ${now}
       WHERE "lock_name" = ${name} AND "holder" = ${holder}
      RETURNING "holder"`;
    return rows.length === 1;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.ensureTable();
    await this.db.$executeRaw`
      DELETE FROM "reindex_lease" WHERE "lock_name" = ${name} AND "holder" = ${holder}`;
  }

  async read(name: string): Promise<ReindexLeaseRow | null> {
    await this.ensureTable();
    const rows = await this.db.$queryRaw<RawLeaseRow[]>`
      SELECT "holder", "expires_at", "updated_at"
        FROM "reindex_lease" WHERE "lock_name" = ${name}`;
    const row = rows[0];
    return row ? fromRaw(name, row) : null;
  }

  async assertHeld(
    projectId: string,
    name: string,
    holder: string,
    exec: RawSqlExecutor | undefined,
    extendUntilMs: number,
  ): Promise<void> {
    // NEVER touch the pool from inside someone else's transaction. When `exec` is set we
    // are riding the swap's interactive transaction, which has one pooled connection
    // PINNED for the duration of its callback; `ensureTable()` issues DDL on `this.db`,
    // i.e. it would ask the pool for a SECOND connection while the first is held. Today
    // that is harmless only by luck of memoisation (the run's `acquire()` resolved
    // `this.ensured` minutes ago, so no SQL is emitted) — but `ensureTable` CLEARS the
    // memo on failure, so a re-triggered create would fire a `CREATE UNLOGGED TABLE` +
    // `pg_advisory_xact_lock` on a different backend from inside the open swap
    // transaction: a self-deadlock against a small pool, surfacing as a P2028 at the
    // most safety-critical moment in the system. Skip it — inside the caller's
    // transaction the table demonstrably exists, because we hold a ROW in it.
    if (!exec) await this.ensureTable();

    // ONE statement, doing BOTH jobs. It is an `UPDATE`, not a `SELECT … FOR UPDATE`,
    // and the difference is load-bearing in two directions:
    //
    //   FENCE (unchanged). An `UPDATE` takes the row's EXCLUSIVE lock exactly as
    //   `FOR UPDATE` does. Run inside the swap's transaction (`exec` = the tx client) it
    //   holds that lock until COMMIT, so a concurrent `acquire` — which must take the
    //   same lock to apply its `ON CONFLICT DO UPDATE`, BEFORE it evaluates that
    //   statement's `WHERE expires_at <= now` — blocks behind the swap instead of racing
    //   it. `WHERE holder = $holder` + 0 rows returned is the same fenced signal the
    //   `FOR UPDATE` form produced by comparing the holder it read. Nothing about the
    //   half-open window's closure changes. (Both halves proved against a real Postgres:
    //   `tests/reindex-lease-postgres.integration.test.ts` (c4) blocks the steal, and
    //   (c4-control) shows it sailing through without the lock.)
    //
    //   RENEWAL (new — PR #805 review round 2). That same row lock is what stops the
    //   run's OWN heartbeat from renewing while the swap runs: a heartbeat `UPDATE` on
    //   another pooled connection would block on it, and on a large corpus the swap can
    //   outlive the 120 s TTL. A `FOR UPDATE` fence therefore reaches COMMIT holding an
    //   EXPIRED lease, and the steal queued behind the row lock wins the instant the lock
    //   drops — fencing the run at its post-swap `renew()` and silently skipping delta
    //   re-apply, orphan deletes and the model retag. Renewing AS we fence removes that
    //   whole class of failure for free: same lock, same 0-rows-means-fenced semantics,
    //   plus a lease that outlives the transaction it is guarding. (c6) covers it.
    //
    // And because this write lives INSIDE the caller's transaction, a swap that aborts
    // rolls the extension back with it — a pod SIGKILLed mid-cut-over leaves the lease on
    // its ordinary TTL, not a 10-minute one. The longer expiry is only ever published by
    // a COMMIT, i.e. only when we really did still hold the lease and really did cut over.
    const db = exec ?? this.db;
    const rows = await db.$queryRaw<Array<{ holder: string }>>`
      UPDATE "reindex_lease"
         SET "expires_at" = ${extendUntilMs}, "updated_at" = ${Date.now()}
       WHERE "lock_name" = ${name} AND "holder" = ${holder}
      RETURNING "holder"`;
    if (rows.length !== 1) throw new ReindexFencedError(projectId, holder);
  }

  async forceRelease(name: string): Promise<ReindexLeaseRow | null> {
    await this.ensureTable();
    const rows = await this.db.$queryRaw<RawLeaseRow[]>`
      DELETE FROM "reindex_lease" WHERE "lock_name" = ${name}
      RETURNING "holder", "expires_at", "updated_at"`;
    const row = rows[0];
    return row ? fromRaw(name, row) : null;
  }

  async reset(): Promise<void> {
    await this.ensureTable().catch(() => {});
    await this.db.$executeRawUnsafe(`TRUNCATE TABLE "${LEASE_TABLE}"`).catch(() => {});
  }
}
