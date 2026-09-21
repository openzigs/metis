/**
 * Unit tests for the FinOps alert engine (Epic #47 / Issue #49).
 *
 * Mocks Prisma. Emphasis on the AC: rule eval is IDEMPOTENT — re-running the
 * tick within the cooldown does NOT re-fire, and lastFiredAt is the durable
 * idempotency state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface WsRow {
  id: string;
  name: string;
  monthlyBudgetCents: number | null;
  deletedAt: Date | null;
}
interface RuleRow {
  id: string;
  workspaceId: string;
  name: string;
  thresholdPct: number;
  basis: string;
  cooldownSec: number;
  enabled: boolean;
  lastFiredAt: Date | null;
}
interface ForecastRow {
  workspaceId: string;
  projectId: string | null;
  monthToDateCents: number;
  projectedMonthEndCents: number;
  computedAt: Date;
}

const wsTable: WsRow[] = [];
const ruleTable: RuleRow[] = [];
const forecastTable: ForecastRow[] = [];
const channelTable: Array<{
  id: string;
  workspaceId: string;
  type: string;
  target: string;
  secret: string | null;
  config: string;
  enabled: boolean;
}> = [];
const eventTable: Record<string, unknown>[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    workspace: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          wsTable.find((w) => w.id === where.id) ?? null,
      ),
      findMany: vi.fn(async () =>
        wsTable.filter((w) => w.deletedAt === null && w.monthlyBudgetCents != null),
      ),
    },
    costForecast: {
      findFirst: vi.fn(
        async ({ where }: { where: { workspaceId: string; projectId: string | null } }) =>
          forecastTable
            .filter((f) => f.workspaceId === where.workspaceId && f.projectId === where.projectId)
            .sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0] ?? null,
      ),
    },
    alertRule: {
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string; enabled: boolean } }) =>
        ruleTable.filter((r) => r.workspaceId === where.workspaceId && r.enabled === where.enabled),
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { lastFiredAt: Date } }) => {
          const r = ruleTable.find((x) => x.id === where.id);
          if (r) r.lastFiredAt = data.lastFiredAt;
          return r;
        },
      ),
    },
    alertChannel: {
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string } }) =>
        channelTable.filter((c) => c.workspaceId === where.workspaceId && c.enabled),
      ),
    },
    alertEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        eventTable.push(data);
        return { id: `ae_${eventTable.length}`, ...data };
      }),
    },
    // Mirror Prisma's array-form `$transaction`: await every operation and
    // return their results in order. The mocked `create`/`update` already
    // return promises, so awaiting them here runs the pair together.
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  },
}));

// Issue #67 — the engine fires a best-effort Teams notification after a durable
// fire. Mock the hook so we can assert it is invoked with the fired alert's
// details (and so the real proactive-send path is not exercised in this unit).
vi.mock("../src/lib/teams/notification-hooks.js", () => ({
  notifyBudgetExceeded: vi.fn(),
}));

import {
  tickWorkspace,
  tickAllWorkspaces,
  startAlertEngine,
  setDefaultDispatcherFactory,
} from "../src/lib/finops/alert-engine.js";
import { notifyBudgetExceeded } from "../src/lib/teams/notification-hooks.js";

const NOW = new Date("2026-06-15T12:00:00Z");

beforeEach(() => {
  wsTable.length = 0;
  ruleTable.length = 0;
  forecastTable.length = 0;
  channelTable.length = 0;
  eventTable.length = 0;
  vi.mocked(notifyBudgetExceeded).mockClear();
});

function seedFiringScenario() {
  wsTable.push({ id: "w1", name: "Acme", monthlyBudgetCents: 10_000, deletedAt: null });
  forecastTable.push({
    workspaceId: "w1",
    projectId: null,
    monthToDateCents: 5_000,
    projectedMonthEndCents: 9_000, // 90%
    computedAt: new Date("2026-06-15T06:00:00Z"),
  });
  ruleTable.push({
    id: "r80",
    workspaceId: "w1",
    name: "80% projected",
    thresholdPct: 80,
    basis: "projected",
    cooldownSec: 3600,
    enabled: true,
    lastFiredAt: null,
  });
}

describe("tickWorkspace", () => {
  it("fires a rule, persists an AlertEvent, and advances lastFiredAt", async () => {
    seedFiringScenario();
    const fired = await tickWorkspace("w1", NOW);
    expect(fired).toHaveLength(1);
    expect(eventTable).toHaveLength(1);
    expect(eventTable[0].spendCents).toBe(9_000);
    expect(ruleTable[0].lastFiredAt).toEqual(NOW);
  });

  it("writes the AlertEvent + lastFiredAt advance in a single $transaction (Mi1 atomicity)", async () => {
    seedFiringScenario();
    const { prisma } = await import("../src/lib/prisma.js");
    const txn = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
    txn.mockClear(); // mock is module-scoped; isolate this assertion
    await tickWorkspace("w1", NOW);
    // Exactly one transaction wrapping exactly two operations (create + update).
    expect(txn).toHaveBeenCalledOnce();
    const ops = txn.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(2);
    // Both effects landed.
    expect(eventTable).toHaveLength(1);
    expect(ruleTable[0].lastFiredAt).toEqual(NOW);
  });

  it("propagates a transaction failure so the fire is not half-committed", async () => {
    seedFiringScenario();
    const { prisma } = await import("../src/lib/prisma.js");
    const txn = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
    // Simulate the DB rejecting the atomic write (e.g. the second op fails and
    // the whole transaction rolls back). The tick must surface the error
    // rather than silently leaving a half-written fire.
    txn.mockRejectedValueOnce(new Error("transaction rolled back"));
    await expect(tickWorkspace("w1", NOW)).rejects.toThrow(/rolled back/);
  });

  it("fires a best-effort Teams notification (#67) after the durable AlertEvent", async () => {
    seedFiringScenario();
    await tickWorkspace("w1", NOW);
    expect(notifyBudgetExceeded).toHaveBeenCalledTimes(1);
    expect(notifyBudgetExceeded).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({
        workspaceName: "Acme",
        ruleName: "80% projected",
        basis: "projected",
        spendCents: 9_000,
        budgetCents: 10_000,
      }),
    );
  });

  it("does NOT fire the Teams notification when nothing tripped", async () => {
    wsTable.push({ id: "w1", name: "Acme", monthlyBudgetCents: 10_000, deletedAt: null });
    forecastTable.push({
      workspaceId: "w1",
      projectId: null,
      monthToDateCents: 100,
      projectedMonthEndCents: 200, // 2% — below any rule
      computedAt: new Date("2026-06-15T06:00:00Z"),
    });
    ruleTable.push({
      id: "r80",
      workspaceId: "w1",
      name: "80% projected",
      thresholdPct: 80,
      basis: "projected",
      cooldownSec: 3600,
      enabled: true,
      lastFiredAt: null,
    });
    await tickWorkspace("w1", NOW);
    expect(notifyBudgetExceeded).not.toHaveBeenCalled();
  });

  it("is IDEMPOTENT — a second tick within cooldown does not re-fire", async () => {
    seedFiringScenario();
    await tickWorkspace("w1", NOW);
    expect(eventTable).toHaveLength(1);
    // Re-run 10 minutes later (cooldown is 1h) — must not re-fire.
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const fired2 = await tickWorkspace("w1", later);
    expect(fired2).toHaveLength(0);
    expect(eventTable).toHaveLength(1);
  });

  it("re-fires once the cooldown has elapsed", async () => {
    seedFiringScenario();
    await tickWorkspace("w1", NOW);
    const muchLater = new Date(NOW.getTime() + 2 * 3600 * 1000);
    const fired = await tickWorkspace("w1", muchLater);
    expect(fired).toHaveLength(1);
    expect(eventTable).toHaveLength(2);
  });

  it("does nothing when the workspace has no budget", async () => {
    wsTable.push({ id: "w1", name: "Acme", monthlyBudgetCents: null, deletedAt: null });
    const fired = await tickWorkspace("w1", NOW);
    expect(fired).toHaveLength(0);
  });

  it("does nothing when there is no forecast yet", async () => {
    wsTable.push({ id: "w1", name: "Acme", monthlyBudgetCents: 10_000, deletedAt: null });
    const fired = await tickWorkspace("w1", NOW);
    expect(fired).toHaveLength(0);
  });

  it("invokes the injected dispatcher and records delivery results", async () => {
    seedFiringScenario();
    channelTable.push({
      id: "c1",
      workspaceId: "w1",
      type: "webhook",
      target: "https://example.com/hook",
      secret: "s",
      config: "{}",
      enabled: true,
    });
    const dispatcher = vi.fn(async () => [{ channelId: "c1", type: "webhook", ok: true }]);
    await tickWorkspace("w1", NOW, { dispatcher });
    expect(dispatcher).toHaveBeenCalledOnce();
    const deliveries = JSON.parse(eventTable[0].deliveries as string);
    expect(deliveries[0]).toMatchObject({ channelId: "c1", ok: true });
  });

  it("records a failed delivery when the dispatcher throws", async () => {
    seedFiringScenario();
    channelTable.push({
      id: "c1",
      workspaceId: "w1",
      type: "email",
      target: "a@b.com",
      secret: null,
      config: "{}",
      enabled: true,
    });
    const dispatcher = vi.fn(async () => {
      throw new Error("smtp down");
    });
    await tickWorkspace("w1", NOW, { dispatcher });
    const deliveries = JSON.parse(eventTable[0].deliveries as string);
    expect(deliveries[0]).toMatchObject({ ok: false, error: "smtp down" });
  });
});

describe("tickAllWorkspaces", () => {
  it("ticks every budgeted workspace and totals fired alerts", async () => {
    seedFiringScenario();
    const count = await tickAllWorkspaces(NOW);
    expect(count).toBe(1);
  });

  it("swallows a per-workspace tick failure without aborting the run", async () => {
    seedFiringScenario();
    const { prisma } = await import("../src/lib/prisma.js");
    const findUnique = prisma.workspace.findUnique as unknown as ReturnType<typeof vi.fn>;
    findUnique.mockRejectedValueOnce(new Error("db down"));
    const count = await tickAllWorkspaces(NOW);
    expect(count).toBe(0); // failure was caught, not thrown
  });
});

describe("startAlertEngine / setDefaultDispatcherFactory", () => {
  it("returns a stoppable handle and accepts a default dispatcher factory", () => {
    const factory = vi.fn(() => async () => []);
    setDefaultDispatcherFactory(factory);
    const handle = startAlertEngine(60_000);
    expect(typeof handle.stop).toBe("function");
    handle.stop();
    setDefaultDispatcherFactory(null);
  });

  it("fires a tick on each interval using the registered dispatcher factory", async () => {
    vi.useFakeTimers();
    try {
      seedFiringScenario();
      const dispatcher = vi.fn(async () => []);
      const factory = vi.fn(() => dispatcher);
      setDefaultDispatcherFactory(factory);
      const handle = startAlertEngine(60_000);
      // Advance one interval — the callback should resolve the factory and tick.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(factory).toHaveBeenCalled();
      handle.stop();
      setDefaultDispatcherFactory(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs and swallows a tick failure raised inside the interval callback", async () => {
    vi.useFakeTimers();
    try {
      const { prisma } = await import("../src/lib/prisma.js");
      const findMany = prisma.workspace.findMany as unknown as ReturnType<typeof vi.fn>;
      findMany.mockRejectedValueOnce(new Error("db gone"));
      const handle = startAlertEngine(60_000);
      // Must not throw out of the timer callback (the .catch swallows it).
      await vi.advanceTimersByTimeAsync(60_000);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
