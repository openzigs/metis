/**
 * #1059 — an in-memory `spec_kit_jobs` table with the same contract as
 * `src/lib/spec-kit/job-store.ts`, for suites that stub Prisma. It keeps the
 * two properties the job runner relies on: `activeKey` is unique among rows
 * that hold one, and every state change is a compare-and-set.
 *
 * Use it as the module mock:
 *
 *   vi.mock("../src/lib/spec-kit/job-store.js", async () =>
 *     (await import("./helpers/spec-kit-job-store-fake.js")).fakeSpecKitJobStore);
 *
 * and call `resetFakeSpecKitJobStore()` between tests. The real table, its
 * unique index included, is exercised by `spec-kit-jobs-1059.sqlite.test.ts`.
 */
import type { JobOutcome, NewSpecKitJob, SpecKitJobRow } from "../../src/lib/spec-kit/job-store.js";

const LIVE_STATUSES = ["running", "cancelling"];
const rows = new Map<string, SpecKitJobRow>();
const isLive = (row: SpecKitJobRow): boolean => LIVE_STATUSES.includes(row.status);
const copy = (row: SpecKitJobRow | undefined | null): SpecKitJobRow | null =>
  row ? { ...row } : null;

/** The rows themselves, for a test that needs to age a heartbeat or plant a job. */
export const fakeSpecKitJobRows = rows;

export function resetFakeSpecKitJobStore(): void {
  rows.clear();
}

/** Insert a row as another process would have left it. */
export function plantFakeSpecKitJob(row: Partial<SpecKitJobRow> & { id: string }): SpecKitJobRow {
  const now = new Date();
  const full: SpecKitJobRow = {
    projectId: "p1",
    command: "speckit.plan",
    featureSlug: null,
    activeKey: null,
    status: "running",
    phase: null,
    result: null,
    error: null,
    startedById: null,
    heartbeatAt: now,
    startedAt: now,
    finishedAt: null,
    ...row,
  };
  rows.set(full.id, full);
  return full;
}

export const fakeSpecKitJobStore = {
  LIVE_STATUSES,

  async createJob(job: NewSpecKitJob): Promise<SpecKitJobRow | null> {
    for (const row of rows.values()) {
      if (row.activeKey === job.activeKey) return null;
    }
    const row: SpecKitJobRow = {
      id: job.id,
      projectId: job.projectId,
      command: job.command,
      featureSlug: job.featureSlug,
      activeKey: job.activeKey,
      status: "running",
      phase: null,
      result: null,
      error: null,
      startedById: job.startedById,
      heartbeatAt: job.now,
      startedAt: job.now,
      finishedAt: null,
    };
    rows.set(row.id, row);
    return copy(row);
  },

  async findJob(projectId: string, id: string): Promise<SpecKitJobRow | null> {
    const row = rows.get(id);
    return row && row.projectId === projectId ? copy(row) : null;
  },

  async findJobByActiveKey(activeKey: string): Promise<SpecKitJobRow | null> {
    return copy([...rows.values()].find((row) => row.activeKey === activeKey));
  },

  async listLiveJobs(projectId: string): Promise<SpecKitJobRow[]> {
    return [...rows.values()]
      .filter((row) => row.projectId === projectId && isLive(row))
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((row) => ({ ...row }));
  },

  async beatJob(id: string, now: Date): Promise<string | null> {
    const row = rows.get(id);
    if (!row || !isLive(row)) return null;
    row.heartbeatAt = now;
    return row.status;
  },

  async setJobPhase(id: string, phase: string): Promise<void> {
    const row = rows.get(id);
    if (row && isLive(row)) row.phase = phase;
  },

  async markJobCancelling(projectId: string, id: string): Promise<boolean> {
    const row = rows.get(id);
    if (!row || row.projectId !== projectId || row.status !== "running") return false;
    row.status = "cancelling";
    return true;
  },

  async finishJob(
    id: string,
    outcome: JobOutcome,
    now: Date,
    expect: { status?: string; heartbeatAt?: Date } = {},
  ): Promise<boolean> {
    const row = rows.get(id);
    if (!row) return false;
    if (expect.status ? row.status !== expect.status : !isLive(row)) return false;
    if (expect.heartbeatAt && row.heartbeatAt.getTime() !== expect.heartbeatAt.getTime()) {
      return false;
    }
    row.status = outcome.status;
    row.activeKey = null;
    row.finishedAt = now;
    row.result = outcome.result ?? null;
    row.error = outcome.error ?? null;
    return true;
  },

  async findStaleJobs(cutoff: Date): Promise<SpecKitJobRow[]> {
    return [...rows.values()]
      .filter((row) => isLive(row) && row.heartbeatAt.getTime() < cutoff.getTime())
      .map((row) => ({ ...row }));
  },

  async pruneFinishedJobs(cutoff: Date): Promise<number> {
    let pruned = 0;
    for (const row of [...rows.values()]) {
      if (!isLive(row) && row.finishedAt && row.finishedAt.getTime() < cutoff.getTime()) {
        rows.delete(row.id);
        pruned += 1;
      }
    }
    return pruned;
  },
};
