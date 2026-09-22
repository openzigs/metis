/**
 * #15 — a model reply that requests SEVERAL tools at once executed NONE of them.
 *
 * `parseToolCall` understood exactly one JSON object (direct, fenced, or "first
 * `{` to last `}`"). With two objects that last slice spans both and is not valid
 * JSON, so the reply was classified as a FINAL ANSWER: in chat the raw tool
 * markup was rendered to the user as the answer, and in analysis the code agent's
 * investigation stopped after one call and every requirement came back
 * `could-not-verify`. `<tool_calls>` wrappers — the shape DeepSeek emits,
 * including a nested form — were not recognised at all.
 *
 * Every test here drives the SHIPPED parser or the REAL `runAgentLoop` against a
 * provider stub that emits the multi-call reply, i.e. the model/provider boundary
 * the bug crossed.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../ai/types.js";
import type { AgentTool } from "./tools/types.js";
import {
  MAX_TOOL_CALLS_PER_REPLY,
  classifyFinalAnswer,
  looksLikeToolCallMarkup,
  parseToolCall,
  parseToolCalls,
  runAgentLoop,
} from "./agent-loop.js";
import { isJsonFinalAnswer } from "./agentic-degradation.js";

const KNOWN = ["search_code_symbols", "search_code_graph", "list_files"];

/** The reply observed live in #15, verbatim in shape (DeepSeek, nested wrapper). */
const DEEPSEEK_NESTED = [
  "<tool_calls>",
  '  <tool_calls>{"tool": "search_code_symbols", "args": {"query": "DNS rebinding SSRF", "limit": 15}}</tool_calls>',
  '  <tool_calls>{"tool": "search_code_symbols", "args": {"query": "pinned lookup"}}</tool_calls>',
  '  <tool_calls>{"tool": "search_code_graph", "args": {"query": "safeFetch"}}</tool_calls>',
  "</tool_calls>",
].join("\n");

const FINDINGS_JSON = JSON.stringify({
  agentKey: "code",
  summary: "done",
  findings: [],
  notes: [],
});

describe("#15 parseToolCalls — every encoding yields an ORDERED list of calls", () => {
  it("parses consecutive JSON objects (fails on main: first-{-to-last-} is not valid JSON)", () => {
    const text =
      '{"tool": "search_code_symbols", "args": {"query": "auth"}}\n' +
      '{"tool": "search_code_graph", "args": {"query": "session"}}';
    expect(parseToolCalls(text, KNOWN)).toEqual([
      { tool: "search_code_symbols", args: { query: "auth" } },
      { tool: "search_code_graph", args: { query: "session" } },
    ]);
    // The single-call parser still sees no call here — which is the defect.
    expect(parseToolCall(text, KNOWN)).toBeNull();
  });

  it("parses back-to-back objects with no separator at all", () => {
    expect(parseToolCalls('{"tool":"list_files"}{"tool":"search_code_graph"}', KNOWN)).toEqual([
      { tool: "list_files", args: {} },
      { tool: "search_code_graph", args: {} },
    ]);
  });

  it("parses a JSON array of calls", () => {
    const text = JSON.stringify([
      { tool: "search_code_symbols", args: { query: "a" } },
      { tool: "list_files", pattern: "src/**" },
    ]);
    expect(parseToolCalls(text, KNOWN)).toEqual([
      { tool: "search_code_symbols", args: { query: "a" } },
      // Flat-arg absorption (#774) still applies per call.
      { tool: "list_files", args: { pattern: "src/**" } },
    ]);
  });

  it("parses a fenced JSON array of calls", () => {
    const text =
      "Let me look.\n```json\n" +
      JSON.stringify([{ tool: "list_files" }, { tool: "search_code_graph" }]) +
      "\n```";
    expect(parseToolCalls(text, KNOWN)?.map((c) => c.tool)).toEqual([
      "list_files",
      "search_code_graph",
    ]);
  });

  it("parses a flat <tool_calls> wrapper", () => {
    const text =
      '<tool_calls>{"tool":"list_files","args":{"pattern":"*.ts"}}' +
      '{"tool":"search_code_graph","args":{"query":"x"}}</tool_calls>';
    expect(parseToolCalls(text, KNOWN)).toEqual([
      { tool: "list_files", args: { pattern: "*.ts" } },
      { tool: "search_code_graph", args: { query: "x" } },
    ]);
  });

  it("parses the nested <tool_calls> form DeepSeek emits, in order", () => {
    expect(parseToolCalls(DEEPSEEK_NESTED, KNOWN)).toEqual([
      { tool: "search_code_symbols", args: { query: "DNS rebinding SSRF", limit: 15 } },
      { tool: "search_code_symbols", args: { query: "pinned lookup" } },
      { tool: "search_code_graph", args: { query: "safeFetch" } },
    ]);
  });

  it("parses a <tool_calls> wrapper around a single call", () => {
    expect(
      parseToolCalls(
        '<tool_calls>{"tool":"list_files","args":{"pattern":"a"}}</tool_calls>',
        KNOWN,
      ),
    ).toEqual([{ tool: "list_files", args: { pattern: "a" } }]);
  });

  it("returns a single call exactly as parseToolCall does", () => {
    const text = '{"tool":"search_code_graph","args":{"query":"auth"}}';
    expect(parseToolCalls(text, KNOWN)).toEqual([parseToolCall(text, KNOWN)]);
  });

  it("does not split a call on braces inside a string argument", () => {
    // UNBALANCED braces inside strings: a scanner that ignored string literals
    // would close the first call at the `}` in its query and lose it.
    const text =
      '{"tool":"search_code_symbols","args":{"query":"close } here"}}' +
      '{"tool":"search_code_graph","args":{"query":"open { there"}}';
    expect(parseToolCalls(text, KNOWN)).toEqual([
      { tool: "search_code_symbols", args: { query: "close } here" } },
      { tool: "search_code_graph", args: { query: "open { there" } },
    ]);
  });

  it("does not end a string argument at an ESCAPED quote", () => {
    // `\"` must not close the literal, or the `}` after it would close the call.
    const text =
      '{"tool":"search_code_symbols","args":{"query":"say \\"}\\" now"}}' + '{"tool":"list_files"}';
    expect(parseToolCalls(text, KNOWN)).toEqual([
      { tool: "search_code_symbols", args: { query: 'say "}" now' } },
      { tool: "list_files", args: {} },
    ]);
  });

  it("ignores prose and non-call JSON between calls", () => {
    const text =
      'First I will list files: {"tool":"list_files"} and then {"note":"not a call"} ' +
      'search the graph: {"tool":"search_code_graph","args":{"query":"x"}}';
    expect(parseToolCalls(text, KNOWN)?.map((c) => c.tool)).toEqual([
      "list_files",
      "search_code_graph",
    ]);
  });

  it("returns null for prose", () => {
    expect(parseToolCalls("The answer is that DNS rebinding is blocked.", KNOWN)).toBeNull();
    expect(parseToolCalls("", KNOWN)).toBeNull();
  });

  it("SAFETY: a findings answer is never a tool call, even beside tool-shaped objects", () => {
    expect(parseToolCalls(FINDINGS_JSON, KNOWN)).toBeNull();
    expect(parseToolCalls(`{"tool":"list_files"}\n${FINDINGS_JSON}`, KNOWN)).toBeNull();
    expect(parseToolCalls(`[${FINDINGS_JSON}, {"tool":"list_files"}]`, KNOWN)).toBeNull();
  });

  it("classifies a multi-call reply as a tool call, not as JSON or prose", () => {
    expect(classifyFinalAnswer(DEEPSEEK_NESTED)).toBe("tool-call");
    expect(classifyFinalAnswer('{"tool":"list_files"}{"tool":"search_code_graph"}')).toBe(
      "tool-call",
    );
  });

  it("isJsonFinalAnswer rejects a multi-call reply (it used to accept the first object)", () => {
    expect(isJsonFinalAnswer('{"tool":"list_files"}\n{"tool":"search_code_graph"}')).toBe(false);
    expect(isJsonFinalAnswer(FINDINGS_JSON)).toBe(true);
  });
});

describe("#15 looksLikeToolCallMarkup — unparseable tool markup is still recognised", () => {
  it.each([
    ["an unterminated <tool_calls> wrapper", '<tool_calls>{"tool": "search_code_symbols", "args":'],
    ["a truncated call object", '{"tool": "search_code_graph", "args": {"query": "x"'],
    ["a truncated fenced call", '```json\n  {"tool": "list_files", "args": {'],
    ["a truncated array of calls", '[ {"tool": "list_files"}, {"tool": '],
    [
      "a truncated singular <tool_call> (Qwen shape)",
      '<tool_call>{"name": "search", "arguments": {',
    ],
    ["a broken wrapper after a preamble", 'Let me search.\n<tool_calls>\n  <tool_calls>{"tool": '],
    ["an empty wrapper", "<tool_calls>\n</tool_calls>"],
  ])("recognises %s", (_label, text) => {
    expect(looksLikeToolCallMarkup(text)).toBe(true);
  });

  it.each([
    ["prose", "DNS rebinding is blocked by the pinned lookup."],
    ["a findings answer", FINDINGS_JSON],
    ["prose that merely mentions a tool", "I used search_code_graph to find it."],
    ["JSON whose first key is not tool", '{"answer": "tool"}'],
    [
      "prose that explains the <tool_calls> format",
      "DeepSeek wraps calls in a `<tool_calls>` element; METIS now parses <tool_calls> wrappers.",
    ],
  ])("does not flag %s", (_label, text) => {
    expect(looksLikeToolCallMarkup(text)).toBe(false);
  });
});

describe("#15 parsing stays linear on untrusted model output (ReDoS)", () => {
  function fastestMs(fn: () => unknown, runs = 3): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }

  // Each shape is a worst case for a naive "try every `{` as a start" scanner or
  // for an unanchored whitespace-heavy regex.
  const SHAPES: Array<[string, (n: number) => string]> = [
    ["unclosed opening braces", (n) => "{".repeat(n)],
    ["an unclosed string inside an object", (n) => '{"tool":"' + "a".repeat(n)],
    ["a run of escaped quotes", (n) => '{"tool":"' + '\\"'.repeat(n / 2)],
    ["repeated wrapper tags", (n) => "<tool_calls>".repeat(Math.floor(n / 12))],
    ["whitespace after a fence", (n) => "```json" + " ".repeat(n)],
    ["whitespace inside a call prefix", (n) => "[" + " ".repeat(n / 2) + "{" + " ".repeat(n / 2)],
    ["many tiny valid calls", (n) => '{"tool":"list_files"}'.repeat(Math.floor(n / 21))],
  ];

  it.each(SHAPES)(
    "parses 200 KB of %s in under 100 ms",
    (_label, make) => {
      const input = make(200 * 1024);
      parseToolCalls('{"tool":"list_files"}', KNOWN); // warm the JIT
      const ms = fastestMs(() => {
        parseToolCalls(input, KNOWN);
        looksLikeToolCallMarkup(input);
        classifyFinalAnswer(input);
      });
      expect(ms).toBeLessThan(100);
    },
    60_000,
  );

  it.each(SHAPES)(
    "scales linearly with input length for %s",
    (_label, make) => {
      const run = (n: number) => () => {
        parseToolCalls(make(n), KNOWN);
        looksLikeToolCallMarkup(make(n));
      };
      parseToolCalls('{"tool":"list_files"}', KNOWN);
      const small = fastestMs(run(50 * 1024));
      const large = fastestMs(run(200 * 1024));
      // 4x the input: linear predicts ~4x, quadratic ~16x.
      expect(large).toBeLessThan(small * 8 + 25);
    },
    60_000,
  );
});

// ── The loop ────────────────────────────────────────────────────────────────

const reply = (content: string): ChatResponse => ({
  content,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  model: "stub",
  provider: "offline-stub",
});

function scriptedProvider(responses: string[]): {
  provider: AIProvider;
  seen: ChatMessage[][];
} {
  let i = 0;
  const seen: ChatMessage[][] = [];
  const provider = {
    key: "offline-stub",
    model: "stub",
    offline: true,
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      seen.push(messages.map((m) => ({ ...m })));
      const content = responses[Math.min(i, responses.length - 1)] as string;
      i += 1;
      return reply(content);
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return ["stub"];
    },
    async ping() {
      return true;
    },
  } as unknown as AIProvider;
  return { provider, seen };
}

/** A tool that records the order it ran in, via a shared log. */
function recordingTool(name: string, log: string[]): AgentTool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: { query: { type: "string" } } },
    async execute(args: unknown) {
      const query = (args as { query?: string }).query ?? "";
      log.push(`${name}:${query}`);
      return { content: `RESULT(${name}:${query})`, resultCount: 1 };
    },
  };
}

const loopInput = (tools: AgentTool[]) =>
  ({
    systemMessage: "You are Winston.",
    userMessage: "Investigate REQ-001.",
    tools,
    toolContext: { projectId: "proj-1" },
  }) as Parameters<typeof runAgentLoop>[1];

describe("#15 runAgentLoop executes every call in a multi-call reply", () => {
  it("runs each call in order and returns ALL results to the model next turn", async () => {
    const order: string[] = [];
    const tools = [
      recordingTool("search_code_symbols", order),
      recordingTool("search_code_graph", order),
    ];
    const { provider, seen } = scriptedProvider([DEEPSEEK_NESTED, FINDINGS_JSON]);
    const onToolCall = vi.fn();

    const result = await runAgentLoop(provider, loopInput(tools), { maxTurns: 5, onToolCall });

    // Executed, in the order the model asked for them.
    expect(order).toEqual([
      "search_code_symbols:DNS rebinding SSRF",
      "search_code_symbols:pinned lookup",
      "search_code_graph:safeFetch",
    ]);
    expect(result.toolCalls.map((c) => c.tool)).toEqual([
      "search_code_symbols",
      "search_code_symbols",
      "search_code_graph",
    ]);
    expect(onToolCall).toHaveBeenCalledTimes(3);

    // Every result reached the model on the NEXT turn, in order, in one message.
    expect(seen).toHaveLength(2);
    const next = seen[1] as ChatMessage[];
    const toolTurn = next[next.length - 1] as ChatMessage;
    expect(toolTurn.role).toBe("user");
    const a = toolTurn.content.indexOf("RESULT(search_code_symbols:DNS rebinding SSRF)");
    const b = toolTurn.content.indexOf("RESULT(search_code_symbols:pinned lookup)");
    const c = toolTurn.content.indexOf("RESULT(search_code_graph:safeFetch)");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);

    // The investigation continued to a real final answer.
    expect(result.finalResponse).toBe(FINDINGS_JSON);
    expect(result.turnsUsed).toBe(2);
  });

  it("keeps the single-call tool-result message byte-identical", async () => {
    const order: string[] = [];
    const { provider, seen } = scriptedProvider([
      '{"tool":"search_code_graph","args":{"query":"x"}}',
      FINDINGS_JSON,
    ]);
    await runAgentLoop(provider, loopInput([recordingTool("search_code_graph", order)]), {
      maxTurns: 3,
    });
    const next = seen[1] as ChatMessage[];
    expect(next[next.length - 1]?.content).toBe(
      "Tool result for search_code_graph:\nRESULT(search_code_graph:x)",
    );
  });

  it(`executes at most ${MAX_TOOL_CALLS_PER_REPLY} calls from one reply and says so`, async () => {
    const order: string[] = [];
    const many = Array.from(
      { length: MAX_TOOL_CALLS_PER_REPLY + 3 },
      (_, i) => `{"tool":"search_code_graph","args":{"query":"q${i}"}}`,
    ).join("\n");
    const { provider, seen } = scriptedProvider([many, FINDINGS_JSON]);

    const result = await runAgentLoop(
      provider,
      loopInput([recordingTool("search_code_graph", order)]),
      { maxTurns: 3 },
    );

    expect(order).toHaveLength(MAX_TOOL_CALLS_PER_REPLY);
    expect(result.toolCalls).toHaveLength(MAX_TOOL_CALLS_PER_REPLY);
    const next = seen[1] as ChatMessage[];
    expect(next[next.length - 1]?.content).toContain(
      `only the first ${MAX_TOOL_CALLS_PER_REPLY} of ${MAX_TOOL_CALLS_PER_REPLY + 3}`,
    );
  });

  it("answers an unknown tool inside a batch with a repair error and still runs the rest", async () => {
    const order: string[] = [];
    const { provider, seen } = scriptedProvider([
      '{"tool":"made_up"}{"tool":"search_code_graph","args":{"query":"y"}}',
      FINDINGS_JSON,
    ]);
    const result = await runAgentLoop(
      provider,
      loopInput([recordingTool("search_code_graph", order)]),
      { maxTurns: 3 },
    );
    expect(order).toEqual(["search_code_graph:y"]);
    expect(result.toolCalls.map((c) => c.isError === true)).toEqual([true, false]);
    const next = seen[1] as ChatMessage[];
    expect(next[next.length - 1]?.content).toContain('Unknown tool "made_up"');
  });

  it("stops executing a batch once the caller aborts", async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const aborting: AgentTool = {
      name: "search_code_graph",
      description: "aborts the run after its first call",
      parameters: { type: "object", properties: {} },
      async execute() {
        ran.push("x");
        ac.abort();
        return { content: "r" };
      },
    };
    const { provider } = scriptedProvider([
      '{"tool":"search_code_graph"}{"tool":"search_code_graph"}',
    ]);
    await expect(
      runAgentLoop(provider, loopInput([aborting]), { maxTurns: 3, signal: ac.signal }),
    ).rejects.toThrow(/Abort/);
    expect(ran).toEqual(["x"]);
  });
});

describe("#15 tool markup is never returned as the answer", () => {
  it("replaces an UNPARSEABLE <tool_calls> reply with the safe fallback", async () => {
    const broken = '<tool_calls>\n  <tool_calls>{"tool": "search_code_symbols", "args": {"query"';
    const { provider } = scriptedProvider([broken]);
    const result = await runAgentLoop(provider, loopInput([]), { maxTurns: 2 });

    expect(result.finalResponse).not.toContain("<tool_calls>");
    expect(result.finalResponse).not.toContain('"tool"');
    expect(result.hasFinalAnswer).toBe(false);
  });

  it("replaces a multi-call reply left over at the turn cap with the safe fallback", async () => {
    const order: string[] = [];
    const { provider } = scriptedProvider([DEEPSEEK_NESTED]);
    const result = await runAgentLoop(
      provider,
      loopInput([
        recordingTool("search_code_symbols", order),
        recordingTool("search_code_graph", order),
      ]),
      { maxTurns: 1 },
    );
    expect(result.turnsExhausted).toBe(true);
    expect(result.finalResponse).not.toContain("<tool_calls>");
    expect(result.finalResponse).toMatch(/tool-call limit/);
  });

  it("asks for a final answer (salvage retry) when the model's last reply is broken markup", async () => {
    const broken = '{"tool": "search_code_graph", "args": {"query": "x"';
    const { provider, seen } = scriptedProvider([broken, FINDINGS_JSON]);
    const result = await runAgentLoop(provider, loopInput([]), {
      maxTurns: 1,
      finalAnswerRetry: { instruction: "Answer now." },
    });
    expect(seen).toHaveLength(2);
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
    expect(result.finalResponse).toBe(FINDINGS_JSON);
  });
});
