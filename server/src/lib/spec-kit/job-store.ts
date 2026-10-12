/**
 * #1059 — the `spec_kit_jobs` table: every database call the Spec Kit job
 * runner makes, and nothing else, so the runner's rules (who may start, who may
 * save, who may finish, what a dead job becomes) read as plain code in
 * `jobs.ts`.
 *
 * Two properties are kept HERE, in SQL, because nothing above the database can
 * keep them once there is more than one replica:
 *
 *   - **Every state change is one conditional `UPDATE`** on the status (and,
 *     for the commit, the `activeKey`) the row must still have. Two writers of
 *     the same row — the owner finishing and a sweep, a cancel and a save, the
 *     time limit and a save — are serialised by the database and exactly one of
 *     them matches a row.
 *   - **One clock.** `heartbeatAt` and `finishedAt` are written with the
 *     DATABASE's current time, and a heartbeat is judged stale by comparing it
 *     with the database's current time in the same statement. No replica's
 *     `new Date()` is ever compared with another's: a replica whose clock is
 *     minutes off neither fails a live job nor keeps a dead one alive.
 *
 * The time expressions differ per engine, so those statements are raw SQL
 * behind {@link specKitJobClock}; everything else is the typed client.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

export interface SpecKitJobRow {
  id: string;
  projectId: string;
  command: string;
  featureSlug: string | null;
  activeKey: string | null;
  status: string;
  phase: string | null;
  result: string | null;
  error: string | null;
  startedById: string | null;
  heartbeatAt: Date;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * The statuses of a job that still holds its `activeKey`. `running` may still
 * be cancelled or timed out; `cancelling` has lost the right to save; `saving`
 * has won it and can no longer be cancelled.
 */
export const LIVE_STATUSES = ["running", "cancelling", "saving"];

export type SpecKitJobSqlEngine = "sqlite" | "postgresql";

/** The engine behind `DATABASE_URL`, by the scheme rule `lib/prisma.ts` uses. */
export function specKitJobSqlEngine(env: NodeJS.ProcessEnv = process.env): SpecKitJobSqlEngine {
  const url = (env.DATABASE_URL ?? "").trim();
  return url.startsWith("postgres://") || url.startsWith("postgresql://") ? "postgresql" : "sqlite";
}

/**
 * The database's own clock, as SQL.
 *
 *   - SQLite: Prisma's driver adapter stores a `DateTime` as ISO-8601 text
 *     (`2026-10-12T09:44:56.729+00:00`), which sorts as text in time order.
 *     `strftime` renders "now" in exactly that shape.
 *   - Postgres: the columns are `TIMESTAMP(3)` holding UTC. `clock_timestamp()`
 *     rather than `now()`, which is frozen at the start of a transaction.
 */
export function specKitJobClock(engine: SpecKitJobSqlEngine): {
  now: Prisma.Sql;
  ago: (ms: number) => Prisma.Sql;
} {
  if (engine === "postgresql") {
    return {
      now: Prisma.sql`timezone('UTC', clock_timestamp())`,
      ago: (ms) =>
        Prisma.sql`(timezone('UTC', clock_timestamp()) - (CAST(${ms} AS double precision) * interval '1 millisecond'))`,
    };
  }
  return {
    now: Prisma.sql`strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')`,
    ago: (ms) =>
      Prisma.sql`strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now', ${`-${(ms / 1000).toFixed(3)} seconds`})`,
  };
}

const clock = (): ReturnType<typeof specKitJobClock> => specKitJobClock(specKitJobSqlEngine());

/**
 * A unique-constraint refusal, from the typed client (`P2002`) or from a raw
 * statement, which Prisma reports as `P2010` with the driver's own
 * classification underneath.
 */
function isUniqueRefusal(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code === "P2002") return true;
  const meta = (err as { meta?: { driverAdapterError?: { cause?: { kind?: unknown } } } }).meta;
  return meta?.driverAdapterError?.cause?.kind === "UniqueConstraintViolation";
}

export interface NewSpecKitJob {
  id: string;
  projectId: string;
  command: string;
  featureSlug: string | null;
  activeKey: string;
  startedById: string | null;
}

/**
 * Insert a running job, stamped with the database's time. `null` when another
 * live job holds `activeKey`: the unique index refused the row, which is how a
 * second writer is kept out.
 */
export async function createJob(job: NewSpecKitJob): Promise<SpecKitJobRow | null> {
  const { now } = clock();
  try {
    await prisma.$executeRaw`
      INSERT INTO "spec_kit_jobs"
        ("id", "projectId", "command", "featureSlug", "activeKey", "status", "startedById", "heartbeatAt", "startedAt")
      VALUES
        (${job.id}, ${job.projectId}, ${job.command}, ${job.featureSlug}, ${job.activeKey}, 'running', ${job.startedById}, ${now}, ${now})`;
  } catch (err) {
    if (isUniqueRefusal(err)) return null;
    throw err;
  }
  return prisma.specKitJob.findUnique({ where: { id: job.id } });
}

/** A job by id, only within `projectId`: another project's id reads as absent. */
export function findJob(projectId: string, id: string): Promise<SpecKitJobRow | null> {
  return prisma.specKitJob.findFirst({ where: { id, projectId } });
}

/** The live job holding `activeKey`, if any. */
export function findJobByActiveKey(activeKey: string): Promise<SpecKitJobRow | null> {
  return prisma.specKitJob.findUnique({ where: { activeKey } });
}

/** A project's live jobs, oldest first. */
export function listLiveJobs(projectId: string): Promise<SpecKitJobRow[]> {
  return prisma.specKitJob.findMany({
    where: { projectId, status: { in: LIVE_STATUSES } },
    orderBy: { startedAt: "asc" },
  });
}

/**
 * Refresh a live job's heartbeat with the database's time. Returns its status,
 * or `null` when the row is no longer live (finished, swept or deleted) — the
 * caller has lost the job.
 */
export async function beatJob(id: string): Promise<string | null> {
  const { now } = clock();
  const refreshed = await prisma.$executeRaw`
    UPDATE "spec_kit_jobs" SET "heartbeatAt" = ${now}
    WHERE "id" = ${id} AND "status" IN (${Prisma.join(LIVE_STATUSES)})`;
  if (!refreshed) return null;
  const row = await prisma.specKitJob.findUnique({ where: { id }, select: { status: true } });
  return row && LIVE_STATUSES.includes(row.status) ? row.status : null;
}

/** Record what a live job is doing. A finished job's phase is left as it ended. */
export async function setJobPhase(id: string, phase: string): Promise<void> {
  await prisma.specKitJob.updateMany({
    where: { id, status: { in: LIVE_STATUSES } },
    data: { phase },
  });
}

/**
 * THE COMMIT POINT: `running` → `saving`. True only when the row is still this
 * job's (`id`), still `running` (not cancelled, timed out or swept) and still
 * holds the `activeKey` it was started with. A job for which this is false must
 * write nothing. Refreshes the heartbeat in the same statement, so a job that
 * has just won the right to save is not stale.
 */
export async function beginSaving(id: string, activeKey: string): Promise<boolean> {
  const { now } = clock();
  const won = await prisma.$executeRaw`
    UPDATE "spec_kit_jobs" SET "status" = 'saving', "heartbeatAt" = ${now}
    WHERE "id" = ${id} AND "status" = 'running' AND "activeKey" = ${activeKey}`;
  return won > 0;
}

/**
 * Re-check, before each later artifact write, that the job still owns its row
 * in `saving`, and refresh its heartbeat. False when the row was taken from it
 * (a sweep found its heartbeat stopped): it must write nothing more.
 */
export async function confirmSaving(id: string, activeKey: string): Promise<boolean> {
  const { now } = clock();
  const still = await prisma.$executeRaw`
    UPDATE "spec_kit_jobs" SET "heartbeatAt" = ${now}
    WHERE "id" = ${id} AND "status" = 'saving' AND "activeKey" = ${activeKey}`;
  return still > 0;
}

/**
 * `running` → `cancelling`. False when the job was not `running` — in
 * particular when it is already `saving`, which a cancel can no longer stop.
 */
export async function markJobCancelling(projectId: string, id: string): Promise<boolean> {
  const marked = await prisma.specKitJob.updateMany({
    where: { id, projectId, status: "running" },
    data: { status: "cancelling" },
  });
  return marked.count > 0;
}

export interface JobOutcome {
  status: "succeeded" | "failed" | "cancelled";
  result?: string;
  error?: string;
}

/**
 * Move a job from one of the statuses in `from` to its terminal state and
 * release its `activeKey`. False when the row is in none of them, so a row
 * somebody else already moved is never overwritten: whoever's `UPDATE` matched
 * first owns the outcome.
 */
export async function finishJob(
  id: string,
  outcome: JobOutcome,
  from: readonly string[],
): Promise<boolean> {
  const { now } = clock();
  const finished = await prisma.$executeRaw`
    UPDATE "spec_kit_jobs"
    SET "status" = ${outcome.status}, "activeKey" = NULL, "finishedAt" = ${now},
        "result" = ${outcome.result ?? null}, "error" = ${outcome.error ?? null}
    WHERE "id" = ${id} AND "status" IN (${Prisma.join([...from])})`;
  return finished > 0;
}

/** Which live rows a stale sweep may look at. An empty scope is every row. */
export interface StaleScope {
  id?: string;
  projectId?: string;
  activeKey?: string;
}

/** What a swept row becomes, by the status it was found in. */
export interface StaleOutcomes {
  /** A `running` row: nothing was saved. JSON for the `error` column. */
  interruptedError: string;
  /** A `saving` row: some of its files may have been saved. JSON for the `error` column. */
  interruptedWhileSavingError: string;
}

export interface SweptJob {
  id: string;
  projectId: string;
  /** The status the sweep left: `cancelled` (it was `cancelling`) or `failed`. */
  status: string;
}

/**
 * Fail every live row in `scope` whose heartbeat is more than `staleMs` behind
 * the DATABASE's clock, in one statement: the comparison and the write cannot
 * be separated by another writer, and a finished row (whatever its heartbeat)
 * never matches. A dead `cancelling` job is simply `cancelled`.
 */
export async function failStaleJobs(
  scope: StaleScope,
  staleMs: number,
  outcomes: StaleOutcomes,
): Promise<SweptJob[]> {
  const { now, ago } = clock();
  const narrowed = [
    scope.id !== undefined ? Prisma.sql`AND "id" = ${scope.id}` : Prisma.empty,
    scope.projectId !== undefined ? Prisma.sql`AND "projectId" = ${scope.projectId}` : Prisma.empty,
    scope.activeKey !== undefined ? Prisma.sql`AND "activeKey" = ${scope.activeKey}` : Prisma.empty,
  ];
  // The right-hand `"status"` in each CASE is the value BEFORE this update.
  return prisma.$queryRaw<SweptJob[]>`
    UPDATE "spec_kit_jobs"
    SET "error" = CASE "status"
          WHEN 'cancelling' THEN NULL
          WHEN 'saving' THEN ${outcomes.interruptedWhileSavingError}
          ELSE ${outcomes.interruptedError} END,
        "status" = CASE "status" WHEN 'cancelling' THEN 'cancelled' ELSE 'failed' END,
        "activeKey" = NULL, "result" = NULL, "finishedAt" = ${now}
    WHERE "status" IN (${Prisma.join(LIVE_STATUSES)})
      AND "heartbeatAt" < ${ago(staleMs)}
      ${Prisma.join(narrowed, " ")}
    RETURNING "id", "projectId", "status"`;
}

/** Delete terminal jobs that finished more than `retentionMs` ago, by the database's clock. */
export async function pruneFinishedJobs(retentionMs: number): Promise<number> {
  const { ago } = clock();
  return prisma.$executeRaw`
    DELETE FROM "spec_kit_jobs"
    WHERE "status" NOT IN (${Prisma.join(LIVE_STATUSES)}) AND "finishedAt" < ${ago(retentionMs)}`;
}

/**
 * Remove a job that was inserted but never started (its scope could not be
 * recorded), so no `running` row is left without a runner. Its id never left
 * the server.
 */
export async function discardJob(id: string): Promise<void> {
  await prisma.specKitJob.deleteMany({ where: { id, status: "running" } });
}
