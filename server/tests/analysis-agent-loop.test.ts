/**
 * Tests for the multi-turn agent loop engine (Epic #473 — Issues #477, #478).
 *
 * Covers: tool call parsing, loop execution, budget enforcement, abort handling.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import {
  runAgentLoop,
  parseToolCall,
  formatToolDescriptions,
} from "../src/lib/analysis/agent-loop.js";
import type { AgentTool, ToolContext, ToolResult } from "../src/lib/analysis/tools/types.js";

const stubResponse = (content: string, tokens = 100): ChatResponse => ({
  content,
  usage: { promptTokens: tokens / 2, completionTokens: tokens / 2, totalTokens: tokens },
  model: "stub",
  provider: "offline-stub",
});

function makeProvider(responses: string[]): AIProvider {
  let callIndex = 0;
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async () =>
      stubResponse(responses[callIndex++] ?? responses[responses.length - 1]),
    ),
    stream: vi.fn(async function* () {
      yield { type: "done" };
    }),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0, model: "stub" })),
    models: vi.fn(async () => ["stub"]),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;
}

function makeTool(name: string, handler?: (args: unknown) => Promise<ToolResult>): AgentTool {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: handler ?? (async () => ({ content: `Result from ${name}` })),
  };
}

const FINDINGS_JSON = JSON.stringify({
  agentKey: "code",
  summary: "Analysis complete",
  findings: [
    {
      category: "architecture",
      severity: "medium",
      title: "Missing abstraction",
      body: "The service layer lacks proper abstraction.",
      tags: ["architecture"],
      citations: [],
    },
  ],
  notes: [],
});

const TOOL_CALL_JSON = JSON.stringify({
  tool: "search_code_graph",
  args: { query: "UserService" },
});

// ════════════════════════════════════════════════════════════════════════
// parseToolCall
// ════════════════════════════════════════════════════════════════════════
describe("parseToolCall", () => {
  it("parses a valid tool call", () => {
    const result = parseToolCall('{"tool": "search_code_graph", "args": {"query": "user"}}');
    expect(result).toEqual({ tool: "search_code_graph", args: { query: "user" } });
  });

  it("returns null for final findings JSON (no tool field)", () => {
    const result = parseToolCall(FINDINGS_JSON);
    expect(result).toBeNull();
  });

  it("returns null for plain text response", () => {
    expect(parseToolCall("I'm done analyzing the code.")).toBeNull();
  });

  it("parses tool call inside markdown fences", () => {
    const response = '```json\n{"tool": "read_file_slice", "args": {"filePath": "src/a.ts"}}\n```';
    const result = parseToolCall(response);
    expect(result).toEqual({ tool: "read_file_slice", args: { filePath: "src/a.ts" } });
  });

  it("parses tool call with prose around it", () => {
    const response = 'Let me search for that.\n{"tool": "list_files", "args": {"pattern": "*.ts"}}';
    const result = parseToolCall(response);
    expect(result).toEqual({ tool: "list_files", args: { pattern: "*.ts" } });
  });

  it("handles empty args", () => {
    const result = parseToolCall('{"tool": "list_files"}');
    expect(result).toEqual({ tool: "list_files", args: {} });
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatToolDescriptions
// ════════════════════════════════════════════════════════════════════════
describe("formatToolDescriptions", () => {
  it("formats tool descriptions for the system prompt (compact mode)", () => {
    const tools = [makeTool("search_code_graph"), makeTool("read_file_slice")];
    const result = formatToolDescriptions(tools);
    expect(result).toContain("Available tools:");
    expect(result).toContain("search_code_graph");
    expect(result).toContain("read_file_slice");
    expect(result).toContain('{"tool": "<name>"');
  });

  it("formats full mode with parameter details", () => {
    const tools = [makeTool("search_code_graph")];
    const result = formatToolDescriptions(tools, "full");
    expect(result).toContain("- search_code_graph");
    expect(result).toContain("query: string");
  });

  it("returns empty string for no tools", () => {
    expect(formatToolDescriptions([])).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════════════
// runAgentLoop
// ════════════════════════════════════════════════════════════════════════
describe("runAgentLoop", () => {
  const toolContext: ToolContext = { projectId: "proj-123" };

  it("single-shot mode (maxTurns=1) returns first response directly", async () => {
    const provider = makeProvider([FINDINGS_JSON]);
    const result = await runAgentLoop(provider, {
      systemMessage: "You are an agent.",
      userMessage: "Analyze this code.",
      tools: [],
      toolContext,
    });

    expect(result.finalResponse).toBe(FINDINGS_JSON);
    expect(result.turnsUsed).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.budgetExhausted).toBe(false);
  });

  it("executes a tool call and continues the loop", async () => {
    const provider = makeProvider([TOOL_CALL_JSON, FINDINGS_JSON]);
    const searchTool = makeTool("search_code_graph", async () => ({
      content: "method UserService.findById — src/user.ts:10-20",
    }));

    const result = await runAgentLoop(
      provider,
      {
        systemMessage: "You are an agent.",
        userMessage: "Find the user service.",
        tools: [searchTool],
        toolContext,
      },
      { maxTurns: 5 },
    );

    expect(result.turnsUsed).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("search_code_graph");
    expect(result.finalResponse).toBe(FINDINGS_JSON);
  });

  it("handles multiple tool calls in sequence", async () => {
    const call1 = JSON.stringify({ tool: "list_files", args: { pattern: "*.ts" } });
    const call2 = JSON.stringify({ tool: "read_file_slice", args: { filePath: "a.ts" } });

    const provider = makeProvider([call1, call2, FINDINGS_JSON]);
    const tools = [
      makeTool("list_files", async () => ({ content: "a.ts\nb.ts" })),
      makeTool("read_file_slice", async () => ({ content: "1| const x = 1;" })),
    ];

    const result = await runAgentLoop(
      provider,
      { systemMessage: "sys", userMessage: "user", tools, toolContext },
      { maxTurns: 10 },
    );

    expect(result.turnsUsed).toBe(3);
    expect(result.toolCalls).toHaveLength(2);
  });

  it("reports unknown tool error back to the agent", async () => {
    const badCall = JSON.stringify({ tool: "nonexistent", args: {} });
    const provider = makeProvider([badCall, FINDINGS_JSON]);

    await runAgentLoop(
      provider,
      { systemMessage: "sys", userMessage: "user", tools: [makeTool("real_tool")], toolContext },
      { maxTurns: 5 },
    );

    // The provider's second call should include the error message
    const chatFn = provider.chat as ReturnType<typeof vi.fn>;
    const secondCall = chatFn.mock.calls[1]?.[0] as ChatMessage[];
    const toolResultMsg = secondCall?.find((m) => m.content.includes("Unknown tool"));
    expect(toolResultMsg).toBeDefined();
  });

  it("enforces token budget and sets budgetExhausted flag", async () => {
    // Each call uses 100 tokens, budget is 150
    const provider = makeProvider([TOOL_CALL_JSON, TOOL_CALL_JSON, FINDINGS_JSON]);
    const tools = [makeTool("search_code_graph")];

    const result = await runAgentLoop(
      provider,
      { systemMessage: "sys", userMessage: "user", tools, toolContext },
      { maxTurns: 10, maxTokens: 150 },
    );

    expect(result.budgetExhausted).toBe(true);
    expect(result.turnsUsed).toBe(2);
    expect(result.usage.totalTokens).toBeGreaterThan(150);
  });

  it("stops at maxTurns", async () => {
    // Agent keeps calling tools forever
    const infiniteToolCall = JSON.stringify({ tool: "search_code_graph", args: {} });
    const provider = makeProvider([infiniteToolCall, infiniteToolCall, infiniteToolCall]);
    const tools = [makeTool("search_code_graph")];

    const result = await runAgentLoop(
      provider,
      { systemMessage: "sys", userMessage: "user", tools, toolContext },
      { maxTurns: 3 },
    );

    expect(result.turnsUsed).toBe(3);
  });

  it("propagates abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = makeProvider([FINDINGS_JSON]);
    await expect(
      runAgentLoop(
        provider,
        { systemMessage: "sys", userMessage: "user", tools: [], toolContext },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Aborted");
  });

  it("handles tool execution errors gracefully", async () => {
    const errorTool = makeTool("failing_tool", async () => {
      throw new Error("Database connection failed");
    });
    const toolCall = JSON.stringify({ tool: "failing_tool", args: {} });
    const provider = makeProvider([toolCall, FINDINGS_JSON]);

    const result = await runAgentLoop(
      provider,
      { systemMessage: "sys", userMessage: "user", tools: [errorTool], toolContext },
      { maxTurns: 5 },
    );

    expect(result.turnsUsed).toBe(2);
    expect(result.toolCalls[0].resultPreview).toContain("Error executing tool");
  });

  it("includes the full tool definitions in the cached system message (#398)", async () => {
    const provider = makeProvider([FINDINGS_JSON]);
    const tools = [makeTool("my_tool")];

    await runAgentLoop(
      provider,
      { systemMessage: "Base system.", userMessage: "user", tools, toolContext },
      { maxTurns: 1 },
    );

    const chatFn = provider.chat as ReturnType<typeof vi.fn>;
    const opts = chatFn.mock.calls[0]?.[1];
    // #398 — runAgentLoop now folds the full JSON-schema tool definitions into
    // the byte-stable cached prefix (under the standing analysis protocol).
    expect(opts?.systemMessage).toContain("Available tools (full definitions)");
    expect(opts?.systemMessage).toContain("my_tool");
    expect(opts?.systemMessage).toContain("METIS Analysis Protocol");
    expect(opts?.systemMessage).toContain("Base system.");
  });
});
