/**
 * Tests for the native Anthropic provider's prompt-caching wiring
 * (#anthropic-prompt-caching) and usage mapping.
 *
 * The official `@anthropic-ai/sdk` is mocked so NO network call is made: the
 * mock captures the request body passed to `messages.create` / `messages.stream`
 * so we can assert exactly where `cache_control` breakpoints are placed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the SDK default export. The provider does `new Anthropic(...)` and
//    then calls `client.messages.create(...)` / `client.messages.stream(...)`.
//    We expose shared spies so each test can read the captured request body.
const createSpy = vi.fn();
const streamSpy = vi.fn();
const modelsListSpy = vi.fn();

// #1257 — the WARN/debug the provider emits about the output budget is an
// acceptance criterion of its own, so the child logger is a spy rather than a
// silent side effect. Without this the whole logging path could be deleted and
// every test would still pass (adversarial panel, `test-falsifiability`).
// `vi.hoisted` because `vi.mock` factories are hoisted above ordinary consts.
const { logWarnSpy, logDebugSpy } = vi.hoisted(() => ({
  logWarnSpy: vi.fn(),
  logDebugSpy: vi.fn(),
}));
vi.mock("../../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger.js")>();
  return {
    ...actual,
    createChildLogger: (name: string) =>
      name === "ai-anthropic"
        ? { warn: logWarnSpy, debug: logDebugSpy, info: vi.fn(), error: vi.fn() }
        : actual.createChildLogger(name),
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: streamSpy };
    models = { list: modelsListSpy };
    constructor(_opts: unknown) {
      /* no-op: never touches the network */
    }
  }
  return { default: FakeAnthropic };
});

// Import AFTER vi.mock so the provider binds to the mocked SDK.
import { AnthropicProvider, normalizeAnthropicModelId } from "./anthropic-provider.js";
import type { ChatChunk, ChatMessage } from "../types.js";
import { __resetConfigSingleton } from "../../config/config-service.js";
import { SDK_MODEL_NONSTREAMING_TOKENS } from "../nonstreaming-output-bound.js";

/** A non-streaming `messages.create` result with the usage we map. */
function fakeMessage(over?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: "hello" }],
    model: "claude-sonnet-4-6",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 12,
    },
    ...over,
  };
}

/**
 * A fake stream handle: async-iterable over the given events, with the
 * `controller` + `finalMessage()` surface the provider depends on.
 */
function fakeStreamHandle(events: unknown[], final = fakeMessage()) {
  return {
    controller: { abort: vi.fn() },
    finalMessage: vi.fn().mockResolvedValue(final),
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

/** The request body captured from the last `messages.create` call. */
function lastCreateBody(): Record<string, unknown> {
  return createSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}
/** The request body captured from the last `messages.stream` call. */
function lastStreamBody(): Record<string, unknown> {
  return streamSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

type Block = { type: string; text?: string; cache_control?: { type: string } };

function provider() {
  return new AnthropicProvider({ apiKey: "test-key" });
}

beforeEach(() => {
  logWarnSpy.mockReset();
  logDebugSpy.mockReset();
  createSpy.mockReset();
  streamSpy.mockReset();
  modelsListSpy.mockReset();
  createSpy.mockResolvedValue(fakeMessage());
  streamSpy.mockReturnValue(
    fakeStreamHandle([{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }]),
  );
});

const messages: ChatMessage[] = [
  { role: "system", content: "SYS PROMPT" },
  { role: "user", content: "the large stable facts prefix" },
];

describe("AnthropicProvider prompt caching — chat()", () => {
  it("caches the system block when promptCaching.system is true", async () => {
    await provider().chat(messages, { promptCaching: { system: true } });
    const body = lastCreateBody();
    // system is now a content-block array with an ephemeral breakpoint.
    expect(Array.isArray(body.system)).toBe(true);
    const sys = body.system as Block[];
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({
      type: "text",
      text: "SYS PROMPT",
      cache_control: { type: "ephemeral" },
    });
  });

  it("caches the last user content block when promptCaching.messages is true", async () => {
    await provider().chat(messages, { promptCaching: { messages: true } });
    const body = lastCreateBody();
    const msgs = body.messages as Array<{ role: string; content: Block[] | string }>;
    const lastUser = msgs.at(-1)!;
    expect(Array.isArray(lastUser.content)).toBe(true);
    const blocks = lastUser.content as Block[];
    expect(blocks.at(-1)).toMatchObject({
      type: "text",
      text: "the large stable facts prefix",
      cache_control: { type: "ephemeral" },
    });
  });

  it("caches BOTH system and last user block when both flags are set", async () => {
    await provider().chat(messages, { promptCaching: { system: true, messages: true } });
    const body = lastCreateBody();
    expect(Array.isArray(body.system)).toBe(true);
    expect((body.system as Block[])[0].cache_control).toEqual({ type: "ephemeral" });
    const lastUser = (body.messages as Array<{ content: Block[] }>).at(-1)!;
    expect((lastUser.content as Block[]).at(-1)!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("places at most 2 breakpoints (Anthropic allows <= 4)", async () => {
    await provider().chat(messages, { promptCaching: { system: true, messages: true } });
    const body = lastCreateBody();
    let breakpoints = 0;
    for (const b of (body.system as Block[]) ?? []) if (b.cache_control) breakpoints++;
    for (const m of body.messages as Array<{ content: Block[] | string }>) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) if (b.cache_control) breakpoints++;
      }
    }
    expect(breakpoints).toBe(2);
    expect(breakpoints).toBeLessThanOrEqual(4);
  });

  it("does NOT set cache_control and keeps system as a string when flags are off (back-compat)", async () => {
    await provider().chat(messages, {});
    const body = lastCreateBody();
    // system stays a bare string.
    expect(typeof body.system).toBe("string");
    expect(body.system).toBe("SYS PROMPT");
    // user message stays a bare string with no cache_control anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("cache_control");
    const lastUser = (body.messages as Array<{ content: unknown }>).at(-1)!;
    expect(typeof lastUser.content).toBe("string");
  });

  it("marks the LAST user message (not an earlier one) when there are multiple turns", async () => {
    const multi: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "second user turn (the stable prefix)" },
    ];
    await provider().chat(multi, { promptCaching: { messages: true } });
    const msgs = lastCreateBody().messages as Array<{ role: string; content: Block[] | string }>;
    const userTurns = msgs.filter((m) => m.role === "user");
    // First user turn untouched (plain string), last user turn is block-form + cached.
    expect(typeof userTurns[0].content).toBe("string");
    const lastBlocks = userTurns.at(-1)!.content as Block[];
    expect(lastBlocks.at(-1)).toMatchObject({
      text: "second user turn (the stable prefix)",
      cache_control: { type: "ephemeral" },
    });
  });

  it("preserves a multi-block user message and caches only its LAST block (judge layout)", async () => {
    // Mirrors the FaithfulnessJudge's [claims, evidence] layout: evidence last.
    const judgeLike: ChatMessage[] = [
      { role: "system", content: "JUDGE SYS" },
      {
        role: "user",
        content: [
          { type: "text", text: "CLAIMS (varying per batch)" },
          { type: "text", text: "EVIDENCE (stable across batches)" },
        ],
      },
    ];
    await provider().chat(judgeLike, { promptCaching: { system: true, messages: true } });
    const lastUser = (lastCreateBody().messages as Array<{ content: Block[] }>).at(-1)!;
    const blocks = lastUser.content as Block[];
    expect(blocks).toHaveLength(2);
    // Leading (claims) block has NO breakpoint; trailing (evidence) block does.
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[0].text).toBe("CLAIMS (varying per batch)");
    expect(blocks[1]).toMatchObject({
      text: "EVIDENCE (stable across batches)",
      cache_control: { type: "ephemeral" },
    });
  });
});

describe("AnthropicProvider prompt caching — stream()", () => {
  async function drain(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const c of gen) out.push(c);
    return out;
  }

  it("caches the system block on the stream path when promptCaching.system is true", async () => {
    await drain(provider().stream(messages, { promptCaching: { system: true } }));
    const sys = lastStreamBody().system as Block[];
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("caches the last user block on the stream path when promptCaching.messages is true", async () => {
    await drain(provider().stream(messages, { promptCaching: { messages: true } }));
    const lastUser = (lastStreamBody().messages as Array<{ content: Block[] }>).at(-1)!;
    expect((lastUser.content as Block[]).at(-1)!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT set cache_control on the stream path when flags are off (back-compat)", async () => {
    await drain(provider().stream(messages, {}));
    const body = lastStreamBody();
    expect(typeof body.system).toBe("string");
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});

describe("AnthropicProvider usage mapping (cache tokens)", () => {
  it("maps cacheRead/cacheWrite from chat()", async () => {
    const res = await provider().chat(messages, {});
    expect(res.usage.cacheReadTokens).toBe(80);
    expect(res.usage.cacheWriteTokens).toBe(12);
    expect(res.usage.promptTokens).toBe(100);
    expect(res.usage.completionTokens).toBe(20);
    expect(res.usage.totalTokens).toBe(120);
  });

  it("maps cacheRead/cacheWrite from stream() final usage", async () => {
    streamSpy.mockReturnValue(
      fakeStreamHandle(
        [{ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }],
        fakeMessage({
          usage: {
            input_tokens: 5,
            output_tokens: 7,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 0,
          },
        }),
      ),
    );
    const chunks: ChatChunk[] = [];
    for await (const c of provider().stream(messages, {})) chunks.push(c);
    const usageChunk = chunks.find((c) => c.type === "usage");
    expect(usageChunk).toBeDefined();
    if (usageChunk?.type === "usage") {
      expect(usageChunk.usage.cacheReadTokens).toBe(200);
      expect(usageChunk.usage.cacheWriteTokens).toBe(0);
    }
  });

  it("defaults cache tokens to 0 when the SDK omits them", async () => {
    createSpy.mockResolvedValue(fakeMessage({ usage: { input_tokens: 3, output_tokens: 4 } }));
    const res = await provider().chat(messages, {});
    expect(res.usage.cacheReadTokens).toBe(0);
    expect(res.usage.cacheWriteTokens).toBe(0);
  });
});

describe("AnthropicProvider request building (non-cache paths)", () => {
  it("folds system + tool turns into the top-level system param and user turns", async () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "S1" },
      { role: "user", content: "U1" },
      { role: "tool", content: "tool output", name: "search" },
    ];
    await provider().chat(msgs, { systemMessage: "OPTS-SYS" });
    const body = lastCreateBody();
    // systemMessage option + system-role message are joined into `system`.
    expect(body.system).toBe("OPTS-SYS\n\nS1");
    // tool role is folded into a user turn; there is no system-role message left.
    const roles = (body.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles).toEqual(["user", "user"]);
  });

  it("emits thinking + output_config when reasoningEffort is set", async () => {
    await provider().chat(messages, { reasoningEffort: "high" });
    const body = lastCreateBody();
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("honours a maxTokens override", async () => {
    await provider().chat(messages, { maxTokens: 1234 });
    expect(lastCreateBody().max_tokens).toBe(1234);
  });
});

describe("AnthropicProvider misc surface", () => {
  it("embed() throws (Anthropic has no embeddings API)", async () => {
    await expect(provider().embed(["x"])).rejects.toThrow(/does not support embeddings/);
  });

  it("models() returns the SDK ids when present", async () => {
    modelsListSpy.mockResolvedValue({ data: [{ id: "claude-a" }, { id: "claude-b" }] });
    await expect(provider().models()).resolves.toEqual(["claude-a", "claude-b"]);
  });

  it("models() falls back to the default model on error", async () => {
    modelsListSpy.mockRejectedValue(new Error("boom"));
    await expect(provider().models()).resolves.toEqual(["claude-sonnet-4-6"]);
  });

  it("ping() returns true when the probe succeeds and false on error", async () => {
    modelsListSpy.mockResolvedValue({ data: [] });
    await expect(provider().ping()).resolves.toBe(true);
    modelsListSpy.mockRejectedValue(new Error("down"));
    await expect(provider().ping()).resolves.toBe(false);
  });
});

describe("AnthropicProvider error + abort handling", () => {
  it("maps an SDK error to AIProviderError preserving the status", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429, name: "APIError" });
    createSpy.mockRejectedValue(err);
    await expect(provider().chat(messages, {})).rejects.toMatchObject({
      status: 429,
    });
  });

  it("throws AbortError immediately when the signal is already aborted (chat)", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider().chat(messages, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("throws AbortError immediately when the signal is already aborted (stream)", async () => {
    const controller = new AbortController();
    controller.abort();
    const gen = provider().stream(messages, { signal: controller.signal });
    await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("maps a stream setup error to AIProviderError", async () => {
    streamSpy.mockImplementation(() => {
      throw Object.assign(new Error("stream failed"), { status: 503 });
    });
    const gen = provider().stream(messages, {});
    await expect(gen.next()).rejects.toMatchObject({ status: 503 });
  });

  it("registers and removes the abort listener around a full stream (non-aborted signal)", async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    streamSpy.mockReturnValue(
      fakeStreamHandle([
        { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
        { type: "other_event" }, // ignored, exercises the non-delta branch
      ]),
    );
    const chunks: ChatChunk[] = [];
    for await (const c of provider().stream(messages, { signal: controller.signal })) {
      chunks.push(c);
    }
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeSpy).toHaveBeenCalled();
    expect(chunks.filter((c) => c.type === "delta")).toHaveLength(2);
    expect(chunks.some((c) => c.type === "usage")).toBe(true);
    expect(chunks.at(-1)).toEqual({ type: "done" });
  });

  it("defaults to status 502 when a non-Error value with no status is thrown", async () => {
    createSpy.mockRejectedValue("a bare string failure");
    await expect(provider().chat(messages, {})).rejects.toMatchObject({ status: 502 });
  });
});

describe("AnthropicProvider prompt caching — config-gated 1h TTL (#702)", () => {
  type TtlBlock = { type: string; text?: string; cache_control?: { type: string; ttl?: string } };
  const original = process.env.ANTHROPIC_PROMPT_CACHE_TTL;

  function setTtl(value: string | undefined): void {
    if (value === undefined) delete process.env.ANTHROPIC_PROMPT_CACHE_TTL;
    else process.env.ANTHROPIC_PROMPT_CACHE_TTL = value;
    // Rebuild the config singleton so it re-reads process.env by reference.
    __resetConfigSingleton();
  }

  afterEach(() => {
    setTtl(original);
  });

  it("emits ttl:'1h' on BOTH breakpoints when ANTHROPIC_PROMPT_CACHE_TTL=1h", async () => {
    setTtl("1h");
    await provider().chat(messages, { promptCaching: { system: true, messages: true } });
    const body = lastCreateBody();

    const sys = body.system as TtlBlock[];
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    const lastUser = (body.messages as Array<{ content: TtlBlock[] }>).at(-1)!;
    expect(lastUser.content.at(-1)!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("emits ttl:'1h' on the stream path too", async () => {
    setTtl("1h");
    const gen = provider().stream(messages, { promptCaching: { system: true, messages: true } });
    for await (const _c of gen) void _c;
    const body = lastStreamBody();
    expect((body.system as TtlBlock[])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const lastUser = (body.messages as Array<{ content: TtlBlock[] }>).at(-1)!;
    expect(lastUser.content.at(-1)!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("emits a BYTE-IDENTICAL bare breakpoint (no ttl key) when the flag is off/'5m'", async () => {
    setTtl("5m");
    await provider().chat(messages, { promptCaching: { system: true, messages: true } });
    const body = lastCreateBody();

    const sys = body.system as TtlBlock[];
    // Deep-equal with NO ttl key — the regression guard.
    expect(sys[0].cache_control).toEqual({ type: "ephemeral" });
    expect("ttl" in (sys[0].cache_control as object)).toBe(false);

    const lastUser = (body.messages as Array<{ content: TtlBlock[] }>).at(-1)!;
    expect(lastUser.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    // The whole request never contains the substring "1h" anywhere.
    expect(JSON.stringify(body)).not.toContain('"ttl"');
  });

  it("treats an unset key as byte-identical bare (default behaviour)", async () => {
    setTtl(undefined);
    await provider().chat(messages, { promptCaching: { system: true, messages: true } });
    const body = lastCreateBody();
    expect((body.system as TtlBlock[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(body)).not.toContain('"ttl"');
  });
});

describe("normalizeAnthropicModelId", () => {
  it("strips the us. cross-region prefix and anthropic. vendor segment", () => {
    expect(normalizeAnthropicModelId("us.anthropic.claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("strips both the us.anthropic. prefix AND the -v1:0 Bedrock version suffix", () => {
    expect(normalizeAnthropicModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("handles the eu. region prefix and a -v2:1 version suffix", () => {
    expect(normalizeAnthropicModelId("eu.anthropic.claude-x-v2:1")).toBe("claude-x");
  });

  it("handles the apac. region prefix", () => {
    expect(normalizeAnthropicModelId("apac.anthropic.claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("passes already-bare ids through unchanged", () => {
    expect(normalizeAnthropicModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(normalizeAnthropicModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("does not strip a -v1:0 fragment that is not at the end", () => {
    // Only a TRAILING Bedrock suffix is removed.
    expect(normalizeAnthropicModelId("claude-v1:0-test")).toBe("claude-v1:0-test");
  });

  it("is safe for empty / undefined input (returns empty string)", () => {
    expect(normalizeAnthropicModelId("")).toBe("");
    expect(normalizeAnthropicModelId(undefined)).toBe("");
  });
});

describe("AnthropicProvider model-id normalization at the SDK boundary", () => {
  it("passes the NORMALIZED bare id to messages.create when opts.model is Bedrock-style", async () => {
    await provider().chat(messages, {
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(lastCreateBody().model).toBe("claude-haiku-4-5-20251001");
  });

  it("passes the NORMALIZED bare id to messages.stream when opts.model is Bedrock-style", async () => {
    const chunks: ChatChunk[] = [];
    for await (const c of provider().stream(messages, {
      model: "us.anthropic.claude-sonnet-4-6",
    })) {
      chunks.push(c);
    }
    expect(lastStreamBody().model).toBe("claude-sonnet-4-6");
  });

  it("normalizes a Bedrock-style default model passed to the constructor", async () => {
    const p = new AnthropicProvider({
      apiKey: "test-key",
      model: "us.anthropic.claude-sonnet-4-6",
    });
    expect(p.model).toBe("claude-sonnet-4-6");
    await p.chat(messages, {});
    expect(lastCreateBody().model).toBe("claude-sonnet-4-6");
  });
});

describe("AnthropicProvider tool-tag stripping (#718) — stream()", () => {
  async function drain(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
    const out: ChatChunk[] = [];
    for await (const c of gen) out.push(c);
    return out;
  }
  const textDelta = (text: string) => ({
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  });
  const visible = (chunks: ChatChunk[]) =>
    chunks
      .filter((c) => c.type === "delta")
      .map((c) => (c.type === "delta" ? c.content : ""))
      .join("");

  it("converts an inline <tool_call> to a structured event and strips it from text", async () => {
    streamSpy.mockReturnValue(
      fakeStreamHandle([
        textDelta("here "),
        textDelta('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>'),
        textDelta(" done"),
      ]),
    );
    const chunks = await drain(provider().stream(messages, {}));
    expect(visible(chunks)).toBe("here  done");
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call?.type === "tool_call" && call.name).toBe("bash");
  });

  it("handles a tool tag split across two deltas without leaking a half-tag", async () => {
    streamSpy.mockReturnValue(
      fakeStreamHandle([
        textDelta("answer <tool_c"),
        textDelta('all>{"name":"grep","arguments":{}}</tool_call>!'),
      ]),
    );
    const chunks = await drain(provider().stream(messages, {}));
    expect(visible(chunks)).toBe("answer !");
    expect(visible(chunks)).not.toContain("<tool_c");
    expect(chunks.some((c) => c.type === "tool_call")).toBe(true);
  });
});

/**
 * #1226 — the terminal `done` chunk must carry Anthropic's `stop_reason` so a
 * caller can tell a finished answer (`end_turn`) apart from one the model was
 * cut off from completing (`max_tokens`).
 */
describe("AnthropicProvider stop_reason forwarding (#1226)", () => {
  async function doneChunk(final: Record<string, unknown>) {
    streamSpy.mockReturnValue(
      fakeStreamHandle(
        [{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }],
        fakeMessage(final),
      ),
    );
    const chunks: ChatChunk[] = [];
    for await (const c of provider().stream(messages)) chunks.push(c);
    return chunks.find((c) => c.type === "done");
  }

  it("forwards stop_reason=max_tokens (the model hit its output cap)", async () => {
    expect(await doneChunk({ stop_reason: "max_tokens" })).toEqual({
      type: "done",
      finishReason: "max_tokens",
    });
  });

  it("forwards a normal stop_reason=end_turn", async () => {
    expect(await doneChunk({ stop_reason: "end_turn" })).toEqual({
      type: "done",
      finishReason: "end_turn",
    });
  });

  it("omits finishReason when the final message has no stop_reason", async () => {
    expect(await doneChunk({ stop_reason: null })).toEqual({ type: "done" });
  });
});

/**
 * #1224 — the SAME signal on the NON-streaming path.
 *
 * `stream()` forwarded `stop_reason` from #1226 onwards while `chat()` dropped
 * it on the floor, so `ChatResponse.finishReason` was permanently `undefined`
 * on this provider. Every downstream truncation check therefore read "no
 * evidence" and no amount of logging on the caller's side could have fired.
 */
describe("AnthropicProvider stop_reason on chat() (#1224)", () => {
  const chatWith = async (final: Record<string, unknown>) => {
    createSpy.mockResolvedValue(fakeMessage(final));
    return provider().chat(messages);
  };

  it("surfaces stop_reason=max_tokens as finishReason", async () => {
    expect((await chatWith({ stop_reason: "max_tokens" })).finishReason).toBe("max_tokens");
  });

  it("surfaces a normal stop_reason=end_turn", async () => {
    expect((await chatWith({ stop_reason: "end_turn" })).finishReason).toBe("end_turn");
  });

  it("leaves finishReason undefined when the API reported no stop_reason", async () => {
    expect((await chatWith({ stop_reason: null })).finishReason).toBeUndefined();
  });
});

/**
 * #1257 — the SDK refuses a non-streaming request above 21,333 `max_tokens`,
 * client-side, before any network call. `chat()` is that path and the provider
 * builds its client with no `timeout`, so the throw is live here.
 *
 * These assert on the BODY handed to `messages.create`, never on what comes
 * back: the mocked SDK has no cap and emits no thinking, so a behavioural
 * assertion here would pass whatever number was sent (the trap #1224 and #1223
 * each hit).
 */
describe("AnthropicProvider non-streaming output bound (#1257)", () => {
  it("clamps an over-bound maxTokens on chat() to the SDK limit", async () => {
    // 32,768 is `DEFAULT_SECTION_MAX_OUTPUT_TOKENS` — the cap the claim
    // extractor, the faithfulness judge and the discovery agent all resolve and
    // pass to `chat()`. Unclamped it throws before the request is made.
    await provider().chat(messages, { maxTokens: 32_768 });
    expect(lastCreateBody().max_tokens).toBe(21_333);
  });

  it("passes a maxTokens inside the bound through untouched", async () => {
    await provider().chat(messages, { maxTokens: 21_000 });
    expect(lastCreateBody().max_tokens).toBe(21_000);
  });

  it("sends exactly the bound, never one more", async () => {
    await provider().chat(messages, { maxTokens: 21_333 });
    expect(lastCreateBody().max_tokens).toBe(21_333);
    await provider().chat(messages, { maxTokens: 21_334 });
    expect(lastCreateBody().max_tokens).toBe(21_333);
  });

  it("bounds the value the provider's OWN default would send", async () => {
    const p = new AnthropicProvider({ apiKey: "k", defaultMaxTokens: 40_000 });
    await p.chat(messages);
    expect(lastCreateBody().max_tokens).toBe(21_333);
  });

  it("the clamped body is one the installed SDK would actually accept", async () => {
    // The oracle again, at the boundary that matters: whatever the provider
    // sends must survive the SDK's own pre-flight check.
    const { default: RealAnthropic } =
      await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");
    const client = new RealAnthropic({ apiKey: "test-key-not-used" });
    await provider().chat(messages, { maxTokens: 128_000 });
    expect(() =>
      client.calculateNonstreamingTimeout(lastCreateBody().max_tokens as number),
    ).not.toThrow();
  });

  it("does NOT bound stream(), which carries no such SDK limit", async () => {
    // The escape hatch has to stay open, or the clamp becomes an over-block on
    // the one path that legitimately supports a larger output budget.
    for await (const _ of provider().stream(messages, { maxTokens: 64_000 })) {
      /* drain */
    }
    expect(lastStreamBody().max_tokens).toBe(64_000);
  });
});

/**
 * #1257 — thinking tokens are spent from the SAME output budget as the answer,
 * so a cap sized against the payload is sized against roughly half the request.
 * The provider is the only place the number is observable, so it maps and logs
 * it; `thinkingTokens` is allowlisted in `logger.ts` (#1263) and therefore
 * reaches the log rather than `[REDACTED]`.
 */
describe("AnthropicProvider thinking-token accounting (#1257)", () => {
  const usageWith = (details: unknown) => ({
    input_tokens: 11_300,
    output_tokens: 16_000,
    output_tokens_details: details,
  });

  it("maps output_tokens_details.thinking_tokens onto usage", async () => {
    createSpy.mockResolvedValue(
      fakeMessage({ usage: usageWith({ thinking_tokens: 9_763 }), stop_reason: "max_tokens" }),
    );
    const res = await provider().chat(messages);
    expect(res.usage.thinkingTokens).toBe(9_763);
  });

  it("maps it on the streaming path too", async () => {
    streamSpy.mockReturnValue(
      fakeStreamHandle(
        [{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }],
        fakeMessage({ usage: usageWith({ thinking_tokens: 5_088 }) }),
      ),
    );
    let thinking: number | undefined;
    for await (const chunk of provider().stream(messages)) {
      if (chunk.type === "usage") thinking = chunk.usage.thinkingTokens;
    }
    expect(thinking).toBe(5_088);
  });

  it("leaves thinkingTokens undefined when the API reported no details", async () => {
    // Absence of evidence, not a zero: a provider that does not report the field
    // must not be recorded as having thought for free.
    createSpy.mockResolvedValue(fakeMessage({ usage: usageWith(null) }));
    expect((await provider().chat(messages)).usage.thinkingTokens).toBeUndefined();
  });

  it("does not count thinking twice — output_tokens already includes it", async () => {
    createSpy.mockResolvedValue(fakeMessage({ usage: usageWith({ thinking_tokens: 9_763 }) }));
    const res = await provider().chat(messages);
    expect(res.usage.completionTokens).toBe(16_000);
    expect(res.usage.totalTokens).toBe(11_300 + 16_000);
  });
});

/**
 * #1257 (adversarial panel, `test-falsifiability`) — "thinking-token consumption
 * is logged" is an acceptance criterion, and until these cases existed
 * `logOutputBudget` and both its call sites could have been deleted wholesale
 * with the whole suite still green. Asserting `res.usage.thinkingTokens` only
 * covers `mapUsage`; it does not touch the logging path at all.
 */
describe("AnthropicProvider logs the output budget (#1257)", () => {
  const usage = (thinking: number | undefined) => ({
    input_tokens: 11_300,
    output_tokens: 16_000,
    ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
  });

  it("WARNS with the thinking count when the cap was reached", async () => {
    createSpy.mockResolvedValue(fakeMessage({ usage: usage(9_763), stop_reason: "max_tokens" }));
    await provider().chat(messages, { maxTokens: 16_000 });

    const call = logWarnSpy.mock.calls.find((c) => /output cap reached/i.test(String(c[0])));
    expect(call, "no output-cap WARN was emitted").toBeDefined();
    const meta = call![1] as Record<string, unknown>;
    expect(meta.thinkingTokens).toBe(9_763);
    expect(meta.maxTokens).toBe(16_000);
    expect(meta.outputTokens).toBe(16_000);
    expect(meta.finishReason).toBe("max_tokens");
  });

  it("logs at DEBUG, not WARN, when the run completed cleanly", async () => {
    createSpy.mockResolvedValue(fakeMessage({ usage: usage(5_088), stop_reason: "end_turn" }));
    await provider().chat(messages, { maxTokens: 21_000 });

    expect(logWarnSpy.mock.calls.filter((c) => /output cap reached/i.test(String(c[0])))).toEqual(
      [],
    );
    const call = logDebugSpy.mock.calls.find((c) => /output budget/i.test(String(c[0])));
    expect(call, "no output-budget DEBUG was emitted").toBeDefined();
    expect((call![1] as Record<string, unknown>).thinkingTokens).toBe(5_088);
  });

  it("stays silent when the provider reported no thinking breakdown", async () => {
    // Nothing to account for, so nothing is claimed — never a logged zero.
    createSpy.mockResolvedValue(fakeMessage({ usage: usage(undefined), stop_reason: "end_turn" }));
    await provider().chat(messages, { maxTokens: 21_000 });
    expect(logDebugSpy.mock.calls.filter((c) => /output budget/i.test(String(c[0])))).toEqual([]);
  });

  it("logs the same accounting on the STREAMING path", async () => {
    streamSpy.mockReturnValue(
      fakeStreamHandle(
        [{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }],
        fakeMessage({ usage: usage(8_308), stop_reason: "end_turn" }),
      ),
    );
    for await (const _ of provider().stream(messages, { maxTokens: 64_000 })) {
      /* drain */
    }
    const call = logDebugSpy.mock.calls.find((c) => /output budget/i.test(String(c[0])));
    expect(call).toBeDefined();
    const meta = call![1] as Record<string, unknown>;
    expect(meta.op).toBe("stream");
    expect(meta.thinkingTokens).toBe(8_308);
  });
});

/**
 * #1257 (adversarial panel, `instruction-correctness`) — the SDK's SECOND throw
 * condition. `Messages.create` looks the outgoing `body.model` up in
 * `MODEL_NONSTREAMING_TOKENS` and throws above 8,192 for eight `claude-opus-4*`
 * ids, well below the general 21,333. `ANTHROPIC_MODEL` is an unconstrained
 * string, so those ids are reachable in a real deployment.
 */
describe("AnthropicProvider honours the SDK's PER-MODEL non-streaming ceiling (#1257)", () => {
  it("clamps to 8192 for a listed model, where 21,333 would still have thrown", async () => {
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-opus-4-0" });
    await p.chat(messages, { maxTokens: 21_000 });
    expect(lastCreateBody().max_tokens).toBe(8_192);
  });

  it("matches on the NORMALIZED outgoing id, not the caller's Bedrock spelling", async () => {
    // `us.anthropic.claude-opus-4-1-20250805-v1:0` is not in the SDK's table;
    // what the provider actually sends — `claude-opus-4-1-20250805` — is.
    await provider().chat(messages, {
      model: "us.anthropic.claude-opus-4-1-20250805-v1:0",
      maxTokens: 21_000,
    });
    expect(lastCreateBody().model).toBe("claude-opus-4-1-20250805");
    expect(lastCreateBody().max_tokens).toBe(8_192);
  });

  it("leaves an unlisted model on the general bound", async () => {
    await provider().chat(messages, { model: "claude-sonnet-5", maxTokens: 32_768 });
    expect(lastCreateBody().max_tokens).toBe(21_333);
  });

  it("what it sends is accepted by the SDK's real pre-flight, BOTH arguments", async () => {
    // The oracle the panel said was half-blind: called with one argument this
    // passes for anything at or below 21,333 and cannot see the per-model throw.
    const { default: RealAnthropic } =
      await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");
    const client = new RealAnthropic({ apiKey: "test-key-not-used" });
    for (const model of ["claude-opus-4-0", "claude-opus-4-1-20250805", "claude-sonnet-5"]) {
      await provider().chat(messages, { model, maxTokens: 128_000 });
      const body = lastCreateBody();
      expect(
        () =>
          client.calculateNonstreamingTimeout(
            body.max_tokens as number,
            SDK_MODEL_NONSTREAMING_TOKENS[body.model as string],
          ),
        `${model} still exceeds the SDK's own pre-flight`,
      ).not.toThrow();
    }
  });
});
