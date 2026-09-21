/**
 * Issue #1117 (findings B + C) — a degraded synthesis must leave a trace on the
 * analysis, not just in the logs.
 *
 * Driven through the real `AnalysisOrchestrator.runPipeline` so the assertion is
 * on what crosses the persistence boundary: the walkthrough that filed #1117
 * could only identify the fallback by dumping the persisted agent-result blob
 * out of SQLite and recognising `fallbackSynthesize`'s summary template.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { SynthesisDegradation } from "@metis/shared";

const ANALYSIS_ID = "an_1117bc";
const PROJECT_ID = "pr_1117bc";

const persistedEnhancements: Array<Record<string, unknown>> = [];

/** What `runSynthesis` reports this run. Mutated per test. */
const synthesis: { degraded?: SynthesisDegradation } = {};

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
  persistRequirements: vi.fn(async () => ["rq_1"]),
  persistCrossDocFindings: vi.fn(async () => undefined),
  readFlattenedFindings: vi.fn(async () => []),
}));

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("./synthesis.js", () => ({
  runSynthesis: vi.fn(async () => ({
    output: {
      summary: "Auto-synthesized 1 requirement(s) from 2 finding(s).",
      // What the deterministic fallback emits: no type, no criteria.
      requirements: [
        {
          type: "feature",
          title: "Plaintext passwords stored in SIGNON table",
          body: "b",
          priority: "critical",
          evidenceFindingIndexes: [],
          acceptanceCriteria: [],
        },
      ],
    },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ...(synthesis.degraded ? { degraded: synthesis.degraded } : {}),
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
  const actual = await importOriginal<typeof import("./approval-checkpoint.js")>();
  return {
    ...actual,
    createApprovalRequests: vi.fn(async () => undefined),
    canCreateTickets: vi.fn(async () => ({ allowed: true, pendingCount: 0, rejectedCount: 0 })),
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
        a: string,
        b: string,
        c: string,
        d: string[],
        e: Record<string, unknown>,
      ) => Promise<void>;
    }
  ).runPipeline(ANALYSIS_ID, "JPetStore", "A test project", ["document"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
  });
}

const degradedPatch = (): SynthesisDegradation | undefined =>
  persistedEnhancements.find((p) => p.synthesisDegraded !== undefined)?.synthesisDegraded as
    | SynthesisDegradation
    | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  persistedEnhancements.length = 0;
  delete synthesis.degraded;
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

describe("#1117 B + C — a degraded synthesis is recorded on the analysis", () => {
  it("writes the degradation to enhancement metadata", async () => {
    synthesis.degraded = {
      reason: "non-json",
      detail: "Expected double-quoted property name in JSON at position 2093",
      attempts: 2,
      requirementCount: 16,
      at: "2026-07-28T11:38:00.000Z",
    };

    await runPipeline();

    expect(degradedPatch()).toEqual(synthesis.degraded);
  });

  it("writes nothing when synthesis was healthy", async () => {
    await runPipeline();

    expect(degradedPatch()).toBeUndefined();
    // Absence is the signal, so no key may be written on a good run.
    expect(persistedEnhancements.some((p) => "synthesisDegraded" in p)).toBe(false);
  });

  it("does not disturb the other metadata the run writes", async () => {
    synthesis.degraded = {
      reason: "provider-error",
      attempts: 1,
      requirementCount: 1,
      at: "2026-07-28T11:38:00.000Z",
    };

    await runPipeline();

    // The degradation rides its OWN patch: `persistAnalysisEnhancement` merges
    // by key, so a patch carrying only this field cannot clobber another.
    const patch = persistedEnhancements.find((p) => p.synthesisDegraded !== undefined)!;
    expect(Object.keys(patch)).toEqual(["synthesisDegraded"]);
  });
});
