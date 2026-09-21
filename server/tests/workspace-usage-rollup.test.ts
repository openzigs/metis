/**
 * Tests for workspace usage rollup (Epic #759, Issue #763).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    workspace: { findMany: vi.fn() },
    tokenUsage: { aggregate: vi.fn(), findFirst: vi.fn() },
    workspaceUsageDaily: { upsert: vi.fn() },
  },
}));

// A STABLE logger instance (not a fresh object per call) so a test can assert
// that the rollup scheduler's error branch actually ran (#1303).
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => log,
}));

import { prisma } from "../src/lib/prisma.js";
import { FORECAST_WINDOW_DAYS } from "../src/lib/finops/forecast-service.js";
import {
  rollupWorkspaceUsage,
  rollupWorkspaceUsageWindow,
  startWorkspaceUsageRollup,
  ROLLUP_TRAILING_DAYS,
  ROLLUP_CATCHUP_DAYS,
} from "../src/lib/workspaces/usage-rollup.js";

const DAY_MS = 86_400_000;

/** UTC `YYYY-MM-DD` of every day the rollup aggregated, in call order. */
function daysAggregated(): string[] {
  return vi
    .mocked(prisma.tokenUsage.aggregate)
    .mock.calls.map((c) =>
      (c[0] as unknown as { where: { createdAt: { gte: Date } } }).where.createdAt.gte
        .toISOString()
        .slice(0, 10),
    );
}

function utcDay(offsetDays: number, from: Date = new Date()): string {
  return new Date(from.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

describe("rollupWorkspaceUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates token usage per workspace for a given date", async () => {
    vi.mocked(prisma.workspace.findMany).mockResolvedValue([
      { id: "ws-1" },
      { id: "ws-2" },
    ] as never);

    vi.mocked(prisma.tokenUsage.aggregate).mockImplementation(
      async (args: { where: { project: { workspaceId: string } } }) => {
        if (args.where.project.workspaceId === "ws-1") {
          return {
            _sum: { totalTokens: 5000, costCents: 100 },
            _count: { sessionId: 3 },
          } as never;
        }
        return {
          _sum: { totalTokens: 0, costCents: 0 },
          _count: { sessionId: 0 },
        } as never;
      },
    );

    vi.mocked(prisma.workspaceUsageDaily.upsert).mockResolvedValue({} as never);

    const count = await rollupWorkspaceUsage(new Date("2025-06-15"));
    expect(count).toBe(1); // only ws-1 has data
    expect(prisma.workspaceUsageDaily.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.workspaceUsageDaily.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId: "ws-1",
          tokensUsed: 5000,
          costCents: 100,
          sessions: 3,
        }),
      }),
    );
  });

  it("treats Prisma's null _sum (no matching rows) as zero rather than NaN", async () => {
    // Prisma returns `_sum: { totalTokens: null, costCents: null }` — not zeroes —
    // when the WHERE matches no rows. Without the `?? 0` coalesce the skip test
    // below reads `null === 0` as false and upserts a NaN-bearing row.
    vi.mocked(prisma.workspace.findMany).mockResolvedValue([{ id: "ws-none" }] as never);
    vi.mocked(prisma.tokenUsage.aggregate).mockResolvedValue({
      _sum: { totalTokens: null, costCents: null },
      _count: { sessionId: 0 },
    } as never);

    const count = await rollupWorkspaceUsage(new Date("2025-06-15"));
    expect(count).toBe(0);
    expect(prisma.workspaceUsageDaily.upsert).not.toHaveBeenCalled();
  });

  it("skips workspaces with no usage data", async () => {
    vi.mocked(prisma.workspace.findMany).mockResolvedValue([{ id: "ws-empty" }] as never);
    vi.mocked(prisma.tokenUsage.aggregate).mockResolvedValue({
      _sum: { totalTokens: 0, costCents: 0 },
      _count: { sessionId: 0 },
    } as never);

    const count = await rollupWorkspaceUsage();
    expect(count).toBe(0);
    expect(prisma.workspaceUsageDaily.upsert).not.toHaveBeenCalled();
  });
});

describe("rollupWorkspaceUsageWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.workspace.findMany).mockResolvedValue([{ id: "ws-1" }] as never);
    vi.mocked(prisma.tokenUsage.aggregate).mockResolvedValue({
      _sum: { totalTokens: 1000, costCents: 50 },
      _count: { sessionId: 2 },
    } as never);
    vi.mocked(prisma.workspaceUsageDaily.upsert).mockResolvedValue({} as never);
  });

  it("rolls each trailing UTC day ending with the anchor day, oldest first", async () => {
    const anchor = new Date("2025-06-15T09:30:00.000Z");
    const count = await rollupWorkspaceUsageWindow(3, anchor);

    expect(daysAggregated()).toEqual(["2025-06-13", "2025-06-14", "2025-06-15"]);
    expect(count).toBe(3);
  });

  it("includes the PREVIOUS complete day, not only the partial current one", async () => {
    // #1303 review, blocking: a tick that rolls only `new Date()` freezes each
    // day's row at whatever wall-clock moment the leader happened to start, so
    // day D is permanently short by however much of D ran after that moment.
    const anchor = new Date("2025-06-15T01:00:00.000Z");
    await rollupWorkspaceUsageWindow(ROLLUP_TRAILING_DAYS, anchor);
    expect(daysAggregated()).toContain("2025-06-14");
  });

  it("crosses a month boundary without emitting a day-0 or invalid date", async () => {
    const anchor = new Date("2025-03-01T12:00:00.000Z");
    await rollupWorkspaceUsageWindow(3, anchor);
    expect(daysAggregated()).toEqual(["2025-02-27", "2025-02-28", "2025-03-01"]);
  });

  it("defaults its anchor to now", async () => {
    await rollupWorkspaceUsageWindow(1);
    expect(daysAggregated()).toEqual([utcDay(0)]);
  });

  it("rolls nothing for a non-positive window", async () => {
    await rollupWorkspaceUsageWindow(0);
    expect(prisma.tokenUsage.aggregate).not.toHaveBeenCalled();
  });

  it("catches up at least as far back as the window the forecaster reads", () => {
    // The rollup is the only writer of `workspace_usage_daily`; the only reader
    // is `loadWorkspaceWindow`, which densifies a missing day to zero cents. A
    // catch-up shallower than that window leaves silent zeroes in the forecast.
    expect(ROLLUP_CATCHUP_DAYS).toBeGreaterThanOrEqual(FORECAST_WINDOW_DAYS);
    expect(ROLLUP_TRAILING_DAYS).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Issue #1303 — the rollup is the ONLY writer of `workspace_usage_daily`, and
 * `finops/forecast-service.ts:loadWorkspaceWindow` is a live reader of it
 * (mounted at `GET /api/workspaces/:id/finops`). Until this issue it was
 * registered with nothing, so that reader densified an all-zero 30-day window
 * and every workspace-scope forecast projected 0 cents. These tests pin the
 * scheduler registration so the job cannot silently stop running again.
 */
describe("startWorkspaceUsageRollup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(prisma.workspace.findMany).mockResolvedValue([] as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a rollup immediately on start, before the first interval elapses", async () => {
    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.workspace.findMany).toHaveBeenCalled();
    handle.stop();
  });

  it("catches up the reader's whole window on the first run after start", async () => {
    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    // `workspace_usage_daily` is empty for every day before this job first ran,
    // and the forecaster reads a 30-day window — so the first run must fill it.
    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(ROLLUP_CATCHUP_DAYS);
    handle.stop();
  });

  it("re-rolls only the trailing days on each subsequent tick", async () => {
    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(prisma.workspace.findMany).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(ROLLUP_TRAILING_DAYS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(2 * ROLLUP_TRAILING_DAYS);
    handle.stop();
  });

  it("rolls the completed previous UTC day on a tick, not just today", async () => {
    // The blocking defect this replaces: `rollupWorkspaceUsage()` with no
    // argument aggregates TODAY only, and the next tick lands on the following
    // UTC day — so no completed day was ever revisited.
    vi.mocked(prisma.tokenUsage.aggregate).mockResolvedValue({
      _sum: { totalTokens: 0, costCents: 0 },
      _count: { sessionId: 0 },
    } as never);
    vi.mocked(prisma.workspace.findMany).mockResolvedValue([{ id: "ws-1" }] as never);
    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(prisma.tokenUsage.aggregate).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daysAggregated()).toContain(utcDay(-1));
    expect(daysAggregated()).toContain(utcDay(0));
    handle.stop();
  });

  it("skips a tick that would overlap a run still in flight", async () => {
    // A catch-up run issues ROLLUP_CATCHUP_DAYS sequential aggregations; on a
    // slow database that can outlast an interval, and two concurrent passes
    // would upsert the same (workspace, date) key from two transactions.
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    vi.mocked(prisma.workspace.findMany).mockImplementation((async () => {
      await gate;
      return [] as never;
    }) as never);

    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    // Still exactly one pass in flight, stuck on its first day.
    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "workspace usage rollup still running; skipping this tick",
    );
    release();
    handle.stop();
  });

  it("stops ticking after stop()", async () => {
    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(prisma.workspace.findMany).mockClear();
    handle.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
  });

  it("logs and swallows a failed run so the timer survives to the next tick", async () => {
    vi.mocked(prisma.workspace.findMany).mockRejectedValueOnce(new Error("db down"));
    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    // The rejection was CAUGHT — not merely left to become an unhandled
    // rejection, which vitest reports outside the test tally and which this
    // assertion would otherwise pass right over.
    expect(log.error).toHaveBeenCalledWith(
      "workspace usage rollup run failed",
      expect.objectContaining({ error: "db down" }),
    );
    vi.mocked(prisma.workspace.findMany).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.workspace.findMany).toHaveBeenCalled();
    handle.stop();
  });

  it("retries the full catch-up on the next tick when the first run failed", async () => {
    vi.mocked(prisma.workspace.findMany).mockRejectedValueOnce(new Error("db down"));
    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(prisma.workspace.findMany).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prisma.workspace.findMany).toHaveBeenCalledTimes(ROLLUP_CATCHUP_DAYS);
    handle.stop();
  });

  it("logs a non-Error rejection without dropping its detail", async () => {
    vi.mocked(prisma.workspace.findMany).mockRejectedValueOnce("connection reset");
    const handle = startWorkspaceUsageRollup(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledWith(
      "workspace usage rollup run failed",
      expect.objectContaining({ error: "connection reset" }),
    );
    handle.stop();
  });

  it("tolerates a timer with no unref (non-Node timer shims)", () => {
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(42 as unknown as NodeJS.Timeout);
    expect(() => startWorkspaceUsageRollup(60_000).stop()).not.toThrow();
    spy.mockRestore();
  });

  it("unrefs the timer so a pending rollup never holds the event loop open", () => {
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    const handle = startWorkspaceUsageRollup(60_000);
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
    handle.stop();
  });
});
