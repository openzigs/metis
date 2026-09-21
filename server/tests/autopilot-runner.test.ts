/**
 * Unit tests for the autopilot runner (Epic #164).
 *
 * Covers the disabled-project guard, the cost-ceiling abort, and the
 * audit lifecycle hooks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockProject {
  autopilotEnabled: boolean;
  autopilotCostCeilingCents: number | null;
  monthlyTokenBudget: number | null;
}

const projects = new Map<string, MockProject>();
const usageRows: Array<{
  projectId: string;
  totalTokens: number;
  costCents: number;
  createdAt: Date;
}> = [];
const auditCalls: Array<{ action: string; metadata?: Record<string, unknown> }> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = projects.get(where.id);
        return row ? { id: where.id, ...row } : null;
      }),
    },
    tokenUsage: {
      findMany: vi.fn(
        async ({ where }: { where: { projectId: string; createdAt?: { gte?: Date } } }) =>
          usageRows.filter((r) => {
            if (r.projectId !== where.projectId) return false;
            if (where.createdAt?.gte && r.createdAt < where.createdAt.gte) return false;
            return true;
          }),
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: { action: string; metadata?: Record<string, unknown> }) => {
    auditCalls.push(entry);
  }),
}));

import {
  AutopilotCostCeilingError,
  AutopilotDisabledError,
  assertAutopilotAllowed,
  assertCeiling,
  loadAutopilotSettings,
  runAutopilot,
} from "../src/lib/autopilot/autopilot-runner.js";

beforeEach(() => {
  projects.clear();
  usageRows.length = 0;
  auditCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadAutopilotSettings", () => {
  it("returns null when project is missing", async () => {
    expect(await loadAutopilotSettings("missing")).toBeNull();
  });

  it("returns the settings row when found", async () => {
    projects.set("p1", {
      autopilotEnabled: true,
      autopilotCostCeilingCents: 1000,
      monthlyTokenBudget: null,
    });
    const r = await loadAutopilotSettings("p1");
    expect(r?.autopilotEnabled).toBe(true);
    expect(r?.autopilotCostCeilingCents).toBe(1000);
  });
});

describe("assertAutopilotAllowed", () => {
  it("throws AUTOPILOT_DISABLED when project missing", async () => {
    await expect(assertAutopilotAllowed("none")).rejects.toBeInstanceOf(AutopilotDisabledError);
  });

  it("throws AUTOPILOT_DISABLED when autopilotEnabled=false", async () => {
    projects.set("p1", {
      autopilotEnabled: false,
      autopilotCostCeilingCents: null,
      monthlyTokenBudget: null,
    });
    await expect(assertAutopilotAllowed("p1")).rejects.toBeInstanceOf(AutopilotDisabledError);
  });

  it("returns settings when enabled and under ceiling", async () => {
    projects.set("p1", {
      autopilotEnabled: true,
      autopilotCostCeilingCents: 100_000,
      monthlyTokenBudget: null,
    });
    const settings = await assertAutopilotAllowed("p1");
    expect(settings.autopilotEnabled).toBe(true);
  });

  it("throws AutopilotCostCeilingError when projection meets the ceiling", async () => {
    projects.set("p1", {
      autopilotEnabled: true,
      autopilotCostCeilingCents: 100,
      monthlyTokenBudget: null,
    });
    // 50 cents on day 15 of a 30-day month → projection 100 → ceiling hit.
    const fixedNow = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
    usageRows.push({
      projectId: "p1",
      totalTokens: 1000,
      costCents: 50,
      createdAt: new Date(Date.UTC(2026, 5, 1, 12, 0, 0)),
    });
    await expect(assertAutopilotAllowed("p1", fixedNow)).rejects.toBeInstanceOf(
      AutopilotCostCeilingError,
    );
  });
});

describe("assertCeiling", () => {
  it("returns 0 when ceilingCents is null", async () => {
    expect(await assertCeiling("p1", null)).toBe(0);
  });

  it("throws when projection is over ceiling", async () => {
    const fixedNow = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
    usageRows.push({
      projectId: "p1",
      totalTokens: 1000,
      costCents: 100,
      createdAt: new Date(Date.UTC(2026, 5, 1, 12, 0, 0)),
    });
    await expect(assertCeiling("p1", 100, fixedNow)).rejects.toBeInstanceOf(
      AutopilotCostCeilingError,
    );
  });
});

describe("runAutopilot", () => {
  it("emits start + complete audit on a happy run", async () => {
    projects.set("p1", {
      autopilotEnabled: true,
      autopilotCostCeilingCents: null,
      monthlyTokenBudget: null,
    });
    const r = await runAutopilot({
      projectId: "p1",
      run: async () => ({ ok: true }),
    });
    expect(r.status).toBe("completed");
    const actions = auditCalls.map((c) => c.action);
    expect(actions).toContain("autopilot.run.start");
    expect(actions).toContain("autopilot.run.complete");
  });

  it("emits abort audit when the runner throws AutopilotCostCeilingError", async () => {
    projects.set("p1", {
      autopilotEnabled: true,
      autopilotCostCeilingCents: null,
      monthlyTokenBudget: null,
    });
    const r = await runAutopilot({
      projectId: "p1",
      run: async () => {
        throw new AutopilotCostCeilingError(200, 100);
      },
    });
    expect(r.status).toBe("aborted");
    const actions = auditCalls.map((c) => c.action);
    expect(actions).toContain("autopilot.run.abort");
  });

  it("re-throws non-cost errors and emits failed audit", async () => {
    projects.set("p1", {
      autopilotEnabled: true,
      autopilotCostCeilingCents: null,
      monthlyTokenBudget: null,
    });
    await expect(
      runAutopilot({
        projectId: "p1",
        run: async () => {
          throw new Error("downstream boom");
        },
      }),
    ).rejects.toThrow("downstream boom");
    const actions = auditCalls.map((c) => c.action);
    expect(actions).toContain("autopilot.run.failed");
  });

  it("rejects up-front when the project has autopilotEnabled=false", async () => {
    projects.set("p1", {
      autopilotEnabled: false,
      autopilotCostCeilingCents: null,
      monthlyTokenBudget: null,
    });
    await expect(
      runAutopilot({ projectId: "p1", run: async () => undefined }),
    ).rejects.toBeInstanceOf(AutopilotDisabledError);
  });
});
