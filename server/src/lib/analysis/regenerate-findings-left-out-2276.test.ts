/**
 * #2276 — the capability tracker exists only during `runPipeline`, so a
 * single-agent regenerate recorded nothing of what its answer lost at the
 * 50-finding cap, and the stored `findingsLeftOut` for that agent went stale:
 * it kept naming the old answer's cut findings, or said nothing about the new
 * answer's. After a regenerate the stored notices describe the new answer.
 *
 * Private seams are stubbed on the instance, as in continue-cut-short-code.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapability, FindingsLeftOutNotice } from "@metis/shared";

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
const OUTPUT = { agentKey: "document", summary: "s", findings: [], notes: [] };

type Stubbed = {
  regenerateLoadedAgent: (
    opts: { analysisId: string; agentKey: string; actorId: string; extendBudget?: boolean },
    analysis: unknown,
    controller: AbortController,
  ) => Promise<void>;
  noteFindingsLeftOut: (analysisId: string, notice: FindingsLeftOutNotice | undefined) => void;
  regenFindingsLeftOut: Map<string, FindingsLeftOutNotice[]>;
  runOneAgent: ReturnType<typeof vi.fn>;
  runSynthesisAndPersist: ReturnType<typeof vi.fn>;
  planContinuation: ReturnType<typeof vi.fn>;
  codeRequirementSet: ReturnType<typeof vi.fn>;
  regenerateCodeAgent: ReturnType<typeof vi.fn>;
  refreshCodeInvestigation: ReturnType<typeof vi.fn>;
  codeInvestigationGap: ReturnType<typeof vi.fn>;
};

const cut = (agentKey: string, titles: string[]): FindingsLeftOutNotice => ({
  agentKey,
  producedCount: 50 + titles.length,
  keptCount: 50,
  leftOutTitles: titles,
});

/** The regenerated agent's answer cuts `notice` (none when undefined), as `runOneAgent` reports it. */
function makeOrchestrator(notice?: FindingsLeftOutNotice) {
  const orch = new AnalysisOrchestrator({
    provider: { chat: vi.fn() } as never,
    retrieve: async () => [],
  }) as unknown as Stubbed;
  const answer = async (input: { analysisId: string; agentKey: string }) => {
    orch.noteFindingsLeftOut(input.analysisId, notice);
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

function capability(findingsLeftOut?: FindingsLeftOutNotice[]): AnalysisCapability {
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
    ...(findingsLeftOut ? { findingsLeftOut } : {}),
    reasons: findingsLeftOut ? ["findings-left-out"] : [],
  };
}

const regenerate = (orch: Stubbed, agentKey = "document", extendBudget = false) =>
  orch.regenerateLoadedAgent(
    { analysisId: "an_1", agentKey, actorId: "u1", ...(extendBudget ? { extendBudget } : {}) },
    ANALYSIS,
    new AbortController(),
  );

const persisted = () =>
  serviceMock.persistAnalysisCapability.mock.calls.at(-1)?.[1] as AnalysisCapability | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#2276 — a regenerated agent's findings cut is recorded on the run", () => {
  it("names the cut findings of the new answer on a run that had none", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability());
    await regenerate(makeOrchestrator(cut("document", ["New 51"])));
    expect(persisted()?.findingsLeftOut).toEqual([cut("document", ["New 51"])]);
    expect(persisted()?.reasons).toContain("findings-left-out");
  });

  it("replaces the regenerated agent's old notice and keeps the other agents'", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(
      capability([cut("document", ["Old 51", "Old 52"]), cut("web", ["Web 51"])]),
    );
    await regenerate(makeOrchestrator(cut("document", ["New 51"])));
    expect(persisted()?.findingsLeftOut).toEqual([
      cut("web", ["Web 51"]),
      cut("document", ["New 51"]),
    ]);
  });

  it("clears the notice and its reason when the new answer cut nothing", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability([cut("document", ["Old 51"])]));
    await regenerate(makeOrchestrator());
    expect(persisted()).toBeDefined();
    expect(persisted()).not.toHaveProperty("findingsLeftOut");
    expect(persisted()?.reasons).not.toContain("findings-left-out");
  });

  it("a malformed stored requirementsLeftOut entry does not fail the regenerate", async () => {
    const stored = {
      ...capability([cut("document", ["Old 51"])]),
      requirementsLeftOut: [{ agentKey: "code" }],
    } as unknown as AnalysisCapability;
    serviceMock.getAnalysisCapability.mockResolvedValue(stored);
    await regenerate(makeOrchestrator(cut("document", ["New 51"])));
    expect(persisted()?.findingsLeftOut).toEqual([cut("document", ["New 51"])]);
    expect(persisted()).not.toHaveProperty("requirementsLeftOut");
  });

  it("writes nothing when neither the old nor the new answer cut anything", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability([cut("web", ["Web 51"])]));
    await regenerate(makeOrchestrator());
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
  });

  it("a continuation keeps the code agent's earlier notice and adds its own", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability([cut("code", ["First 51"])]));
    const orch = makeOrchestrator(cut("code", ["Second 51"]));
    orch.planContinuation = vi.fn(async () => ({
      anyUnreached: true,
      requirements: [{ id: "REQ-1", text: "t" }],
      byConnector: new Map(),
      gap: { unreached: 1, total: 1 },
      scope: {},
    }));
    const prior = process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
    process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "100000";
    const asRegenerate = orch as unknown as {
      assertCanContinueInvestigation: () => Promise<void>;
    };
    asRegenerate.assertCanContinueInvestigation = async () => undefined;
    try {
      await regenerate(orch, "code", true);
    } finally {
      if (prior === undefined) delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
      else process.env.ANALYSIS_AGENT_TOKEN_BUDGET = prior;
    }
    expect(orch.regenerateCodeAgent).toHaveBeenCalledTimes(1);
    expect(persisted()?.findingsLeftOut).toEqual([
      cut("code", ["First 51"]),
      cut("code", ["Second 51"]),
    ]);
  });

  it("a failed regenerate records nothing and leaves no collector behind", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue(capability());
    const orch = makeOrchestrator(cut("document", ["New 51"]));
    orch.runSynthesisAndPersist.mockRejectedValue(new Error("synthesis failed"));
    await regenerate(orch);
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
    expect(orch.regenFindingsLeftOut.has("an_1")).toBe(false);
  });

  it("a failed capability read does not fail the regenerate", async () => {
    serviceMock.getAnalysisCapability.mockRejectedValue(new Error("db down"));
    await expect(
      regenerate(makeOrchestrator(cut("document", ["New 51"]))),
    ).resolves.toBeUndefined();
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
    expect(serviceMock.finalizeAnalysisDelta).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("outside a regenerate, a run with no tracker records nothing", () => {
    const orch = makeOrchestrator();
    orch.noteFindingsLeftOut("an_other", cut("document", ["x"]));
    expect(orch.regenFindingsLeftOut.has("an_other")).toBe(false);
  });
});
