/**
 * Unit tests for the FinOps forecast service (Epic #47 / Issue #48).
 *
 * Mocks Prisma per the repo convention. Verifies window loading + densify,
 * month-end persistence, MAPE backtest persistence, and the recompute-all
 * fan-out over workspaces + projects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface UsageDailyRow {
  workspaceId: string;
  date: Date;
  costCents: number;
}
interface TokenUsageRow {
  projectId: string;
  createdAt: Date;
  costCents: number;
}

const usageDaily: UsageDailyRow[] = [];
const tokenUsage: TokenUsageRow[] = [];
const workspaces: Array<{ id: string; deletedAt: Date | null; projects: { id: string }[] }> = [];
const createdForecasts: Record<string, unknown>[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    workspaceUsageDaily: {
      findMany: vi.fn(
        async ({ where }: { where: { workspaceId: string; date?: { gte?: Date } } }) =>
          usageDaily.filter(
            (r) =>
              r.workspaceId === where.workspaceId && (!where.date?.gte || r.date >= where.date.gte),
          ),
      ),
    },
    tokenUsage: {
      findMany: vi.fn(
        async ({ where }: { where: { projectId: string; createdAt?: { gte?: Date } } }) =>
          tokenUsage.filter(
            (r) =>
              r.projectId === where.projectId &&
              (!where.createdAt?.gte || r.createdAt >= where.createdAt.gte),
          ),
      ),
    },
    workspace: {
      findMany: vi.fn(async () => workspaces),
    },
    costForecast: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdForecasts.push(data);
        return { id: `cf_${createdForecasts.length}`, ...data, computedAt: new Date() };
      }),
      findFirst: vi.fn(async () => null),
    },
  },
}));

import {
  backtestWindow,
  computeMonthBounds,
  computeProjectForecast,
  computeWorkspaceForecast,
  loadProjectWindow,
  loadWorkspaceWindow,
  recomputeAllForecasts,
  startForecastRecompute,
  FORECAST_WINDOW_DAYS,
} from "../src/lib/finops/forecast-service.js";
import type { DailyCostPoint } from "../src/lib/finops/forecast-math.js";

const NOW = new Date(Date.UTC(2026, 5, 15, 12, 0, 0)); // 2026-06-15

beforeEach(() => {
  usageDaily.length = 0;
  tokenUsage.length = 0;
  workspaces.length = 0;
  createdForecasts.length = 0;
});

describe("computeMonthBounds", () => {
  it("derives day-of-month, days-in-month, and a 30-day window start", () => {
    const b = computeMonthBounds(NOW);
    expect(b.dayOfMonth).toBe(15);
    expect(b.daysInMonth).toBe(30); // June
    const windowDays = Math.round((NOW.getTime() - b.windowStart.getTime()) / 86_400_000);
    expect(windowDays).toBe(FORECAST_WINDOW_DAYS);
  });
});

describe("loadWorkspaceWindow", () => {
  it("buckets by UTC day and densifies missing days with zero", async () => {
    usageDaily.push(
      { workspaceId: "w1", date: new Date(Date.UTC(2026, 5, 10)), costCents: 500 },
      { workspaceId: "w1", date: new Date(Date.UTC(2026, 5, 12)), costCents: 700 },
    );
    const points = await loadWorkspaceWindow("w1", NOW);
    // Continuous series: 30 days back + today inclusive => 31 points.
    expect(points.length).toBe(31);
    const d10 = points.find((p) => p.day === "2026-06-10");
    const d11 = points.find((p) => p.day === "2026-06-11");
    expect(d10?.costCents).toBe(500);
    expect(d11?.costCents).toBe(0); // densified gap
  });
});

describe("loadProjectWindow", () => {
  it("aggregates TokenUsage rows into per-day buckets", async () => {
    tokenUsage.push(
      { projectId: "p1", createdAt: new Date(Date.UTC(2026, 5, 14, 3)), costCents: 100 },
      { projectId: "p1", createdAt: new Date(Date.UTC(2026, 5, 14, 20)), costCents: 250 },
    );
    const points = await loadProjectWindow("p1", NOW);
    const d14 = points.find((p) => p.day === "2026-06-14");
    expect(d14?.costCents).toBe(350);
  });
});

describe("computeWorkspaceForecast", () => {
  it("persists a workspace-scope forecast row with MTD + projection", async () => {
    // Seed June 1-15 with a flat 1000c/day workspace usage.
    for (let day = 1; day <= 15; day++) {
      usageDaily.push({
        workspaceId: "w1",
        date: new Date(Date.UTC(2026, 5, day)),
        costCents: 1000,
      });
    }
    const r = await computeWorkspaceForecast("w1", NOW);
    expect(r.scope).toBe("workspace");
    expect(r.monthToDateCents).toBe(15_000);
    // ~1000/day * 30 days ≈ 30k
    expect(r.projectedMonthEndCents).toBeGreaterThan(28_000);
    expect(r.projectedMonthEndCents).toBeLessThan(32_000);
    expect(createdForecasts).toHaveLength(1);
    expect(createdForecasts[0].scope).toBe("workspace");
    expect(createdForecasts[0].projectId).toBeNull();
  });
});

describe("computeProjectForecast", () => {
  it("persists a project-scope forecast row", async () => {
    for (let day = 1; day <= 15; day++) {
      tokenUsage.push({
        projectId: "p1",
        createdAt: new Date(Date.UTC(2026, 5, day, 6)),
        costCents: 200,
      });
    }
    const r = await computeProjectForecast("w1", "p1", NOW);
    expect(r.scope).toBe("project");
    expect(r.projectId).toBe("p1");
    expect(r.monthToDateCents).toBe(3_000);
    expect(createdForecasts[0].projectId).toBe("p1");
  });
});

describe("backtestWindow", () => {
  it("returns null for short windows", () => {
    const short: DailyCostPoint[] = Array.from({ length: 5 }, (_, i) => ({
      day: `2026-06-0${i + 1}`,
      costCents: 100,
    }));
    expect(backtestWindow(short)).toBeNull();
  });

  it("reports a low MAPE on a stable series", () => {
    const stable: DailyCostPoint[] = Array.from({ length: 20 }, (_, i) => ({
      day: `2026-06-${String(i + 1).padStart(2, "0")}`,
      costCents: 1000,
    }));
    const m = backtestWindow(stable);
    expect(m).not.toBeNull();
    expect(m as number).toBeLessThanOrEqual(0.15);
  });
});

describe("recomputeAllForecasts", () => {
  it("fans out over workspaces and their projects", async () => {
    workspaces.push(
      { id: "w1", deletedAt: null, projects: [{ id: "p1" }, { id: "p2" }] },
      { id: "w2", deletedAt: null, projects: [] },
    );
    const res = await recomputeAllForecasts(NOW);
    expect(res.workspaces).toBe(2);
    expect(res.projects).toBe(2);
    // 2 workspace forecasts + 2 project forecasts
    expect(createdForecasts).toHaveLength(4);
  });

  it("swallows a per-project failure without aborting the run", async () => {
    workspaces.push({ id: "w1", deletedAt: null, projects: [{ id: "p1" }] });
    const { prisma } = await import("../src/lib/prisma.js");
    const create = prisma.costForecast.create as unknown as ReturnType<typeof vi.fn>;
    // First (workspace) succeeds, second (project) throws.
    create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => {
      createdForecasts.push(data);
      return { id: "cf_ws", ...data };
    });
    create.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    const res = await recomputeAllForecasts(NOW);
    expect(res.workspaces).toBe(1);
    expect(res.projects).toBe(0);
  });
});

describe("startForecastRecompute", () => {
  it("returns a handle and can be stopped", () => {
    const handle = startForecastRecompute(60_000);
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });
});
