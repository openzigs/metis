/**
 * #198 — extended thinking in a multi-turn tool loop on the Anthropic Messages
 * client, and on DeepSeek's Anthropic-compatible endpoint (manual `enabled`
 * thinking there, adaptive on Claude):
 *
 *   1. the assistant turn that issued `tool_use` is replayed with its `thinking`
 *      / `redacted_thinking` blocks — verbatim, in the order generated;
 *   2. a forced tool choice with thinking on is sent as `auto` (thinking kept),
 *      and sent unchanged when thinking is explicitly off.
 *
 * Rules checked against platform.claude.com/docs/en/build-with-claude/thinking
 * ("Preserving thinking blocks"; "Tool choice limitation"). The SDK is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { __resetModelCatalogForTests } from "../model-catalog.js";
import type { ChatChunk, ChatMessage, ChatToolSpec } from "../types.js";

const TOOLS: ChatToolSpec[] = [
  { name: "search_code", description: "search", parameters: { type: "object", properties: {} } },
];
const THINKING = { type: "thinking", thinking: "", signature: "sig-A" };
const REDACTED = { type: "redacted_thinking", data: "opaque-B" };
const PROGRESS = { type: "thinking", thinking: "", signature: "sig-C" };
const TOOL_USE_1 = { type: "tool_use", id: "toolu_1", name: "search_code", input: { q: "a" } };
const TOOL_USE_2 = { type: "tool_use", id: "toolu_2", name: "search_code", input: { q: "b" } };

const message = (content: unknown[], stop = "tool_use") => ({
  content,
  model: "claude-sonnet-5",
  stop_reason: stop,
  usage: { input_tokens: 5, output_tokens: 2 },
});

const lastParams = () => createSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;

beforeEach(() => {
  createSpy.mockReset();
  streamSpy.mockReset();
  logWarn.mockClear();
  __resetModelCatalogForTests();
});

/** Drive a two-turn tool loop exactly as the shared agent loop does. */
async function twoTurnLoop(p: AnthropicProvider): Promise<Record<string, unknown>> {
  const first = await p.chat([{ role: "user", content: "find it" }], {
    tools: TOOLS,
    reasoningEffort: "high",
  });
  const history: ChatMessage[] = [
    { role: "user", content: "find it" },
    {
      role: "assistant",
      content: first.content,
      toolCalls: first.toolCalls,
      ...(first.nativeContent ? { nativeContent: first.nativeContent } : {}),
    },
    ...(first.toolCalls ?? []).map(
      (c): ChatMessage => ({ role: "tool", toolCallId: c.id, name: c.name, content: "found" }),
    ),
  ];
  await p.chat(history, { tools: TOOLS, reasoningEffort: "high" });
  return lastParams();
}

describe.each([
  ["Claude (adaptive thinking)", undefined, "adaptive"],
  ["DeepSeek endpoint (manual thinking)", "https://api.deepseek.com/anthropic", "enabled"],
])("#198 two-turn tool loop with reasoningEffort — %s", (_label, baseUrl, thinkingType) => {
  const make = () =>
    new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      ...(baseUrl ? { baseUrl } : {}),
    });

  it("replays the tool_use turn with its thinking blocks, verbatim and in order", async () => {
    // Interleaved: reasoning, a call, a progress update, a second call.
    createSpy
      .mockResolvedValueOnce(message([THINKING, TOOL_USE_1, REDACTED, PROGRESS, TOOL_USE_2]))
      .mockResolvedValueOnce(message([{ type: "text", text: "done" }], "end_turn"));
    const second = await twoTurnLoop(make());
    expect(second.thinking).toEqual({ type: thinkingType });
    const msgs = second.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: [THINKING, TOOL_USE_1, REDACTED, PROGRESS, TOOL_USE_2],
    });
    // Both calls are answered, in one user turn, after the replayed turn.
    expect(msgs[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "found" },
        { type: "tool_result", tool_use_id: "toolu_2", content: "found" },
      ],
    });
  });

  it("a turn without thinking replays as text + tool_use (no nativeContent)", async () => {
    createSpy
      .mockResolvedValueOnce(message([{ type: "text", text: "looking" }, TOOL_USE_1]))
      .mockResolvedValueOnce(message([{ type: "text", text: "done" }], "end_turn"));
    const second = await twoTurnLoop(make());
    const msgs = second.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "toolu_1", name: "search_code", input: { q: "a" } },
      ],
    });
  });
});

describe("#198 nativeContent carriage", () => {
  const make = () => new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5" });

  it("chat() carries the turn's blocks only when it has reasoning AND a tool_use", async () => {
    createSpy.mockResolvedValueOnce(message([THINKING, TOOL_USE_1]));
    const withBoth = await make().chat([{ role: "user", content: "x" }], { tools: TOOLS });
    expect(withBoth.nativeContent).toEqual({
      provider: "anthropic",
      blocks: [THINKING, TOOL_USE_1],
    });

    createSpy.mockResolvedValueOnce(
      message([THINKING, { type: "text", text: "answer" }], "end_turn"),
    );
    const noTool = await make().chat([{ role: "user", content: "x" }]);
    expect(noTool.nativeContent).toBeUndefined();
  });

  it("stream() carries them on the done chunk", async () => {
    streamSpy.mockReturnValueOnce({
      controller: { abort: vi.fn() },
      async *[Symbol.asyncIterator]() {
        /* no text */
      },
      finalMessage: async () => message([THINKING, TOOL_USE_1]),
    });
    const chunks: ChatChunk[] = [];
    for await (const c of make().stream([{ role: "user", content: "x" }], { tools: TOOLS })) {
      chunks.push(c);
    }
    const done = chunks.find((c) => c.type === "done") as Extract<ChatChunk, { type: "done" }>;
    expect(done.nativeContent).toEqual({ provider: "anthropic", blocks: [THINKING, TOOL_USE_1] });
  });

  it("another provider's nativeContent is ignored on the Anthropic wire", async () => {
    createSpy.mockResolvedValueOnce(message([{ type: "text", text: "ok" }], "end_turn"));
    await make().chat(
      [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "calling",
          toolCalls: [{ id: "t1", name: "search_code", args: {} }],
          nativeContent: { provider: "other" as "anthropic", blocks: [{ type: "bogus" }] },
        },
        { role: "tool", toolCallId: "t1", content: "r" },
      ],
      { tools: TOOLS },
    );
    const msgs = lastParams().messages as Array<{ role: string; content: unknown }>;
    expect(msgs[1]!.content).toEqual([
      { type: "text", text: "calling" },
      { type: "tool_use", id: "t1", name: "search_code", input: {} },
    ]);
  });
});

describe("#198 forced tool choice under thinking", () => {
  const make = (baseUrl?: string) =>
    new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      ...(baseUrl ? { baseUrl } : {}),
    });

  beforeEach(() => {
    createSpy.mockResolvedValue(message([{ type: "text", text: "ok" }], "end_turn"));
  });

  it.each([
    ["required", "required" as const],
    ["a named tool", { name: "search_code" }],
  ])("downgrades %s to auto and KEEPS the thinking + effort", async (_l, toolChoice) => {
    const p = make();
    await p.chat([{ role: "user", content: "x" }], {
      tools: TOOLS,
      toolChoice,
      reasoningEffort: "medium",
    });
    const params = lastParams();
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(logWarn).toHaveBeenCalledTimes(1);
    // One warning per provider instance, not per call.
    await p.chat([{ role: "user", content: "x" }], {
      tools: TOOLS,
      toolChoice,
      reasoningEffort: "medium",
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("on DeepSeek's manual mode too", async () => {
    await make("https://api.deepseek.com/anthropic").chat([{ role: "user", content: "x" }], {
      tools: TOOLS,
      toolChoice: "required",
      reasoningEffort: "high",
    });
    expect(lastParams().tool_choice).toEqual({ type: "auto" });
    expect(lastParams().thinking).toEqual({ type: "enabled" });
  });

  it("sends the forced choice unchanged when thinking is off or not requested", async () => {
    await make().chat([{ role: "user", content: "x" }], {
      tools: TOOLS,
      toolChoice: "required",
      reasoningEffort: "high",
      disableThinking: true,
    });
    expect(lastParams().tool_choice).toEqual({ type: "any" });
    await make().chat([{ role: "user", content: "x" }], {
      tools: TOOLS,
      toolChoice: { name: "search_code" },
    });
    expect(lastParams().tool_choice).toEqual({ type: "tool", name: "search_code" });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("auto and none pass through with thinking on", async () => {
    await make().chat([{ role: "user", content: "x" }], {
      tools: TOOLS,
      toolChoice: "none",
      reasoningEffort: "high",
    });
    expect(lastParams().tool_choice).toEqual({ type: "none" });
  });
});
