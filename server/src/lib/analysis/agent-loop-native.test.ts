/**
 * #141 — the analysis agent loop on NATIVE tool calls.
 *
 *   • tools go out as native definitions, calls come back on the provider's
 *     tool channel, results go back as `tool` messages answering each call id;
 *   • several calls in one reply execute IN ORDER, and every call id is
 *     answered — including those over the per-reply cap;
 *   • a reply that still calls tools on the last turn is not an answer;
 *   • the text protocol is untouched when native mode is not requested, and
 *     native mode is chosen only for a tool-capable model (and, on the analysis
 *     path, only with ANALYSIS_NATIVE_TOOL_CALLS on).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TOOL_CALLS_PER_REPLY,
  NATIVE_TOOL_PROTOCOL,
  analysisNativeToolCallsEnabled,
  nativeToolSpecsFor,
  runAgentLoop,
} from "./agent-loop.js";
import {
  OfflineStubProvider,
  type OfflineScriptTurn,
} from "../ai/providers/offline-stub-provider.js";
import type { AgentTool } from "./tools/types.js";
import type { AIProvider, ChatMessage } from "../ai/types.js";

const order: string[] = [];
function tool(name: string): AgentTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    async execute(args) {
      const q = (args as { q?: string }).q ?? "";
      order.push(`${name}:${q}`);
      return { content: `RESULT ${name}:${q}`, resultCount: 1 };
    },
  };
}
const TOOLS = [tool("search_code_graph"), tool("search_code_symbols")];
const input = {
  systemMessage: "ROLE",
  userMessage: "TASK",
  tools: TOOLS,
  toolContext: { projectId: "p1" },
};
const call = (id: string, name: string, q: string) => ({ id, name, args: { q } });
const native = {
  tools: nativeToolSpecsFor(new OfflineStubProvider({ script: [] }), undefined, TOOLS)!.tools,
};

afterEach(() => {
  order.length = 0;
  delete process.env.ANALYSIS_NATIVE_TOOL_CALLS;
});

function stub(script: OfflineScriptTurn[]): OfflineStubProvider {
  return new OfflineStubProvider({ script });
}

describe("#141 native tool calls in runAgentLoop", () => {
  it("offers native definitions, runs several calls in ORDER, answers each call id", async () => {
    const p = stub([
      {
        content: "",
        toolCalls: [
          call("c1", "search_code_symbols", "a"),
          call("c2", "search_code_graph", "b"),
          call("c3", "search_code_symbols", "c"),
        ],
      },
      { content: '{"findings":[]}' },
    ]);
    const result = await runAgentLoop(p, input, { maxTurns: 4, native });
    expect(order).toEqual([
      "search_code_symbols:a",
      "search_code_graph:b",
      "search_code_symbols:c",
    ]);
    expect(result.finalResponse).toBe('{"findings":[]}');
    expect(result.hasFinalAnswer).toBe(true);
    expect(result.toolCalls.map((c) => c.callId)).toEqual(["c1", "c2", "c3"]);

    const first = p.requests[0]!;
    expect(first.opts.tools?.map((t) => t.name)).toEqual([
      "search_code_graph",
      "search_code_symbols",
    ]);
    expect(first.opts.toolChoice).toBe("auto");
    // The text-protocol manifest is NOT rendered in native mode.
    expect(first.opts.systemMessage).toContain(NATIVE_TOOL_PROTOCOL);
    expect(first.opts.systemMessage).not.toContain('{"tool": "<name>"');

    const second = p.requests[1]!.messages;
    const assistant = second.find((m) => m.role === "assistant")!;
    expect(assistant.toolCalls?.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    const results = second.filter((m) => m.role === "tool");
    expect(results.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(String(results[0]!.content)).toMatch(/^Tool result for search_code_symbols:\n/);
    expect(String(results[0]!.content)).toContain("===METIS-DATA-BOUNDARY===");
    expect(String(results[0]!.content)).toContain("RESULT search_code_symbols:a");
  });

  it("answers calls over the per-reply cap with an error result instead of running them", async () => {
    const many = Array.from({ length: MAX_TOOL_CALLS_PER_REPLY + 2 }, (_, i) =>
      call(`c${i}`, "search_code_graph", String(i)),
    );
    const p = stub([{ toolCalls: many }, { content: "done" }]);
    await runAgentLoop(p, input, { maxTurns: 3, native });
    expect(order).toHaveLength(MAX_TOOL_CALLS_PER_REPLY);
    const toolMsgs = p.requests[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(MAX_TOOL_CALLS_PER_REPLY + 2);
    expect(toolMsgs.at(-1)).toMatchObject({ isError: true });
    expect(String(toolMsgs.at(-1)!.content)).toMatch(/not executed/);
  });

  it("replays the provider's native content (#198) on the tool-calling turn", async () => {
    const nativeContent = { provider: "anthropic" as const, blocks: [{ type: "thinking" }] };
    const provider = {
      key: "anthropic",
      model: "m",
      offline: false,
      capabilities: { responseFormat: false, nativeToolCalls: true },
      seen: [] as ChatMessage[][],
      async chat(messages: ChatMessage[]) {
        this.seen.push(messages);
        return this.seen.length === 1
          ? {
              content: "",
              toolCalls: [call("c1", "search_code_graph", "x")],
              nativeContent,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "m",
              provider: "anthropic" as const,
            }
          : {
              content: "answer",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "m",
              provider: "anthropic" as const,
            };
      },
    };
    await runAgentLoop(provider as unknown as AIProvider, input, { maxTurns: 3, native });
    const assistant = provider.seen[1]!.find((m) => m.role === "assistant")!;
    expect(assistant.nativeContent).toEqual(nativeContent);
  });

  it("a reply still calling tools on the last turn is not an answer", async () => {
    const p = stub([
      { content: "Let me look further.", toolCalls: [call("c1", "search_code_graph", "x")] },
    ]);
    const result = await runAgentLoop(p, input, { maxTurns: 1, native });
    expect(result.turnsExhausted).toBe(true);
    expect(result.hasFinalAnswer).toBe(false);
    expect(result.finalResponse).toMatch(/tool-call limit/);
    expect(result.salvageSource).toBe("Let me look further.");
  });

  it("the final-answer retry stays tool-free (toolChoice none) and does not repeat the turn", async () => {
    const p = stub([
      { content: "", toolCalls: [call("c1", "search_code_graph", "x")] },
      { content: '{"findings":[]}' },
    ]);
    const result = await runAgentLoop(p, input, {
      maxTurns: 1,
      native,
      finalAnswerRetry: { instruction: "ANSWER NOW" },
    });
    expect(result.finalAnswerRetry).toEqual({ attempted: true, succeeded: true });
    expect(result.finalResponse).toBe('{"findings":[]}');
    const retry = p.requests[1]!;
    expect(retry.opts.toolChoice).toBe("none");
    expect(retry.opts.tools).toBeDefined();
    const assistants = retry.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(retry.messages.at(-1)).toEqual({ role: "user", content: "ANSWER NOW" });
  });

  it("a budget stop leaves the un-run calls out of the retry transcript", async () => {
    const p = stub([
      {
        content: "thinking aloud",
        toolCalls: [call("c1", "search_code_graph", "x")],
        usage: { totalTokens: 10_000 },
      },
      { content: '{"findings":[]}' },
    ]);
    const result = await runAgentLoop(p, input, {
      maxTurns: 3,
      maxTokens: 100,
      native,
      finalAnswerRetry: { instruction: "ANSWER NOW" },
    });
    expect(result.budgetExhausted).toBe(true);
    expect(order).toEqual([]);
    const retry = p.requests[1]!.messages;
    expect(retry.some((m) => m.toolCalls)).toBe(false);
    expect(retry).toContainEqual({ role: "assistant", content: "thinking aloud" });
  });

  it("routes calls through a caller's executor (the chat gate seam)", async () => {
    const executeTool = vi.fn(async (c: { id: string; tool: string }) => ({
      content: `gated ${c.tool}`,
      tool: `canonical:${c.tool}`,
      fullText: "FULL",
    }));
    const p = stub([{ toolCalls: [call("c1", "search_code_graph", "x")] }, { content: "ok" }]);
    const result = await runAgentLoop(p, input, { maxTurns: 3, native, executeTool });
    expect(order).toEqual([]); // the tool's own execute is never reached directly
    expect(executeTool).toHaveBeenCalledWith({
      id: "c1",
      tool: "search_code_graph",
      args: { q: "x" },
    });
    expect(result.toolCalls[0]).toMatchObject({
      tool: "canonical:search_code_graph",
      result: "FULL",
    });
  });

  it("uses a caller's model function when given (the streaming seam)", async () => {
    const p = stub([]);
    const callModel = vi.fn(async () => ({
      content: "streamed answer",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "m",
      provider: "offline-stub" as const,
    }));
    const result = await runAgentLoop(p, input, { maxTurns: 2, native, callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result.finalResponse).toBe("streamed answer");
  });

  it("text protocol is unchanged when native mode is not requested", async () => {
    const p = stub([
      { content: '{"tool": "search_code_graph", "args": {"q": "x"}}' },
      { content: '{"findings":[]}' },
    ]);
    const result = await runAgentLoop(p, input, { maxTurns: 3 });
    expect(order).toEqual(["search_code_graph:x"]);
    expect(p.requests[0]!.opts.tools).toBeUndefined();
    expect(p.requests[1]!.messages.at(-1)).toEqual({
      role: "user",
      content: "Tool result for search_code_graph:\nRESULT search_code_graph:x",
    });
    expect(result.toolCalls[0]!.callId).toBe("call_1");
  });

  it("#1225 compaction also bounds native `tool` results", async () => {
    const big: AgentTool = {
      name: "search_code_graph",
      description: "g",
      parameters: { type: "object" },
      execute: async () => ({ content: "line\n" + "x".repeat(20_000) }),
    };
    const p = stub([
      { toolCalls: [call("c1", "search_code_graph", "a")] },
      { toolCalls: [call("c2", "search_code_graph", "b")] },
      { content: "done" },
    ]);
    const result = await runAgentLoop(
      p,
      { ...input, tools: [big] },
      {
        maxTurns: 4,
        native,
        transcriptCompaction: { maxTranscriptTokens: 2_000, preserveRecentTurns: 1 },
      },
    );
    expect(result.transcriptCompaction?.messagesCompacted).toBeGreaterThan(0);
    const firstResult = p.requests[2]!.messages.find((m) => m.toolCallId === "c1")!;
    expect(String(firstResult.content)).toContain("transcript compaction (#1225)");
    expect(String(firstResult.content)).toMatch(/^Tool result for search_code_graph:\n/);
  });

  it("native mode ignores tool-shaped JSON in prose", async () => {
    const p = stub([{ content: '{"tool": "search_code_graph", "args": {"q": "x"}}' }]);
    await runAgentLoop(p, input, { maxTurns: 2, native });
    expect(order).toEqual([]);
  });
});

describe("#141 choosing native mode", () => {
  it("only for a tool-capable model", () => {
    expect(nativeToolSpecsFor(new OfflineStubProvider(), undefined, TOOLS)).toBeUndefined();
    expect(
      nativeToolSpecsFor(new OfflineStubProvider({ script: [] }), undefined, []),
    ).toBeUndefined();
    const specs = nativeToolSpecsFor(new OfflineStubProvider({ script: [] }), "m", TOOLS)!;
    expect(specs.tools.map((t) => t.name)).toEqual(["search_code_graph", "search_code_symbols"]);
  });

  it("the analysis path needs ANALYSIS_NATIVE_TOOL_CALLS on (default off)", () => {
    expect(analysisNativeToolCallsEnabled()).toBe(false);
    for (const v of ["true", "1", "on", " ON "]) {
      process.env.ANALYSIS_NATIVE_TOOL_CALLS = v;
      expect(analysisNativeToolCallsEnabled()).toBe(true);
    }
    process.env.ANALYSIS_NATIVE_TOOL_CALLS = "off";
    expect(analysisNativeToolCallsEnabled()).toBe(false);
  });
});
