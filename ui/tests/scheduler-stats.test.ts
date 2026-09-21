/**
 * #463 (epic #459) — Scheduler summary stat computations.
 */
import { describe, it, expect } from "vitest";
import { computeSchedulerStats } from "@/lib/scheduler-stats";
import type { ScheduledJobRow } from "@/lib/scheduler-api";

const NOW = new Date("2026-06-26T12:00:00.000Z").getTime();

function job(over: Partial<ScheduledJobRow>): ScheduledJobRow {
  return {
    id: "j1",
    key: "k1",
    name: "Job",
    cron: "*/15 * * * *",
    taskType: "http-webhook",
    payload: "{}",
    enabled: true,
    maxAttempts: 3,
    nextRunAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  } as ScheduledJobRow;
}

describe("computeSchedulerStats", () => {
  it("returns zeros for an empty or undefined list", () => {
    expect(computeSchedulerStats([], NOW)).toEqual({
      total: 0,
      enabled: 0,
      paused: 0,
      nextRunAt: null,
    });
    expect(computeSchedulerStats(undefined, NOW)).toEqual({
      total: 0,
      enabled: 0,
      paused: 0,
      nextRunAt: null,
    });
  });

  it("counts enabled vs paused jobs", () => {
    const stats = computeSchedulerStats(
      [job({ enabled: true }), job({ enabled: false }), job({ enabled: false })],
      NOW,
    );
    expect(stats).toMatchObject({ total: 3, enabled: 1, paused: 2 });
  });

  it("picks the earliest FUTURE nextRunAt among enabled jobs", () => {
    const stats = computeSchedulerStats(
      [
        job({ nextRunAt: "2026-06-26T15:00:00.000Z" }),
        job({ nextRunAt: "2026-06-26T13:00:00.000Z" }), // earliest future
        job({ nextRunAt: "2026-06-26T18:00:00.000Z" }),
      ],
      NOW,
    );
    expect(stats.nextRunAt).toBe("2026-06-26T13:00:00.000Z");
  });

  it("ignores past runs, null runs, and disabled jobs when choosing next run", () => {
    const stats = computeSchedulerStats(
      [
        job({ nextRunAt: "2026-06-26T09:00:00.000Z" }), // past → ignored
        job({ enabled: false, nextRunAt: "2026-06-26T12:30:00.000Z" }), // disabled → ignored
        job({ nextRunAt: null }), // no run
        job({ nextRunAt: "2026-06-26T14:00:00.000Z" }), // the only valid future run
      ],
      NOW,
    );
    expect(stats.nextRunAt).toBe("2026-06-26T14:00:00.000Z");
  });

  it("returns null nextRunAt when no enabled job has a future run", () => {
    const stats = computeSchedulerStats([job({ nextRunAt: "2026-06-26T09:00:00.000Z" })], NOW);
    expect(stats.nextRunAt).toBeNull();
  });
});
