/**
 * #133 — native tools and structured output on the Anthropic Messages client:
 * `tools` / `tool_choice`, `tool_use` → typed calls, `tool_result` turns,
 * cache-control placement with tools in the prefix, `output_config.format`
 * and its single 400 fallback. The SDK is mocked; nothing dials out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSpy, streamSpy, logWarn } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  streamSpy: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: streamSpy };
    models = { list: vi.fn() };
    constructor(_opts: unknown) {
      /* no network */
    }
  }
  return { default: FakeAnthropic };
});
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() }),
}));

import { AnthropicProvider } from "./anthropic-provider.js";
import { __resetModelCatalogForTests, MODEL_CATALOG_OVERRIDES_ENV } from "../model-catalog.js";
import type { ChatChunk, ChatMessage, ChatToolSpec, JsonSchemaResponseFormat } from "../types.js";

const TOOLS: ChatToolSpec[] = [
  { name: "search_code", description: "search", parameters: { type: "object", properties: {} } },
  { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
];
const SCHEMA: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "v",
    schema: { type: "object", properties: { n: { type: "integer", minimum: 0 } }, required: ["n"] },
  },
};
const USER: ChatMessage[] = [{ role: "user", content: "hi" }];

const message = (content: unknown[], stop = "end_turn") => ({
  content,
  model: "claude-sonnet-5",
  stop_reason: stop,
  usage: { input_tokens: 5, output_tokens: 2 },
});

const make = (baseUrl?: string) =>
  new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5", ...(baseUrl ? { baseUrl } : {}) });

const lastParams = () => createSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function fakeStream(final: unknown, texts: string[] = [], failWith?: unknown) {
  return {
    controller: { abort: vi.fn() },
    async *[Symbol.asyncIterator]() {
      if (failWith) throw failWith;
      for (const t of texts)
        yield { type: "content_block_delta", delta: { type: "text_delta", text: t } };
    },
    finalMessage: async () => final,
  };
}

beforeEach(() => {
  createSpy.mockReset();
  streamSpy.mockReset();
  logWarn.mockClear();
  __resetModelCatalogForTests();
  createSpy.mockResolvedValue(message([{ type: "text", text: "ok" }]));
});
afterEach(() => {
  delete process.env[MODEL_CATALOG_OVERRIDES_ENV];
  delete process.env.ANTHROPIC_PROMPT_CACHE_TTL;
  __resetModelCatalogForTests();
});

describe("tools on the request", () => {
  it("sends tools with input_schema and maps every tool_choice form", async () => {
    const p = make();
    for (const [choice, wire] of [
      ["auto", { type: "auto" }],
      ["none", { type: "none" }],
      ["required", { type: "any" }],
      [{ name: "read_file" }, { type: "tool", name: "read_file" }],
    ] as const) {
      await p.chat(USER, { tools: TOOLS, toolChoice: choice });
      expect(lastParams().tools).toEqual([
        { name: "search_code", description: "search", input_schema: TOOLS[0].parameters },
        { name: "read_file", description: "read", input_schema: TOOLS[1].parameters },
      ]);
      expect(lastParams().tool_choice).toEqual(wire);
    }
    await p.chat(USER, { tools: TOOLS });
    expect(lastParams()).not.toHaveProperty("tool_choice");
  });

  it("sends no tools when disabled or when the catalog marks the model not tool-capable", async () => {
    const p = make();
    await p.chat(USER, { tools: TOOLS, disableTools: true });
    expect(lastParams()).not.toHaveProperty("tools");
    process.env[MODEL_CATALOG_OVERRIDES_ENV] = JSON.stringify({
      "anthropic:claude-sonnet-5": { capabilities: { tools: false } },
    });
    __resetModelCatalogForTests();
    await p.chat(USER, { tools: TOOLS });
    expect(lastParams()).not.toHaveProperty("tools");
    expect(logWarn.mock.calls.some(([m]) => String(m).includes("Dropping ChatOptions.tools"))).toBe(
      true,
    );
  });
});

describe("tool results and replayed calls", () => {
  it("replays tool_use blocks and merges consecutive results into one user turn", async () => {
    await make().chat([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [
          { id: "t1", name: "search_code", args: { q: "x" } },
          { id: "t2", name: "read_file", args: undefined },
        ],
      },
      { role: "tool", content: "found", toolCallId: "t1" },
      { role: "tool", content: "boom", toolCallId: "t2", isError: true },
      { role: "tool", content: "legacy text", name: "old" },
    ]);
    const messages = lastParams().messages as Array<{ role: string; content: unknown }>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t1", name: "search_code", input: { q: "x" } },
        { type: "tool_use", id: "t2", name: "read_file", input: {} },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "found" },
        { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
      ],
    });
    // A tool message without a call id keeps the pre-#133 folding into a user turn.
    expect(messages[3]).toEqual({ role: "user", content: "legacy text" });
  });

  it("an assistant turn with only tool calls sends no empty text block", async () => {
    await make().chat([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", args: {} }] },
      { role: "tool", content: "r", toolCallId: "t1" },
    ]);
    const messages = lastParams().messages as Array<{ content: Array<{ type: string }> }>;
    expect(messages[1].content.map((b) => b.type)).toEqual(["tool_use"]);
  });
});

describe("tool calls in the response", () => {
  it("chat returns several tool_use blocks as typed calls, in order", async () => {
    createSpy.mockResolvedValue(
      message(
        [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "t1", name: "search_code", input: { q: "rate" } },
          { type: "tool_use", id: "t2", name: "read_file", input: { path: "a" } },
        ],
        "tool_use",
      ),
    );
    const res = await make().chat(USER, { tools: TOOLS });
    expect(res.content).toBe("Let me look.");
    expect(res.finishReason).toBe("tool_use");
    expect(res.toolCalls).toEqual([
      { id: "t1", name: "search_code", args: { q: "rate" } },
      { id: "t2", name: "read_file", args: { path: "a" } },
    ]);
  });

  it("stream yields the calls from the final message after the text and before usage/done", async () => {
    streamSpy.mockReturnValue(
      fakeStream(
        message(
          [
            { type: "text", text: "Hm." },
            { type: "tool_use", id: "t1", name: "search_code", input: { q: "a" } },
            { type: "tool_use", id: "t2", name: "read_file" },
          ],
          "tool_use",
        ),
        ["Hm."],
      ),
    );
    const chunks = await collect(make().stream(USER, { tools: TOOLS }));
    expect(chunks.map((c) => c.type)).toEqual(["delta", "tool_call", "tool_call", "usage", "done"]);
    expect(chunks[1]).toEqual({
      type: "tool_call",
      name: "search_code",
      arguments: { q: "a" },
      toolCallId: "t1",
      native: true,
    });
    expect(chunks[2]).toMatchObject({ toolCallId: "t2", arguments: {} });
    expect(chunks[4]).toEqual({ type: "done", finishReason: "tool_use" });
  });
});

describe("cache-control placement with tools (#696/#700 prefix rules)", () => {
  it("a system breakpoint covers the tools — no tool carries its own", async () => {
    await make().chat(USER, {
      tools: TOOLS,
      systemMessage: "You are METIS.",
      promptCaching: { system: true },
    });
    const p = lastParams();
    expect(p.system).toEqual([
      { type: "text", text: "You are METIS.", cache_control: { type: "ephemeral" } },
    ]);
    for (const t of p.tools as Array<Record<string, unknown>>)
      expect(t).not.toHaveProperty("cache_control");
  });

  it("with no system prompt, the LAST tool carries the breakpoint", async () => {
    await make().chat(USER, { tools: TOOLS, promptCaching: { system: true } });
    const tools = lastParams().tools as Array<Record<string, unknown>>;
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(lastParams()).not.toHaveProperty("system");
  });

  it("uncached requests put no breakpoint on tools; messages caching marks the last tool_result", async () => {
    const p = make();
    await p.chat(USER, { tools: TOOLS });
    for (const t of lastParams().tools as Array<Record<string, unknown>>) {
      expect(t).not.toHaveProperty("cache_control");
    }
    await p.chat(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", args: {} }] },
        { role: "tool", content: "r", toolCallId: "t1" },
      ],
      { tools: TOOLS, promptCaching: { messages: true } },
    );
    const messages = lastParams().messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[2].content[0]).toMatchObject({
      type: "tool_result",
      cache_control: { type: "ephemeral" },
    });
  });
});

describe("structured output — output_config.format", () => {
  it("sends the SDK-fitted schema, next to any effort", async () => {
    await make().chat(USER, { responseFormat: SCHEMA, reasoningEffort: "high" });
    expect(lastParams().output_config).toEqual({
      effort: "high",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { n: { type: "integer", description: "{minimum: 0}" } },
          additionalProperties: false,
          required: ["n"],
        },
      },
    });
  });

  it("sends an untransformable schema as-is", async () => {
    const odd: JsonSchemaResponseFormat = {
      type: "json_schema",
      json_schema: { name: "odd", schema: { properties: {} } },
    };
    await make().chat(USER, { responseFormat: odd });
    expect((lastParams().output_config as { format: { schema: unknown } }).format.schema).toEqual({
      properties: {},
    });
  });

  it("drops json_object (no Messages API mode) and every format on DeepSeek, warning once", async () => {
    await make().chat(USER, { responseFormat: { type: "json_object" } });
    expect(lastParams()).not.toHaveProperty("output_config");
    const ds = make("https://api.deepseek.com/anthropic");
    expect(ds.capabilitiesFor("deepseek-v4-pro").jsonSchema).toBe(false);
    await ds.chat(USER, { responseFormat: SCHEMA });
    expect(lastParams()).not.toHaveProperty("output_config");
  });

  it("a 400 on a request carrying the format is retried ONCE without it (effort kept)", async () => {
    createSpy
      .mockRejectedValueOnce(
        Object.assign(new Error("output_config.format: bad schema"), { status: 400 }),
      )
      .mockResolvedValueOnce(message([{ type: "text", text: "free-form" }]));
    const res = await make().chat(USER, { responseFormat: SCHEMA, reasoningEffort: "low" });
    expect(res.content).toBe("free-form");
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[1][0].output_config).toEqual({ effort: "low" });
  });

  it("the retry drops output_config entirely when the format was all it held", async () => {
    createSpy
      .mockRejectedValueOnce(Object.assign(new Error("bad"), { status: 400 }))
      .mockResolvedValueOnce(message([{ type: "text", text: "x" }]));
    await make().chat(USER, { responseFormat: SCHEMA });
    expect(createSpy.mock.calls[1][0]).not.toHaveProperty("output_config");
  });

  it("does not retry a non-400, nor a 400 on a request without a format", async () => {
    createSpy.mockRejectedValue(Object.assign(new Error("overloaded"), { status: 529 }));
    await expect(make().chat(USER, { responseFormat: SCHEMA })).rejects.toThrow(/overloaded/);
    expect(createSpy).toHaveBeenCalledTimes(1);
    createSpy.mockReset();
    createSpy.mockRejectedValue(Object.assign(new Error("bad"), { status: 400 }));
    await expect(make().chat(USER)).rejects.toThrow(/bad/);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("stream retries without the format when the 400 arrives before any event", async () => {
    const final = message([{ type: "text", text: "ok" }]);
    streamSpy
      .mockReturnValueOnce(
        fakeStream(final, [], Object.assign(new Error("bad schema"), { status: 400 })),
      )
      .mockReturnValueOnce(fakeStream(final, ["ok"]));
    const chunks = await collect(make().stream(USER, { responseFormat: SCHEMA }));
    expect(chunks.find((c) => c.type === "delta")).toEqual({ type: "delta", content: "ok" });
    expect(streamSpy.mock.calls[1][0]).not.toHaveProperty("output_config");
  });

  it("stream does not retry once something was yielded", async () => {
    const final = message([{ type: "text", text: "ok" }]);
    const failing = {
      controller: { abort: vi.fn() },
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } };
        throw Object.assign(new Error("bad"), { status: 400 });
      },
      finalMessage: async () => final,
    };
    streamSpy.mockReturnValueOnce(failing);
    await expect(collect(make().stream(USER, { responseFormat: SCHEMA }))).rejects.toThrow(/bad/);
    expect(streamSpy).toHaveBeenCalledTimes(1);
  });
});
