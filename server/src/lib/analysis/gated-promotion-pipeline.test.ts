/**
 * Issue #1104 finding B — a run whose output is withheld by the approval gate
 * must not report plain success.
 *
 * Driven end-to-end through the REAL pipeline (`AnalysisOrchestrator.runPipeline`)
 * with the approval checkpoint reporting pending requests, which is exactly the
 * live shape: 13 pending / 1 approved, `ticketStatus.allowed=false`,
 * `persistRequirements` never reached — and the run still announced itself as
 * "completed" with zero requirements and no warning.
 *
 * The assertions are on what crossed real boundaries: the job-lifecycle
 * completion message the UI shows, and the enhancement metadata the analysis
 * page reads.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_1104b";
const PROJECT_ID = "pr_1104b";

/** Synthesis output — two requirements the gate will withhold. */
const SYNTH_REQUIREMENTS = [
  { title: "Idempotent order placement", body: "b", priority: "high", evidenceFindingIndexes: [] },
  { title: "Inventory decrement", body: "b", priority: "medium", evidenceFindingIndexes: [] },
];

const gate = {
  allowed: false,
  pendingCount: 2,
  rejectedCount: 0,
};

const persistedEnhancements: Array<Record<string, unknown>> = [];
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
  getStructuredRequirements: vi.fn(async () => null),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => undefined),
  markAnalysisFailed: vi.fn(async () => undefined),
  persistAgentResult: vi.fn(async () => ({ id: "ar_1", findingIds: [] })),
  persistAnalysisEnhancement: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    persistedEnhancements.push(patch);
  }),
  persistAnalysisCapability: vi.fn(async () => undefined),
  persistAnalysisAffectedCode: vi.fn(async () => undefined),
  persistAnalysisDatabaseAware: vi.fn(async () => undefined),
  persistAnalysisEscalation: vi.fn(async () => undefined),
  persistRequirements: vi.fn(async (input: Record<string, unknown>) => {
    persistedRequirements.push(input);
    return ["rq_1", "rq_2"];
  }),
  persistCrossDocFindings: vi.fn(async () => undefined),
  readFlattenedFindings: vi.fn(async () => []),
}));

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("./synthesis.js", () => ({
  runSynthesis: vi.fn(async () => ({
    output: { summary: "s", requirements: SYNTH_REQUIREMENTS, risks: [], recommendations: [] },
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
vi.mock("./approval-checkpoint.js", async (importOriginal) => {
  // The gate WORDING is production logic (`describePromotionGate`), so keep the
  // real implementation and stub only the DB-backed count.
  const actual = await importOriginal<typeof import("./approval-checkpoint.js")>();
  return {
    ...actual,
    createApprovalRequests: vi.fn(async () => undefined),
    canCreateTickets: vi.fn(async () => ({ ...gate })),
  };
});

const jobCompleted = vi.fn();
vi.mock("../socket/job-events.js", () => ({
  jobEvents: {
    started: vi.fn(),
    completed: (...args: unknown[]) => jobCompleted(...args),
    failed: vi.fn(),
  },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

const AGENT_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });

function makeProvider() {
  return {
    chat: vi.fn(async () => ({
      content: AGENT_ANSWER,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model",
      provider: "bedrock" as const,
    })),
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
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", ["document"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
  });
}

/** The last promotion-bearing metadata patch the run wrote. */
function promotionPatch(): Record<string, unknown> | undefined {
  return persistedEnhancements.filter((p) => p.promotionBlocked !== undefined).at(-1);
}

function completionMessage(): string {
  return String(jobCompleted.mock.calls.at(-1)?.[3] ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  persistedEnhancements.length = 0;
  persistedRequirements.length = 0;
  gate.allowed = false;
  gate.pendingCount = 2;
  gate.rejectedCount = 0;
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

describe("#1104 B — a gated run never reports unqualified success", () => {
  it("names the pending approvals in the completion message the UI shows", async () => {
    await runPipeline();

    const message = completionMessage();
    expect(message).not.toBe("Analysis complete");
    expect(message).toMatch(/awaiting approval/i);
    expect(message).toContain("2");
  });

  it("records how many requirements the gate is withholding", async () => {
    await runPipeline();

    const blocked = promotionPatch()?.promotionBlocked as
      | { blocked: boolean; pendingCount: number; awaitingRequirementCount?: number }
      | undefined;
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.pendingCount).toBe(2);
    // The two synthesized requirements exist — they are held back, not absent.
    expect(blocked?.awaitingRequirementCount).toBe(2);
  });

  it("still withholds the requirements (the gate is real)", async () => {
    await runPipeline();
    expect(persistedRequirements).toHaveLength(0);
  });

  it("reports plain success when nothing is gated", async () => {
    gate.allowed = true;
    gate.pendingCount = 0;

    await runPipeline();

    expect(completionMessage()).toBe("Analysis complete");
    expect(persistedRequirements).toHaveLength(1);
  });
});
