/**
 * #289 — through the REAL pipeline (`AnalysisOrchestrator.runPipeline`): the
 * agent phase's results are persisted, as rows keyed by the agent's ref,
 * BEFORE synthesis reads the analysis's findings — so they merge with the
 * specialists'. Before #289 the orchestrator folded in the usage and dropped
 * every result (no `persistAgentResult` call for any agent-phase agent).
 * Mocks mirror `tool-telemetry-pipeline.test.ts`.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_289";
const PROJECT_ID = "pr_289";

const state = {
  documentRequirements: [
    { id: "REQ-001", text: "Drift severity must be computed from a commit-SHA baseline." },
  ],
};

/** The order persistence and the synthesis read happened in. */
const order: string[] = [];

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
    order.push(`persist:${String(input.agentKey)}`);
    return undefined;
  }),
  persistAnalysisEnhancement: vi.fn(async () => undefined),
  persistAnalysisCapability: vi.fn(async () => undefined),
  persistAnalysisAffectedCode: vi.fn(async () => undefined),
  persistAnalysisDatabaseAware: vi.fn(async () => undefined),
  persistAnalysisEscalation: vi.fn(async () => undefined),
  persistRequirements: vi.fn(async () => []),
  persistCrossDocFindings: vi.fn(async () => undefined),
  readFlattenedFindings: vi.fn(async () => {
    order.push("readFlattenedFindings");
    return [];
  }),
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
// #289 — the REAL phase module, with only the agent run scripted: the
// persistence step under test is the real `persistAgentPhaseResults`.
const phaseResults: unknown[] = [];
vi.mock("./custom-agent-phase.js", async (original) => ({
  ...(await original<typeof import("./custom-agent-phase.js")>()),
  runEnabledCustomAgents: vi.fn(async () => ({
    results: phaseResults,
    usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
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
const { markAnalysisCompleted } = await import("./analysis-service.js");

const DOC_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });

async function runPipeline(): Promise<void> {
  const orch = new AnalysisOrchestrator({
    provider: {
      chat: vi.fn(async () => ({
        content: DOC_ANSWER,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        provider: "bedrock" as const,
      })),
    } as never,
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
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", ["document"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  persistedAgentResults.length = 0;
  order.length = 0;
  phaseResults.length = 0;
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

const FINDING = {
  category: "security",
  severity: "high",
  title: "Admin routes have no authorization check",
  body: "b",
  tags: [],
  citations: [],
};

describe("#289 — agent-phase results reach the persisted analysis", () => {
  it("persists each agent's findings under its ref, before synthesis reads the findings", async () => {
    phaseResults.push(
      {
        agentId: "c1",
        agentRef: "custom:c1",
        kind: "custom",
        agentName: "Threat Modeller",
        content: "{}",
        usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
        output: { summary: "s", findings: [FINDING], notes: [] },
        startedAt: new Date(0),
        completedAt: new Date(1),
      },
      {
        agentId: "l1",
        agentRef: "library:l1",
        kind: "library",
        agentName: "Reviewer",
        content: "prose",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        invalid: { reason: "non-json-response", issues: [] },
        finalAnswerRetry: { attempted: true, succeeded: false },
        startedAt: new Date(0),
        completedAt: new Date(1),
      },
    );
    await runPipeline();

    const custom = persistedAgentResults.find((r) => r.agentKey === "custom:c1");
    expect(custom).toMatchObject({
      analysisId: ANALYSIS_ID,
      status: "completed",
      output: {
        findings: [FINDING],
        source: { kind: "custom", ref: "custom:c1", name: "Threat Modeller" },
      },
    });
    const library = persistedAgentResults.find((r) => r.agentKey === "library:l1");
    expect(library).toMatchObject({
      status: "failed",
      errorMessage: "No findings recorded: its answer contained no JSON object after one retry.",
    });

    // Persisted BEFORE synthesis reads the run's findings, so they merge.
    const firstRead = order.indexOf("readFlattenedFindings");
    expect(firstRead).toBeGreaterThan(-1);
    expect(order.indexOf("persist:custom:c1")).toBeLessThan(firstRead);
    expect(order.indexOf("persist:library:l1")).toBeLessThan(firstRead);

    // Usage accounting (#81) is unchanged: the phase's usage is in the totals.
    const completedTotals = vi.mocked(markAnalysisCompleted).mock.calls[0]?.[1] as
      { totalTokens: number } | undefined;
    expect(completedTotals?.totalTokens).toBeGreaterThanOrEqual(7);
  });

  it("persists nothing for the agent phase when no agent is enabled", async () => {
    await runPipeline();
    expect(
      persistedAgentResults.filter((r) => /^(custom|library):/.test(String(r.agentKey))),
    ).toEqual([]);
  });
});
