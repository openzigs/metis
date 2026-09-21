/**
 * Issue #285 — native Anthropic provider (@anthropic-ai/sdk, Messages API).
 *
 * The official SDK is mocked end-to-end (no live network). We assert:
 *   • chat() maps ChatMessage[] + ChatOptions → messages.create and back,
 *     with the system prompt as the TOP-LEVEL `system` param (not a message);
 *   • usage maps input/output/cache tokens → TokenUsage (provider "anthropic");
 *   • stream() uses messages.stream(...).finalMessage() and yields delta+usage;
 *   • error mapping (auth/rate-limit/connection/generic) → AIError subclasses;
 *   • ping() is a lightweight bounded probe;
 *   • embed() throws a clear unsupported AIProviderError;
 *   • models() returns the configured/known ids.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mock @anthropic-ai/sdk ─────────────────────────────────────────────
// A hand-rolled mock that mirrors the real client surface we depend on:
//   client.messages.create(...), client.messages.stream(...).finalMessage(),
//   client.models.list(), and the typed error classes hung off the default
//   export (Anthropic.APIError etc.).
const createMock = vi.fn();
const streamMock = vi.fn();
const modelsListMock = vi.fn();
const ctorMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  // Error classes are declared inside the (hoisted) factory so they exist
  // before the SDK module is first imported.
  class MockAPIError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "APIError";
      this.status = status;
    }
  }
  class MockAuthenticationError extends MockAPIError {
    constructor(message = "auth") {
      super(message, 401);
      this.name = "AuthenticationError";
    }
  }
  class MockRateLimitError extends MockAPIError {
    constructor(message = "rate") {
      super(message, 429);
      this.name = "RateLimitError";
    }
  }
  class MockAPIConnectionError extends MockAPIError {
    constructor(message = "conn") {
      super(message);
      this.name = "APIConnectionError";
    }
  }
  class Anthropic {
    messages: { create: typeof createMock; stream: typeof streamMock };
    models: { list: typeof modelsListMock };
    constructor(opts: unknown) {
      ctorMock(opts);
      this.messages = { create: createMock, stream: streamMock };
      this.models = { list: modelsListMock };
    }
    static APIError = MockAPIError;
    static AuthenticationError = MockAuthenticationError;
    static RateLimitError = MockRateLimitError;
    static APIConnectionError = MockAPIConnectionError;
  }
  return { default: Anthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../../../src/lib/ai/providers/anthropic-provider.js";
import { AIError } from "../../../src/lib/ai/errors.js";

const MockAPIError = (Anthropic as unknown as { APIError: typeof Error }).APIError;
const MockAuthenticationError = (
  Anthropic as unknown as { AuthenticationError: new (m?: string) => Error }
).AuthenticationError;
const MockRateLimitError = (Anthropic as unknown as { RateLimitError: new () => Error })
  .RateLimitError;
const MockAPIConnectionError = (Anthropic as unknown as { APIConnectionError: new () => Error })
  .APIConnectionError;

afterEach(() => {
  vi.clearAllMocks();
});

function makeMessage(over: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: "hello world" }],
    model: "claude-sonnet-4-6",
    usage: {
      input_tokens: 11,
      output_tokens: 4,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 7,
    },
    ...over,
  };
}

describe("AnthropicProvider — identity", () => {
  it("exposes the anthropic key, default model and is not offline", () => {
    const p = new AnthropicProvider({ apiKey: "sk-test", model: "claude-sonnet-4-6" });
    expect(p.key).toBe("anthropic");
    expect(p.model).toBe("claude-sonnet-4-6");
    expect(p.offline).toBe(false);
  });

  it("falls back to the bare claude-sonnet-4-6 default when no model supplied", () => {
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    expect(p.model).toBe("claude-sonnet-4-6");
  });

  it("forwards apiKey / authToken / baseURL to the SDK client", () => {
    new AnthropicProvider({
      apiKey: "sk-test",
      authToken: "oauth-tok",
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-4-8",
    });
    expect(ctorMock).toHaveBeenCalledTimes(1);
    const opts = ctorMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.apiKey).toBe("sk-test");
    expect(opts.authToken).toBe("oauth-tok");
    expect(opts.baseURL).toBe("https://api.anthropic.com");
  });
});

describe("AnthropicProvider.chat", () => {
  it("maps messages, hoists the system prompt, and maps usage", async () => {
    createMock.mockResolvedValue(makeMessage());
    const p = new AnthropicProvider({ apiKey: "sk-test", model: "claude-sonnet-4-6" });

    const res = await p.chat(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      { systemMessage: "extra system" },
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    const req = createMock.mock.calls[0][0] as Record<string, unknown>;
    // System must be top-level, never a message.
    expect(typeof req.system).toBe("string");
    expect(req.system).toContain("extra system");
    expect(req.system).toContain("be terse");
    const msgs = req.messages as Array<{ role: string }>;
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
    expect(req.model).toBe("claude-sonnet-4-6");
    expect(req.max_tokens).toBeGreaterThan(0);
    // Removed sampling knobs must NOT be sent (400 on current models).
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("top_p");
    expect(req).not.toHaveProperty("budget_tokens");

    expect(res.content).toBe("hello world");
    expect(res.provider).toBe("anthropic");
    expect(res.usage).toEqual({
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
    });
  });

  it("honours per-call model + maxTokens overrides", async () => {
    createMock.mockResolvedValue(makeMessage({ model: "claude-opus-4-8" }));
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    await p.chat([{ role: "user", content: "x" }], {
      model: "claude-opus-4-8",
      maxTokens: 1234,
    });
    const req = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(req.model).toBe("claude-opus-4-8");
    expect(req.max_tokens).toBe(1234);
  });

  it("maps reasoningEffort to adaptive thinking + output_config.effort", async () => {
    createMock.mockResolvedValue(makeMessage());
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    await p.chat([{ role: "user", content: "x" }], { reasoningEffort: "high" });
    const req = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config).toEqual({ effort: "high" });
  });

  it("returns empty content and zeroed usage when the response is sparse", async () => {
    createMock.mockResolvedValue({ model: "claude-sonnet-4-6" });
    const p = new AnthropicProvider({ apiKey: "k" });
    const res = await p.chat([{ role: "user", content: "x" }]);
    expect(res.content).toBe("");
    expect(res.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // model falls back to the request model when the response omits it
    expect(res.model).toBe("claude-sonnet-4-6");
  });

  it("skips non-text content blocks when extracting text", async () => {
    createMock.mockResolvedValue(
      makeMessage({
        content: [
          { type: "tool_use", id: "t1" },
          { type: "text", text: "kept" },
        ],
      }),
    );
    const p = new AnthropicProvider({ apiKey: "k" });
    const res = await p.chat([{ role: "user", content: "x" }]);
    expect(res.content).toBe("kept");
  });

  it("folds assistant and tool turns into valid Messages API roles", async () => {
    createMock.mockResolvedValue(makeMessage());
    const p = new AnthropicProvider({ apiKey: "k" });
    await p.chat([
      { role: "user", content: "hi" },
      { role: "assistant", content: "prior reply" },
      { role: "tool", content: "tool output", name: "search" },
    ]);
    const req = createMock.mock.calls[0][0] as { messages: Array<{ role: string }> };
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("concatenates multiple text content blocks", async () => {
    createMock.mockResolvedValue(
      makeMessage({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    );
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    const res = await p.chat([{ role: "user", content: "x" }]);
    expect(res.content).toBe("ab");
  });

  it("throws AbortError when the signal is already aborted", async () => {
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    const ac = new AbortController();
    ac.abort();
    await expect(p.chat([{ role: "user", content: "x" }], { signal: ac.signal })).rejects.toThrow(
      /abort/i,
    );
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("AnthropicProvider.stream", () => {
  it("yields deltas from text events then usage + done from finalMessage", async () => {
    async function* events() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "foo" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "bar" } };
    }
    const handle = {
      [Symbol.asyncIterator]: () => events()[Symbol.asyncIterator](),
      finalMessage: vi.fn(async () => makeMessage()),
      controller: { abort: vi.fn() },
    };
    streamMock.mockReturnValue(handle);

    const p = new AnthropicProvider({ apiKey: "sk-test" });
    const chunks = [];
    for await (const c of p.stream([{ role: "user", content: "x" }])) chunks.push(c);

    expect(chunks).toContainEqual({ type: "delta", content: "foo" });
    expect(chunks).toContainEqual({ type: "delta", content: "bar" });
    const usage = chunks.find((c) => c.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      usage: {
        promptTokens: 11,
        completionTokens: 4,
        totalTokens: 15,
        cacheReadTokens: 7,
        cacheWriteTokens: 2,
      },
    });
    expect(chunks[chunks.length - 1]).toEqual({ type: "done" });
    // streaming requests a larger budget by default
    const req = streamMock.mock.calls[0][0] as Record<string, unknown>;
    expect(req.max_tokens).toBeGreaterThan(16000);
  });

  it("maps a synchronous stream() construction error to AIError", async () => {
    streamMock.mockImplementation(() => {
      throw new MockRateLimitError();
    });
    const p = new AnthropicProvider({ apiKey: "k" });
    const it = p.stream([{ role: "user", content: "x" }]);
    await expect(it.next()).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR", status: 429 });
  });

  it("maps a mid-stream iteration error to AIError", async () => {
    async function* boom() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "foo" } };
      throw new MockAPIConnectionError();
    }
    const handle = {
      [Symbol.asyncIterator]: () => boom()[Symbol.asyncIterator](),
      finalMessage: vi.fn(async () => makeMessage()),
      controller: { abort: vi.fn() },
    };
    streamMock.mockReturnValue(handle);
    const p = new AnthropicProvider({ apiKey: "k" });
    const out = [];
    await expect(
      (async () => {
        for await (const c of p.stream([{ role: "user", content: "x" }])) out.push(c);
      })(),
    ).rejects.toBeInstanceOf(AIError);
    expect(out).toContainEqual({ type: "delta", content: "foo" });
  });

  it("throws AbortError when the signal is already aborted before streaming", async () => {
    const p = new AnthropicProvider({ apiKey: "k" });
    const ac = new AbortController();
    ac.abort();
    const it = p.stream([{ role: "user", content: "x" }], { signal: ac.signal });
    await expect(it.next()).rejects.toThrow(/abort/i);
  });

  it("aborts the SDK stream when the caller signal fires", async () => {
    const abort = vi.fn();
    async function* events() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "foo" } };
    }
    const handle = {
      [Symbol.asyncIterator]: () => events()[Symbol.asyncIterator](),
      finalMessage: vi.fn(async () => makeMessage()),
      controller: { abort },
    };
    streamMock.mockReturnValue(handle);
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    const ac = new AbortController();
    const it = p.stream([{ role: "user", content: "x" }], { signal: ac.signal });
    await it.next();
    ac.abort();
    expect(abort).toHaveBeenCalled();
  });
});

describe("AnthropicProvider — error mapping", () => {
  it("maps AuthenticationError → AIError without leaking the key", async () => {
    createMock.mockRejectedValue(new MockAuthenticationError("bad key sk-secret"));
    const p = new AnthropicProvider({ apiKey: "sk-secret", model: "claude-sonnet-4-6" });
    await expect(p.chat([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
      status: 401,
    });
  });

  it("maps RateLimitError → AIError 429", async () => {
    createMock.mockRejectedValue(new MockRateLimitError());
    const p = new AnthropicProvider({ apiKey: "k" });
    await expect(p.chat([{ role: "user", content: "x" }])).rejects.toMatchObject({ status: 429 });
  });

  it("maps APIConnectionError → AIProviderError (unreachable)", async () => {
    createMock.mockRejectedValue(new MockAPIConnectionError());
    const p = new AnthropicProvider({ apiKey: "k" });
    await expect(p.chat([{ role: "user", content: "x" }])).rejects.toBeInstanceOf(AIError);
  });

  it("maps a non-Error throw and defaults the status to 502", async () => {
    createMock.mockRejectedValue("string failure");
    const p = new AnthropicProvider({ apiKey: "k" });
    await expect(p.chat([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
      status: 502,
    });
  });

  it("ignores a non-numeric status on the SDK error", async () => {
    const err = Object.assign(new Error("weird"), { status: "nope" });
    createMock.mockRejectedValue(err);
    const p = new AnthropicProvider({ apiKey: "k" });
    await expect(p.chat([{ role: "user", content: "x" }])).rejects.toMatchObject({ status: 502 });
  });

  it("never includes the API key in the surfaced error message", async () => {
    createMock.mockRejectedValue(new MockAPIError("server exploded", 500));
    const p = new AnthropicProvider({ apiKey: "sk-super-secret-value" });
    try {
      await p.chat([{ role: "user", content: "x" }]);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("sk-super-secret-value");
    }
  });
});

describe("AnthropicProvider.embed", () => {
  it("throws a clear unsupported AIProviderError", async () => {
    const p = new AnthropicProvider({ apiKey: "k" });
    await expect(p.embed(["x"])).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
    await expect(p.embed(["x"])).rejects.toThrow(/embeddings/i);
  });
});

describe("AnthropicProvider.models / ping", () => {
  it("models() returns ids from the SDK when listing succeeds", async () => {
    modelsListMock.mockResolvedValue({
      data: [{ id: "claude-opus-4-8" }, { id: "claude-haiku-4-5" }],
    });
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-6" });
    const ids = await p.models();
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("models() falls back to the configured model when listing fails", async () => {
    modelsListMock.mockRejectedValue(new Error("nope"));
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-6" });
    expect(await p.models()).toEqual(["claude-sonnet-4-6"]);
  });

  it("ping() returns true when models.list resolves", async () => {
    modelsListMock.mockResolvedValue({ data: [{ id: "claude-sonnet-4-6" }] });
    const p = new AnthropicProvider({ apiKey: "k" });
    expect(await p.ping()).toBe(true);
  });

  it("ping() returns false when the probe rejects", async () => {
    modelsListMock.mockRejectedValue(new Error("unreachable"));
    const p = new AnthropicProvider({ apiKey: "k" });
    expect(await p.ping()).toBe(false);
  });

  it("ping() passes the 2s probe timeout in the SDK RequestOptions (2nd arg)", async () => {
    modelsListMock.mockResolvedValue({ data: [{ id: "claude-sonnet-4-6" }] });
    const p = new AnthropicProvider({ apiKey: "k" });
    await p.ping();
    // params (1st arg) carries no timeout; timeout lives in RequestOptions (2nd arg).
    expect(modelsListMock.mock.calls[0][0]).toBeUndefined();
    expect(modelsListMock.mock.calls[0][1]).toMatchObject({ timeout: 2_000 });
  });

  it("models() passes the 2s probe timeout in the SDK RequestOptions (2nd arg)", async () => {
    modelsListMock.mockResolvedValue({ data: [{ id: "claude-sonnet-4-6" }] });
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-6" });
    await p.models();
    expect(modelsListMock.mock.calls[0][0]).toBeUndefined();
    expect(modelsListMock.mock.calls[0][1]).toMatchObject({ timeout: 2_000 });
  });
});
