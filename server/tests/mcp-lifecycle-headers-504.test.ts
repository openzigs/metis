/**
 * #504 — MCP header values holding `${vault:x}` references are expanded at
 * connect time through the server's #480 bindings, exactly like env values.
 * Before, they were bound on save but sent to the endpoint literally.
 */
import { describe, expect, it, vi } from "vitest";
import { MCPLifecycleManager } from "../src/lib/mcp/lifecycle-manager.js";
import { expandVaultRefs } from "../src/lib/vault/env-manager.js";
import type { MCPServerConfig, MCPTransportClient } from "../src/lib/mcp/types.js";
import type { VaultService } from "../src/lib/vault/vault-service.js";

const secrets = new Map([["sec-hdr", "hdr-token"]]);
const vault = {
  read: vi.fn(async (id: string) => {
    const plaintext = secrets.get(id);
    if (!plaintext) throw new Error(`Secret ${id} not found`);
    return { plaintext };
  }),
  // A label lookup would find this; a bound read must never consult it.
  list: vi.fn(async () => [{ id: "sec-squat", label: "tok", scope: "global" }]),
} as unknown as VaultService;

function makeConfig(over: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "srv-504",
    scope: "global",
    projectId: null,
    label: "hdr",
    transport: "http",
    runtime: "native",
    command: null,
    args: [],
    url: "https://mcp.example.test",
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
    request: vi.fn(async (method: string) =>
      method === "initialize"
        ? { protocolVersion: "2025-06-18", serverInfo: { name: "x" } }
        : { tools: [] },
    ),
  };
}

function manager() {
  const factory = vi.fn((_config: MCPServerConfig) => makeTransport());
  const resolveEnv = vi.fn(
    (env: Record<string, string>, b?: Record<string, string> | null, kind?: "env" | "header") =>
      expandVaultRefs(env, vault, b, kind),
  );
  const mgr = new MCPLifecycleManager({
    resolveEnv,
    provisioners: {
      native: { provision: async (_c, env) => ({ command: "", args: [], env }) },
    },
    transportFactory: (config) => factory(config),
    maxRestarts: 0,
  });
  return { mgr, factory, resolveEnv };
}

describe("MCP header vault references (#504)", () => {
  it("hands the transport expanded headers, read by bound id, and keeps the refs on the config", async () => {
    const { mgr, factory } = manager();
    const headers = { Authorization: "Bearer ${vault:tok}", "X-Plain": "p" };
    const config = makeConfig({ headers, secretBindings: { tok: "sec-hdr" } });

    const state = await mgr.start(config);

    expect(state.status).toBe("ready");
    expect(factory.mock.calls[0][0].headers).toEqual({
      Authorization: "Bearer hdr-token",
      "X-Plain": "p",
    });
    expect(config.headers).toEqual(headers);
    expect(vault.list).not.toHaveBeenCalled();
  });

  it("refuses to connect when the bound header secret is gone", async () => {
    const { mgr, factory } = manager();
    const state = await mgr.start(
      makeConfig({
        id: "srv-504-stale",
        headers: { Authorization: "Bearer ${vault:tok}" },
        secretBindings: { tok: "sec-deleted" },
      }),
    );

    expect(state.status).toBe("error");
    expect(state.lastError).toMatch(/has been deleted/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("names a header, not an env var, when a header reference fails", async () => {
    const { mgr } = manager();
    const state = await mgr.start(
      makeConfig({
        id: "srv-504-hdr-msg",
        env: { TOKEN: "${vault:tok}" },
        headers: { Authorization: "Bearer ${vault:gone}" },
        secretBindings: { tok: "sec-hdr" },
      }),
    );

    expect(state.lastError).toMatch(/^header resolution failed: .*\(header Authorization\)/);
    expect(state.lastError).not.toMatch(/env/);
  });

  it("still names the env var when an env reference fails", async () => {
    const { mgr } = manager();
    const state = await mgr.start(
      makeConfig({
        id: "srv-504-env-msg",
        env: { TOKEN: "${vault:gone}" },
        headers: { Authorization: "Bearer ${vault:tok}" },
        secretBindings: { tok: "sec-hdr" },
      }),
    );

    expect(state.lastError).toMatch(/^env resolution failed: .*\(env TOKEN\)/);
  });

  it("does not run header values without references through the resolver", async () => {
    const { mgr, factory, resolveEnv } = manager();
    await mgr.start(makeConfig({ id: "srv-504-plain", headers: { "X-Plain": "p" } }));

    expect(resolveEnv).toHaveBeenCalledTimes(1); // the env only
    expect(factory.mock.calls[0][0].headers).toEqual({ "X-Plain": "p" });
  });
});
