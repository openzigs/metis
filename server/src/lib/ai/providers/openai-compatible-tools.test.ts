/**
 * #132 — native tool calls on the OpenAI-compatible client: the request shape,
 * streamed tool-call assembly, the catalog's "not tool-capable" gate and the
 * runtime tools-rejection fallback. No network: `fetch` is stubbed per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() }),
}));

import {
  OpenAICompatibleProvider,
  ToolCallDeltaAssembler,
  isToolsUnsupportedBody,
  resetLocalConcurrencyLimitersForTests,
} from "./openai-compatible-provider.js";
import { __resetModelCatalogForTests, MODEL_CATALOG_OVERRIDES_ENV } from "../model-catalog.js";
import { __resetCacheHitAggregatorSingleton } from "../cache-hit-telemetry.js";
import type { ChatChunk, ChatToolSpec } from "../types.js";

const TOOLS: ChatToolSpec[] = [
  { name: "search_code", description: "search", parameters: { type: "object", properties: {} } },
];

const originalFetch = globalThis.fetch;
let bodies: Array<Record<string, unknown>> = [];

/** Stub fetch with a queue of responders; each receives the parsed body. */
function stubFetch(...responders: Array<(body: Record<string, unknown>) => Response>): void {
  bodies = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    const r = responders[Math.min(i++, responders.length - 1)];
    return r(body);
  }) as unknown as typeof fetch;
}

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status });
const okText = (content: string) =>
  json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: {} });

function sse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200 },
  );
}

const make = (key: "local-gemma" | "bedrock-gateway" = "local-gemma", model = "gemma3:12b") =>
  new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "k",
    model,
    providerKey: key,
    retryBaseDelayMs: 1,
    sleepFn: async () => undefined,
  });

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

beforeEach(() => {
  logWarn.mockClear();
  __resetModelCatalogForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env[MODEL_CATALOG_OVERRIDES_ENV];
  __resetModelCatalogForTests();
  resetLocalConcurrencyLimitersForTests();
  __resetCacheHitAggregatorSingleton();
});

describe("ToolCallDeltaAssembler", () => {
  it("joins argument fragments per index even when two calls interleave", () => {
    const a = new ToolCallDeltaAssembler();
    a.push([{ index: 1, id: "b", function: { name: "read_file", arguments: "" } }]);
    a.push([{ index: 0, id: "a", function: { name: "search_code", arguments: '{"q":' } }]);
    a.push([{ index: 1, function: { arguments: '{"p":"x"' } }]);
    a.push([{ index: 0, function: { arguments: '"rate"}' } }]);
    a.push([{ index: 1, function: { arguments: "}" } }]);
    expect([...a.flush()]).toEqual([
      {
        type: "tool_call",
        name: "search_code",
        arguments: { q: "rate" },
        toolCallId: "a",
        native: true,
      },
      {
        type: "tool_call",
        name: "read_file",
        arguments: { p: "x" },
        toolCallId: "b",
        native: true,
      },
    ]);
    expect([...a.flush()]).toEqual([]);
  });

  it("keeps invalid JSON arguments as the raw string and empty arguments as {}", () => {
    const a = new ToolCallDeltaAssembler();
    a.push([
      { index: 0, id: "a", function: { name: "x", arguments: "{not json" } },
      { index: 1, id: "b", function: { name: "y" } },
      { index: 2, function: { arguments: "{}" } },
    ]);
    const out = [...a.flush()];
    expect(out).toHaveLength(2); // the nameless fragment is not a call
    expect(out[0]).toMatchObject({ arguments: "{not json" });
    expect(out[1]).toMatchObject({ arguments: {} });
  });

  it("falls back to arrival order and a synthetic id when a runtime omits index and id", () => {
    const a = new ToolCallDeltaAssembler();
    a.push([{ function: { name: "x", arguments: "{}" } }]);
    a.push(undefined);
    expect([...a.flush()]).toEqual([
      { type: "tool_call", name: "x", arguments: {}, toolCallId: "call_0", native: true },
    ]);
  });

  // PR #194 review — runtimes that repeat the name, or reuse an index.
  it("does not double a name that is repeated on a later fragment", () => {
    const a = new ToolCallDeltaAssembler();
    a.push([{ index: 0, id: "a", function: { name: "search_code", arguments: '{"q":' } }]);
    a.push([{ index: 0, function: { name: "search_code", arguments: '"x"}' } }]);
    expect([...a.flush()]).toEqual([
      {
        type: "tool_call",
        name: "search_code",
        arguments: { q: "x" },
        toolCallId: "a",
        native: true,
      },
    ]);
  });

  it("starts a new call when a new id arrives at an index already in use", () => {
    const a = new ToolCallDeltaAssembler();
    a.push([{ index: 0, id: "a", function: { name: "search_code", arguments: '{"q":"1"}' } }]);
    a.push([{ index: 0, id: "b", function: { name: "read_file", arguments: '{"p":"2"}' } }]);
    a.push([{ index: 0, id: "c", function: { name: "search_code", arguments: '{"q":' } }]);
    a.push([{ index: 0, function: { arguments: '"3"}' } }]);
    expect([...a.flush()]).toEqual([
      {
        type: "tool_call",
        name: "search_code",
        arguments: { q: "1" },
        toolCallId: "a",
        native: true,
      },
      {
        type: "tool_call",
        name: "read_file",
        arguments: { p: "2" },
        toolCallId: "b",
        native: true,
      },
      {
        type: "tool_call",
        name: "search_code",
        arguments: { q: "3" },
        toolCallId: "c",
        native: true,
      },
    ]);
  });
});

describe("isToolsUnsupportedBody", () => {
  it("matches Ollama's tools rejection and nothing that merely names a model", () => {
    expect(
      isToolsUnsupportedBody(400, "registry.ollama.ai/library/gemma3:12b does not support tools"),
    ).toBe(true);
    expect(isToolsUnsupportedBody(422, '"gemma3:12b" does not support tools')).toBe(true);
    expect(isToolsUnsupportedBody(500, "does not support tools")).toBe(false);
    expect(isToolsUnsupportedBody(404, 'model "toolsmith:7b" not found')).toBe(false);
    expect(isToolsUnsupportedBody(400, '"phi4-reasoning:14b" does not support thinking')).toBe(
      false,
    );
  });
});

describe("request shape", () => {
  it("sends tools as functions and maps every tool_choice form", async () => {
    stubFetch(() => okText("x"));
    const p = make();
    for (const [choice, wire] of [
      ["auto", "auto"],
      ["none", "none"],
      ["required", "required"],
      [{ name: "search_code" }, { type: "function", function: { name: "search_code" } }],
    ] as const) {
      await p.chat([{ role: "user", content: "hi" }], { tools: TOOLS, toolChoice: choice });
      expect(bodies.at(-1)?.tools).toEqual([
        {
          type: "function",
          function: { name: "search_code", description: "search", parameters: TOOLS[0].parameters },
        },
      ]);
      expect(bodies.at(-1)?.tool_choice).toEqual(wire);
    }
  });

  it("omits tool_choice when the caller gave none, and sends nothing when tools are disabled", async () => {
    stubFetch(() => okText("x"));
    const p = make();
    await p.chat([{ role: "user", content: "hi" }], { tools: TOOLS });
    expect(bodies.at(-1)).not.toHaveProperty("tool_choice");
    await p.chat([{ role: "user", content: "hi" }], { tools: TOOLS, disableTools: true });
    expect(bodies.at(-1)).not.toHaveProperty("tools");
  });

  it("serialises assistant tool calls and tool results; a legacy tool message is unchanged", async () => {
    stubFetch(() => okText("x"));
    await make().chat([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Looking.",
        toolCalls: [{ id: "c1", name: "x", args: { a: 1 } }],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c2", name: "y", args: '{"raw":true}' }],
      },
      { role: "tool", content: "result", toolCallId: "c1", name: "x" },
      { role: "tool", content: "legacy", name: "old" },
    ]);
    const messages = bodies[0].messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "Looking.",
      tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: '{"a":1}' } }],
    });
    expect(messages[2]).toMatchObject({ content: null });
    expect(
      (messages[2].tool_calls as Array<{ function: { arguments: string } }>)[0].function.arguments,
    ).toBe('{"raw":true}');
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" });
    expect(messages[4]).toEqual({ role: "tool", content: "legacy" });
  });

  it("parses non-streamed tool calls, keeping invalid JSON arguments raw", async () => {
    stubFetch(() =>
      json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "x", arguments: "{bad" } },
                { type: "function", function: { name: "y", arguments: "" } },
                { type: "function", function: {} },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const res = await make().chat([{ role: "user", content: "hi" }], { tools: TOOLS });
    expect(res.content).toBe("");
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([
      { id: "c1", name: "x", args: "{bad" },
      { id: "call_1", name: "y", args: {} },
    ]);
  });
});

describe("the catalog gate — a model marked not tool-capable is never sent tools", () => {
  it("drops tools for that model only, and warns once per model", async () => {
    process.env[MODEL_CATALOG_OVERRIDES_ENV] = JSON.stringify({
      "local-gemma:gemma3:12b": { capabilities: { tools: false } },
    });
    stubFetch(() => okText("x"));
    const p = make();
    expect(p.capabilitiesFor("gemma3:12b").nativeToolCalls).toBe(false);
    await p.chat([{ role: "user", content: "hi" }], { tools: TOOLS });
    await collect(p.stream([{ role: "user", content: "hi" }], { tools: TOOLS }));
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[1]).not.toHaveProperty("tools");
    await p.chat([{ role: "user", content: "hi" }], { tools: TOOLS, model: "qwen3:8b" });
    expect(bodies[2].tools).toBeDefined();
    const drops = logWarn.mock.calls.filter(([m]) =>
      String(m).includes("Dropping ChatOptions.tools"),
    );
    expect(drops).toHaveLength(1);
    expect(drops[0][1]).toMatchObject({
      provider: "local-gemma",
      model: "gemma3:12b",
      toolCount: 1,
    });
  });
});

describe("the runtime tools-rejection fallback", () => {
  const REJECT = () =>
    new Response("registry.ollama.ai/library/gemma3:12b does not support tools", { status: 400 });

  it("chat retries once without tools, keeps response_format, and remembers the model", async () => {
    stubFetch(
      REJECT,
      () => okText("answer"),
      () => okText("again"),
    );
    const p = make();
    const opts = { tools: TOOLS, responseFormat: { type: "json_object" as const } };
    const res = await p.chat([{ role: "user", content: "hi" }], opts);
    expect(res.content).toBe("answer");
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[1]).not.toHaveProperty("tools");
    // The tools 400 must not be misread as a structured-output rejection.
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
    await p.chat([{ role: "user", content: "hi" }], opts);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("tools");
  });

  it("stream retries once without tools before any token", async () => {
    stubFetch(REJECT, () =>
      sse([
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const chunks = await collect(
      make().stream([{ role: "user", content: "hi" }], { tools: TOOLS }),
    );
    expect(
      chunks.filter((c) => c.type === "delta").map((c) => (c as { content: string }).content),
    ).toEqual(["ok"]);
    expect(bodies[1]).not.toHaveProperty("tools");
  });

  it("does not retry a 400 about something else", async () => {
    stubFetch(() => new Response("bad request: messages missing", { status: 400 }));
    await expect(make().chat([{ role: "user", content: "hi" }], { tools: TOOLS })).rejects.toThrow(
      /400/,
    );
    expect(bodies).toHaveLength(1);
  });
});

describe("streamed tool calls", () => {
  it("emits assembled calls after the text and before usage/done, with finishReason", async () => {
    stubFetch(() =>
      sse([
        { choices: [{ delta: { content: "Looking" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "c1", function: { name: "x", arguments: '{"a"' } }],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      ]),
    );
    const chunks = await collect(
      make().stream([{ role: "user", content: "hi" }], { tools: TOOLS }),
    );
    expect(chunks.map((c) => c.type)).toEqual(["delta", "tool_call", "usage", "done"]);
    expect(chunks[1]).toEqual({
      type: "tool_call",
      name: "x",
      arguments: { a: 1 },
      toolCallId: "c1",
      native: true,
    });
    expect(chunks[3]).toEqual({ type: "done", finishReason: "tool_calls" });
  });

  it("emits calls when a runtime ends the stream without [DONE]", async () => {
    const enc = new TextEncoder();
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "z", arguments: "{}" } }] } }] })}\n\n`,
                ),
              );
              c.close();
            },
          }),
          { status: 200 },
        ),
    );
    const chunks = await collect(
      make().stream([{ role: "user", content: "hi" }], { tools: TOOLS }),
    );
    expect(chunks.map((c) => c.type)).toEqual(["tool_call", "done"]);
  });
});
