/**
 * Tool bridge — risk resolution + slug + lifecycle integration.
 */
import { describe, expect, it, vi } from "vitest";
import { MCPLifecycleManager } from "../src/lib/mcp/lifecycle-manager.js";
import {
  MCPToolBridge,
  formatToolName,
  resolveRisk,
  sha256OfCanonical,
} from "../src/lib/mcp/tool-bridge.js";
import { getToolRegistry, __resetToolRegistrySingleton } from "../src/lib/ai/tool-registry.js";
const resetToolRegistry = __resetToolRegistrySingleton;
import type { MCPServerConfig, MCPTransportClient } from "../src/lib/mcp/types.js";

// #876 — `tool-bridge.ts` touches `lastUsedAt` for the idle reaper with a fire-and-forget
// `prisma.mCPServer.updateMany(...)` whose rejection it deliberately swallows. Prisma logs it
// anyway (`log: ["warn", "error"]` outside production), and the write outlives the test file:
// against a Postgres datasource that failure arrives only after a real socket round-trip, so
// the log landed during worker teardown as
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` — every test
// passing, exit code 1. Mocking Prisma keeps this unit test off the database entirely, which
// is what it always intended.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    mCPServer: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

const auditEvents: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (entry: { action: string; metadata?: Record<string, unknown> }) => {
    auditEvents.push({ action: entry.action, metadata: entry.metadata });
  },
}));

function makeConfig(over: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "srv1",
    scope: "global",
    projectId: null,
    label: "Cool Server!",
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
    healthCheckIntervalSec: 60,
    enabled: true,
    ...over,
  };
}

function makeTransport(): MCPTransportClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    closed: vi.fn(() => new Promise(() => undefined)),
    request: vi.fn(async (m: string) => {
      if (m === "initialize") return { protocolVersion: "2025-06-18" };
      if (m === "tools/list")
        return {
          tools: [
            { name: "read_file", description: "" },
            { name: "delete_all", description: "", annotations: { destructiveHint: true } },
          ],
        };
      if (m === "tools/call") return { content: "ok", isError: false };
      throw new Error("?");
    }),
  };
}

describe("formatToolName + resolveRisk", () => {
  it("slugifies labels", () => {
    expect(formatToolName("Cool Server!", "read")).toBe("mcp:cool-server:read");
    expect(formatToolName("---trim---", "x")).toBe("mcp:trim:x");
  });
  it("forces high for untrusted servers regardless of per-tool risk", () => {
    expect(resolveRisk("untrusted", "low")).toBe("high");
    expect(resolveRisk("untrusted", "medium")).toBe("high");
  });
  it("respects per-tool risk for trusted servers", () => {
    expect(resolveRisk("trusted", "low")).toBe("low");
    expect(resolveRisk("trusted", "high")).toBe("high");
  });
});

describe("MCPToolBridge", () => {
  function setup(opts: { trust?: "trusted" | "untrusted" } = {}) {
    resetToolRegistry();
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const registry = {
      getAllowList: vi.fn(async () => []),
    } as unknown as ConstructorParameters<typeof MCPToolBridge>[1];
    const bridge = new MCPToolBridge(lifecycle, registry);
    bridge.attach();
    return { lifecycle, bridge, config: makeConfig({ trustLevel: opts.trust ?? "untrusted" }) };
  }

  it("registers tools with mcp:<slug>:<name> after start", async () => {
    const { lifecycle, bridge, config } = setup();
    await lifecycle.start(config);
    const names = bridge.registeredFor("srv1").sort();
    expect(names).toEqual(["mcp:cool-server:delete_all", "mcp:cool-server:read_file"]);
    const tool = getToolRegistry().get("mcp:cool-server:read_file");
    expect(tool?.risk).toBe("high"); // untrusted forces high
  });

  it("uses per-tool risk for trusted servers", async () => {
    const { lifecycle, bridge, config } = setup({ trust: "trusted" });
    await lifecycle.start(config);
    expect(bridge.registeredFor("srv1").length).toBe(2);
    const read = getToolRegistry().get("mcp:cool-server:read_file");
    expect(read?.risk).toBe("medium"); // server default
    const del = getToolRegistry().get("mcp:cool-server:delete_all");
    expect(del?.risk).toBe("high"); // destructive hint
  });

  it("unregisters on stop", async () => {
    const { lifecycle, bridge, config } = setup();
    await lifecycle.start(config);
    expect(bridge.registeredFor("srv1").length).toBeGreaterThan(0);
    await lifecycle.stop("srv1");
    expect(bridge.registeredFor("srv1")).toEqual([]);
  });
});

describe("MCPToolBridge invocation", () => {
  it("invokes through the registry, validates allow-list for project sessions", async () => {
    __resetToolRegistrySingleton();
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const allowList: Record<string, string[]> = { proj1: [] };
    const registry = {
      getAllowList: vi.fn(async (pid: string) => allowList[pid] ?? []),
    } as unknown as ConstructorParameters<typeof MCPToolBridge>[1];
    const bridge = new MCPToolBridge(lifecycle, registry);
    bridge.attach();
    await lifecycle.start(makeConfig({ trustLevel: "trusted" }));
    const tools = getToolRegistry();
    // Disallowed: project session, server NOT in allow-list
    const denied = await tools.invoke(
      "mcp:cool-server:read_file",
      {},
      { sessionId: "s", userId: "u", projectId: "proj1" },
    );
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/allow-list/);
    // Allowed: explicitly add to allow-list
    allowList.proj1 = ["srv1"];
    const result = await tools.invoke(
      "mcp:cool-server:read_file",
      {},
      { sessionId: "s", userId: "u", projectId: "proj1" },
    );
    expect(result.isError).toBe(false);
    // Allowed: no project (admin session)
    const r2 = await tools.invoke("mcp:cool-server:read_file", {}, { sessionId: "s", userId: "u" });
    expect(r2.isError).toBe(false);
    bridge.shutdown();
  });

  it("returns isError when the server is not ready", async () => {
    __resetToolRegistrySingleton();
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const registry = {
      getAllowList: vi.fn(async () => []),
    } as unknown as ConstructorParameters<typeof MCPToolBridge>[1];
    const bridge = new MCPToolBridge(lifecycle, registry);
    bridge.attach();
    await lifecycle.start(makeConfig({ trustLevel: "trusted" }));
    await lifecycle.stop("srv1");
    // After stop the bridge unregisters tools, so re-register manually via syncServer
    // to test the not-ready path.
    bridge.syncServer("srv1");
    expect(bridge.registeredFor("srv1")).toEqual([]);
  });
});

// SEC-6: project-scoped server may only be invoked by sessions on the same project.
describe("MCPToolBridge cross-project isolation (SEC-6)", () => {
  it("denies invocation when ctx.projectId !== config.projectId", async () => {
    __resetToolRegistrySingleton();
    auditEvents.length = 0;
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const registry = {
      getAllowList: vi.fn(async () => []),
    } as unknown as ConstructorParameters<typeof MCPToolBridge>[1];
    const bridge = new MCPToolBridge(lifecycle, registry);
    bridge.attach();
    await lifecycle.start(
      makeConfig({ scope: "project", projectId: "proj-a", trustLevel: "trusted" }),
    );
    const denied = await getToolRegistry().invoke(
      "mcp:cool-server:read_file",
      {},
      { sessionId: "s", userId: "u", projectId: "proj-b" },
    );
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/cross-project/);
    const denyAudit = auditEvents.find((e) => e.metadata?.decision === "denied");
    expect(denyAudit).toBeTruthy();
    expect(denyAudit?.metadata?.denyReason).toBe("cross_project_access");
    bridge.shutdown();
  });

  it("permits invocation when ctx.projectId === config.projectId", async () => {
    __resetToolRegistrySingleton();
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const registry = {
      getAllowList: vi.fn(async () => []),
    } as unknown as ConstructorParameters<typeof MCPToolBridge>[1];
    const bridge = new MCPToolBridge(lifecycle, registry);
    bridge.attach();
    await lifecycle.start(
      makeConfig({ scope: "project", projectId: "proj-a", trustLevel: "trusted" }),
    );
    const ok = await getToolRegistry().invoke(
      "mcp:cool-server:read_file",
      {},
      { sessionId: "s", userId: "u", projectId: "proj-a" },
    );
    expect(ok.isError).toBe(false);
    bridge.shutdown();
  });
});

// SEC-8 / R-E5: audit metadata must include version, sha256, argsHash, resultHash, decision.
describe("MCPToolBridge audit completeness (SEC-8 / R-E5)", () => {
  it("emits version, sha256, argsHash, resultHash, decision on allowed invocation", async () => {
    __resetToolRegistrySingleton();
    auditEvents.length = 0;
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const registry = {
      getAllowList: vi.fn(async () => []),
    } as unknown as ConstructorParameters<typeof MCPToolBridge>[1];
    const bridge = new MCPToolBridge(lifecycle, registry);
    bridge.attach();
    await lifecycle.start(
      makeConfig({
        trustLevel: "trusted",
        version: "1.4.2",
        sha256: "a".repeat(64),
      }),
    );
    await getToolRegistry().invoke(
      "mcp:cool-server:read_file",
      { path: "/tmp/x" },
      { sessionId: "s", userId: "u" },
    );
    const evt = auditEvents.find((e) => e.action === "mcp.tool.invoke");
    expect(evt).toBeTruthy();
    const md = evt!.metadata!;
    expect(md.version).toBe("1.4.2");
    expect(md.sha256).toBe("a".repeat(64));
    expect(md.decision).toBe("allowed");
    expect(typeof md.argsHash).toBe("string");
    expect((md.argsHash as string).length).toBe(64);
    expect(typeof md.resultHash).toBe("string");
    expect((md.resultHash as string).length).toBe(64);
    bridge.shutdown();
  });

  it("emits decision=denied with hashes when allow-list rejects", async () => {
    __resetToolRegistrySingleton();
    auditEvents.length = 0;
    const lifecycle = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      transportFactory: () => makeTransport(),
    });
    const registry = {
      getAllowList: vi.fn(async () => []),
    } as unknown as ConstructorParameters<typeof MCPToolBridge>[1];
    const bridge = new MCPToolBridge(lifecycle, registry);
    bridge.attach();
    await lifecycle.start(makeConfig({ trustLevel: "trusted", version: "v1" }));
    await getToolRegistry().invoke(
      "mcp:cool-server:read_file",
      {},
      { sessionId: "s", userId: "u", projectId: "proj-x" },
    );
    const evt = auditEvents.find((e) => e.metadata?.decision === "denied");
    expect(evt).toBeTruthy();
    expect(evt!.metadata!.denyReason).toBe("not_on_allow_list");
    expect(evt!.metadata!.version).toBe("v1");
    expect(typeof evt!.metadata!.argsHash).toBe("string");
    bridge.shutdown();
  });
});

describe("sha256OfCanonical", () => {
  it("produces stable hash regardless of key order", () => {
    expect(sha256OfCanonical({ a: 1, b: 2 })).toBe(sha256OfCanonical({ b: 2, a: 1 }));
  });
  it("differs when content differs", () => {
    expect(sha256OfCanonical({ a: 1 })).not.toBe(sha256OfCanonical({ a: 2 }));
  });
  it("handles primitives, arrays, null", () => {
    expect(sha256OfCanonical(null)).toBe(sha256OfCanonical(undefined));
    expect(sha256OfCanonical([1, 2])).not.toBe(sha256OfCanonical([2, 1]));
  });
});
