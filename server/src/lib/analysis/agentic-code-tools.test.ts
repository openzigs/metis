/**
 * Issue #730 (Epic #725) — the agentic code agent's tool set now includes the
 * hybrid `search_code_symbols` tool alongside `search_code_graph`.
 *
 * Two contracts are proven at the module boundary (no orchestrator boot, no live
 * LLM / embedder / Prisma):
 *   1. `assembleAgenticCodeTools` OFFERS `search_code_symbols` whenever the
 *      agentic loop runs (a built code graph is a precondition of that path), with
 *      a deterministic, name-ordered schema position in the cache-stable prompt.
 *   2. The shared `runAgentLoop` EXECUTES a `search_code_symbols` call end-to-end
 *      against a stubbed searcher, and the result carries `filePath:startLine-endLine`
 *      provenance fed back to the model — matching chat's tool (Epic #712).
 */
import { describe, expect, it, vi } from "vitest";
import { assembleAgenticCodeTools } from "./orchestrator.js";
import { runAgentLoop, formatToolSchemas, sortToolsForCache } from "./agent-loop.js";
import type { KnowledgeService } from "../rag/knowledge-service.js";
import type {
  FusedCodeSearcher,
  RawCodeSymbolHit,
  SymbolLineLookup,
} from "../rag/fused-code-context.js";
import type { AIProvider, ChatMessage, ChatResponse } from "../ai/types.js";

/** A KnowledgeService stub — `search_knowledge` is never invoked in these tests. */
const knowledgeStub = { search: vi.fn(async () => []) } as unknown as KnowledgeService;

function mockSearcher(hits: RawCodeSymbolHit[]): FusedCodeSearcher {
  return { search: vi.fn(async () => hits) };
}

function mockLineLookup(
  spans: Record<string, { filePath: string; startLine: number; endLine: number }>,
): SymbolLineLookup {
  return { resolve: vi.fn(async () => new Map(Object.entries(spans))) };
}

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

describe("assembleAgenticCodeTools", () => {
  it("offers search_code_symbols alongside search_code_graph and search_knowledge", () => {
    const tools = assembleAgenticCodeTools({ knowledgeService: knowledgeStub });
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_code_symbols");
    expect(names).toContain("search_code_graph");
    expect(names).toContain("search_knowledge");
    // File tools are gated on a repo clone dir — absent here.
    expect(names).not.toContain("read_file_slice");
    expect(names).not.toContain("list_files");
  });

  it("adds the repo file tools only when a clone dir is present", () => {
    const withClone = assembleAgenticCodeTools({
      knowledgeService: knowledgeStub,
      cloneDir: "/data/repos/abc",
    }).map((t) => t.name);
    expect(withClone).toContain("read_file_slice");
    expect(withClone).toContain("list_files");
    // The hybrid symbol tool is present regardless of the clone dir.
    expect(withClone).toContain("search_code_symbols");
  });

  it("renders a deterministic, name-ordered schema block (cache-stable prompt lead)", () => {
    // Array order is push order; the prompt lead sorts by name, so the schema
    // position of search_code_symbols is deterministic across builds.
    const a = formatToolSchemas(assembleAgenticCodeTools({ knowledgeService: knowledgeStub }));
    const b = formatToolSchemas(assembleAgenticCodeTools({ knowledgeService: knowledgeStub }));
    expect(a).toBe(b);
    expect(a).toContain("search_code_symbols");

    const ordered = sortToolsForCache(
      assembleAgenticCodeTools({ knowledgeService: knowledgeStub }),
    ).map((t) => t.name);
    expect(ordered).toEqual([...ordered].sort((x, y) => x.localeCompare(y, "en")));
  });

  it("wires the tool to the injected fusedCode searcher/line-lookup seam", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "denorm.ts", name: "loadCfg", kind: "function", score: 0.7 },
    ]);
    const lineLookup = mockLineLookup({
      s1: { filePath: "src/config/load.ts", startLine: 3, endLine: 21 },
    });
    const tools = assembleAgenticCodeTools({
      knowledgeService: knowledgeStub,
      fusedCodeDeps: { searcher, lineLookup },
    });
    const tool = tools.find((t) => t.name === "search_code_symbols");
    expect(tool).toBeDefined();

    const res = await tool!.execute({ query: "config loader" }, { projectId: "proj-9" });
    expect(searcher.search).toHaveBeenCalledWith("config loader", "proj-9", { limit: 15 });
    // Authoritative CodeSymbol span, not the searcher's denormalised path.
    expect(res.content).toContain("function loadCfg — src/config/load.ts:3-21");
  });
});

describe("runAgentLoop with the agentic code tool set", () => {
  it("executes a search_code_symbols call and feeds the provenance back to the model", async () => {
    const searcher = mockSearcher([
      { symbolId: "s1", filePath: "denorm.ts", name: "buildIndex", kind: "function", score: 0.88 },
    ]);
    const lineLookup = mockLineLookup({
      s1: { filePath: "src/rag/index.ts", startLine: 12, endLine: 48 },
    });
    const tools = assembleAgenticCodeTools({
      knowledgeService: knowledgeStub,
      fusedCodeDeps: { searcher, lineLookup },
    });

    const { provider, chat } = scriptedProvider([
      '{"tool": "search_code_symbols", "args": {"query": "index builder"}}',
      "buildIndex lives at src/rag/index.ts:12-48.",
    ]);

    const result = await runAgentLoop(
      provider,
      {
        systemMessage: "You are Winston.",
        userMessage: "Where is the index built?",
        tools,
        toolContext: { projectId: "proj-agentic" },
      },
      { maxTurns: 10, maxTokens: 50_000 },
    );

    // The searcher ran, scoped to the loop's tool-context project.
    expect(searcher.search).toHaveBeenCalledWith("index builder", "proj-agentic", { limit: 15 });
    // The tool call was recorded with filePath:startLine-endLine provenance.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("search_code_symbols");
    expect(result.toolCalls[0].resultPreview).toContain("src/rag/index.ts:12-48");
    // The provenance was fed back on the second turn.
    const secondTurn = chat.mock.calls[1][0] as ChatMessage[];
    expect(JSON.stringify(secondTurn)).toContain("src/rag/index.ts:12-48");
    // The loop returns the model's final prose, not the tool-call JSON.
    expect(result.finalResponse).toBe("buildIndex lives at src/rag/index.ts:12-48.");
  });

  it("degrades cleanly (no throw, loop continues) when the symbol index is empty", async () => {
    // Empty searcher = a project with no built symbol index → a clean tool result.
    const searcher = mockSearcher([]);
    const lineLookup = mockLineLookup({});
    const tools = assembleAgenticCodeTools({
      knowledgeService: knowledgeStub,
      fusedCodeDeps: { searcher, lineLookup },
    });

    const { provider } = scriptedProvider([
      '{"tool": "search_code_symbols", "args": {"query": "anything"}}',
      "No symbols available; answering from requirements only.",
    ]);

    const result = await runAgentLoop(
      provider,
      {
        systemMessage: "You are Winston.",
        userMessage: "Find the widget factory.",
        tools,
        toolContext: { projectId: "proj-empty" },
      },
      { maxTurns: 10, maxTokens: 50_000 },
    );

    expect(result.toolCalls[0].resultPreview).toContain("No matching code symbols");
    // The loop did not throw and produced a final answer.
    expect(result.finalResponse).toBe("No symbols available; answering from requirements only.");
  });
});

describe("#1312 / #777 — describe_table is offered only when it can work", () => {
  const names = (tools: { name: string }[]) => tools.map((t) => t.name);

  it("withholds describe_table when the project has no DB connector", () => {
    const tools = assembleAgenticCodeTools({ knowledgeService: knowledgeStub });
    expect(names(tools)).not.toContain("describe_table");
  });

  it("offers describe_table when an introspector is supplied", () => {
    const tools = assembleAgenticCodeTools({
      knowledgeService: knowledgeStub,
      describeTableDeps: { introspect: async () => ({ tables: [] }) },
    });
    expect(names(tools)).toContain("describe_table");
  });

  it("keeps the prompt schema order deterministic once the tool is added", () => {
    const tools = assembleAgenticCodeTools({
      knowledgeService: knowledgeStub,
      describeTableDeps: { introspect: async () => ({ tables: [] }) },
    });
    expect(names(sortToolsForCache(tools))).toEqual([...names(tools)].sort());
  });
});
