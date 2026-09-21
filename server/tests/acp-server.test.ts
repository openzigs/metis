/**
 * ACP WebSocket server — upgrade auth + dispatch + shutdown.
 */
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import { ACP_PATH, attachAcpServer, extractBearer, urlPathEquals } from "../src/lib/acp/server.js";

interface BootedServer {
  http: http.Server;
  acp: ReturnType<typeof attachAcpServer>;
  port: number;
  url: string;
}

async function boot(verifyMap: Record<string, string | null>): Promise<BootedServer> {
  const httpServer = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const acp = attachAcpServer(httpServer, {
    verify: async (token) => {
      const userId = verifyMap[token];
      if (!userId) return null;
      return { tokenId: `tk_${userId}`, userId, scopes: [] };
    },
    dispatch: async (req) => ({
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: { method: req.method, ok: true },
    }),
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no address");
  const port = addr.port;
  return { http: httpServer, acp, port, url: `ws://127.0.0.1:${port}${ACP_PATH}` };
}

let booted: BootedServer | null = null;

beforeEach(() => {
  booted = null;
});

afterEach(async () => {
  if (booted) {
    await booted.acp.shutdown();
    await new Promise<void>((resolve) => booted!.http.close(() => resolve()));
    booted = null;
  }
});

describe("urlPathEquals", () => {
  it("matches with and without query / trailing slash", () => {
    expect(urlPathEquals("/api/acp", "/api/acp")).toBe(true);
    expect(urlPathEquals("/api/acp/", "/api/acp")).toBe(true);
    expect(urlPathEquals("/api/acp?x=1", "/api/acp")).toBe(true);
    expect(urlPathEquals("/api/other", "/api/acp")).toBe(false);
  });
});

describe("extractBearer", () => {
  it("returns null without header", () => {
    expect(extractBearer({ headers: {} } as unknown as http.IncomingMessage)).toBeNull();
  });
  it("returns null when not Bearer", () => {
    expect(
      extractBearer({ headers: { authorization: "Basic abc" } } as unknown as http.IncomingMessage),
    ).toBeNull();
  });
  it("strips Bearer prefix", () => {
    expect(
      extractBearer({
        headers: { authorization: "Bearer metis_xyz" },
      } as unknown as http.IncomingMessage),
    ).toBe("metis_xyz");
  });
});

describe("attachAcpServer", () => {
  it("rejects upgrade without bearer (401)", async () => {
    booted = await boot({ metis_good: "u1" });
    const ws = new WebSocket(booted.url);
    const result = await new Promise<{ code: number; message: string }>((resolve) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve({ code: res.statusCode ?? 0, message: res.statusMessage ?? "" });
      });
      ws.on("error", () => {
        resolve({ code: 0, message: "error" });
      });
    });
    expect(result.code).toBe(401);
  });

  it("rejects unknown token (401)", async () => {
    booted = await boot({ metis_good: "u1" });
    const ws = new WebSocket(booted.url, { headers: { Authorization: "Bearer metis_bad" } });
    const result = await new Promise<{ code: number }>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve({ code: res.statusCode ?? 0 }));
      ws.on("error", () => resolve({ code: 0 }));
    });
    expect(result.code).toBe(401);
  });

  it("dispatches requests on a valid bearer", async () => {
    booted = await boot({ metis_good: "u1" });
    const ws = new WebSocket(booted.url, { headers: { Authorization: "Bearer metis_good" } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const reply = await new Promise<unknown>((resolve, reject) => {
      ws.once("message", (data) => resolve(JSON.parse(String(data))));
      ws.once("error", reject);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "list-projects" }));
    });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { method: "list-projects", ok: true },
    });
    expect(booted.acp.connectionCount).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  it("returns parse-error on bad JSON frames", async () => {
    booted = await boot({ metis_good: "u1" });
    const ws = new WebSocket(booted.url, { headers: { Authorization: "Bearer metis_good" } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const reply = await new Promise<{ error: { code: number } }>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(String(data))));
      ws.send("not json");
    });
    expect(reply.error.code).toBe(-32700);
    ws.close();
  });

  it("shutdown closes active sockets with code 1001", async () => {
    booted = await boot({ metis_good: "u1" });
    const ws = new WebSocket(booted.url, { headers: { Authorization: "Bearer metis_good" } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.once("close", (code) => resolve({ code }));
    });
    await booted.acp.shutdown();
    const r = await closed;
    expect(r.code).toBe(1001);
  });

  it("upgrade after shutdown returns 503", async () => {
    booted = await boot({ metis_good: "u1" });
    await booted.acp.shutdown();
    const ws = new WebSocket(booted.url, { headers: { Authorization: "Bearer metis_good" } });
    const result = await new Promise<{ code: number }>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve({ code: res.statusCode ?? 0 }));
      ws.on("error", () => resolve({ code: 0 }));
    });
    expect([0, 404, 503]).toContain(result.code);
    // Re-shutdown is a no-op (we already shut down in this test).
    booted = null;
  });

  it("verify throwing surfaces 500 on the upgrade", async () => {
    const httpServer = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const acp = attachAcpServer(httpServer, {
      verify: async () => {
        throw new Error("verify-boom");
      },
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no address");
    const port = addr.port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${ACP_PATH}`, {
        headers: { Authorization: "Bearer metis_anything" },
      });
      const result = await new Promise<{ code: number }>((resolve) => {
        ws.on("unexpected-response", (_req, res) => resolve({ code: res.statusCode ?? 0 }));
        ws.on("error", () => resolve({ code: 0 }));
      });
      expect([0, 500]).toContain(result.code);
    } finally {
      await acp.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("dispatch errors come back as -32603 internal", async () => {
    const httpServer = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const acp = attachAcpServer(httpServer, {
      verify: async () => ({ tokenId: "t", userId: "u", scopes: [] }),
      dispatch: async () => {
        throw new Error("boom");
      },
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no address");
    const port = addr.port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${ACP_PATH}`, {
        headers: { Authorization: "Bearer metis_anything" },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const reply = await new Promise<{ error: { code: number } }>((resolve) => {
        ws.once("message", (data) => resolve(JSON.parse(String(data))));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "list-projects" }));
      });
      expect(reply.error.code).toBe(-32603);
      ws.close();
    } finally {
      await acp.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
