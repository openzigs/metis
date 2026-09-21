/**
 * Workspace usage rollup job (Epic #759, Issue #763).
 *
 * Aggregates TokenUsage data into WorkspaceUsageDaily rows. Registered with the
 * leader-only `SingletonJobs` set in `server/src/server.ts` (#1303).
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("workspace-usage-rollup");

/**
 * Rolls up token usage for a given date (or today by default) across all
 * workspaces. Groups TokenUsage by project → workspace for the day.
 */
export async function rollupWorkspaceUsage(date?: Date): Promise<number> {
  const targetDate = date ?? new Date();
  // Normalize to start-of-day UTC
  const dayStart = new Date(
    Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate()),
  );
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // Get all workspaces
  const workspaces = await prisma.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  let upsertCount = 0;

  for (const ws of workspaces) {
    // Aggregate TokenUsage for projects in this workspace on this date
    const aggregation = await prisma.tokenUsage.aggregate({
      where: {
        project: { workspaceId: ws.id },
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      _sum: { totalTokens: true, costCents: true },
      _count: { sessionId: true },
    });

    const tokensUsed = aggregation._sum.totalTokens ?? 0;
    const costCents = aggregation._sum.costCents ?? 0;
    const sessions = aggregation._count.sessionId ?? 0;

    if (tokensUsed === 0 && costCents === 0 && sessions === 0) {
      continue;
    }

    await prisma.workspaceUsageDaily.upsert({
      where: {
        workspaceId_date: { workspaceId: ws.id, date: dayStart },
      },
      create: {
        workspaceId: ws.id,
        date: dayStart,
        tokensUsed,
        costCents,
        sessions,
      },
      update: {
        tokensUsed,
        costCents,
        sessions,
      },
    });

    upsertCount++;
  }

  log.info(
    `Rolled up usage for ${upsertCount} workspace(s) on ${dayStart.toISOString().split("T")[0]}`,
  );
  return upsertCount;
}

/**
 * Days of history a scheduled tick re-rolls, ending with the current day.
 *
 * Must be at least 2. A tick that rolled only `new Date()` would aggregate the
 * *partial* current day and never revisit it: the interval is anchored to the
 * leader's start time, so the next tick lands on the following UTC day and day
 * D keeps whatever fraction of itself had elapsed when the tick fired. Rolling
 * the previous complete day as well closes each day exactly once; the upsert is
 * idempotent, so re-rolling a day already written is free of side effects.
 */
export const ROLLUP_TRAILING_DAYS = 2;

/**
 * Days of history the FIRST run after a start re-rolls.
 *
 * `workspace_usage_daily` has no writer other than this job, so on any deploy
 * that predates #1303 the table is empty for all history. Its only reader,
 * `finops/forecast-service.ts:loadWorkspaceWindow`, densifies a missing day to
 * zero cents over a `FORECAST_WINDOW_DAYS` window — so without a catch-up the
 * forecast stays silently wrong for a month after the job starts running.
 * Kept >= that window by a test rather than by importing across the boundary,
 * so the reader does not become an import-time dependency of its own writer.
 */
export const ROLLUP_CATCHUP_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Roll up the trailing `days` UTC days ending with `anchor` (default now),
 * oldest first. Days are walked sequentially: the aggregation is per workspace
 * per day and there is no benefit to putting more of it in flight at once.
 */
export async function rollupWorkspaceUsageWindow(
  days: number,
  anchor: Date = new Date(),
): Promise<number> {
  let total = 0;
  for (let back = days - 1; back >= 0; back--) {
    total += await rollupWorkspaceUsage(new Date(anchor.getTime() - back * DAY_MS));
  }
  return total;
}

export interface WorkspaceUsageRollupHandle {
  stop(): void;
}

/** Default cadence: 24h, matching the nightly FinOps forecast recompute. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * Issue #1303 — start the daily rollup.
 *
 * Registered in the `SingletonJobs` set in `server/src/server.ts`. This job is
 * the ONLY writer of `workspace_usage_daily`, and
 * `finops/forecast-service.ts:loadWorkspaceWindow` is a live reader of it
 * (behind `GET /api/workspaces/:id/finops`). While it was registered with
 * nothing, that reader's `densifyWindow` filled the whole 30-day window with
 * zeroes, so every workspace-scope forecast projected 0 cents — a wrong answer
 * rather than an error.
 *
 * Unlike the sibling jobs this fires once immediately, and that first run is a
 * `ROLLUP_CATCHUP_DAYS` catch-up: the timer restarts on every leadership
 * transition, and a leader that waits a full day before its first rollup leaves
 * the forecaster reading a stale table for that day. Subsequent ticks re-roll
 * `ROLLUP_TRAILING_DAYS` so the previous, now complete, day is closed out.
 *
 * Follows the established lifecycle pattern (`setInterval` + `unref` + a handle
 * with `stop()`); a failed run is logged and swallowed so the timer survives,
 * and leaves the catch-up owed so the next tick retries it in full.
 */
export function startWorkspaceUsageRollup(
  intervalMs = DEFAULT_INTERVAL_MS,
): WorkspaceUsageRollupHandle {
  let inFlight = false;
  let caughtUp = false;
  const run = (): void => {
    // A catch-up pass issues ROLLUP_CATCHUP_DAYS sequential aggregations; on a
    // slow database that can outlast an interval, and two overlapping passes
    // would upsert the same (workspaceId, date) key from two transactions.
    if (inFlight) {
      log.warn("workspace usage rollup still running; skipping this tick");
      return;
    }
    inFlight = true;
    void rollupWorkspaceUsageWindow(caughtUp ? ROLLUP_TRAILING_DAYS : ROLLUP_CATCHUP_DAYS)
      .then(() => {
        caughtUp = true;
      })
      .catch((err: unknown) => {
        log.error("workspace usage rollup run failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  log.info("workspace usage rollup scheduler started", { intervalMs });
  return {
    stop() {
      clearInterval(timer);
      log.info("workspace usage rollup scheduler stopped");
    },
  };
}
