/**
 * Auth + contract + SSE tests for the copilot-svc sidecar HTTP surface.
 *
 * Strategy mirrors `embeddings-svc/tests/app.test.ts`: never load the real
 * `@github/copilot-sdk` — we inject a stub `CopilotClientLike` via the
 * `loadClient` dependency seam so tests stay hermetic and fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { EventEmitter } from "node:events";
import { createApp, __resetClientCache, type CopilotClientLike } from "../src/app.js";
import { SessionRegistry, type CopilotSession } from "../src/sessions.js";
import { isolateSupertestLoopback } from "../../tests/helpers/supertest-loopback.js";

const ORIGINAL_TOKEN = process.env.COPILOT_NATIVE_TOKEN;
const TOKEN = "test-secret-token-12345";
const AUTH = `Bearer ${TOKEN}`;

beforeEach(() => {
  isolateSupertestLoopback();
  process.env.COPILOT_NATIVE_TOKEN = TOKEN;
  __resetClientCache();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.COPILOT_NATIVE_TOKEN;
  else process.env.COPILOT_NATIVE_TOKEN = ORIGINAL_TOKEN;
  vi.restoreAllMocks();
  __resetClientCache();
});

/* ------------------------------------------------------------------------- */
/* Stub session — implements just enough of the SDK shape for the sidecar.   */
/* ------------------------------------------------------------------------- */

class StubSession extends EventEmitter implements CopilotSession {
  destroyed = false;
  constructor(public readonly sessionId: string) {
    super();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, handler: (payload: any) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, handler: (payload: any) => void): () => void;
  // The CopilotSession interface in the SDK returns an unsubscribe fn from
  // `on`. Match that shape exactly so the SSE wiring exercises the
  // unsubscribe path during cleanup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, handler: (payload: any) => void): unknown {
    super.on(event, handler);
    return () => super.off(event, handler);
  }
  async send(_input: { prompt: string }): Promise<unknown> {
    // Emit a delta then idle synchronously so the SSE response captures
    // the events before `send` resolves — matches the real SDK ordering
    // where events fan out during streaming.
    this.emit("assistant.message_delta", { text: "hello" });
    this.emit("session.idle", { reason: "completed" });
    return null;
  }
  async sendAndWait(_input: { prompt: string }, _timeoutMs?: number): Promise<unknown> {
    return { content: "ok" };
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

function buildClient(overrides: Partial<CopilotClientLike> = {}): CopilotClientLike {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true, authType: "device" }),
    listModels: vi.fn().mockResolvedValue([{ id: "gpt-4.1" }, { id: "claude-sonnet-4" }]),
    createSession: vi.fn().mockImplementation(async (cfg: { sessionId: string }) => {
      return new StubSession(cfg.sessionId);
    }),
    ...overrides,
  };
}

describe("copilot-svc HTTP surface — health + auth", () => {
  it("exposes /healthz without auth", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("metis-copilot");
    expect(res.body.tokenConfigured).toBe(true);
    expect(res.body.activeSessions).toBe(0);
  });

  it("rejects authenticated routes without a bearer token", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).get("/auth/status");
    expect(res.status).toBe(401);
  });

  it("rejects authenticated routes with the wrong bearer token", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).get("/auth/status").set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("fails closed (503) when COPILOT_NATIVE_TOKEN is unset", async () => {
    delete process.env.COPILOT_NATIVE_TOKEN;
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).get("/auth/status").set("Authorization", "Bearer anything");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("service_unavailable");
  });

  it("returns 404 for unknown routes", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).get("/no/such/route");
    expect(res.status).toBe(404);
  });
});

describe("copilot-svc HTTP surface — auth flow", () => {
  it("surfaces /auth/status from the SDK", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).get("/auth/status").set("Authorization", AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isAuthenticated: true, authType: "device" });
  });

  it("surfaces /models from the SDK", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).get("/models").set("Authorization", AUTH);
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([{ id: "gpt-4.1" }, { id: "claude-sonnet-4" }]);
  });

  it("translates SDK throws into HTTP 500", async () => {
    const app = createApp({
      loadClient: async () =>
        buildClient({ getAuthStatus: vi.fn().mockRejectedValue(new Error("boom")) }),
    });
    const res = await request(app).get("/auth/status").set("Authorization", AUTH);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("auth_status_failed");
  });
});

describe("copilot-svc device-auth routes are REMOVED (#1348)", () => {
  // `POST /auth/device/start` and `/auth/device/wait` existed from the first sidecar
  // commit and could only ever return 501: `CopilotClient` has never shipped
  // `startDeviceAuth` or `waitForAuth` — measured on 0.2.2 AND 0.3.0. They are gone.
  //
  // This asserts 404, not 501. 501 was the OLD behaviour and a route restored by a
  // careless revert would answer 501 again, so asserting 501 would pass on exactly the
  // regression this guards. A removed route answers 404.
  it.each(["/auth/device/start", "/auth/device/wait"])("404s on %s", async (route) => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).post(route).set("Authorization", AUTH).send({});
    expect(res.status, `${route} answered ${res.status}; 501 means the route is back`).toBe(404);
  });
});

describe("copilot-svc HTTP surface — sessions", () => {
  it("rejects /sessions when permissionMode=interactive (v1 limitation)", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app)
      .post("/sessions")
      .set("Authorization", AUTH)
      .send({ sessionId: "sess-1", permissionMode: "interactive" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("interactive_permission_not_supported");
  });

  it("creates a session and tracks it in the registry", async () => {
    const registry = new SessionRegistry(60_000);
    const create = vi.fn().mockImplementation(async (cfg: { sessionId: string }) => {
      return new StubSession(cfg.sessionId);
    });
    const app = createApp({
      loadClient: async () => buildClient({ createSession: create }),
      registry,
    });
    const res = await request(app)
      .post("/sessions")
      .set("Authorization", AUTH)
      .send({ sessionId: "sess-1", model: "gpt-4.1", permissionMode: "auto-approve" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "sess-1" });
    expect(registry.size()).toBe(1);
    // Auto-approve injected an onPermissionRequest function.
    const cfg = create.mock.calls[0]![0] as { onPermissionRequest?: () => Promise<unknown> };
    expect(typeof cfg.onPermissionRequest).toBe("function");
    await expect(cfg.onPermissionRequest!()).resolves.toEqual({ approved: true });
  });

  it("deny-mode sessions reject every permission request", async () => {
    const create = vi.fn().mockImplementation(async (cfg: { sessionId: string }) => {
      return new StubSession(cfg.sessionId);
    });
    const app = createApp({
      loadClient: async () => buildClient({ createSession: create }),
    });
    await request(app)
      .post("/sessions")
      .set("Authorization", AUTH)
      .send({ sessionId: "sess-deny", permissionMode: "deny" });
    const cfg = create.mock.calls[0]![0] as { onPermissionRequest?: () => Promise<unknown> };
    expect(typeof cfg.onPermissionRequest).toBe("function");
    await expect(cfg.onPermissionRequest!()).resolves.toEqual({ approved: false });
  });

  it("validates /sessions request body", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app)
      .post("/sessions")
      .set("Authorization", AUTH)
      .send({ model: "gpt-4.1" }); // missing sessionId
    expect(res.status).toBe(400);
  });

  it("returns 404 for /sessions/:id/send-and-wait when the session does not exist", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app)
      .post("/sessions/missing/send-and-wait")
      .set("Authorization", AUTH)
      .send({ prompt: "hi" });
    expect(res.status).toBe(404);
  });

  it("forwards send-and-wait to the live session", async () => {
    const registry = new SessionRegistry(60_000);
    const session = new StubSession("sess-2");
    registry.set(session);
    const app = createApp({ loadClient: async () => buildClient(), registry });
    const res = await request(app)
      .post("/sessions/sess-2/send-and-wait")
      .set("Authorization", AUTH)
      .send({ prompt: "ping" });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ content: "ok" });
  });

  it("DELETE /sessions/:id destroys the session and returns 204", async () => {
    const registry = new SessionRegistry(60_000);
    const session = new StubSession("sess-3");
    registry.set(session);
    const app = createApp({ loadClient: async () => buildClient(), registry });
    const res = await request(app).delete("/sessions/sess-3").set("Authorization", AUTH);
    expect(res.status).toBe(204);
    expect(session.destroyed).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("DELETE /sessions/:id returns 404 when the session is unknown", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app).delete("/sessions/missing").set("Authorization", AUTH);
    expect(res.status).toBe(404);
  });

  it("streams /sessions/:id/send via SSE and terminates on session.idle", async () => {
    const registry = new SessionRegistry(60_000);
    const session = new StubSession("sess-sse");
    registry.set(session);
    const app = createApp({ loadClient: async () => buildClient(), registry });

    const res = await request(app)
      .post("/sessions/sess-sse/send")
      .set("Authorization", AUTH)
      .set("accept", "text/event-stream")
      .send({ prompt: "stream me" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain("event: assistant.message_delta");
    expect(res.text).toContain('"text":"hello"');
    expect(res.text).toContain("event: session.idle");
  });

  it("send-stream returns 404 for missing sessions", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app)
      .post("/sessions/missing/send")
      .set("Authorization", AUTH)
      .send({ prompt: "x" });
    expect(res.status).toBe(404);
  });

  it("send-stream rejects an empty prompt", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app)
      .post("/sessions/x/send")
      .set("Authorization", AUTH)
      .send({ prompt: "" });
    expect(res.status).toBe(400);
  });
});

describe("copilot-svc HTTP surface — error + capability paths", () => {
  it("returns 501 when the SDK lacks getAuthStatus", async () => {
    const app = createApp({
      loadClient: async () => buildClient({ getAuthStatus: undefined }),
    });
    const res = await request(app).get("/auth/status").set("Authorization", AUTH);
    expect(res.status).toBe(501);
  });

  it("returns 501 when the SDK lacks listModels", async () => {
    const app = createApp({
      loadClient: async () => buildClient({ listModels: undefined }),
    });
    const res = await request(app).get("/models").set("Authorization", AUTH);
    expect(res.status).toBe(501);
  });

  it("translates listModels throws into HTTP 500", async () => {
    const app = createApp({
      loadClient: async () =>
        buildClient({ listModels: vi.fn().mockRejectedValue(new Error("x")) }),
    });
    const res = await request(app).get("/models").set("Authorization", AUTH);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("list_models_failed");
  });

  it("translates createSession throws into HTTP 500", async () => {
    const app = createApp({
      loadClient: async () =>
        buildClient({ createSession: vi.fn().mockRejectedValue(new Error("denied")) }),
    });
    const res = await request(app)
      .post("/sessions")
      .set("Authorization", AUTH)
      .send({ sessionId: "x" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("create_session_failed");
  });

  it("validates send-and-wait body shape", async () => {
    const app = createApp({ loadClient: async () => buildClient() });
    const res = await request(app)
      .post("/sessions/x/send-and-wait")
      .set("Authorization", AUTH)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 501 when the session lacks sendAndWait", async () => {
    const registry = new SessionRegistry(60_000);
    const sess: CopilotSession = { sessionId: "s" };
    registry.set(sess);
    const app = createApp({ loadClient: async () => buildClient(), registry });
    const res = await request(app)
      .post("/sessions/s/send-and-wait")
      .set("Authorization", AUTH)
      .send({ prompt: "x" });
    expect(res.status).toBe(501);
  });

  it("translates sendAndWait throws into HTTP 500", async () => {
    const registry = new SessionRegistry(60_000);
    const sess: CopilotSession = {
      sessionId: "s",
      async sendAndWait() {
        throw new Error("crash");
      },
    };
    registry.set(sess);
    const app = createApp({ loadClient: async () => buildClient(), registry });
    const res = await request(app)
      .post("/sessions/s/send-and-wait")
      .set("Authorization", AUTH)
      .send({ prompt: "x" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("send_and_wait_failed");
  });

  it("returns 501 when the session lacks send", async () => {
    const registry = new SessionRegistry(60_000);
    const sess: CopilotSession = { sessionId: "s" };
    registry.set(sess);
    const app = createApp({ loadClient: async () => buildClient(), registry });
    const res = await request(app)
      .post("/sessions/s/send")
      .set("Authorization", AUTH)
      .send({ prompt: "hello" });
    expect(res.status).toBe(501);
  });

  it("send stream forwards an error event when session.send rejects", async () => {
    // Drives the route's catch path: the SDK throws mid-send, we re-emit
    // an `error` event and close the SSE stream. We use a real
    // http.Server because supertest's in-memory transport hangs on
    // chunked responses that terminate via res.end() after a write —
    // the issue does not reproduce against a real socket.
    const http = await import("node:http");
    const registry = new SessionRegistry(60_000);
    const sess: CopilotSession = {
      sessionId: "err-sse",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: (_event: string, _handler: (payload: any) => void) => () => {},
      send: async () => {
        await Promise.resolve();
        throw new Error("send failed");
      },
    };
    registry.set(sess);
    const app = createApp({ loadClient: async () => buildClient(), registry });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const { request: undiciRequest } = await import("undici");
      const res = await undiciRequest(`http://127.0.0.1:${port}/sessions/err-sse/send`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({ prompt: "x" }),
        bodyTimeout: 5_000,
        headersTimeout: 5_000,
      });
      const text = await res.body.text();
      expect(res.statusCode).toBe(200);
      expect(text).toContain("event: error");
      expect(text).toContain("send failed");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 8_000);

  it("send stream emits session.complete fallback when no idle event fires", async () => {
    const registry = new SessionRegistry(60_000);
    const sess: CopilotSession = {
      sessionId: "quiet",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: (_event: string, _handler: (payload: any) => void) => {
        return () => {};
      },
      async send() {
        return null;
      },
    };
    registry.set(sess);
    const app = createApp({ loadClient: async () => buildClient(), registry });
    const res = await request(app)
      .post("/sessions/quiet/send")
      .set("Authorization", AUTH)
      .send({ prompt: "x" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("event: session.complete");
    expect(res.text).toContain("send_resolved");
  });
});
