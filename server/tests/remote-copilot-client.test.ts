/**
 * Tests for {@link RemoteCopilotClient} — the HTTP shim to `copilot-svc` (#180).
 *
 * Uses a tiny `node:http` probe to act as the sidecar so we exercise the
 * real undici send path without spinning up the actual container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

const ORIGINAL_TOKEN = process.env.COPILOT_NATIVE_TOKEN;
const ORIGINAL_URL = process.env.COPILOT_NATIVE_BASE_URL;
const ORIGINAL_MODE = process.env.COPILOT_NATIVE_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_OFFLINE = process.env.AI_OFFLINE;

interface Probe {
  server: Server;
  url: string;
  calls: Array<{ method: string; path: string; auth?: string; body: string }>;
  close(): Promise<void>;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { method: string; path: string; body: string },
) => void | Promise<void>;

async function startProbe(handler: Handler): Promise<Probe> {
  const calls: Probe["calls"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const ctx = { method: req.method ?? "", path: req.url ?? "", body };
      calls.push({ ...ctx, auth: req.headers.authorization });
      void handler(req, res, ctx);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

beforeEach(() => {
  process.env.COPILOT_NATIVE_TOKEN = "tok";
  delete process.env.AI_OFFLINE;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.COPILOT_NATIVE_TOKEN;
  else process.env.COPILOT_NATIVE_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_URL === undefined) delete process.env.COPILOT_NATIVE_BASE_URL;
  else process.env.COPILOT_NATIVE_BASE_URL = ORIGINAL_URL;
  if (ORIGINAL_MODE === undefined) delete process.env.COPILOT_NATIVE_MODE;
  else process.env.COPILOT_NATIVE_MODE = ORIGINAL_MODE;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_VITEST === undefined) delete process.env.VITEST;
  else process.env.VITEST = ORIGINAL_VITEST;
  if (ORIGINAL_OFFLINE === undefined) delete process.env.AI_OFFLINE;
  else process.env.AI_OFFLINE = ORIGINAL_OFFLINE;
});

describe("RemoteCopilotClient — construction", () => {
  it("throws when COPILOT_NATIVE_TOKEN is missing", async () => {
    delete process.env.COPILOT_NATIVE_TOKEN;
    const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
    expect(() => new RemoteCopilotClient()).toThrow(/COPILOT_NATIVE_TOKEN is required/);
  });

  it("strips trailing slashes from baseUrl", async () => {
    const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
    const client = new RemoteCopilotClient({ baseUrl: "http://copilot:5060///" });
    expect(client.url).toBe("http://copilot:5060");
  });

  it("accepts explicit constructor options over env", async () => {
    process.env.COPILOT_NATIVE_BASE_URL = "http://from-env:5060";
    const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
    const c = new RemoteCopilotClient({ baseUrl: "http://explicit:9999", token: "x" });
    expect(c.url).toBe("http://explicit:9999");
  });

  it("honours COPILOT_NATIVE_SEND_TIMEOUT_MS env var", async () => {
    process.env.COPILOT_NATIVE_SEND_TIMEOUT_MS = "12345";
    const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
    const c = new RemoteCopilotClient();
    expect(c.sendTimeout).toBe(12345);
    delete process.env.COPILOT_NATIVE_SEND_TIMEOUT_MS;
  });
});

describe("RemoteCopilotClient — JSON endpoints", () => {
  it("forwards bearer token and JSON body for POST", async () => {
    // Rides on POST /sessions. It used to ride on POST /auth/device/start, removed in
    // #1348 — the subject here is the transport (bearer header + JSON body), never
    // device auth, so it moved to a route that still exists rather than being deleted.
    const probe = await startProbe((req, res, { method, path }) => {
      if (path === "/sessions" && method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "s-1" }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const out = await c.createSession({ sessionId: "s-1", model: "gpt-4.1" });
      expect(out.sessionId).toBe("s-1");
      expect(probe.calls[0]?.auth).toBe("Bearer tok");
      expect(probe.calls[0]?.body).toContain("gpt-4.1");
    } finally {
      await probe.close();
    }
  });

  it("returns models from listModels", async () => {
    const probe = await startProbe((_req, res, { path }) => {
      if (path === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ id: "gpt-4.1" }, { id: "gpt-5" }] }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const models = await c.listModels!();
      expect(models).toEqual([{ id: "gpt-4.1" }, { id: "gpt-5" }]);
    } finally {
      await probe.close();
    }
  });

  it("listModels tolerates an empty response shape", async () => {
    const probe = await startProbe((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      expect(await c.listModels!()).toEqual([]);
    } finally {
      await probe.close();
    }
  });

  it("getAuthStatus passes through {isAuthenticated, authType}", async () => {
    const probe = await startProbe((_req, res, { path }) => {
      if (path === "/auth/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ isAuthenticated: true, authType: "device" }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const status = await c.getAuthStatus!();
      expect(status).toEqual({ isAuthenticated: true, authType: "device" });
    } finally {
      await probe.close();
    }
  });

  it("throws RemoteCopilotClientError on non-2xx with status preserved", async () => {
    const probe = await startProbe((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    try {
      const { RemoteCopilotClient, RemoteCopilotClientError } =
        await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      await expect(c.getAuthStatus!()).rejects.toMatchObject({
        name: "RemoteCopilotClientError",
        status: 401,
      });
      await expect(c.getAuthStatus!()).rejects.toBeInstanceOf(RemoteCopilotClientError);
    } finally {
      await probe.close();
    }
  });

  it("start() probes /healthz and surfaces failures", async () => {
    const okProbe = await startProbe((_req, res, { path }) => {
      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", tokenConfigured: true }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      await expect(
        new RemoteCopilotClient({ baseUrl: okProbe.url }).start!(),
      ).resolves.toBeUndefined();
    } finally {
      await okProbe.close();
    }

    const failProbe = await startProbe((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "token_missing" }));
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      await expect(
        new RemoteCopilotClient({ baseUrl: failProbe.url }).start!(),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await failProbe.close();
    }
  });

  it("stop() resolves without making a network call", async () => {
    const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
    await expect(
      new RemoteCopilotClient({ baseUrl: "http://nowhere:1" }).stop!(),
    ).resolves.toBeUndefined();
  });
});

describe("RemoteCopilotClient — sessions + SSE bridging", () => {
  it("createSession returns a session that re-emits SSE events on send()", async () => {
    const probe = await startProbe((_req, res, { method, path }) => {
      if (method === "POST" && path === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "sess-1" }));
        return;
      }
      if (method === "POST" && path === "/sessions/sess-1/send") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: assistant.message\ndata: {"text":"hi"}\n\n');
        res.write("event: session.idle\ndata: {}\n\n");
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const session = await c.createSession({ model: "gpt-4.1" });
      expect(session.sessionId).toBe("sess-1");

      const seen: Array<{ event: string; payload: unknown }> = [];
      session.on("assistant.message", (p) => seen.push({ event: "assistant.message", payload: p }));
      session.on("session.idle", (p) => seen.push({ event: "session.idle", payload: p }));

      await session.send({ prompt: "hello" });
      expect(seen).toEqual([
        { event: "assistant.message", payload: { text: "hi" } },
        { event: "session.idle", payload: {} },
      ]);
    } finally {
      await probe.close();
    }
  });

  it("createSession throws when the sidecar omits sessionId", async () => {
    const probe = await startProbe((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      await expect(c.createSession({})).rejects.toMatchObject({
        name: "RemoteCopilotClientError",
      });
    } finally {
      await probe.close();
    }
  });

  it("send rejects when the sidecar returns a non-200 streaming response", async () => {
    const probe = await startProbe((_req, res, { path }) => {
      if (path === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "s2" }));
        return;
      }
      // /sessions/s2/send → 500 with JSON body, not SSE.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const s = await c.createSession({});
      await expect(s.send({ prompt: "hi" })).rejects.toMatchObject({ status: 500 });
    } finally {
      await probe.close();
    }
  });

  it("session.send re-emits an `error` event when the sidecar streams one", async () => {
    const probe = await startProbe((_req, res, { path }) => {
      if (path === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "s3" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: error\ndata: {"message":"send failed"}\n\n');
      res.end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const s = await c.createSession({});
      const errors: unknown[] = [];
      s.on("error", (p) => errors.push(p));
      await s.send({ prompt: "x" });
      expect(errors).toEqual([{ message: "send failed" }]);
    } finally {
      await probe.close();
    }
  });

  // Issue #190 — RemoteSession used to call EventEmitter.emit('error', …)
  // unconditionally. With zero listeners that throws and crashes Node. This
  // regression test asserts we now drop the frame (and log) instead.
  it("session.send drops sidecar `error` frames without listeners instead of crashing", async () => {
    const probe = await startProbe((_req, res, { path }) => {
      if (path === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "s3b" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: error\ndata: {"message":"send failed"}\n\n');
      res.end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const s = await c.createSession({});
      // No `error` listener attached on purpose. Pre-fix this would throw
      // an uncaught exception. Assert send() resolves cleanly instead.
      await expect(s.send({ prompt: "x" })).resolves.toBeUndefined();
    } finally {
      await probe.close();
    }
  });

  it("destroy() calls DELETE /sessions/:id, swallows failures, then unsubscribes listeners", async () => {
    const probe = await startProbe((_req, res, { method, path }) => {
      if (method === "POST" && path === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "s4" }));
        return;
      }
      if (method === "DELETE" && path === "/sessions/s4") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const s = await c.createSession({});
      await expect(s.destroy!()).resolves.toBeUndefined();
      // Calling send after destroy throws.
      await expect(s.send({ prompt: "x" })).rejects.toMatchObject({ status: 410 });
      // disconnect() is an alias for destroy and is idempotent.
      await expect(s.disconnect!()).resolves.toBeUndefined();
    } finally {
      await probe.close();
    }
  });

  it("sendAndWait POSTs to /sessions/:id/send-and-wait with optional timeout", async () => {
    const probe = await startProbe((_req, res, { method, path, body }) => {
      if (method === "POST" && path === "/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "s5" }));
        return;
      }
      if (method === "POST" && path === "/sessions/s5/send-and-wait") {
        const parsed = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echo: parsed }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const { RemoteCopilotClient } = await import("../src/lib/ai/remote-copilot-client.js");
      const c = new RemoteCopilotClient({ baseUrl: probe.url });
      const s = await c.createSession({});
      const out = await s.sendAndWait!({ prompt: "ping" }, 1000);
      expect(out).toEqual({ echo: { prompt: "ping", timeoutMs: 1000 } });
    } finally {
      await probe.close();
    }
  });
});

describe("resolveCopilotNativeMode", () => {
  it("returns sidecar when COPILOT_NATIVE_MODE=sidecar in non-test, non-offline env", async () => {
    process.env.COPILOT_NATIVE_MODE = "sidecar";
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.AI_OFFLINE;
    const { resolveCopilotNativeMode } = await import("../src/lib/ai/remote-copilot-client.js");
    expect(resolveCopilotNativeMode()).toBe("sidecar");
  });

  it("returns in-process when offline mode is set", async () => {
    process.env.COPILOT_NATIVE_MODE = "sidecar";
    process.env.AI_OFFLINE = "1";
    const { resolveCopilotNativeMode } = await import("../src/lib/ai/remote-copilot-client.js");
    expect(resolveCopilotNativeMode()).toBe("in-process");
  });

  it("returns in-process when running under vitest", async () => {
    process.env.COPILOT_NATIVE_MODE = "sidecar";
    process.env.VITEST = "1";
    const { resolveCopilotNativeMode } = await import("../src/lib/ai/remote-copilot-client.js");
    expect(resolveCopilotNativeMode()).toBe("in-process");
  });

  it("returns in-process when COPILOT_NATIVE_MODE is unset", async () => {
    delete process.env.COPILOT_NATIVE_MODE;
    const { resolveCopilotNativeMode } = await import("../src/lib/ai/remote-copilot-client.js");
    expect(resolveCopilotNativeMode()).toBe("in-process");
  });
});

describe("getRemoteCopilotClient singleton", () => {
  it("caches the client across calls and resets on demand", async () => {
    const { getRemoteCopilotClient, __resetRemoteCopilotClientSingleton } =
      await import("../src/lib/ai/remote-copilot-client.js");
    const a = getRemoteCopilotClient();
    const b = getRemoteCopilotClient();
    expect(a).toBe(b);
    __resetRemoteCopilotClientSingleton();
    const c = getRemoteCopilotClient();
    expect(c).not.toBe(a);
  });
});
