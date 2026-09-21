/**
 * Deep health check — exercises the MCP branch added in Phase 6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn(async () => ({ id: "user_admin" })) },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { setMCPRegistry } from "../src/lib/mcp/mcp-service.js";
import type { MCPRegistryService, MCPServerView } from "../src/lib/mcp/mcp-service.js";

let app: ReturnType<typeof createApp>;

function fakeRegistry(items: MCPServerView[]): MCPRegistryService {
  return { list: vi.fn(async () => items) } as unknown as MCPRegistryService;
}

function view(over: Partial<MCPServerView> = {}): MCPServerView {
  return {
    id: "mcp_x",
    scope: "global",
    projectId: null,
    label: "x",
    transport: "stdio",
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
    status: "ready",
    lastHealthCheckAt: null,
    latencyMs: 1,
    failureCount: 0,
    lastError: null,
    healthCheckIntervalSec: 60,
    enabled: true,
    capabilities: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  app = createApp();
  delete process.env.MCP_HEALTH_ALLOW_PARTIAL;
});

afterEach(() => {
  setMCPRegistry(null);
  delete process.env.MCP_HEALTH_ALLOW_PARTIAL;
});

describe("/readyz MCP branch", () => {
  it("ok when no servers are configured", async () => {
    setMCPRegistry(fakeRegistry([]));
    const res = await request(app).get("/readyz");
    expect(res.body.checks.mcp.status).toBe("ok");
    expect(res.body.checks.mcp.message).toMatch(/no servers/);
  });

  it("ok with all-ready servers", async () => {
    setMCPRegistry(fakeRegistry([view({ status: "ready" })]));
    const res = await request(app).get("/readyz");
    expect(res.body.checks.mcp.status).toBe("ok");
  });

  it("error when an enabled server is in error", async () => {
    setMCPRegistry(fakeRegistry([view({ status: "error" })]));
    const res = await request(app).get("/readyz");
    expect(res.body.checks.mcp.status).toBe("error");
    expect(res.status).toBe(503);
  });

  it("degraded when MCP_HEALTH_ALLOW_PARTIAL=1 and at least one ready", async () => {
    process.env.MCP_HEALTH_ALLOW_PARTIAL = "1";
    setMCPRegistry(fakeRegistry([view({ status: "ready" }), view({ id: "y", status: "error" })]));
    const res = await request(app).get("/readyz");
    expect(res.body.checks.mcp.status).toBe("degraded");
  });

  it("degraded when registry throws", async () => {
    setMCPRegistry({
      list: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as MCPRegistryService);
    const res = await request(app).get("/readyz");
    expect(res.body.checks.mcp.status).toBe("degraded");
  });
});
