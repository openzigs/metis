/**
 * Bug #235 — Verifies that CopilotProvider.stream() passes an
 * `onPermissionRequest` handler to the SDK's createSession, so the
 * "An onPermissionRequest handler is required" error never fires.
 */
import { describe, expect, it, vi } from "vitest";
import { CopilotProvider, CopilotWrapper } from "../src/lib/ai/index.js";
import type { CopilotClientLike, CopilotSessionLike } from "../src/lib/ai/copilot-wrapper.js";
import type { ChatChunk } from "../src/lib/ai/types.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeSessionStub(): CopilotSessionLike {
  type Handler = (data: unknown) => void;
  const handlers = new Map<string, Handler[]>();
  return {
    sessionId: "perm-test-session",
    on: (event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const arr = handlers.get(event);
        if (arr)
          handlers.set(
            event,
            arr.filter((h) => h !== handler),
          );
      };
    },
    send: async () => {
      // Fire session.idle asynchronously so the stream terminates.
      queueMicrotask(() => {
        for (const h of handlers.get("session.idle") ?? []) h(undefined);
      });
    },
    sendAndWait: async () => undefined,
    destroy: async () => undefined,
  };
}

function makeClientStub(
  createSessionImpl?: (cfg: Record<string, unknown>) => Promise<CopilotSessionLike>,
): CopilotClientLike {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, authType: "stub" })),
    listModels: vi.fn(async () => [{ id: "stub-model" }]),
    createSession: vi.fn(createSessionImpl ?? (async () => makeSessionStub())),
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("CopilotProvider.stream — onPermissionRequest (#235)", () => {
  it("passes onPermissionRequest to createSession", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    const client = makeClientStub(async (cfg) => {
      capturedConfig = cfg;
      return makeSessionStub();
    });

    const wrapper = new CopilotWrapper({
      model: "test-model",
      client,
    });
    const provider = new CopilotProvider({
      wrapper,
      key: "bedrock-gateway",
    });

    // Consume the stream to trigger session creation.
    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hello" }])) {
      chunks.push(c);
      // The stub session emits no events — we'll hit __end__ immediately.
      if (c.type === "done") break;
    }

    expect(capturedConfig).toBeDefined();
    expect(typeof capturedConfig!.onPermissionRequest).toBe("function");
  });

  it("onPermissionRequest auto-approves", async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    const client = makeClientStub(async (cfg) => {
      capturedConfig = cfg;
      return makeSessionStub();
    });

    const wrapper = new CopilotWrapper({
      model: "test-model",
      client,
    });
    const provider = new CopilotProvider({
      wrapper,
      key: "bedrock-gateway",
    });

    // Trigger session creation.
    for await (const _ of provider.stream([{ role: "user", content: "test" }])) {
      void _;
      break;
    }

    const handler = capturedConfig!.onPermissionRequest as () => Promise<{ approved: boolean }>;
    const result = await handler();
    expect(result).toEqual({ approved: true });
  });
});

// ── session.error propagation (#234 Fix 1) ────────────────────────────────

describe("CopilotProvider.stream — session.error surfaces as AIProviderError", () => {
  /** Build a session stub that fires a given event sequence after send(). */
  function makeEventSession(
    events: Array<{ event: string; data: unknown; delay?: number }>,
  ): CopilotSessionLike {
    type Handler = (data: unknown) => void;
    const handlers = new Map<string, Handler[]>();
    return {
      sessionId: "err-test-session",
      on: (event: string, handler: Handler) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
        return () => {
          const arr = handlers.get(event);
          if (arr)
            handlers.set(
              event,
              arr.filter((h) => h !== handler),
            );
        };
      },
      send: async () => {
        // Fire events asynchronously in order.
        for (const { event: evName, data, delay } of events) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          for (const h of handlers.get(evName) ?? []) h(data);
        }
      },
      sendAndWait: async () => undefined,
      destroy: async () => undefined,
    };
  }

  it("propagates session.error as an AIProviderError to the stream consumer", async () => {
    const session = makeEventSession([
      {
        event: "session.error",
        data: { errorType: "query", message: "400 400 status code (no body)", statusCode: 400 },
      },
      { event: "session.idle", data: undefined, delay: 5 },
    ]);

    const client = makeClientStub(async () => session);
    const wrapper = new CopilotWrapper({ model: "bogus-model", client });
    const provider = new CopilotProvider({ wrapper, key: "bedrock-gateway" });

    const chunks: ChatChunk[] = [];
    let caughtError: Error | undefined;
    try {
      for await (const c of provider.stream([{ role: "user", content: "test" }])) {
        chunks.push(c);
      }
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain("400");
    // No delta chunks should have been emitted.
    expect(chunks.filter((c) => c.type === "delta")).toHaveLength(0);
  });

  it("propagates plain error events as AIProviderError", async () => {
    const session = makeEventSession([
      { event: "error", data: new Error("transport failure") },
      { event: "session.idle", data: undefined, delay: 5 },
    ]);

    const client = makeClientStub(async () => session);
    const wrapper = new CopilotWrapper({ model: "test-model", client });
    const provider = new CopilotProvider({ wrapper, key: "copilot-native" });

    let caughtError: Error | undefined;
    try {
      for await (const _ of provider.stream([{ role: "user", content: "test" }])) {
        void _;
      }
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toBe("transport failure");
  });

  it("surfaces errors found in getMessages() fallback when no events fire", async () => {
    // Use the event-based session for cleaner testing.
    const evSession = makeEventSession([{ event: "session.idle", data: undefined, delay: 5 }]);
    // Attach getMessages to the event session.
    (evSession as unknown as { getMessages: () => Promise<unknown[]> }).getMessages = async () => [
      { type: "session.error", data: { message: "model not found" } },
    ];

    const client = makeClientStub(async () => evSession);
    const wrapper = new CopilotWrapper({ model: "bad-model", client });
    const provider = new CopilotProvider({ wrapper, key: "bedrock-gateway" });

    let caughtError: Error | undefined;
    try {
      for await (const _ of provider.stream([{ role: "user", content: "test" }])) {
        void _;
      }
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toContain("model not found");
  });
});
