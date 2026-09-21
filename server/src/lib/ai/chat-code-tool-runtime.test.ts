/**
 * Epic #712 / Issue #713 — chat-facing code-tool runtime + loop reuse tests.
 *
 * Proves the two hard requirements at the module boundary (no route, no live
 * LLM/gateway/embedder): (1) code tools are OFFERED (deterministic, name-ordered
 * schema block for the byte-stable lead) and (2) EXECUTED via the shared agent
 * loop — parsed, run against the session project, fed back, then a final answer
 * — with each tool call surfaced as a structured `tool_call`, never raw text.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildChatCodeToolRuntime,
  runChatCodeToolTurn,
  CHAT_CODE_TOOL_MAX_TURNS,
} from "./chat-code-tool-runtime.js";
import { parseToolCall } from "../analysis/agent-loop.js";
import type { AgentTool, ToolResult } from "../analysis/tools/types.js";
import type { AIProvider, ChatMessage, ChatResponse } from "./types.js";

/** A provider whose `chat` returns a scripted sequence of responses. */
function scriptedProvider(responses: string[]): {
  provider: AIProvider;
  chat: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const chat = vi.fn(async (): Promise<ChatResponse> => {
    const content = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      content,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "test-model",
      provider: "bedrock-gateway",
    };
  });
  const provider = {
    key: "bedrock-gateway",
    model: "test-model",
    offline: false,
    chat,
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
  return { provider, chat };
}

describe("buildChatCodeToolRuntime", () => {
  it("is disabled (no tools, empty schema block) when the flag is off", () => {
    const rt = buildChatCodeToolRuntime({ enabled: false, projectId: "p1" });
    expect(rt.enabled).toBe(false);
    expect(rt.tools).toEqual([]);
    expect(rt.schemaBlock).toBe("");
  });

  it("is disabled when the session has no project (never search another project's graph)", () => {
    const rt = buildChatCodeToolRuntime({ enabled: true, projectId: null });
    expect(rt.enabled).toBe(false);
    expect(rt.schemaBlock).toBe("");
  });

  it("offers search_code_graph + search_code_symbols with a deterministic, name-ordered schema block", () => {
    const a = buildChatCodeToolRuntime({ enabled: true, projectId: "p1" });
    const b = buildChatCodeToolRuntime({ enabled: true, projectId: "p1" });

    expect(a.enabled).toBe(true);
    expect(a.tools.map((t) => t.name).sort()).toEqual(["search_code_graph", "search_code_symbols"]);

    // Byte-identical across builds (feeds the cache-stable prompt lead).
    expect(a.schemaBlock).toBe(b.schemaBlock);
    // Ordered by tool name: search_code_graph before search_code_symbols.
    expect(a.schemaBlock.indexOf("search_code_graph")).toBeLessThan(
      a.schemaBlock.indexOf("search_code_symbols"),
    );
    // The schema block carries the textual tool-call protocol.
    expect(a.schemaBlock).toContain("search_code_graph");
    expect(a.schemaBlock).toContain('{"tool": "<name>", "args": {<parameters>}}');
  });
});

describe("runChatCodeToolTurn", () => {
  /** A capturing tool that records the project it was executed against. */
  function captureTool(name: string, result: string): { tool: AgentTool; seen: string[] } {
    const seen: string[] = [];
    const tool: AgentTool = {
      name,
      description: `desc ${name}`,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx): Promise<ToolResult> => {
        seen.push(ctx.projectId);
        return { content: result };
      },
    };
    return { tool, seen };
  }

  it("parses a tool call, executes it against session.projectId, feeds it back, then answers", async () => {
    const { tool, seen } = captureTool("search_code_graph", "class Foo — src/foo.ts:1-9");
    const { provider, chat } = scriptedProvider([
      '{"tool": "search_code_graph", "args": {"query": "Foo"}}',
      "Foo is defined at src/foo.ts:1-9.",
    ]);

    const toolCalls: Array<{ tool: string; args: unknown }> = [];
    const result = await runChatCodeToolTurn(
      provider,
      {
        messages: [{ role: "user", content: "where is Foo?" }],
        tools: [tool],
        projectId: "proj-abc",
      },
      { onToolCall: (c) => toolCalls.push(c) },
    );

    // Executed against the session project — no cross-project leakage.
    expect(seen).toEqual(["proj-abc"]);
    // Surfaced as a structured tool_call (name + args), not raw text.
    expect(toolCalls).toEqual([{ tool: "search_code_graph", args: { query: "Foo" } }]);
    // Final prose answer returned (not the tool-call JSON).
    expect(result.finalResponse).toBe("Foo is defined at src/foo.ts:1-9.");
    expect(result.toolCalls).toEqual([{ tool: "search_code_graph", args: { query: "Foo" } }]);
    expect(result.turnsUsed).toBe(2);
    // The tool result was fed back to the model on the second turn.
    const secondTurnMessages = chat.mock.calls[1][0] as ChatMessage[];
    expect(JSON.stringify(secondTurnMessages)).toContain("class Foo — src/foo.ts:1-9");
  });

  it("passes providerChatOptions verbatim and omits an empty systemMessage", async () => {
    const { tool } = captureTool("search_code_graph", "ok");
    const { provider, chat } = scriptedProvider(["final answer, no tool call"]);

    await runChatCodeToolTurn(
      provider,
      {
        messages: [
          { role: "system", content: "LEAD" },
          { role: "user", content: "hi" },
        ],
        tools: [tool],
        projectId: "p",
      },
      {
        providerChatOptions: {
          callType: "chat",
          sessionId: "sess-1",
          promptCaching: { system: true },
        },
      },
    );

    const opts = chat.mock.calls[0][1];
    expect(opts.callType).toBe("chat");
    expect(opts.sessionId).toBe("sess-1");
    expect(opts.promptCaching).toEqual({ system: true });
    // systemPrompt "" ⇒ no systemMessage option (chat keeps system content in the messages array).
    expect(opts.systemMessage).toBeUndefined();
    // The route's pre-built conversation is used verbatim as the initial messages.
    const firstTurnMessages = chat.mock.calls[0][0] as ChatMessage[];
    expect(firstTurnMessages[0]).toEqual({ role: "system", content: "LEAD" });
  });

  it("bounds iterations AND never leaks raw tool-call JSON when the budget is exhausted mid-call", async () => {
    const { tool } = captureTool("search_code_graph", "result");
    // Always a tool call → the loop hits CHAT_CODE_TOOL_MAX_TURNS with the model
    // STILL emitting a parseable tool call on the final allowed turn (#713 (d) /
    // #718: this is the leak path — finalResponse must NOT be protocol JSON).
    const toolCallJson = '{"tool": "search_code_graph", "args": {}}';
    const { provider, chat } = scriptedProvider([toolCallJson]);

    const result = await runChatCodeToolTurn(provider, {
      messages: [{ role: "user", content: "loop" }],
      tools: [tool],
      projectId: "p",
    });

    // Bound is unchanged: exactly maxTurns model calls, no extra synthesis call.
    expect(chat).toHaveBeenCalledTimes(CHAT_CODE_TOOL_MAX_TURNS);
    expect(result.turnsUsed).toBe(CHAT_CODE_TOOL_MAX_TURNS);

    // The returned answer is a safe, human-readable fallback — NOT the raw
    // tool-protocol JSON the model was still emitting on the final turn.
    expect(result.finalResponse).not.toBe(toolCallJson);
    expect(parseToolCall(result.finalResponse)).toBeNull();
    expect(result.finalResponse).toContain("tool-call limit");
    expect(result.finalResponse).not.toContain('"tool"');
  });

  it("survives an onToolCall callback that throws (best-effort surfacing)", async () => {
    const { tool } = captureTool("search_code_graph", "result");
    const { provider } = scriptedProvider([
      '{"tool": "search_code_graph", "args": {}}',
      "final answer after a throwing callback",
    ]);

    const result = await runChatCodeToolTurn(
      provider,
      { messages: [{ role: "user", content: "q" }], tools: [tool], projectId: "p" },
      {
        onToolCall: () => {
          throw new Error("surfacing sink blew up");
        },
      },
    );

    // The throw is swallowed; the loop still executes the tool and answers.
    expect(result.toolCalls).toEqual([{ tool: "search_code_graph", args: {} }]);
    expect(result.finalResponse).toBe("final answer after a throwing callback");
  });

  it("answers directly (no tool_call frames) when the model needs no tool", async () => {
    const { tool, seen } = captureTool("search_code_graph", "unused");
    const { provider } = scriptedProvider(["Direct answer without any tool."]);
    const toolCalls: unknown[] = [];

    const result = await runChatCodeToolTurn(
      provider,
      { messages: [{ role: "user", content: "hello" }], tools: [tool], projectId: "p" },
      { onToolCall: (c) => toolCalls.push(c) },
    );

    expect(seen).toEqual([]);
    expect(toolCalls).toEqual([]);
    expect(result.finalResponse).toBe("Direct answer without any tool.");
  });
});
