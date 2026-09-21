/**
 * Health monitor — verify it walks ready servers, calls probe, and writes status to DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    mCPServer: {
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return { id: args.where.id };
      }),
    },
  },
}));

import { MCPHealthMonitor } from "../src/lib/mcp/health-monitor.js";
import { MCPLifecycleManager } from "../src/lib/mcp/lifecycle-manager.js";
import type { MCPServerConfig, MCPTransportClient } from "../src/lib/mcp/types.js";

beforeEach(() => {
  updates.length = 0;
});

function transport(opts: { fail?: boolean } = {}): MCPTransportClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    closed: vi.fn(() => new Promise(() => undefined)),
    request: vi.fn(async (m: string) => {
      if (m === "initialize") return { protocolVersion: "2025-06-18" };
      if (m === "tools/list" && opts.fail) throw new Error("dead");
      return { tools: [] };
    }),
  };
}

function config(over: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: over.id ?? "srv1",
    scope: "global",
    projectId: null,
    label: "x",
    transport: "stdio",
    runtime: "native",
    command: "node",
    args: null,
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    trustLevel: "untrusted",
    defaultToolRisk: "medium",
    version: null,
    sha256: null,
    healthCheckIntervalSec: 1,
    enabled: true,
    ...over,
  };
}

describe("MCPHealthMonitor.tick", () => {
  it("probes ready servers when interval has elapsed", async () => {
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => transport(),
    });
    await lifecycle.start(config());
    const mon = new MCPHealthMonitor(lifecycle, { now: () => Date.now() + 999_999 });
    await mon.tick();
    expect(updates.length).toBe(1);
    expect(updates[0].data.status).toBe("ready");
  });

  it("escalates to error after consecutive failures", async () => {
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => transport({ fail: true }),
    });
    await lifecycle.start(config());
    const mon = new MCPHealthMonitor(lifecycle, { now: () => Date.now() + 999_999 });
    await mon.tick();
    await mon.tick();
    await mon.tick();
    const last = updates[updates.length - 1];
    expect(last.data.status).toBe("error");
  });

  it("skips disabled servers", async () => {
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => transport(),
    });
    await lifecycle.start(config({ enabled: false }));
    const mon = new MCPHealthMonitor(lifecycle, { now: () => Date.now() + 999_999 });
    await mon.tick();
    expect(updates).toEqual([]);
  });

  it("start/stop manage interval handles", () => {
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => transport(),
    });
    const setIntervalFn = vi.fn(() => 42 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();
    const mon = new MCPHealthMonitor(lifecycle, {
      scheduler: { setInterval: setIntervalFn, clearInterval: clearIntervalFn },
    });
    mon.start();
    mon.start(); // idempotent
    mon.stop();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});
