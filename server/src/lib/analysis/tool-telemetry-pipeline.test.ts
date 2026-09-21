/**
 * P0 #774 — end-to-end through the REAL pipeline (`AnalysisOrchestrator.runPipeline`).
 *
 * Nothing private is stubbed. The fake MODEL emits the flat tool-call shape the
 * live run emitted (`{"tool":"search_code_graph","query":"drift severity"}`), and
 * the assertions are made on what crossed real boundaries:
 *   - what Prisma was asked (did the agent's search actually run, WITH its filter?)
 *   - what the service layer was told to persist (are the loop's tool-call error
 *     counts observable on the AgentResult, per AC 4?)
 *
 * On main the flat args were dropped, so `search_code_graph` ran UNFILTERED and
 * the loop's `toolCalls` were discarded by the caller — the two facts that made
 * the #773 incident invisible until live dogfooding.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_774";
const PROJECT_ID = "pr_774";

const state = {
  documentRequirements: [
    { id: "REQ-001", text: "Drift severity must be computed from a commit-SHA baseline." },
  ],
};

/** Everything `persistAgentResult` was called with during the run. */
const persistedAgentResults: Array<Record<string, unknown>> = [];

const mockCodeSymbolFindMany = vi.fn(async () => [
  {
    qualifiedName: "server/src/drift/severity.ts::computeSeverity",
    kind: "function",
    filePath: "server/src/drift/severity.ts",
    startLine: 10,
    endLine: 42,
    language: "typescript",
  },
]);

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    // #855 — back `hasSchemaData` (#854), the database-aware resolver's
    // schema-data probe. This suite never sets a per-project override, so the
    // resolved setting defaults to `auto`; 0 counts resolve to "no schema data"
    // (schema mapping stays a no-op, matching pre-#855 default-off behaviour).
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      findMany: (...a: unknown[]) => mockCodeSymbolFindMany(...(a as [])),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    codeEdge: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) => {
        if (where.agentKey === "document") {
          return { output: JSON.stringify({ requirements: state.documentRequirements }) };
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
  persistAgentResult: vi.fn(async (input: Record<string, unknown>) => {
    persistedAgentResults.push(input);
    return undefined;
  }),
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

const { AnalysisOrchestrator } = await import("./orchestrator.js");

const AGENT_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });

/**
 * The model, scripted to reproduce the live failure shape:
 *   turn 1 (document agent) → plain findings JSON
 *   turn 2 (code loop)      → FLAT search_code_graph call (args at top level)
 *   turn 3 (code loop)      → FLAT read_file_slice call MISSING its required param
 *   turn 4 (code loop)      → findings JSON (final answer)
 */
function makeProvider() {
  let n = 0;
  const script = [
    AGENT_ANSWER,
    JSON.stringify({ tool: "search_code_graph", query: "drift severity" }),
    JSON.stringify({ tool: "search_code_symbols", limit: 5 }), // required `query` absent
    AGENT_ANSWER,
  ];
  return {
    chat: vi.fn(async () => {
      const content = script[n] ?? AGENT_ANSWER;
      n += 1;
      return {
        content,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        provider: "bedrock" as const,
      };
    }),
  };
}

async function runPipeline(): Promise<void> {
  const orch = new AnalysisOrchestrator({
    provider: makeProvider() as never,
    retrieve: async () => [],
    knowledge: {} as never,
  });
  await (
    orch as unknown as {
      runPipeline: (
        analysisId: string,
        projectName: string,
        projectDescription: string,
        agentKeys: string[],
        opts: Record<string, unknown>,
      ) => Promise<void>;
    }
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", ["document", "code"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  persistedAgentResults.length = 0;
  // Isolate the tool loop: the passive fused-code seed (#729) is a separate,
  // already-tested path.
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

const codeResult = () => persistedAgentResults.find((r) => r.agentKey === "code");

describe("#774 — flat tool args + tool telemetry through the real pipeline", () => {
  it("runs the agent's FLAT search WITH its filter (fails on main: unfiltered)", async () => {
    await runPipeline();

    expect(mockCodeSymbolFindMany).toHaveBeenCalledTimes(1);
    const where = (mockCodeSymbolFindMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })
      .where;
    // On main `args` was `{}` ⇒ no `qualifiedName` filter ⇒ the first 30 symbols
    // alphabetically came back as "evidence".
    expect(where.qualifiedName).toEqual({ contains: "drift severity" });
  });

  it("persists the loop's tool-call error counts on the AgentResult (AC 4)", async () => {
    await runPipeline();

    const telemetry = codeResult()?.toolTelemetry as
      | {
          totalCalls: number;
          errorCalls: number;
          byTool: Array<{ tool: string; calls: number; errors: number }>;
          errorSamples: Array<{ tool: string; message: string }>;
        }
      | undefined;

    expect(telemetry).toBeDefined();
    expect(telemetry?.totalCalls).toBe(2);
    // The `search_code_symbols` call was missing its required `query`.
    expect(telemetry?.errorCalls).toBe(1);
    expect(telemetry?.byTool).toEqual(
      expect.arrayContaining([
        { tool: "search_code_graph", calls: 1, errors: 0 },
        { tool: "search_code_symbols", calls: 1, errors: 1 },
      ]),
    );
    expect(telemetry?.errorSamples[0]?.tool).toBe("search_code_symbols");
    // The sample is the model-facing repair message, so an operator reading the
    // row sees exactly what the model saw.
    expect(telemetry?.errorSamples[0]?.message).toContain("received keys: [limit]");
  });
});
