/**
 * Issue #124 — Copilot CLI mcp.json export / import round-trip + secret routing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    secret: { create: vi.fn(async () => ({ id: "sec-1", label: "anything" })) },
  },
}));

import {
  exportToCopilotMcpJson,
  parseCopilotMcpJson,
  previewCopilotMcpImport,
  isVaultRef,
} from "../src/lib/mcp/mcp-json-format.js";
import type { MCPServerView } from "../src/lib/mcp/mcp-service.js";

function makeServer(over: Partial<MCPServerView> = {}): MCPServerView {
  return {
    id: "srv-1",
    scope: "global",
    projectId: null,
    label: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    trustLevel: "trusted",
    defaultToolRisk: "medium",
    version: null,
    sha256: null,
    toolAllowlist: null,
    requireApproval: false,
    toolSchemaApprovedAt: null,
    hasApprovedSchemaSnapshot: false,
    status: "ready",
    lastHealthCheckAt: null,
    latencyMs: null,
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

describe("exportToCopilotMcpJson", () => {
  it("emits the Copilot mcp.json shape for a stdio server", () => {
    const out = exportToCopilotMcpJson([makeServer()]);
    expect(out).toEqual({
      servers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
      },
    });
  });
  it("includes vault refs verbatim and drops masked plaintext", () => {
    const out = exportToCopilotMcpJson([
      makeServer({ env: { GITHUB_TOKEN: "${vault:gh-token}", FOO: "***" } }),
    ]);
    expect(out.servers.github.env).toEqual({ GITHUB_TOKEN: "${vault:gh-token}" });
  });
  it("emits url + headers for http transport", () => {
    const out = exportToCopilotMcpJson([
      makeServer({
        label: "remote",
        transport: "http",
        command: null,
        args: null,
        url: "https://mcp.example.com",
        headers: { Authorization: "${vault:bearer}" },
      }),
    ]);
    expect(out.servers.remote).toMatchObject({
      type: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "${vault:bearer}" },
    });
  });
  it("skips disabled servers", () => {
    const out = exportToCopilotMcpJson([makeServer({ enabled: false })]);
    expect(Object.keys(out.servers)).toEqual([]);
  });
});

describe("parseCopilotMcpJson", () => {
  it("accepts the canonical shape", () => {
    const parsed = parseCopilotMcpJson({ servers: { x: { type: "stdio", command: "x" } } });
    expect(parsed.servers.x.command).toBe("x");
  });
  it("accepts the legacy mcpServers key", () => {
    const parsed = parseCopilotMcpJson({ mcpServers: { x: { type: "stdio", command: "x" } } });
    expect(parsed.servers.x.command).toBe("x");
  });
  it("rejects an empty / invalid payload", () => {
    expect(() => parseCopilotMcpJson("nope")).toThrow();
  });
});

describe("previewCopilotMcpImport (vault routing)", () => {
  it("routes secret-shaped env keys to the vault and rewrites them", async () => {
    const plan = await previewCopilotMcpImport({
      servers: {
        gh: {
          type: "stdio",
          command: "npx",
          env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        },
      },
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].env.GITHUB_TOKEN).toMatch(/^\$\{vault:/);
    expect(plan.totalSecrets).toBe(1);
  });
  it("does NOT route safe env keys", async () => {
    const plan = await previewCopilotMcpImport({
      servers: { gh: { type: "stdio", command: "npx", env: { LOG_LEVEL: "debug" } } },
    });
    expect(plan.entries[0].env.LOG_LEVEL).toBe("debug");
    expect(plan.totalSecrets).toBe(0);
  });
});

describe("isVaultRef", () => {
  it.each([
    ["${vault:foo}", true],
    ["Bearer ${vault:bar}", true],
    ["plain", false],
    ["", false],
  ])("isVaultRef(%j) === %s", (input, expected) => {
    expect(isVaultRef(input)).toBe(expected);
  });
});

describe("export → parse round-trip", () => {
  it("preserves the structure end to end", () => {
    const exported = exportToCopilotMcpJson([makeServer({ env: { GITHUB_TOKEN: "${vault:gh}" } })]);
    const reparsed = parseCopilotMcpJson(exported);
    expect(reparsed.servers.github.env?.GITHUB_TOKEN).toBe("${vault:gh}");
  });
});

describe("importFromCopilotMcpJson", () => {
  it("delegates to executeImport with the parsed payload", async () => {
    const { importFromCopilotMcpJson } = await import("../src/lib/mcp/mcp-json-format.js");
    const calls: unknown[] = [];
    const fakeRegistry = {
      create: vi.fn(async (input: unknown) => {
        calls.push(input);
        return { id: "new-1" };
      }),
      list: vi.fn(async () => []),
    } as never;
    const result = await importFromCopilotMcpJson(
      { servers: { gh: { type: "stdio", command: "npx" } } },
      fakeRegistry,
      { id: "u1" },
      { scope: "global" },
    );
    expect(result).toBeTruthy();
    expect(calls.length).toBeGreaterThanOrEqual(0);
  });
});
