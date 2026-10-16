/**
 * Issue #1033 — through the REAL pipeline (`AnalysisOrchestrator.runPipeline`):
 * synthesis is handed the reviewed requirements WITH their ids, and the ids its
 * output names decide which approved requirement gets which criteria and
 * evidence when the run persists them.
 *
 * Every other #1033 test passes ids by hand or calls the join directly, so
 * dropping the id where the orchestrator builds synthesis's input left them
 * all green while a real run fell back to the title-only join (adversarial
 * panel, test-falsifiability lens).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_1033";
const PROJECT_ID = "pr_1033";

const structuredReq = (id: string, title: string) => ({
  id,
  title,
  description: `${title}.`,
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
});

const STRUCTURED = [
  structuredReq("6c0e…-feed", "Require non-empty feed title"),
  structuredReq("1f2a…-basic", "Require HTTP Basic authentication for metrics"),
  structuredReq("9b7d…-empty", "Reject empty metrics username or password"),
];

/** What the model returns: one item for the two metrics requirements. */
const SYNTH_REQUIREMENTS = [
  {
    type: "feature",
    title: "Require HTTP Basic auth on the metrics endpoint, rejecting empty credentials",
    body: "b",
    priority: "high",
    labels: [],
    evidenceFindingIndexes: [0],
    acceptanceCriteria: ["Missing credentials get 404.", "Empty credentials are rejected."],
    structuredIds: ["1f2a…-basic", "9b7d…-empty"],
  },
];

const synthesisInputs: Array<Record<string, unknown>> = [];
const persistedRequirements: Array<Record<string, unknown>> = [];

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => null) },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    codeEdge: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    agentResult: { findFirst: vi.fn(async () => ({ status: "completed" })) },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
  getStructuredRequirements: vi.fn(async () => ({ requirements: STRUCTURED, runId: "run_1" })),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => undefined),
  markAnalysisFailed: vi.fn(async () => undefined),
  persistAgentResult: vi.fn(async () => ({ id: "ar_1", findingIds: [] })),
  persistAnalysisEnhancement: vi.fn(async () => undefined),
  persistAnalysisCapability: vi.fn(async () => undefined),
  persistAnalysisAffectedCode: vi.fn(async () => undefined),
  persistAnalysisDatabaseAware: vi.fn(async () => undefined),
  persistAnalysisEscalation: vi.fn(async () => undefined),
  persistRequirements: vi.fn(async (input: Record<string, unknown>) => {
    persistedRequirements.push(input);
    return ["rq_1", "rq_2", "rq_3"];
  }),
  persistCrossDocFindings: vi.fn(async () => undefined),
  readFlattenedFindings: vi.fn(async () => []),
}));

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("./synthesis.js", () => ({
  runSynthesis: vi.fn(async (_provider: unknown, input: Record<string, unknown>) => {
    synthesisInputs.push(input);
    return {
      output: { summary: "s", requirements: SYNTH_REQUIREMENTS },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }),
}));
vi.mock("./cross-doc-detection.js", () => ({ runCrossDocDetection: vi.fn(async () => null) }));
vi.mock("./custom-agent-phase.js", () => ({
  runEnabledCustomAgents: vi.fn(async () => ({
    results: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })),
  persistAgentPhaseResults: vi.fn(async () => undefined),
}));
vi.mock("../teams/notification-hooks.js", () => ({
  notifyAnalysisComplete: vi.fn(async () => undefined),
}));
vi.mock("../traceability/seed-code-links-from-findings.js", () => ({
  seedRequirementCodeLinksFromFindings: vi.fn(async () => undefined),
}));
vi.mock("./clarification-enrichment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clarification-enrichment.js")>()),
  hasAnsweredClarification: vi.fn(async () => false),
}));
vi.mock("./approval-checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./approval-checkpoint.js")>();
  return {
    ...actual,
    createApprovalRequests: vi.fn(async () => undefined),
    canCreateTickets: vi.fn(async () => ({ allowed: true, pendingCount: 0, rejectedCount: 0 })),
    listApprovalRequests: vi.fn(async () =>
      STRUCTURED.map((r) => ({
        type: "requirement",
        itemId: r.id,
        status: "approved",
        createdAt: new Date("2026-10-16T00:00:00Z"),
      })),
    ),
  };
});
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

async function runPipeline(): Promise<void> {
  const orch = new AnalysisOrchestrator({
    provider: {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ summary: "ok", findings: [], notes: [] }),
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
  ).runPipeline(ANALYSIS_ID, "Miniflux", "A feed reader", ["document"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  synthesisInputs.length = 0;
  persistedRequirements.length = 0;
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

describe("#1033 — the pipeline carries requirement ids through synthesis to promotion", () => {
  it("hands synthesis each reviewed requirement under its id", async () => {
    await runPipeline();
    expect(synthesisInputs).toHaveLength(1);
    expect(synthesisInputs[0]!.refinedRequirements).toEqual(
      STRUCTURED.map((r) => ({ id: r.id, title: r.title, description: r.description })),
    );
  });

  it("persists the named requirements with the criteria and evidence synthesis gave them", async () => {
    await runPipeline();
    expect(persistedRequirements).toHaveLength(1);
    const rows = (
      persistedRequirements[0]!.synthesis as {
        requirements: Array<{
          title: string;
          acceptanceCriteria: string[];
          evidenceFindingIndexes: number[];
        }>;
      }
    ).requirements;
    expect(rows.map((r) => r.title)).toEqual(STRUCTURED.map((r) => r.title));
    const [feed, basic, empty] = rows;
    // Not first in the reviewed list, and both named by one synthesis item.
    for (const r of [basic, empty]) {
      expect(r!.acceptanceCriteria).toEqual([
        "Missing credentials get 404.",
        "Empty credentials are rejected.",
      ]);
      expect(r!.evidenceFindingIndexes).toEqual([0]);
    }
    // Named by nothing: stays empty rather than borrowing its neighbours'.
    expect(feed!.acceptanceCriteria).toEqual([]);
    expect(feed!.evidenceFindingIndexes).toEqual([]);
  });
});
