/**
 * #2437 review — the capability tracker exists only during `runPipeline`, so a
 * single-agent regenerate of the code agent recorded nothing of what access
 * restrictions left out of its code reads, and the stored `restrictedLeftOut`
 * kept describing the original run: a restriction added since was never
 * reported, and one lifted since was still reported. After a regenerate the
 * stored count describes the regenerated pass (a continuation merges into it).
 *
 * Private seams are stubbed on the instance, as in
 * regenerate-findings-left-out-2276.test.ts. The skipped-repo resume, which
 * merges, is covered in resume-skipped-repos.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapability, RestrictedLeftOutNotice } from "@metis/shared";

const { prismaMock, serviceMock } = vi.hoisted(() => ({
  prismaMock: {
    repoConnection: { findMany: vi.fn(async () => [{ id: "repo_1", label: "miniflux" }]) },
    agentResult: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    finding: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
  serviceMock: {
    finalizeAnalysisDelta: vi.fn(async () => undefined),
    markAnalysisRunning: vi.fn(async () => undefined),
    getAnalysisCapability: vi.fn(),
    persistAnalysisCapability: vi.fn(async (_id: string, _capability: unknown) => undefined),
    persistAnalysisEnhancement: vi.fn(async () => undefined),
    persistAgentResult: vi.fn(async (_input: unknown) => ({ id: "ar_x", findingIds: [] })),
  },
}));

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./analysis-service.js", () => serviceMock);
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const OUTPUT = { agentKey: "code", summary: "s", findings: [], notes: [] };

/** One access check of a pass's code reads, as the code paths report it. */
type Left = { files: number; symbolIds?: string[] };

type Stubbed = {
  regenerateLoadedAgent: (
    opts: { analysisId: string; agentKey: string; actorId: string; extendBudget?: boolean },
    analysis: unknown,
    controller: AbortController,
  ) => Promise<void>;
  noteRestrictedLeftOut: (analysisId: string, left: Left) => void;
  regenRestrictedLeftOut: Map<string, unknown>;
  runOneAgent: ReturnType<typeof vi.fn>;
  runSynthesisAndPersist: ReturnType<typeof vi.fn>;
  planContinuation: ReturnType<typeof vi.fn>;
  codeRequirementSet: ReturnType<typeof vi.fn>;
  regenerateCodeAgent: ReturnType<typeof vi.fn>;
  refreshCodeInvestigation: ReturnType<typeof vi.fn>;
  codeInvestigationGap: ReturnType<typeof vi.fn>;
};

/** The regenerated pass's code reads report `checks` (none: it read no code). */
function makeOrchestrator(checks: Left[] = []) {
  const orch = new AnalysisOrchestrator({
    provider: { chat: vi.fn() } as never,
    retrieve: async () => [],
  }) as unknown as Stubbed;
  const answer = async (input: { analysisId: string; agentKey: string }) => {
    for (const left of checks) orch.noteRestrictedLeftOut(input.analysisId, left);
    return { agentKey: input.agentKey, output: OUTPUT, usage: USAGE, durationMs: 1 };
  };
  orch.runOneAgent = vi.fn(answer);
  orch.regenerateCodeAgent = vi.fn(answer);
  orch.runSynthesisAndPersist = vi.fn(async () => undefined);
  orch.codeRequirementSet = vi.fn(async () => []);
  orch.refreshCodeInvestigation = vi.fn(async () => undefined);
  orch.codeInvestigationGap = vi.fn(async () => ({ gap: undefined, scope: {} }));
  return orch;
}

const ANALYSIS = {
  id: "an_1",
  projectId: "pr_1",
  metadata: JSON.stringify({ model: "deepseek-flash" }),
  project: { name: "Miniflux", description: "feed reader", status: "active" },
};

const notice = (files: number, symbols: number): RestrictedLeftOutNotice => ({
  reason: "shared-audience",
  files,
  symbols,
});

function capability(restrictedLeftOut?: RestrictedLeftOutNotice): AnalysisCapability {
  return {
    codeAnalysisRequested: true,
    databaseAnalysisRequested: false,
    codeGraphPresent: true,
    agentMode: "agentic",
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
    quarantineFallbackUsed: false,
    skippedRepos: [],
    ...(restrictedLeftOut ? { restrictedLeftOut } : {}),
    reasons: [],
  };
}

const regenerate = (orch: Stubbed, agentKey = "code", extendBudget = false) =>
  orch.regenerateLoadedAgent(
    { analysisId: "an_1", agentKey, actorId: "u1", ...(extendBudget ? { extendBudget } : {}) },
    ANALYSIS,
    new AbortController(),
  );

/** A continuation regenerate: the code agent re-runs the unreached requirements. */
async function continueInvestigation(orch: Stubbed): Promise<void> {
  orch.planContinuation = vi.fn(async () => ({
    anyUnreached: true,
    requirements: [{ id: "REQ-1", text: "t" }],
    byConnector: new Map(),
    gap: { unreached: 1, total: 1 },
    scope: {},
  }));
  const prior = process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "100000";
  try {
    await regenerate(orch, "code", true);
  } finally {
    if (prior === undefined) delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
    else process.env.ANALYSIS_AGENT_TOKEN_BUDGET = prior;
  }
}

const persisted = () =>
  serviceMock.persistAnalysisCapability.mock.calls.at(-1)?.[1] as AnalysisCapability | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#2437 — a regenerated code pass's restricted count is recorded on the run", () => {
  it("reports a restriction added since the run, which recorded none", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability());
    await regenerate(
      makeOrchestrator([
        { files: 2 },
        { files: 2, symbolIds: ["s1", "s2"] },
        { files: 2, symbolIds: ["s1"] },
      ]),
    );
    expect(persisted()?.restrictedLeftOut).toEqual(notice(2, 2));
    // Not a capability reason: the banner does not change.
    expect(persisted()?.reasons).toEqual([]);
  });

  it("replaces the original run's count with the regenerated pass's", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability(notice(5, 4)));
    await regenerate(makeOrchestrator([{ files: 1, symbolIds: ["s1"] }]));
    expect(persisted()?.restrictedLeftOut).toEqual(notice(1, 1));
  });

  it("removes the stale count once the restriction is lifted", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability(notice(3, 1)));
    await regenerate(makeOrchestrator([{ files: 0, symbolIds: [] }]));
    expect(persisted()).toBeDefined();
    expect(persisted()).not.toHaveProperty("restrictedLeftOut");
  });

  it("a continuation merges its count into the stored one, never lowering it", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability(notice(1, 3)));
    await continueInvestigation(makeOrchestrator([{ files: 2, symbolIds: ["s1"] }]));
    expect(persisted()?.restrictedLeftOut).toEqual(notice(2, 3));
  });

  it("leaves the stored count alone when the regenerated agent read no code", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability(notice(3, 1)));
    await regenerate(makeOrchestrator(), "document");
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
  });

  it("writes nothing when the count did not change", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability(notice(1, 1)));
    await regenerate(makeOrchestrator([{ files: 1, symbolIds: ["s1"] }]));
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
  });

  it("writes nothing when neither the run nor the pass left anything out", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability());
    await regenerate(makeOrchestrator([{ files: 0, symbolIds: [] }]));
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
  });

  it("a failed regenerate records nothing and leaves no collector behind", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability());
    const orch = makeOrchestrator([{ files: 2 }]);
    orch.runSynthesisAndPersist.mockRejectedValue(new Error("synthesis failed"));
    await regenerate(orch);
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
    expect(orch.regenRestrictedLeftOut.has("an_1")).toBe(false);
  });

  it("a failed capability read does not fail the regenerate", async () => {
    serviceMock.getAnalysisCapability.mockRejectedValue(new Error("db down"));
    await expect(regenerate(makeOrchestrator([{ files: 2 }]))).resolves.toBeUndefined();
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
  });

  it("outside a regenerate, a run with no tracker records nothing", () => {
    const orch = makeOrchestrator();
    orch.noteRestrictedLeftOut("an_other", { files: 2 });
    expect(orch.regenRestrictedLeftOut.has("an_other")).toBe(false);
  });
});
