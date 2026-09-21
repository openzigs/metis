/**
 * Lifecycle manager — start/stop, status fan-out, probe failure escalation.
 */
import { describe, expect, it, vi } from "vitest";
import { MCPLifecycleManager } from "../src/lib/mcp/lifecycle-manager.js";
import type { MCPServerConfig, MCPStatusEvent, MCPTransportClient } from "../src/lib/mcp/types.js";

function makeConfig(over: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "srv1",
    scope: "global",
    projectId: null,
    label: "test",
    transport: "stdio",
    runtime: "native",
    command: "node",
    args: ["x.js"],
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    trustLevel: "untrusted",
    defaultToolRisk: "medium",
    version: null,
    sha256: null,
    healthCheckIntervalSec: 60,
    enabled: true,
    ...over,
  };
}

function makeTransport(
  opts: {
    initResult?: unknown;
    toolsResult?: unknown;
    pingError?: Error;
  } = {},
): MCPTransportClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    closed: vi.fn(() => new Promise(() => undefined)),
    request: vi.fn(async (method: string) => {
      if (method === "initialize") {
        return opts.initResult ?? { protocolVersion: "2025-06-18", serverInfo: { name: "x" } };
      }
      if (method === "tools/list") {
        if (opts.pingError) throw opts.pingError;
        return opts.toolsResult ?? { tools: [{ name: "read", description: "" }] };
      }
      throw new Error(`unexpected method ${method}`);
    }),
  };
}

describe("MCPLifecycleManager", () => {
  it("emits starting -> ready and caches tools", async () => {
    const events: MCPStatusEvent[] = [];
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
      emitStatus: (e) => events.push(e),
    });
    const state = await mgr.start(makeConfig());
    expect(state.status).toBe("ready");
    expect(state.tools.length).toBe(1);
    expect(events.map((e) => e.status)).toContain("starting");
    expect(events.map((e) => e.status)).toContain("ready");
  });

  it("flips to disabled when config.enabled is false", async () => {
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const state = await mgr.start(makeConfig({ enabled: false }));
    expect(state.status).toBe("disabled");
  });

  it("captures env-resolution failure as error", async () => {
    const mgr = new MCPLifecycleManager({
      resolveEnv: async () => {
        throw new Error("vault dead");
      },
      transportFactory: () => makeTransport(),
    });
    const state = await mgr.start(makeConfig({ env: { TOKEN: "${vault:x}" } }));
    expect(state.status).toBe("error");
    expect(state.lastError).toMatch(/vault dead/);
  });

  it("schedules a restart when start fails (capped)", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => ({
        start: vi.fn(async () => {
          attempts += 1;
          throw new Error("boom");
        }),
        stop: vi.fn(async () => undefined),
        notify: vi.fn(async () => undefined),
        closed: vi.fn(() => new Promise(() => undefined)),
        request: vi.fn(),
      }),
      maxRestarts: 2,
    });
    await mgr.start(makeConfig());
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(2100);
    // Beyond max — no further attempts.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(3);
    vi.useRealTimers();
  });

  it("probe failures escalate to error after 3 strikes", async () => {
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport({ pingError: new Error("conn refused") }),
    });
    await mgr.start(makeConfig());
    await mgr.probe("srv1");
    await mgr.probe("srv1");
    let snap = mgr.get("srv1");
    expect(snap!.state.status).toBe("ready"); // not yet
    await mgr.probe("srv1");
    snap = mgr.get("srv1");
    expect(snap!.state.status).toBe("error");
  });

  it("invokeTool refuses when not ready", async () => {
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    await mgr.start(makeConfig({ enabled: false }));
    await expect(mgr.invokeTool("srv1", "read", {})).rejects.toThrow(/not ready/);
  });

  it("stop transitions to idle and clears tools", async () => {
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    await mgr.start(makeConfig());
    await mgr.stop("srv1");
    const snap = mgr.get("srv1");
    expect(snap!.state.status).toBe("idle");
    expect(snap!.state.tools).toEqual([]);
  });

  it("listener can be detached", async () => {
    const events: MCPStatusEvent[] = [];
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const off = mgr.onStatus((e) => events.push(e));
    await mgr.start(makeConfig());
    off();
    await mgr.stop("srv1");
    const len = events.length;
    await mgr.start(makeConfig({ id: "srv2" }));
    expect(events.length).toBe(len);
  });
});
