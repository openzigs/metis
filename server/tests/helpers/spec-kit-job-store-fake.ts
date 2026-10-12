/**
 * #1059 — an in-memory `spec_kit_jobs` table with the same contract as
 * `src/lib/spec-kit/job-store.ts`, for suites that stub Prisma.
 *
 * It is a RE-IMPLEMENTATION, so by itself it proves nothing about the real
 * store. What keeps it honest is `spec-kit-job-store-contract.ts`: one set of
 * assertions about every compare-and-set predicate, run against this fake
 * (`spec-kit-job-store-1059.test.ts`), against the real store on SQLite
 * (`spec-kit-job-store-1059.sqlite.test.ts`) and against the real store on
 * Postgres (`spec-kit-job-store-1059-postgres.integration.test.ts`, in CI's
 * `postgres-adapter` job). The job runner's own rules run against both this
 * fake and the real SQLite store (`spec-kit-job-rules.ts`).
 *
 * Use it as the module mock:
 *
 *   vi.mock("../src/lib/spec-kit/job-store.js", async () =>
 *     (await import("./helpers/spec-kit-job-store-fake.js")).fakeSpecKitJobStore);
 *
 * and call `resetFakeSpecKitJobStore()` between tests.
 */
import type {
  JobOutcome,
  NewSpecKitJob,
  SpecKitJobRow,
  StaleOutcomes,
  StaleScope,
  SweptJob,
} from "../../src/lib/spec-kit/job-store.js";

const LIVE_STATUSES = ["running", "cancelling", "saving"];
const rows = new Map<string, SpecKitJobRow>();
const isLive = (row: SpecKitJobRow): boolean => LIVE_STATUSES.includes(row.status);
const copy = (row: SpecKitJobRow | undefined | null): SpecKitJobRow | null =>
  row ? { ...row } : null;

/**
 * The fake DATABASE's clock. Captured once, so a test that moves this process's
 * `Date` (a replica whose clock is wrong) does not move the database's with it
 * — exactly the separation the real store has.
 */
const realNow = Date.now.bind(Date);
const dbNow = (): Date => new Date(realNow());

/** The rows themselves, for a test that needs to age a heartbeat or plant a job. */
export const fakeSpecKitJobRows = rows;

export function resetFakeSpecKitJobStore(): void {
  rows.clear();
}

/** Insert a row as another process would have left it. */
export function plantFakeSpecKitJob(row: Partial<SpecKitJobRow> & { id: string }): SpecKitJobRow {
  const now = dbNow();
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
    if (rows.has(job.id)) return null;
    for (const row of rows.values()) {
      if (row.activeKey === job.activeKey) return null;
    }
    const now = dbNow();
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
      heartbeatAt: now,
      startedAt: now,
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

  async beatJob(id: string): Promise<string | null> {
    const row = rows.get(id);
    if (!row || !isLive(row)) return null;
    row.heartbeatAt = dbNow();
    return row.status;
  },

  async setJobPhase(id: string, phase: string): Promise<void> {
    const row = rows.get(id);
    if (row && isLive(row)) row.phase = phase;
  },

  async beginSaving(id: string, activeKey: string): Promise<boolean> {
    const row = rows.get(id);
    if (!row || row.status !== "running" || row.activeKey !== activeKey) return false;
    row.status = "saving";
    row.heartbeatAt = dbNow();
    return true;
  },

  async confirmSaving(id: string, activeKey: string): Promise<boolean> {
    const row = rows.get(id);
    if (!row || row.status !== "saving" || row.activeKey !== activeKey) return false;
    row.heartbeatAt = dbNow();
    return true;
  },

  async markJobCancelling(projectId: string, id: string): Promise<boolean> {
    const row = rows.get(id);
    if (!row || row.projectId !== projectId || row.status !== "running") return false;
    row.status = "cancelling";
    return true;
  },

  async finishJob(id: string, outcome: JobOutcome, from: readonly string[]): Promise<boolean> {
    const row = rows.get(id);
    if (!row || !from.includes(row.status)) return false;
    row.status = outcome.status;
    row.activeKey = null;
    row.finishedAt = dbNow();
    row.result = outcome.result ?? null;
    row.error = outcome.error ?? null;
    return true;
  },

  async failStaleJobs(
    scope: StaleScope,
    staleMs: number,
    outcomes: StaleOutcomes,
  ): Promise<SweptJob[]> {
    const now = dbNow();
    const swept: SweptJob[] = [];
    for (const row of rows.values()) {
      if (!isLive(row)) continue;
      if (!(row.heartbeatAt.getTime() < now.getTime() - staleMs)) continue;
      if (scope.id !== undefined && row.id !== scope.id) continue;
      if (scope.projectId !== undefined && row.projectId !== scope.projectId) continue;
      if (scope.activeKey !== undefined && row.activeKey !== scope.activeKey) continue;
      const was = row.status;
      row.status = was === "cancelling" ? "cancelled" : "failed";
      row.error =
        was === "cancelling"
          ? null
          : was === "saving"
            ? outcomes.interruptedWhileSavingError
            : outcomes.interruptedError;
      row.activeKey = null;
      row.result = null;
      row.finishedAt = now;
      swept.push({ id: row.id, projectId: row.projectId, status: row.status });
    }
    return swept;
  },

  async pruneFinishedJobs(retentionMs: number): Promise<number> {
    const cutoff = realNow() - retentionMs;
    let pruned = 0;
    for (const row of [...rows.values()]) {
      if (!isLive(row) && row.finishedAt && row.finishedAt.getTime() < cutoff) {
        rows.delete(row.id);
        pruned += 1;
      }
    }
    return pruned;
  },

  async discardJob(id: string): Promise<void> {
    if (rows.get(id)?.status === "running") rows.delete(id);
  },
};
