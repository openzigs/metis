/**
 * Sub-issue #277 — MCPIdleReaper sweep behaviour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRow {
  id: string;
  label: string;
  scope: string;
  transport: string;
  command: string | null;
  status: string;
  enabled: boolean;
  createdAt: Date;
  lastToolInvocationAt: Date | null;
  deletedAt: Date | null;
  capabilities: unknown;
}

const cfgState = {
  booleans: new Map<string, boolean>(),
  numbers: new Map<string, number>(),
};

const rows: FakeRow[] = [];
const updates: Array<{ id: string; data: Partial<FakeRow> }> = [];

vi.mock("../../../src/lib/config/config-service.js", () => ({
  getConfigService: () => ({
    getBool: (k: string, def: boolean) => cfgState.booleans.get(k) ?? def,
    getNumber: (k: string, def: number) => cfgState.numbers.get(k) ?? def,
    get: () => undefined,
  }),
}));

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    mCPServer: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => {
          if (r.deletedAt) return false;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        }),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeRow> }) => {
        updates.push({ id: where.id, data });
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
  },
}));

vi.mock("../../../src/lib/audit/mcp-audit.js", () => ({
  auditMcpEvent: vi.fn(),
}));

import { MCPIdleReaper } from "../../../src/lib/mcp/idle-reaper.js";
import { auditMcpEvent } from "../../../src/lib/audit/mcp-audit.js";
import type { MCPLifecycleManager } from "../../../src/lib/mcp/lifecycle-manager.js";

beforeEach(() => {
  cfgState.booleans.clear();
  cfgState.numbers.clear();
  rows.length = 0;
  updates.length = 0;
  vi.clearAllMocks();
});

function makeLifecycle() {
  return { stop: vi.fn(async () => undefined) } as unknown as MCPLifecycleManager;
}

describe("MCPIdleReaper", () => {
  it("is a no-op when MCP_ALLOW_USER_SCOPE is false", async () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", false);
    const reaper = new MCPIdleReaper(makeLifecycle());
    const result = await reaper.sweep();
    expect(result).toEqual({ stopped: 0, skipped: 0 });
  });

  it("sweep with no rows is a no-op", async () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", true);
    const reaper = new MCPIdleReaper(makeLifecycle());
    const result = await reaper.sweep();
    expect(result).toEqual({ stopped: 0, skipped: 0 });
  });

  it("stops an idle user-scoped row past the cutoff", async () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", true);
    cfgState.numbers.set("MCP_USER_IDLE_TIMEOUT_MIN", 10);
    const lifecycle = makeLifecycle();
    const now = new Date("2026-01-01T12:00:00Z");
    rows.push({
      id: "mcp_idle",
      label: "idle-one",
      scope: "user",
      transport: "stdio",
      command: "node",
      status: "ready",
      enabled: true,
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      lastToolInvocationAt: new Date(now.getTime() - 60 * 60 * 1000),
      deletedAt: null,
      capabilities: null,
    });
    const reaper = new MCPIdleReaper(lifecycle, { now: () => now });
    const result = await reaper.sweep();
    expect(result.stopped).toBe(1);
    expect((lifecycle.stop as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["mcp_idle", "idle-reaper"],
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.enabled).toBe(false);
    expect(updates[0].data.status).toBe("idle");
    expect((auditMcpEvent as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "mcp.stopped",
    );
  });

  it("skips active rows whose last invocation is within the window", async () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", true);
    cfgState.numbers.set("MCP_USER_IDLE_TIMEOUT_MIN", 30);
    const lifecycle = makeLifecycle();
    const now = new Date("2026-01-01T12:00:00Z");
    rows.push({
      id: "mcp_active",
      label: "active-one",
      scope: "user",
      transport: "stdio",
      command: "node",
      status: "ready",
      enabled: true,
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      lastToolInvocationAt: new Date(now.getTime() - 5 * 60 * 1000),
      deletedAt: null,
      capabilities: null,
    });
    const reaper = new MCPIdleReaper(lifecycle, { now: () => now });
    const result = await reaper.sweep();
    expect(result).toEqual({ stopped: 0, skipped: 1 });
    expect((lifecycle.stop as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("uses createdAt as the activity floor when lastToolInvocationAt is null", async () => {
    cfgState.booleans.set("MCP_ALLOW_USER_SCOPE", true);
    cfgState.numbers.set("MCP_USER_IDLE_TIMEOUT_MIN", 10);
    const lifecycle = makeLifecycle();
    const now = new Date("2026-01-01T12:00:00Z");
    rows.push({
      id: "mcp_fresh",
      label: "fresh-one",
      scope: "user",
      transport: "stdio",
      command: "node",
      status: "ready",
      enabled: true,
      createdAt: new Date(now.getTime() - 5 * 60 * 1000), // within window
      lastToolInvocationAt: null,
      deletedAt: null,
      capabilities: null,
    });
    const reaper = new MCPIdleReaper(lifecycle, { now: () => now });
    const result = await reaper.sweep();
    expect(result.skipped).toBe(1);
    expect(result.stopped).toBe(0);
  });

  it("start/stop are idempotent and do not throw", () => {
    const reaper = new MCPIdleReaper(makeLifecycle(), { intervalMs: 60_000 });
    reaper.start();
    reaper.start();
    reaper.stop();
    reaper.stop();
  });
});
