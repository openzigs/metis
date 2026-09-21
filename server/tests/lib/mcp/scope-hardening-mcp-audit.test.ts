/**
 * Issue #278 — auditMcpEvent payload shape and redaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded: Array<Record<string, unknown>> = [];

vi.mock("../../../src/lib/audit/audit-service.js", () => ({
  audit: (input: Record<string, unknown>) => {
    recorded.push(input);
  },
}));

import { auditMcpEvent } from "../../../src/lib/audit/mcp-audit.js";

beforeEach(() => {
  recorded.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("auditMcpEvent", () => {
  const baseCtx = {
    mcpId: "mcp_1",
    name: "demo",
    scope: "global",
    runtime: "docker-stdio",
    image: "ghcr.io/x/y:1",
    transport: "stdio",
    actor: { type: "user" as const, id: "user-1" },
    command: "docker",
    argsCount: 3,
    envKeys: ["TOKEN", "ENDPOINT"],
  };

  it("emits mcp.registered with shape-stable metadata", () => {
    auditMcpEvent("mcp.registered", baseCtx);
    expect(recorded).toHaveLength(1);
    const row = recorded[0];
    expect(row.action).toBe("mcp.registered");
    expect((row.target as { id: string }).id).toBe("mcp_1");
    expect(row.actor).toBe("user-1");
    const md = row.metadata as Record<string, unknown>;
    expect(md.name).toBe("demo");
    expect(md.scope).toBe("global");
    expect(md.runtime).toBe("docker-stdio");
    expect(md.image).toBe("ghcr.io/x/y:1");
    expect(md.transport).toBe("stdio");
    expect(md.command).toBe("docker");
    expect(md.argsCount).toBe(3);
    expect(md.envKeys).toEqual(["TOKEN", "ENDPOINT"]);
  });

  it("never includes env values, only env keys", () => {
    auditMcpEvent("mcp.registered", { ...baseCtx, envKeys: ["SECRET_TOKEN"] });
    const md = recorded[0].metadata as Record<string, unknown>;
    expect(md.envKeys).toEqual(["SECRET_TOKEN"]);
    // The serialised metadata should not contain any secret-looking value.
    expect(JSON.stringify(md)).not.toMatch(/eyJ|Bearer\s/);
    expect(JSON.stringify(md)).not.toContain("plaintext-secret-value");
  });

  it("emits mcp.updated with the same shape", () => {
    auditMcpEvent("mcp.updated", { ...baseCtx, extra: { changed: ["label"] } });
    expect(recorded[0].action).toBe("mcp.updated");
    const md = recorded[0].metadata as Record<string, unknown>;
    expect(md.changed).toEqual(["label"]);
  });

  it("emits mcp.started without start_failed-only fields", () => {
    auditMcpEvent("mcp.started", baseCtx);
    expect(recorded[0].action).toBe("mcp.started");
    const md = recorded[0].metadata as Record<string, unknown>;
    expect(md).not.toHaveProperty("errorMessage");
    expect(md).not.toHaveProperty("exitCode");
  });

  it("emits mcp.stopped", () => {
    auditMcpEvent("mcp.stopped", { ...baseCtx, extra: { reason: "manual" } });
    expect(recorded[0].action).toBe("mcp.stopped");
    expect((recorded[0].metadata as Record<string, unknown>).reason).toBe("manual");
  });

  it("emits mcp.start_failed with errorMessage and exitCode", () => {
    auditMcpEvent("mcp.start_failed", {
      ...baseCtx,
      errorMessage: "spawn failed",
      exitCode: 137,
    });
    const md = recorded[0].metadata as Record<string, unknown>;
    expect(md.errorMessage).toBe("spawn failed");
    expect(md.exitCode).toBe(137);
  });

  it("falls back to nulls when optional fields are missing", () => {
    auditMcpEvent("mcp.registered", {
      mcpId: "mcp_2",
      name: "minimal",
      scope: "global",
      actor: { type: "system", id: null },
    });
    const md = recorded[0].metadata as Record<string, unknown>;
    expect(md.runtime).toBeNull();
    expect(md.image).toBeNull();
    expect(md.transport).toBeNull();
    expect(md.command).toBeNull();
    expect(md.argsCount).toBe(0);
    expect(md.envKeys).toEqual([]);
    expect(recorded[0].actor).toBeNull();
  });

  it("preserves caller-supplied extra metadata without overwriting reserved keys", () => {
    auditMcpEvent("mcp.registered", {
      ...baseCtx,
      extra: { source: { kind: "catalog", catalogId: "x" }, name: "should-not-overwrite" },
    });
    const md = recorded[0].metadata as Record<string, unknown>;
    expect((md.source as Record<string, unknown>).kind).toBe("catalog");
    expect(md.name).toBe("demo"); // reserved keys win
  });
});
