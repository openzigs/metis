/**
 * #40 — since #15 the agent loop runs EVERY tool call in one reply (up to
 * `MAX_TOOL_CALLS_PER_REPLY`), but all three tool-protocol blocks still told the
 * model "Call tools one at a time" / "Call one tool at a time", so a model that
 * obeyed spent one turn per search.
 *
 * These tests pin the protocol text of every tool serialization the cached
 * prefix can carry — `schema` (the #398 default), `compact` (the runtime
 * default manifest) and `full` — byte-for-byte, so the only prompt text that
 * changed is the multi-call sentence, and they prove the forms the prompt
 * advertises are forms the shipped parser actually accepts.
 */
import { describe, expect, it } from "vitest";
import type { AgentTool } from "./tools/types.js";
import {
  MAX_TOOL_CALLS_PER_REPLY,
  buildCachedSystemPrompt,
  formatToolDescriptions,
  formatToolSchemas,
  parseToolCalls,
} from "./agent-loop.js";

const TOOL: AgentTool = {
  name: "search_code",
  description: "Search code",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Query" } },
    required: ["query"],
  },
  execute: async () => ({ content: "ok" }),
};

const CALL_LINE =
  'To call a tool, respond with ONLY a JSON object: {"tool": "<name>", "args": {<parameters>}}';
const MULTI_LINE =
  "You may request several tools in one reply, as consecutive JSON objects or as a JSON array of them " +
  `(at most ${MAX_TOOL_CALLS_PER_REPLY} per reply); they run in order and every result comes back on the next turn. ` +
  "After receiving tool results, you may call more tools or provide your final answer.";

describe("tool-protocol prompt text (#40)", () => {
  it("compact manifest: exact protocol block, multi-call sentence included", () => {
    expect(formatToolDescriptions([TOOL], "compact")).toBe(
      [
        "",
        "Available tools:",
        "  search_code: Search code",
        "",
        "Use get_tool_schema to see full parameters for any tool before calling it.",
        CALL_LINE,
        "To provide your final answer, respond with your findings JSON directly (not wrapped in a tool call).",
        MULTI_LINE,
      ].join("\n"),
    );
  });

  it("full manifest: exact protocol block, multi-call sentence included", () => {
    expect(formatToolDescriptions([TOOL], "full")).toBe(
      [
        "",
        "Available tools:",
        "- search_code(query: string — Query): Search code",
        "",
        CALL_LINE,
        "To provide your final answer, respond with your findings JSON directly (not wrapped in a tool call).",
        MULTI_LINE,
      ].join("\n"),
    );
  });

  it("schema block (the cached-prefix default): exact protocol paragraph", () => {
    const text = formatToolSchemas([TOOL]);
    const paragraph = text.split("\n\n### Tool:")[0];
    expect(paragraph).toBe(
      [
        "",
        "## Available tools (full definitions)",
        "",
        "These tool definitions are fixed for this session. Call a tool by",
        'responding with ONLY a JSON object: {"tool": "<name>", "args": {<parameters>}}.',
        "You may request several tools in one reply, as consecutive JSON objects or as",
        `a JSON array of them (at most ${MAX_TOOL_CALLS_PER_REPLY} per reply); they run in order and every`,
        "result comes back on the next turn. After the tool results you may call more",
        "tools or, once you have finished investigating, respond with your findings JSON",
        "directly (not wrapped in a tool call). Validate every argument against the",
        "tool's parameter schema before use.",
      ].join("\n"),
    );
  });

  it.each(["schema", "compact", "full"] as const)(
    "%s: no longer tells the model to call tools one at a time",
    (toolFormat) => {
      const prefix = buildCachedSystemPrompt("role", [TOOL], { toolFormat });
      expect(prefix).not.toMatch(/one (tool )?at a time/i);
      expect(prefix).toContain(`at most ${MAX_TOOL_CALLS_PER_REPLY} per reply`);
    },
  );

  it("every form the prompt advertises is one the shipped parser runs in full", () => {
    const a = '{"tool": "search_code", "args": {"query": "a"}}';
    const b = '{"tool": "search_code", "args": {"query": "b"}}';
    for (const reply of [`${a}\n${b}`, `[${a}, ${b}]`]) {
      const calls = parseToolCalls(reply, ["search_code"]);
      expect(calls?.map((c) => c.args.query)).toEqual(["a", "b"]);
    }
  });
});
