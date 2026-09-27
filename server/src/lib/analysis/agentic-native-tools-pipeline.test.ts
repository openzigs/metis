/**
 * #141 — the orchestrator's agentic code pass on NATIVE tool calls, driven
 * through the REAL `AnalysisOrchestrator.runPipeline`, so the flag's wiring is
 * pinned by what crossed the provider boundary:
 *
 *   • `ANALYSIS_NATIVE_TOOL_CALLS` on + a tool-capable model ⇒ the loop's turns
 *     carry native tool definitions, a native call runs, and its result goes
 *     back as a `tool` message answering the call id;
 *   • flag off (the default) ⇒ no tools on any call and the text-protocol
 *     manifest in the system prompt — the pre-#141 request shape;
 *   • flag on + a model that is not tool-capable ⇒ the text protocol.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_141";
const PROJECT_ID = "pr_141";

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      findMany: vi.fn(async () => [
        {
          qualifiedName: "server/src/auth/session.ts::createSession",
          kind: "function",
          filePath: "server/src/auth/session.ts",
          startLine: 10,
          endLine: 42,
          language: "typescript",
        },
      ]),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    codeEdge: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) => {
        if (where.agentKey === "document") {
          return {
            output: JSON.stringify({
              requirements: [{ id: "REQ-001", text: "Sessions must expire after 30 minutes." }],
            }),
          };
        }
        return { status: "completed" };
      }),
    },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
  getStructuredRequirements: vi.fn(async () => null),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => undefined),
  markAnalysisFailed: vi.fn(async () => undefined),
  persistAgentResult: vi.fn(async () => ({ id: "ar_1", findingIds: [] })),
  persistAnalysisEnhancement: vi.fn(async () => undefined),
  persistAnalysisCapability: vi.fn(async () => undefined),
  persistAnalysisAffectedCode: vi.fn(async () => undefined),
  persistAnalysisDatabaseAware: vi.fn(async () => undefined),
  persistAnalysisEscalation: vi.fn(async () => undefined),
  persistRequirements: vi.fn(async () => []),
  persistCrossDocFindings: vi.fn(async () => undefined),
  readFlattenedFindings: vi.fn(async () => []),
}));

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("./synthesis.js", () => ({
  runSynthesis: vi.fn(async () => ({
    output: { summary: "s", requirements: [], risks: [], recommendations: [] },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })),
}));
vi.mock("./cross-doc-detection.js", () => ({ runCrossDocDetection: vi.fn(async () => null) }));
vi.mock("./custom-agent-phase.js", () => ({
  runEnabledCustomAgents: vi.fn(async () => ({
    results: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })),
}));
vi.mock("../teams/notification-hooks.js", () => ({
  notifyAnalysisComplete: vi.fn(async () => undefined),
}));
vi.mock("../traceability/seed-code-links-from-findings.js", () => ({
  seedRequirementCodeLinksFromFindings: vi.fn(async () => undefined),
}));
vi.mock("./approval-checkpoint.js", () => ({
  createApprovalRequests: vi.fn(async () => undefined),
  canCreateTickets: vi.fn(async () => false),
}));
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

const DOC_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });
const CODE_ANSWER = JSON.stringify({ summary: "code ok", findings: [], notes: [] });

type Recorded = { messages: ChatMessage[]; opts: ChatOptions };

function makeProvider(toolCapable: boolean) {
  const recorded: Recorded[] = [];
  let loopTurns = 0;
  const reply = (content: string, extra: Partial<ChatResponse> = {}): ChatResponse => ({
    content,
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    model: "test-model",
    provider: "bedrock-gateway",
    ...extra,
  });
  const chat = vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
    recorded.push({ messages: [...messages], opts });
    if (opts.callType !== "agent-loop") return reply(DOC_ANSWER);
    loopTurns += 1;
    if (loopTurns > 1) return reply(CODE_ANSWER);
    // First investigation turn: call a tool on whichever channel is in use.
    return opts.tools
      ? reply("", {
          toolCalls: [{ id: "toolu_1", name: "search_code_graph", args: { query: "x" } }],
        })
      : reply(JSON.stringify({ tool: "search_code_graph", args: { query: "x" } }));
  });
  const caps = { responseFormat: false, nativeToolCalls: toolCapable };
  return {
    provider: {
      key: "bedrock-gateway",
      model: "test-model",
      chat,
      capabilities: caps,
      capabilitiesFor: () => caps,
    } as never,
    recorded,
  };
}

async function runPipeline(toolCapable = true): Promise<Recorded[]> {
  const { provider, recorded } = makeProvider(toolCapable);
  const orch = new AnalysisOrchestrator({
    provider,
    retrieve: async () => [],
    knowledge: {} as never,
  });
  await (
    orch as unknown as {
      runPipeline: (
        a: string,
        b: string,
        c: string,
        d: string[],
        e: Record<string, unknown>,
      ) => Promise<void>;
    }
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", ["document", "code"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
  });
  return recorded;
}

const loopCalls = (recorded: Recorded[]) =>
  recorded.filter((c) => c.opts.callType === "agent-loop");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_NATIVE_TOOL_CALLS;
  __resetConfigSingleton();
});

describe("#141 — the orchestrator's agentic pass and ANALYSIS_NATIVE_TOOL_CALLS", () => {
  it("flag on + tool-capable model: native tools, a native call, its result answered by id", async () => {
    process.env.ANALYSIS_NATIVE_TOOL_CALLS = "true";
    const loop = loopCalls(await runPipeline());

    expect(loop.length).toBeGreaterThanOrEqual(2);
    const names = loop[0]!.opts.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("search_code_graph");
    expect(loop[0]!.opts.toolChoice).toBe("auto");
    expect(loop[0]!.opts.systemMessage).not.toContain('{"tool": "<name>"');

    const answered = loop[1]!.messages.filter((m) => m.role === "tool");
    expect(answered.map((m) => m.toolCallId)).toEqual(["toolu_1"]);
    const assistant = loop[1]!.messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls?.map((c) => c.id)).toEqual(["toolu_1"]);
  });

  it("flag off (default): no tools on any call, the text protocol runs", async () => {
    const recorded = await runPipeline();
    const loop = loopCalls(recorded);

    expect(loop.length).toBeGreaterThanOrEqual(2);
    for (const c of recorded) {
      expect(c.opts.tools).toBeUndefined();
      expect(c.opts.toolChoice).toBeUndefined();
    }
    expect(loop[0]!.opts.systemMessage).toContain('{"tool": "<name>"');
    const last = loop[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toMatch(/^Tool result for search_code_graph:/);
    expect(loop[1]!.messages.some((m) => m.role === "tool")).toBe(false);
  });

  it("flag on + a model that is not tool-capable: the text protocol", async () => {
    process.env.ANALYSIS_NATIVE_TOOL_CALLS = "true";
    const loop = loopCalls(await runPipeline(false));
    expect(loop.length).toBeGreaterThanOrEqual(2);
    for (const c of loop) expect(c.opts.tools).toBeUndefined();
    expect(loop[0]!.opts.systemMessage).toContain('{"tool": "<name>"');
  });
});
