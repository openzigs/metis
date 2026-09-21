/**
 * P0 #774 — `parseToolCall` silently DROPPED tool arguments the model emitted at
 * the TOP LEVEL of the JSON object instead of nested under `"args"`.
 *
 * `{"tool":"search_code_symbols","query":"drift severity"}` parsed to
 * `args: {}`, so:
 *   - param'd tools bounced with a misleading "query is required" (the model DID
 *     supply the query), and
 *   - `search_code_graph` — which has NO required params — executed an
 *     UNFILTERED query and returned the same first-30-alphabetical symbols every
 *     call: plausible-looking poison the agent then treated as real evidence
 *     (the proximate cause of the #773 incident).
 *
 * These tests drive the REAL `runAgentLoop` against a provider stub that EMITS
 * the flat shape — the model/provider boundary, never a private method. That is
 * the boundary the bug actually crossed.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../ai/types.js";
import type { AgentTool } from "./tools/types.js";
import { parseToolCall, runAgentLoop } from "./agent-loop.js";

const reply = (content: string): ChatResponse => ({
  content,
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  model: "stub",
  provider: "offline-stub",
});

const FINDINGS_JSON = JSON.stringify({
  agentKey: "code",
  summary: "done",
  findings: [],
  notes: [],
});

/** A tool that records exactly what args the loop handed it. */
function makeSpyTool(name = "search_code_symbols"): AgentTool & { seen: unknown[] } {
  const seen: unknown[] = [];
  const tool: AgentTool & { seen: unknown[] } = {
    name,
    description: "spy",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    seen,
    async execute(args: unknown) {
      seen.push(args);
      return { content: "symbol: computeSeverity at server/src/drift/severity.ts:10-42" };
    },
  };
  return tool;
}

/**
 * Provider stub: emits `first` on turn 1, then the findings JSON. The flat tool
 * call is emitted by the MODEL, exactly as the live run did.
 */
function makeProvider(first: string): AIProvider {
  let turn = 0;
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    async chat(_messages: ChatMessage[]): Promise<ChatResponse> {
      turn += 1;
      return reply(turn === 1 ? first : FINDINGS_JSON);
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
}

const loopInput = (tools: AgentTool[]) =>
  ({
    systemMessage: "You are Winston.",
    userMessage: "Investigate REQ-001.",
    tools,
    toolContext: { projectId: "proj-1" },
  }) as Parameters<typeof runAgentLoop>[1];

describe("#774 — flat (top-level) tool args are honoured", () => {
  it("executes a FLAT tool call identically to the nested form (fails on main)", async () => {
    const flatTool = makeSpyTool();
    const nestedTool = makeSpyTool();

    await runAgentLoop(
      makeProvider(JSON.stringify({ tool: "search_code_symbols", query: "drift severity" })),
      loopInput([flatTool]),
      { maxTurns: 3 },
    );
    await runAgentLoop(
      makeProvider(
        JSON.stringify({ tool: "search_code_symbols", args: { query: "drift severity" } }),
      ),
      loopInput([nestedTool]),
      { maxTurns: 3 },
    );

    // On main the flat call reached the tool with `{}` — the query was dropped.
    expect(flatTool.seen).toEqual([{ query: "drift severity" }]);
    expect(flatTool.seen).toEqual(nestedTool.seen);
  });

  it("honours the `arguments` / `parameters` / `input` container aliases", async () => {
    for (const key of ["arguments", "parameters", "input"]) {
      const tool = makeSpyTool();
      await runAgentLoop(
        makeProvider(JSON.stringify({ tool: "search_code_symbols", [key]: { query: "auth" } })),
        loopInput([tool]),
        { maxTurns: 3 },
      );
      expect(tool.seen, `alias ${key}`).toEqual([{ query: "auth" }]);
    }
  });

  it("keeps the nested shape byte-identical (regression)", () => {
    expect(
      parseToolCall(JSON.stringify({ tool: "search_code_graph", args: { query: "auth" } }), [
        "search_code_graph",
      ]),
    ).toEqual({ tool: "search_code_graph", args: { query: "auth" } });
  });

  it("absorbs flat keys ONLY for a KNOWN tool name", () => {
    // Known ⇒ absorbed.
    expect(parseToolCall('{"tool":"list_files","pattern":"src/**/*.ts"}', ["list_files"])).toEqual({
      tool: "list_files",
      args: { pattern: "src/**/*.ts" },
    });
    // Unknown ⇒ NOT absorbed; still surfaced as a tool call so the loop can emit
    // its "Unknown tool" repair error rather than silently swallowing it.
    expect(parseToolCall('{"tool":"totally_made_up","pattern":"x"}', ["list_files"])).toEqual({
      tool: "totally_made_up",
      args: {},
    });
  });

  it("never absorbs protocol/reserved keys as arguments", () => {
    const call = parseToolCall(
      JSON.stringify({
        tool: "search_code_graph",
        thought: "I should look for severity code",
        reasoning: "because the requirement mentions it",
        query: "severity",
      }),
      ["search_code_graph"],
    );
    expect(call).toEqual({ tool: "search_code_graph", args: { query: "severity" } });
  });

  it("SAFETY: a final-answer findings JSON is never parsed as a tool call", () => {
    // The real shape the agent emits to finish (STANDING_ANALYSIS_PROTOCOL).
    expect(parseToolCall(FINDINGS_JSON, ["search_code_graph"])).toBeNull();
    // Even a findings object that happens to carry a `tool` field (a summary
    // mentioning a tool name, a stray key) must NOT become a tool call — the
    // findings array is the discriminator.
    const poisoned = JSON.stringify({
      agentKey: "code",
      summary: "I used search_code_graph",
      tool: "search_code_graph",
      findings: [
        {
          category: "architecture",
          severity: "medium",
          title: "t",
          body: "b",
          tags: [],
          citations: [],
        },
      ],
      notes: [],
    });
    expect(parseToolCall(poisoned, ["search_code_graph"])).toBeNull();
  });

  it("SAFETY: the loop ends on a findings answer instead of executing a tool", async () => {
    const tool = makeSpyTool("search_code_graph");
    const chat = vi.fn(async () => reply(FINDINGS_JSON));
    const provider = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      chat,
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

    const result = await runAgentLoop(provider, loopInput([tool]), { maxTurns: 5 });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(tool.seen).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(result.finalResponse).toBe(FINDINGS_JSON);
  });
});
