/**
 * FinOps cost forecast service (Epic #47 / Issue #48).
 *
 * Reads a rolling 30-day window of daily cost — per workspace AND per
 * project — runs the OLS+EWMA forecaster (`forecast-math.ts`), computes a
 * month-end projection, and persists a `CostForecast` row so the alert engine
 * (#49) and the FinOps UI (#54) can read the latest projection without
 * recomputing. The nightly job (`startForecastRecompute`) re-runs this for
 * every workspace.
 *
 * Data sources:
 *   - Workspace level: `WorkspaceUsageDaily` (pre-aggregated per workspace/day;
 *     the schema explicitly notes it "Feeds into FinOps forecasting (Epic 8)").
 *   - Project level: `TokenUsage` rows aggregated into per-UTC-day buckets.
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import {
  mape,
  projectMonthEnd,
  type DailyCostPoint,
  type MonthEndProjection,
} from "./forecast-math.js";

const log = createChildLogger("finops-forecast");

/** Rolling window length in days. */
export const FORECAST_WINDOW_DAYS = 30;

export interface ForecastComputeResult extends MonthEndProjection {
  workspaceId: string;
  projectId: string | null;
  scope: "workspace" | "project";
  monthToDateCents: number;
}

interface MonthBounds {
  windowStart: Date;
  monthStart: Date;
  dayOfMonth: number;
  daysInMonth: number;
}

export function computeMonthBounds(now: Date = new Date()): MonthBounds {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const daysInMonth = Math.round((monthEnd.getTime() - monthStart.getTime()) / 86_400_000);
  const dayOfMonth = now.getUTCDate();
  const windowStart = new Date(now.getTime() - FORECAST_WINDOW_DAYS * 86_400_000);
  return { windowStart, monthStart, dayOfMonth, daysInMonth };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Fill any missing days in [windowStart, now] with zero-cost points so the
 * regression sees a continuous series (a quiet day is real signal, not a
 * gap). Returns oldest-first.
 */
function densifyWindow(
  buckets: Map<string, number>,
  windowStart: Date,
  now: Date,
): DailyCostPoint[] {
  const points: DailyCostPoint[] = [];
  const startMs = Date.UTC(
    windowStart.getUTCFullYear(),
    windowStart.getUTCMonth(),
    windowStart.getUTCDate(),
  );
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const day = isoDay(new Date(ms));
    points.push({ day, costCents: buckets.get(day) ?? 0 });
  }
  return points;
}

/** Read the per-workspace daily cost window from `WorkspaceUsageDaily`. */
export async function loadWorkspaceWindow(
  workspaceId: string,
  now: Date = new Date(),
): Promise<DailyCostPoint[]> {
  const { windowStart } = computeMonthBounds(now);
  const rows = await prisma.workspaceUsageDaily.findMany({
    where: { workspaceId, date: { gte: windowStart } },
    select: { date: true, costCents: true },
    orderBy: { date: "asc" },
  });
  const buckets = new Map<string, number>();
  for (const r of rows) {
    const day = isoDay(r.date);
    buckets.set(day, (buckets.get(day) ?? 0) + r.costCents);
  }
  return densifyWindow(buckets, windowStart, now);
}

/** Read a per-project daily cost window by aggregating `TokenUsage`. */
export async function loadProjectWindow(
  projectId: string,
  now: Date = new Date(),
): Promise<DailyCostPoint[]> {
  const { windowStart } = computeMonthBounds(now);
  const rows = await prisma.tokenUsage.findMany({
    where: { projectId, createdAt: { gte: windowStart } },
    select: { createdAt: true, costCents: true },
    orderBy: { createdAt: "asc" },
  });
  const buckets = new Map<string, number>();
  for (const r of rows) {
    const day = isoDay(r.createdAt);
    buckets.set(day, (buckets.get(day) ?? 0) + r.costCents);
  }
  return densifyWindow(buckets, windowStart, now);
}

/** Sum the month-to-date portion of a dense daily window. */
function monthToDate(points: DailyCostPoint[], monthStartIso: string): number {
  let sum = 0;
  for (const p of points) {
    if (p.day >= monthStartIso) sum += p.costCents;
  }
  return sum;
}

/**
 * Walk-forward in-window backtest MAPE: for each day from the midpoint
 * onward, predict that day's run-rate from the preceding sub-window and
 * compare against the actual. Returns null when the window is too short.
 */
export function backtestWindow(points: DailyCostPoint[]): number | null {
  if (points.length < 10) return null;
  const start = Math.max(7, Math.floor(points.length / 2));
  const actual: number[] = [];
  const predicted: number[] = [];
  for (let t = start; t < points.length; t++) {
    const sub = points.slice(0, t);
    const f = projectMonthEnd({
      points: sub,
      monthToDateCents: 0,
      dayOfMonth: 1,
      daysInMonth: 1,
    });
    predicted.push(f.dailyRunRateCents);
    actual.push(points[t].costCents);
  }
  return mape(actual, predicted);
}

function buildResult(
  workspaceId: string,
  projectId: string | null,
  points: DailyCostPoint[],
  now: Date,
): ForecastComputeResult {
  const { monthStart, dayOfMonth, daysInMonth } = computeMonthBounds(now);
  const mtd = monthToDate(points, isoDay(monthStart));
  const projection = projectMonthEnd({
    points,
    monthToDateCents: mtd,
    dayOfMonth,
    daysInMonth,
  });
  return {
    ...projection,
    workspaceId,
    projectId,
    scope: projectId ? "project" : "workspace",
    monthToDateCents: mtd,
  };
}

async function persist(result: ForecastComputeResult, points: DailyCostPoint[]): Promise<void> {
  await prisma.costForecast.create({
    data: {
      workspaceId: result.workspaceId,
      projectId: result.projectId,
      scope: result.scope,
      monthToDateCents: result.monthToDateCents,
      projectedMonthEndCents: result.projectedMonthEndCents,
      dailyRunRateCents: Math.round(result.dailyRunRateCents),
      slopeCentsPerDay: result.slopeCentsPerDay,
      ewmaCents: result.ewmaCents,
      sampleDays: result.sampleDays,
      backtestMape: backtestWindow(points),
    },
  });
}

/** Compute + persist a workspace-level forecast. */
export async function computeWorkspaceForecast(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ForecastComputeResult> {
  const points = await loadWorkspaceWindow(workspaceId, now);
  const result = buildResult(workspaceId, null, points, now);
  await persist(result, points);
  return result;
}

/** Compute + persist a project-level forecast. */
export async function computeProjectForecast(
  workspaceId: string,
  projectId: string,
  now: Date = new Date(),
): Promise<ForecastComputeResult> {
  const points = await loadProjectWindow(projectId, now);
  const result = buildResult(workspaceId, projectId, points, now);
  await persist(result, points);
  return result;
}

/**
 * Recompute forecasts for every workspace (and each of its projects). Invoked
 * by the nightly job. Errors per-workspace are logged and swallowed so one bad
 * workspace never aborts the whole run.
 */
export async function recomputeAllForecasts(now: Date = new Date()): Promise<{
  workspaces: number;
  projects: number;
}> {
  const workspaces = await prisma.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true, projects: { where: { deletedAt: null }, select: { id: true } } },
  });
  let wsCount = 0;
  let projCount = 0;
  for (const ws of workspaces) {
    try {
      await computeWorkspaceForecast(ws.id, now);
      wsCount += 1;
      for (const p of ws.projects) {
        try {
          await computeProjectForecast(ws.id, p.id, now);
          projCount += 1;
        } catch (err) {
          log.warn("project forecast failed", {
            workspaceId: ws.id,
            projectId: p.id,
            error: (err as Error).message,
          });
        }
      }
    } catch (err) {
      log.warn("workspace forecast failed", {
        workspaceId: ws.id,
        error: (err as Error).message,
      });
    }
  }
  log.info("forecast recompute complete", { workspaces: wsCount, projects: projCount });
  return { workspaces: wsCount, projects: projCount };
}

/** Read the most recent forecast for a workspace (or a specific project). */
export async function getLatestForecast(
  workspaceId: string,
  projectId: string | null = null,
): Promise<ForecastRow | null> {
  const row = await prisma.costForecast.findFirst({
    where: { workspaceId, projectId },
    orderBy: { computedAt: "desc" },
  });
  return row;
}

export interface ForecastRow {
  id: string;
  workspaceId: string;
  projectId: string | null;
  scope: string;
  monthToDateCents: number;
  projectedMonthEndCents: number;
  dailyRunRateCents: number;
  slopeCentsPerDay: number;
  ewmaCents: number;
  sampleDays: number;
  backtestMape: number | null;
  computedAt: Date;
}

export interface ForecastRecomputeHandle {
  stop(): void;
}

/** Default nightly cadence: 24h. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * Start the nightly forecast recompute interval. Mirrors the SLA-checker
 * lifecycle pattern (`setInterval` + `unref` + a handle with `stop()`).
 */
export function startForecastRecompute(intervalMs = DEFAULT_INTERVAL_MS): ForecastRecomputeHandle {
  const timer = setInterval(() => {
    recomputeAllForecasts().catch((err) => {
      log.error("forecast recompute run failed", { error: (err as Error).message });
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  log.info("forecast recompute scheduler started", { intervalMs });
  return {
    stop() {
      clearInterval(timer);
      log.info("forecast recompute scheduler stopped");
    },
  };
}
