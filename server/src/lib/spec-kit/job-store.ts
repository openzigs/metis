/**
 * #1059 — the `spec_kit_jobs` table: every database call the Spec Kit job
 * runner makes, and nothing else, so the runner's rules (who may start, who may
 * finish, what a dead job becomes) read as plain code in `jobs.ts`.
 *
 * Every state change is a compare-and-set `updateMany` on the status the
 * caller saw, so two replicas (or a job and the sweeper) can race and exactly
 * one of them wins.
 */
import { prisma } from "../prisma.js";
import { isUniqueViolation } from "../db/prisma-errors.js";

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

/** The statuses of a job that may still write. */
export const LIVE_STATUSES = ["running", "cancelling"];

export interface NewSpecKitJob {
  id: string;
  projectId: string;
  command: string;
  featureSlug: string | null;
  activeKey: string;
  startedById: string | null;
  now: Date;
}

/**
 * Insert a running job. `null` when another live job holds `activeKey`: the
 * unique index refused the row, which is how a second writer is kept out.
 */
export async function createJob(job: NewSpecKitJob): Promise<SpecKitJobRow | null> {
  try {
    return await prisma.specKitJob.create({
      data: {
        id: job.id,
        projectId: job.projectId,
        command: job.command,
        featureSlug: job.featureSlug,
        activeKey: job.activeKey,
        status: "running",
        startedById: job.startedById,
        heartbeatAt: job.now,
        startedAt: job.now,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
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
 * Refresh a live job's heartbeat. Returns its status, or `null` when the row is
 * no longer live (finished, swept or deleted) — the caller has lost the job.
 */
export async function beatJob(id: string, now: Date): Promise<string | null> {
  const refreshed = await prisma.specKitJob.updateMany({
    where: { id, status: { in: LIVE_STATUSES } },
    data: { heartbeatAt: now },
  });
  if (!refreshed.count) return null;
  const row = await prisma.specKitJob.findUnique({ where: { id }, select: { status: true } });
  return row?.status ?? null;
}

/** Record what a live job is doing. A finished job's phase is left as it ended. */
export async function setJobPhase(id: string, phase: string): Promise<void> {
  await prisma.specKitJob.updateMany({
    where: { id, status: { in: LIVE_STATUSES } },
    data: { phase },
  });
}

/** `running` → `cancelling`. False when the job was not `running`. */
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
 * Move a live job to its terminal state and release its `activeKey`. False
 * when the job was no longer live, so a job the sweeper already failed is never
 * overwritten by a late finish. `expect` narrows the compare-and-set further
 * (the sweeper passes the heartbeat it read, so a job that beat since is spared).
 */
export async function finishJob(
  id: string,
  outcome: JobOutcome,
  now: Date,
  expect: { status?: string; heartbeatAt?: Date } = {},
): Promise<boolean> {
  const finished = await prisma.specKitJob.updateMany({
    where: {
      id,
      status: expect.status ?? { in: LIVE_STATUSES },
      ...(expect.heartbeatAt ? { heartbeatAt: expect.heartbeatAt } : {}),
    },
    data: {
      status: outcome.status,
      activeKey: null,
      finishedAt: now,
      result: outcome.result ?? null,
      error: outcome.error ?? null,
    },
  });
  return finished.count > 0;
}

/** Live jobs whose heartbeat is older than `cutoff`: no process is running them. */
export function findStaleJobs(cutoff: Date): Promise<SpecKitJobRow[]> {
  return prisma.specKitJob.findMany({
    where: { status: { in: LIVE_STATUSES }, heartbeatAt: { lt: cutoff } },
  });
}

/** Delete terminal jobs that finished before `cutoff`. Returns how many. */
export async function pruneFinishedJobs(cutoff: Date): Promise<number> {
  const pruned = await prisma.specKitJob.deleteMany({
    where: { status: { notIn: LIVE_STATUSES }, finishedAt: { lt: cutoff } },
  });
  return pruned.count;
}
