/**
 * MCP client — handshake against a fake transport.
 */
import { describe, expect, it, vi } from "vitest";
import { MCPClient } from "../src/lib/mcp/client.js";
import type { MCPTransportClient } from "../src/lib/mcp/types.js";

function fakeTransport(canned: Record<string, unknown>): MCPTransportClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    closed: vi.fn(async () => ({ code: 0, reason: "ok" })),
    request: vi.fn(async (method: string) => {
      if (method in canned) return canned[method];
      throw new Error(`no canned response for ${method}`);
    }),
  };
}

describe("MCPClient", () => {
  it("performs initialize -> initialized -> tools/list", async () => {
    const transport = fakeTransport({
      initialize: { protocolVersion: "2025-06-18", serverInfo: { name: "demo", version: "1" } },
      "tools/list": {
        tools: [
          { name: "read_file", description: "read", annotations: { destructiveHint: false } },
          { name: "rm", description: "destroy", annotations: { destructiveHint: true } },
          { name: "ls" },
        ],
      },
    });
    const c = new MCPClient(transport, "low");
    const hs = await c.handshake();
    expect(hs.serverName).toBe("demo");
    expect(hs.tools).toHaveLength(3);
    expect(hs.tools.find((t) => t.name === "rm")?.risk).toBe("high");
    expect(hs.tools.find((t) => t.name === "read_file")?.risk).toBe("low");
    expect(hs.tools.find((t) => t.name === "ls")?.risk).toBe("low");
    expect(transport.notify).toHaveBeenCalledWith("notifications/initialized");
  });

  it("survives tools/list failure with empty list", async () => {
    const t: MCPTransportClient = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      closed: vi.fn(async () => ({ code: 0, reason: "ok" })),
      request: vi.fn(async (method: string) => {
        if (method === "initialize") return { protocolVersion: "2025-06-18" };
        throw new Error("nope");
      }),
    };
    const c = new MCPClient(t);
    const hs = await c.handshake();
    expect(hs.tools).toEqual([]);
  });

  it("callTool returns isError flag", async () => {
    const t = fakeTransport({
      "tools/call": { content: [{ type: "text", text: "hi" }], isError: true },
    });
    const c = new MCPClient(t);
    const r = await c.callTool("noop", {});
    expect(r.isError).toBe(true);
    expect(r.content).toBeTruthy();
  });

  it("ping calls tools/list with timeout", async () => {
    const t = fakeTransport({ "tools/list": { tools: [] } });
    const c = new MCPClient(t);
    await c.ping();
    expect(t.request).toHaveBeenCalledWith("tools/list", undefined, 5000);
  });

  it("close delegates to transport.stop", async () => {
    const t = fakeTransport({});
    const c = new MCPClient(t);
    await c.close("done");
    expect(t.stop).toHaveBeenCalledWith("done");
  });
});
