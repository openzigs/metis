/**
 * HTTP webhook task handler — security envelope tests.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { auditLog: { create: vi.fn(async () => ({})) } },
}));
vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "ok.example.com",
    address: "203.0.113.1",
    family: 4,
  })),
  // makePinnedLookup is consumed inside makePinnedDispatcher; the tests pass
  // a stub dispatcherFactory so the lookup is never actually invoked, but
  // the import must resolve.
  makePinnedLookup: vi.fn(
    () => (_h: string, _o: unknown, cb: (e: unknown, a: string, f: number) => void) =>
      cb(null, "203.0.113.1", 4),
  ),
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({
    read: vi.fn(async (label: string) => ({ summary: { id: label }, plaintext: "secret-value" })),
  }),
}));

import {
  createHttpWebhookHandler,
  loadWebhookConfig,
} from "../src/lib/scheduler/webhook-handler.js";
import type { TaskHandlerContext, TaskRecord } from "../src/lib/scheduler/types.js";

function makeCtx(payload: Record<string, unknown>, signal?: AbortSignal): TaskHandlerContext {
  const task: TaskRecord = {
    id: "t1",
    scheduledJobId: "j1",
    projectId: null,
    type: "http-webhook",
    trigger: "scheduled",
    status: "running",
    priority: 5,
    payload,
    result: null,
    errorMessage: null,
    progress: null,
    attempts: 1,
    maxAttempts: 3,
    scheduledFor: null,
    startedAt: new Date(),
    completedAt: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    task,
    signal: signal ?? new AbortController().signal,
    reportProgress: vi.fn(),
    log: vi.fn(),
  };
}

describe("loadWebhookConfig()", () => {
  it("parses defaults and env overrides", () => {
    const cfg = loadWebhookConfig({
      WEBHOOK_ALLOWED_HOSTS: "ok.example.com,api.example.com",
      WEBHOOK_MAX_BYTES: "1024",
      WEBHOOK_TIMEOUT_MS: "500",
    });
    expect(cfg.allowedHosts).toContain("ok.example.com");
    expect(cfg.maxBytes).toBe(1024);
    expect(cfg.timeoutMs).toBe(500);
    expect(cfg.requireHttps).toBe(false);
  });

  it("requires HTTPS in production", () => {
    const cfg = loadWebhookConfig({
      NODE_ENV: "production",
      WEBHOOK_ALLOWED_HOSTS: "ok.example.com",
    });
    expect(cfg.requireHttps).toBe(true);
  });
});

describe("createHttpWebhookHandler()", () => {
  it("rejects URLs whose host is not on the allow-list", async () => {
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: vi.fn(),
    });
    await expect(handler(makeCtx({ url: "https://evil.example.com/hook" }))).rejects.toThrow(
      /not on WEBHOOK_ALLOWED_HOSTS/,
    );
  });

  it("rejects http urls in production mode", async () => {
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: true,
      },
      fetchImpl: vi.fn(),
    });
    await expect(handler(makeCtx({ url: "http://ok.example.com/hook" }))).rejects.toThrow(
      /must use https/,
    );
  });

  it("rejects payloads above the byte cap", async () => {
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 10,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: vi.fn(),
    });
    await expect(
      handler(makeCtx({ url: "https://ok.example.com", body: { x: "x".repeat(50) } })),
    ).rejects.toThrow(/exceeds cap/);
  });

  it("rejects disallowed methods", async () => {
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: vi.fn(),
    });
    await expect(
      handler(makeCtx({ url: "https://ok.example.com", method: "DELETE" })),
    ).rejects.toThrow(/not allowed/);
  });

  it("posts JSON to allow-listed hosts and returns the status", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 204,
      headers: new Headers(),
      body: { cancel: async () => undefined },
    }));
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await handler(
      makeCtx({ url: "https://ok.example.com/hook", body: { ok: true } }),
    );
    expect(result).toEqual({ status: 204, host: "ok.example.com" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const callArgs = fetchImpl.mock.calls[0];
    const init = callArgs[1] as { headers: Record<string, string> };
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("resolves a vault reference into the Authorization header without logging it", async () => {
    let observed: Record<string, string> | null = null;
    const fetchImpl = vi.fn(async (_url: unknown, init: { headers: Record<string, string> }) => {
      observed = init.headers;
      return { status: 200, headers: new Headers(), body: { cancel: async () => undefined } };
    });
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await handler(makeCtx({ url: "https://ok.example.com", authHeader: "${vault:my-secret}" }));
    expect(observed!.authorization).toBe("secret-value");
  });

  it("throws on non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 500,
      headers: new Headers(),
      body: { cancel: async () => undefined },
    }));
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(handler(makeCtx({ url: "https://ok.example.com" }))).rejects.toThrow(/non-2xx/);
  });

  it("strips an Authorization header passed via the headers map (vault is the only path)", async () => {
    let observed: Record<string, string> | null = null;
    const fetchImpl = vi.fn(async (_u: unknown, init: { headers: Record<string, string> }) => {
      observed = init.headers;
      return { status: 200, headers: new Headers(), body: { cancel: async () => undefined } };
    });
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await handler(
      makeCtx({
        url: "https://ok.example.com",
        headers: { Authorization: "Bearer leaked", "x-trace": "ok" },
      }),
    );
    expect(observed!["authorization"]).toBeUndefined();
    expect(observed!["x-trace"]).toBe("ok");
  });

  it("rejects when payload.url is missing", async () => {
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: vi.fn(),
    });
    await expect(handler(makeCtx({}))).rejects.toThrow(/url is required/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Review fix M1 — explicit SSRF + redirect security envelope tests.
// ───────────────────────────────────────────────────────────────────────

describe("createHttpWebhookHandler() — SSRF + redirect controls", () => {
  it("uses the pinned-IP dispatcher returned by dispatcherFactory (C1)", async () => {
    const tearDown = vi.fn(async () => undefined);
    const dispatcherFactory = vi.fn(async () => ({ close: tearDown }));
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      body: { cancel: async () => undefined },
    }));
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dispatcherFactory,
    });
    await handler(makeCtx({ url: "https://ok.example.com/hook" }));
    expect(dispatcherFactory).toHaveBeenCalledTimes(1);
    expect(dispatcherFactory.mock.calls[0][0]).toMatchObject({
      hostname: "ok.example.com",
      address: "203.0.113.1",
    });
    // Dispatcher torn down on exit so sockets can't leak across calls.
    expect(tearDown).toHaveBeenCalledTimes(1);
    // The fetch init must carry the dispatcher we built (undici routing).
    const init = fetchImpl.mock.calls[0][1] as { dispatcher?: unknown; redirect?: string };
    expect(init.dispatcher).toBeDefined();
    expect(init.redirect).toBe("manual");
  });

  it("re-validates the host on every redirect hop (C2)", async () => {
    const dispatcherFactory = vi.fn(async () => ({ close: async () => undefined }));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/start")) {
        return {
          status: 302,
          headers: new Headers({ location: "https://ok2.example.com/landing" }),
          body: { cancel: async () => undefined },
        };
      }
      return { status: 204, headers: new Headers(), body: { cancel: async () => undefined } };
    });
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com", "ok2.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dispatcherFactory,
    });
    const result = await handler(makeCtx({ url: "https://ok.example.com/start" }));
    expect(result).toEqual({ status: 204, host: "ok2.example.com" });
    // Dispatcher built once per hop (initial + 1 redirect = 2).
    expect(dispatcherFactory).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect that targets a host outside the allow-list", async () => {
    const dispatcherFactory = vi.fn(async () => ({ close: async () => undefined }));
    const fetchImpl = vi.fn(async () => ({
      status: 302,
      headers: new Headers({ location: "http://169.254.169.254/latest/meta-data/" }),
      body: { cancel: async () => undefined },
    }));
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dispatcherFactory,
    });
    await expect(handler(makeCtx({ url: "https://ok.example.com/hook" }))).rejects.toThrow(
      /not on WEBHOOK_ALLOWED_HOSTS|not allowed/,
    );
  });

  it("caps the redirect chain to stop loops", async () => {
    const dispatcherFactory = vi.fn(async () => ({ close: async () => undefined }));
    const fetchImpl = vi.fn(async () => ({
      status: 302,
      headers: new Headers({ location: "https://ok.example.com/loop" }),
      body: { cancel: async () => undefined },
    }));
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dispatcherFactory,
    });
    await expect(handler(makeCtx({ url: "https://ok.example.com/loop" }))).rejects.toThrow(
      /redirect/,
    );
  });

  it("drops the Authorization header on cross-origin redirect (C2)", async () => {
    const dispatcherFactory = vi.fn(async () => ({ close: async () => undefined }));
    const seenAuth: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      seenAuth.push(init.headers["authorization"]);
      if (url.includes("/start")) {
        return {
          status: 302,
          headers: new Headers({ location: "https://ok2.example.com/landing" }),
          body: { cancel: async () => undefined },
        };
      }
      return { status: 200, headers: new Headers(), body: { cancel: async () => undefined } };
    });
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com", "ok2.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dispatcherFactory,
    });
    await handler(
      makeCtx({ url: "https://ok.example.com/start", authHeader: "${vault:my-secret}" }),
    );
    expect(seenAuth[0]).toBe("secret-value");
    expect(seenAuth[1]).toBeUndefined();
  });

  it("L3: surfaces a JSON-parse failure as bodyParseError instead of swallowing", async () => {
    const dispatcherFactory = vi.fn(async () => ({ close: async () => undefined }));
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: { cancel: async () => undefined },
      text: async () => "{not json",
    }));
    const handler = createHttpWebhookHandler({
      config: {
        allowedHosts: ["ok.example.com"],
        maxBytes: 1024,
        timeoutMs: 500,
        requireHttps: false,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dispatcherFactory,
    });
    const result = (await handler(makeCtx({ url: "https://ok.example.com/json" }))) as Record<
      string,
      unknown
    >;
    expect(result.bodyParseError).toBe(true);
  });
});
