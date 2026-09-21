/**
 * Pure helpers for the Scheduler summary dashboard (#463, epic #459).
 *
 * Derived entirely from the already-loaded job list — no new backend call —
 * so the cards update live alongside the table's react-query refetch.
 */
import type { ScheduledJobRow } from "@/lib/scheduler-api";

export interface SchedulerStats {
  total: number;
  enabled: number;
  paused: number;
  /** Earliest future `nextRunAt` across enabled jobs, or null if none. */
  nextRunAt: string | null;
}

/**
 * Compute summary stats from the job list. `now` is injectable for
 * deterministic tests; defaults to the current time.
 */
export function computeSchedulerStats(
  jobs: ScheduledJobRow[] | undefined,
  now: number = Date.now(),
): SchedulerStats {
  const list = jobs ?? [];
  let enabled = 0;
  let nextRunMs: number | null = null;
  let nextRunAt: string | null = null;

  for (const job of list) {
    if (job.enabled) enabled += 1;
    // Only enabled jobs have a meaningful upcoming run.
    if (!job.enabled || !job.nextRunAt) continue;
    const ms = new Date(job.nextRunAt).getTime();
    if (Number.isNaN(ms) || ms < now) continue;
    if (nextRunMs === null || ms < nextRunMs) {
      nextRunMs = ms;
      nextRunAt = job.nextRunAt;
    }
  }

  return {
    total: list.length,
    enabled,
    paused: list.length - enabled,
    nextRunAt,
  };
}
