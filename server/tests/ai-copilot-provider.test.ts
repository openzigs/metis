/**
 * Tests for `CopilotWrapper` and `CopilotProvider`.
 *
 * Uses a hand-rolled `CopilotClientLike` stub — the real SDK is never loaded.
 * Tests cover:
 *   • token resolution (env → cached file → SDK extension fallback)
 *   • device-auth flow + auth-state persistence
 *   • per-session COPILOT_HOME isolation (R-SDK-9)
 *   • CopilotProvider streams deltas, usage, tool_call → done
 *   • streaming honours AbortSignal
 *   • surfacing SDK errors as AIProviderError
 *   • ping reachability with timeout
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CopilotProvider,
  CopilotWrapper,
  readAuthState,
  writeAuthState,
} from "../src/lib/ai/index.js";
import type { CopilotClientLike, CopilotSessionLike } from "../src/lib/ai/copilot-wrapper.js";
import type { ChatChunk } from "../src/lib/ai/types.js";

let tmpDir = "";
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "metis-ai-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────── helpers ───────────────────────────────────────

interface SessionListeners {
  delta?: (e: { data?: { deltaContent?: string } }) => void;
  toolCall?: (e: { name?: string; arguments?: unknown }) => void;
  usage?: (e: Record<string, number>) => void;
  error?: (e: unknown) => void;
  idle?: () => void;
}

function makeStubSession(): {
  session: CopilotSessionLike;
  listeners: SessionListeners;
  sentPrompts: string[];
} {
  const listeners: SessionListeners = {};
  const sentPrompts: string[] = [];
  const session: CopilotSessionLike = {
    sessionId: "stub",
    on(event, handler) {
      if (event === "assistant.message_delta") listeners.delta = handler;
      if (event === "toolCall") listeners.toolCall = handler;
      if (event === "usage") listeners.usage = handler;
      if (event === "error") listeners.error = handler;
      if (event === "session.idle") listeners.idle = handler;
      return () => undefined;
    },
    async send({ prompt }) {
      sentPrompts.push(prompt);
      // Synchronously emit a few deltas + usage + idle so the consumer drains.
      queueMicrotask(() => {
        listeners.delta?.({ data: { deltaContent: "Hello" } });
        listeners.delta?.({ data: { deltaContent: " world" } });
        listeners.toolCall?.({ name: "noop", arguments: { x: 1 } });
        listeners.usage?.({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
        listeners.idle?.();
      });
    },
    async sendAndWait({ prompt }) {
      sentPrompts.push(prompt);
      listeners.delta?.({ data: { deltaContent: "Hi" } });
      listeners.usage?.({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
      listeners.idle?.();
    },
    destroy: vi.fn(async () => undefined),
  };
  return { session, listeners, sentPrompts };
}

function makeStubClient(
  sessionFactory = makeStubSession,
  overrides: Partial<CopilotClientLike> = {},
): { client: CopilotClientLike; lastSession: { ref?: SessionListeners; sent?: string[] } } {
  const lastSession: { ref?: SessionListeners; sent?: string[] } = {};
  const client: CopilotClientLike = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, authType: "stub" })),
    listModels: vi.fn(async () => [{ id: "stub-1" }, { id: "stub-2" }]),
    createSession: vi.fn(async () => {
      const made = sessionFactory();
      lastSession.ref = made.listeners;
      lastSession.sent = made.sentPrompts;
      return made.session;
    }),
    ...overrides,
  };
  return { client, lastSession };
}

// ─────────────────────────── tests ─────────────────────────────────────────

describe("CopilotWrapper", () => {
  it("starts the SDK once even with concurrent calls", async () => {
    const { client } = makeStubClient();
    const w = new CopilotWrapper({ client });
    await Promise.all([w.ensureStarted(), w.ensureStarted(), w.ensureStarted()]);
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it("resolveToken reads an OPERATOR-SUPPLIED auth file", async () => {
    // This used to drive `startDeviceAuth()` + `waitForAuth()` and assert the file they
    // wrote. Both were removed in #1348 — the SDK has never shipped either member, so
    // the stubs above were a client shape that does not exist, and the test proved
    // nothing about production.
    //
    // The READ half is still live (`resolveToken` -> `readAuthState`), so that is what
    // is asserted now. Nothing inside METIS writes `~/.metis/auth.json` any more, which
    // makes it an operator-supplied or volume-mounted file — seeded here with
    // `writeAuthState` so the fixture cannot drift from the schema the reader expects.
    const authPath = path.join(tmpDir, "auth.json");
    await writeAuthState(authPath, { token: "tok-1", obtainedAt: Date.now() });
    const { client } = makeStubClient();
    const w = new CopilotWrapper({ client, authPath });
    expect(await w.resolveToken()).toBe("tok-1");
    expect((await readAuthState(authPath))?.token).toBe("tok-1");
  });

  it("isAuthenticated falls back to cached file when SDK fails", async () => {
    const authPath = path.join(tmpDir, "auth.json");
    await writeAuthState(authPath, {
      token: "cached",
      obtainedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const { client } = makeStubClient(undefined, {
      getAuthStatus: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const w = new CopilotWrapper({ client, authPath });
    expect(await w.isAuthenticated()).toBe(true);
  });

  it("isAuthenticated false when nothing is configured", async () => {
    const authPath = path.join(tmpDir, "missing.json");
    const { client } = makeStubClient(undefined, {
      getAuthStatus: vi.fn(async () => ({ isAuthenticated: false })),
    });
    const w = new CopilotWrapper({ client, authPath });
    expect(await w.isAuthenticated()).toBe(false);
  });

  it("computes per-session COPILOT_HOME and cleans up (R-SDK-9)", async () => {
    const root = path.join(tmpDir, ".metis-sessions");
    const { client } = makeStubClient();
    const w = new CopilotWrapper({ client, sessionHomeRoot: root });
    const dir = w.sessionHomeFor("abc-123");
    expect(dir).toBe(path.join(root, "abc-123"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "marker"), "x");
    await w.cleanupSessionHome("abc-123");
    await expect(fs.access(dir)).rejects.toBeDefined();
  });

  it("createSession passes BYOK provider config and copilotHome", async () => {
    const { client } = makeStubClient(undefined, {
      createSession: vi.fn(async (cfg) => {
        expect(cfg.provider).toEqual({
          type: "openai",
          baseUrl: "http://gw",
          apiKey: "k",
        });
        expect(cfg.copilotHome).toContain("session-1");
        return makeStubSession().session;
      }),
    });
    const w = new CopilotWrapper({
      client,
      provider: { type: "openai", baseUrl: "http://gw", apiKey: "k" },
      sessionHomeRoot: path.join(tmpDir, "homes"),
    });
    await w.createSession({ sessionId: "session-1", model: "x" });
    expect(client.createSession).toHaveBeenCalled();
  });

  it("listModels returns ids and survives SDK failure", async () => {
    const { client } = makeStubClient();
    const w = new CopilotWrapper({ client });
    expect(await w.listModels()).toEqual(["stub-1", "stub-2"]);

    const failing = makeStubClient(undefined, {
      listModels: vi.fn(async () => {
        throw new Error("nope");
      }),
    }).client;
    const w2 = new CopilotWrapper({ client: failing, model: "fallback" });
    expect(await w2.listModels()).toEqual(["fallback"]);
  });

  it("model getter/setter mutates default", async () => {
    const { client } = makeStubClient();
    const w = new CopilotWrapper({ client, model: "init" });
    expect(w.getModel()).toBe("init");
    w.setModel("next");
    expect(w.getModel()).toBe("next");
  });

  it("hasGithubToken reflects env token", async () => {
    const { client } = makeStubClient();
    const w = new CopilotWrapper({ client, githubToken: "ghp_x" });
    expect(w.hasGithubToken()).toBe(true);
  });
});

// ─────────────────────────── CopilotProvider ───────────────────────────────

describe("CopilotProvider", () => {
  it("streams delta + tool_call + usage + done from a single session", async () => {
    const { client } = makeStubClient();
    const wrapper = new CopilotWrapper({ client });
    const provider = new CopilotProvider({ wrapper, key: "bedrock-gateway" });

    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ],
      { sessionId: "s1" },
    )) {
      chunks.push(c);
    }
    expect(chunks.find((c) => c.type === "delta" && c.content === "Hello")).toBeTruthy();
    expect(chunks.find((c) => c.type === "tool_call")).toBeTruthy();
    expect(chunks.find((c) => c.type === "usage")).toBeTruthy();
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("strips inline <tool_call> XML from bedrock-gateway deltas into a structured event (#718)", async () => {
    // A session that streams a hallucinated qwen-style tool call as plain text,
    // split across two deltas to exercise the boundary buffer.
    function xmlSession() {
      const listeners: SessionListeners = {};
      const sentPrompts: string[] = [];
      const session: CopilotSessionLike = {
        sessionId: "xml",
        on(event, handler) {
          if (event === "assistant.message_delta") listeners.delta = handler;
          if (event === "session.idle") listeners.idle = handler;
          return () => undefined;
        },
        async send() {
          queueMicrotask(() => {
            listeners.delta?.({ data: { deltaContent: "sure <tool_ca" } });
            listeners.delta?.({
              data: {
                deltaContent: 'll>{"name":"bash","arguments":{"command":"ls"}}</tool_call> done',
              },
            });
            listeners.idle?.();
          });
        },
        async sendAndWait() {
          /* unused */
        },
        destroy: vi.fn(async () => undefined),
      };
      return { session, listeners, sentPrompts };
    }
    const { client } = makeStubClient(xmlSession);
    const wrapper = new CopilotWrapper({ client });
    const provider = new CopilotProvider({ wrapper, key: "bedrock-gateway" });

    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hi" }], { sessionId: "x1" })) {
      chunks.push(c);
    }
    const visible = chunks
      .filter((c) => c.type === "delta")
      .map((c) => (c.type === "delta" ? c.content : ""))
      .join("");
    expect(visible).toBe("sure  done");
    expect(visible).not.toContain("<tool_ca");
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call?.type === "tool_call" && call.name).toBe("bash");
  });

  it("chat() aggregates deltas + usage", async () => {
    const { client } = makeStubClient();
    const wrapper = new CopilotWrapper({ client });
    const provider = new CopilotProvider({ wrapper, key: "copilot-native" });
    const r = await provider.chat([{ role: "user", content: "hello" }], { sessionId: "s2" });
    expect(r.content).toBe("Hello world");
    expect(r.usage.totalTokens).toBe(5);
    expect(r.provider).toBe("copilot-native");
  });

  it("AbortSignal cancels the in-flight stream", async () => {
    const { client } = makeStubClient();
    const wrapper = new CopilotWrapper({ client });
    const provider = new CopilotProvider({ wrapper, key: "copilot-native" });
    const ac = new AbortController();
    ac.abort();
    await expect(async () => {
      for await (const _ of provider.stream([{ role: "user", content: "x" }], {
        sessionId: "s3",
        signal: ac.signal,
      })) {
        void _;
      }
    }).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces SDK errors as AIProviderError", async () => {
    const factoryErr = makeStubClient(() => {
      const listeners: SessionListeners = {};
      const session: CopilotSessionLike = {
        sessionId: "s",
        on(event, handler) {
          if (event === "error") listeners.error = handler;
          if (event === "session.idle") listeners.idle = handler;
          return () => undefined;
        },
        async send() {
          listeners.error?.(new Error("boom"));
          listeners.idle?.();
        },
        sendAndWait: undefined,
      };
      return { session, listeners, sentPrompts: [] };
    });
    const wrapper = new CopilotWrapper({ client: factoryErr.client });
    const provider = new CopilotProvider({ wrapper, key: "copilot-native" });
    await expect(
      provider.chat([{ role: "user", content: "x" }], { sessionId: "err" }),
    ).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
    });
  });

  it("models() proxies wrapper.listModels", async () => {
    const { client } = makeStubClient();
    const wrapper = new CopilotWrapper({ client });
    const provider = new CopilotProvider({ wrapper, key: "copilot-native" });
    expect(await provider.models()).toEqual(["stub-1", "stub-2"]);
  });

  it("ping resolves true when client starts and is authenticated", async () => {
    const { client } = makeStubClient();
    const wrapper = new CopilotWrapper({ client });
    const provider = new CopilotProvider({ wrapper, key: "copilot-native" });
    expect(await provider.ping()).toBe(true);
  });

  it("ping returns false when start times out", async () => {
    const slowClient = makeStubClient(undefined, {
      start: vi.fn(() => new Promise(() => undefined)), // never resolves
    });
    const wrapper = new CopilotWrapper({ client: slowClient.client });
    const provider = new CopilotProvider({ wrapper, key: "copilot-native", pingTimeoutMs: 50 });
    expect(await provider.ping()).toBe(false);
  });

  it("destroySession tears down the SDK session", async () => {
    const { client } = makeStubClient();
    const wrapper = new CopilotWrapper({ client });
    const provider = new CopilotProvider({ wrapper, key: "copilot-native" });
    // Trigger session creation by reading one chunk.
    const it = provider.stream([{ role: "user", content: "x" }], { sessionId: "z1" });
    await it.next();
    await provider.destroySession("z1");
  });
});
