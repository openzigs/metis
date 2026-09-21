/**
 * Epic #271 / Issue #281 — Lifecycle integration with provisioners.
 */
import { describe, expect, it, vi } from "vitest";
import { MCPLifecycleManager } from "../src/lib/mcp/lifecycle-manager.js";
import type { MCPServerConfig, MCPTransportClient } from "../src/lib/mcp/types.js";
import type {
  ContainerProvisioner,
  ProvisionedProcess,
} from "../src/lib/mcp/provisioners/index.js";

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

function makeTransport(): MCPTransportClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    closed: vi.fn(() => new Promise(() => undefined)),
    request: vi.fn(async (method: string) => {
      if (method === "initialize") {
        return { protocolVersion: "2025-06-18", serverInfo: { name: "x" } };
      }
      if (method === "tools/list") {
        return { tools: [{ name: "noop", description: "" }] };
      }
      throw new Error(`unexpected method ${method}`);
    }),
  };
}

function recordingProvisioner(opts: {
  cleanup?: ReturnType<typeof vi.fn>;
  failProvision?: boolean;
}): ContainerProvisioner & {
  calls: Array<{ config: MCPServerConfig; env: Record<string, string> }>;
} {
  const calls: Array<{ config: MCPServerConfig; env: Record<string, string> }> = [];
  const provisioner: ContainerProvisioner & {
    calls: Array<{ config: MCPServerConfig; env: Record<string, string> }>;
  } = {
    calls,
    async provision(config, env): Promise<ProvisionedProcess> {
      calls.push({ config, env });
      if (opts.failProvision) throw new Error("provision failed");
      return {
        command: "node",
        args: ["wrapped.js"],
        env,
        cleanup: opts.cleanup,
      };
    },
  };
  return provisioner;
}

describe("MCPLifecycleManager + provisioners (#281)", () => {
  it("calls the runtime-matching provisioner before spawn", async () => {
    const docker = recordingProvisioner({});
    const native = recordingProvisioner({});
    const factory = vi.fn(() => makeTransport());
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => ({ ...e, RESOLVED: "1" }),
      provisioners: { native, "docker-stdio": docker },
      transportFactory: factory,
    });
    await mgr.start(makeConfig({ runtime: "docker-stdio", env: { TOKEN: "x" } }));
    expect(docker.calls.length).toBe(1);
    expect(native.calls.length).toBe(0);
    expect(docker.calls[0].env.RESOLVED).toBe("1");
    // factory receives the provisioned target, not the raw config.
    expect(factory).toHaveBeenCalledTimes(1);
    const [, provisioned] = factory.mock.calls[0] as [MCPServerConfig, ProvisionedProcess];
    expect(provisioned.args).toEqual(["wrapped.js"]);
  });

  it("defaults to native provisioner when runtime is unset", async () => {
    const native = recordingProvisioner({});
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      provisioners: { native },
      transportFactory: () => makeTransport(),
    });
    // Cast to bypass typecheck for legacy rows pre-migration.
    const cfg = makeConfig() as MCPServerConfig & { runtime: undefined };
    delete (cfg as Partial<MCPServerConfig>).runtime;
    await mgr.start(cfg as MCPServerConfig);
    expect(native.calls.length).toBe(1);
  });

  it("transitions to error when the provisioner throws", async () => {
    const failing = recordingProvisioner({ failProvision: true });
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      provisioners: { native: failing },
      transportFactory: () => makeTransport(),
      maxRestarts: 0,
    });
    const state = await mgr.start(makeConfig());
    expect(state.status).toBe("error");
    expect(state.lastError).toMatch(/provision failed/);
  });

  it("transitions to error when the runtime has no provisioner registered", async () => {
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      provisioners: { native: recordingProvisioner({}) },
      transportFactory: () => makeTransport(),
      maxRestarts: 0,
    });
    const state = await mgr.start(makeConfig({ runtime: "k8s-sse" }));
    expect(state.status).toBe("error");
    expect(state.lastError).toMatch(/unsupported MCP runtime: k8s-sse/);
  });

  it("invokes the cleanup hook on stop()", async () => {
    const cleanup = vi.fn(async () => undefined);
    const provisioner = recordingProvisioner({ cleanup });
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      provisioners: { native: provisioner },
      transportFactory: () => makeTransport(),
    });
    await mgr.start(makeConfig());
    await mgr.stop("srv1");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("invokes the cleanup hook even when handshake fails", async () => {
    const cleanup = vi.fn(async () => undefined);
    const provisioner = recordingProvisioner({ cleanup });
    const failingTransport = makeTransport();
    failingTransport.request = vi.fn(async () => {
      throw new Error("handshake boom");
    });
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      provisioners: { native: provisioner },
      transportFactory: () => failingTransport,
      maxRestarts: 0,
    });
    const state = await mgr.start(makeConfig());
    expect(state.status).toBe("error");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("swallows cleanup hook errors so stop() always settles", async () => {
    const cleanup = vi.fn(async () => {
      throw new Error("daemon down");
    });
    const provisioner = recordingProvisioner({ cleanup });
    const mgr = new MCPLifecycleManager({
      resolveEnv: async (e) => e,
      provisioners: { native: provisioner },
      transportFactory: () => makeTransport(),
    });
    await mgr.start(makeConfig());
    await expect(mgr.stop("srv1")).resolves.toBeUndefined();
  });
});
