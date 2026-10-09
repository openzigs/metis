/**
 * #1001 — #706 run 5: 13 of 16 code findings were "Could not verify
 * (investigation cut short)" and 9 of 16 promoted requirements had no code
 * link. The pass had simply run out of `ANALYSIS_AGENT_TOKEN_BUDGET`, and the
 * only place that said so was a collapsed line inside the gap report.
 *
 * Pinned here:
 *   - an exhausted pass raises the `code-investigation-cut-short` reason;
 *   - "continue" re-runs the code agent with a larger budget;
 *   - after a code regenerate, the banner describes the NEW pass (a continued
 *     run that finished stops offering to continue).
 *
 * Private seams are stubbed on the instance, as in regenerate-code-agentic.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapability, AnalysisRetrievalHealth } from "@metis/shared";

const { prismaMock, serviceMock } = vi.hoisted(() => ({
  prismaMock: {
    repoConnection: { findMany: vi.fn() },
    agentResult: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
  serviceMock: {
    finalizeAnalysisDelta: vi.fn(async () => undefined),
    markAnalysisRunning: vi.fn(async () => undefined),
    getAnalysisCapability: vi.fn(),
    persistAnalysisCapability: vi.fn(async (_id: string, _capability: unknown) => undefined),
    persistAnalysisEnhancement: vi.fn(async () => undefined),
  },
}));

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./analysis-service.js", () => serviceMock);
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator, CONTINUE_BUDGET_MULTIPLIER } = await import("./orchestrator.js");
const { createCapabilityTracker, finalizeCapability } = await import("./analysis-capability.js");

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const OUTPUT = { agentKey: "code", summary: "s", findings: [], notes: [] };
const REQS = [{ id: "REQ-1", text: "A user cannot subscribe to the same feed URL twice." }];

type Stubbed = {
  regenerateLoadedAgent: (
    opts: { analysisId: string; agentKey: string; actorId: string; extendBudget?: boolean },
    analysis: unknown,
  ) => Promise<void>;
  recordRetrievalHealth: (analysisId: string, health: AnalysisRetrievalHealth) => void;
  capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
  retrievalHealths: Map<string, AnalysisRetrievalHealth[]>;
  runOneAgent: ReturnType<typeof vi.fn>;
  runAgenticCodeAgent: ReturnType<typeof vi.fn>;
  runSynthesisAndPersist: ReturnType<typeof vi.fn>;
  extractRequirementsFromDocAgent: ReturnType<typeof vi.fn>;
  detectAgentMode: ReturnType<typeof vi.fn>;
  computeAffectedCode: ReturnType<typeof vi.fn>;
  computeEscalations: ReturnType<typeof vi.fn>;
  resolveDatabaseAware: ReturnType<typeof vi.fn>;
  computeAffectedSchema: ReturnType<typeof vi.fn>;
};

const health = (exhausted: boolean): AnalysisRetrievalHealth => ({
  successfulSearches: 6,
  totalCalls: 6,
  failedSearches: 0,
  erroredCalls: 0,
  requirementCount: 16,
  starved: false,
  degraded: false,
  searchedScope: [],
  ...(exhausted ? { exhausted: true } : {}),
});

/** `passHealth` is what the stubbed agentic pass records, as the real one does. */
function makeOrchestrator(passHealth?: AnalysisRetrievalHealth) {
  const orch = new AnalysisOrchestrator({
    provider: { chat: vi.fn() } as never,
    retrieve: async () => [],
  }) as unknown as Stubbed;
  orch.runOneAgent = vi.fn(async () => ({
    agentKey: "code",
    output: OUTPUT,
    usage: USAGE,
    durationMs: 1,
  }));
  orch.runAgenticCodeAgent = vi.fn(async (input: { analysisId: string }) => {
    if (passHealth) orch.recordRetrievalHealth(input.analysisId, passHealth);
    return { agentKey: "code", output: OUTPUT, usage: USAGE, durationMs: 1 };
  });
  orch.runSynthesisAndPersist = vi.fn(async () => undefined);
  orch.extractRequirementsFromDocAgent = vi.fn(async () => REQS);
  orch.detectAgentMode = vi.fn(async () => "agentic");
  orch.computeAffectedCode = vi.fn(async () => ({
    block: "",
    tokens: 0,
    filePaths: [],
    result: { candidates: [] },
  }));
  orch.computeEscalations = vi.fn(async () => undefined);
  orch.resolveDatabaseAware = vi.fn(async () => ({ enabled: false }));
  orch.computeAffectedSchema = vi.fn(async () => ({ block: "", tokens: 0, rows: [] }));
  return orch;
}

const ANALYSIS = {
  id: "an_1",
  projectId: "pr_1",
  metadata: JSON.stringify({ model: "deepseek-flash" }),
  project: { name: "Miniflux", description: "feed reader", status: "active" },
};

const CUT_SHORT: AnalysisCapability = {
  codeAnalysisRequested: true,
  databaseAnalysisRequested: false,
  codeGraphPresent: true,
  agentMode: "agentic",
  repoSourceIngested: true,
  fusedCodeRetrievalEnabled: true,
  schemaContextEnabled: true,
  quarantineFallbackUsed: false,
  skippedRepos: [],
  codeRetrievalDegraded: false,
  codeInvestigationCutShort: true,
  reasons: ["code-investigation-cut-short"],
};

const regenerate = (orch: Stubbed, extra: { agentKey?: string; extendBudget?: boolean } = {}) =>
  orch.regenerateLoadedAgent(
    {
      analysisId: "an_1",
      agentKey: extra.agentKey ?? "code",
      actorId: "u1",
      ...(extra.extendBudget ? { extendBudget: true } : {}),
    },
    ANALYSIS,
  );

let priorBudget: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  priorBudget = process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "100000";
  prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "miniflux" }]);
  serviceMock.getAnalysisCapability.mockResolvedValue(CUT_SHORT);
});
afterEach(() => {
  if (priorBudget === undefined) delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  else process.env.ANALYSIS_AGENT_TOKEN_BUDGET = priorBudget;
});

describe("#1001 an exhausted pass is visible on the run", () => {
  it("raises code-investigation-cut-short when a pass ran out of budget", () => {
    const orch = makeOrchestrator();
    const tracker = createCapabilityTracker({
      static: {
        codeGraphPresent: true,
        repoSourceIngested: true,
        fusedCodeRetrievalEnabled: true,
        schemaContextEnabled: true,
      },
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });
    tracker.agentMode = "agentic";
    orch.capabilities.set("an_1", tracker);

    orch.recordRetrievalHealth("an_1", health(false));
    expect(finalizeCapability(tracker).reasons).toEqual([]);

    orch.recordRetrievalHealth("an_1", health(true));
    const capability = finalizeCapability(tracker);
    expect(capability.codeInvestigationCutShort).toBe(true);
    expect(capability.reasons).toEqual(["code-investigation-cut-short"]);
  });
});

describe("#1001 continue with a larger budget", () => {
  it(`runs the code agent with ${CONTINUE_BUDGET_MULTIPLIER}x the configured budget`, async () => {
    const orch = makeOrchestrator();
    await regenerate(orch, { extendBudget: true });
    expect(orch.runAgenticCodeAgent).toHaveBeenCalledTimes(1);
    expect(orch.runAgenticCodeAgent.mock.calls[0][0].tokenBudget).toBe(200_000);
  });

  it("an ordinary regenerate keeps the configured budget", async () => {
    const orch = makeOrchestrator();
    await regenerate(orch);
    expect(orch.runAgenticCodeAgent.mock.calls[0][0].tokenBudget).toBe(100_000);
  });

  it("splits the extended budget across repos on a multi-repo project", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([
      { id: "repo_1", label: "api" },
      { id: "repo_2", label: "web" },
    ]);
    const orch = makeOrchestrator();
    await regenerate(orch, { extendBudget: true });
    const budgets = orch.runAgenticCodeAgent.mock.calls.map((c) => c[0].tokenBudget);
    expect(budgets).toEqual([100_000, 100_000]);
  });
});

describe("#1001 the banner describes the regenerated pass", () => {
  it("clears the cut-short reason once the continued pass finishes within budget", async () => {
    const orch = makeOrchestrator(health(false));
    await regenerate(orch, { extendBudget: true });

    expect(serviceMock.persistAnalysisEnhancement).toHaveBeenCalledWith("an_1", {
      retrieval: expect.objectContaining({ requirementCount: 16 }),
    });
    expect(serviceMock.persistAnalysisCapability).toHaveBeenCalledTimes(1);
    const next = serviceMock.persistAnalysisCapability.mock.calls[0][1] as AnalysisCapability;
    expect(next.codeInvestigationCutShort).toBe(false);
    expect(next.reasons).toEqual([]);
    expect(orch.retrievalHealths.has("an_1")).toBe(false);
  });

  it("keeps offering to continue when the continued pass ran out again", async () => {
    const orch = makeOrchestrator(health(true));
    await regenerate(orch, { extendBudget: true });
    const next = serviceMock.persistAnalysisCapability.mock.calls[0][1] as AnalysisCapability;
    expect(next.codeInvestigationCutShort).toBe(true);
    expect(next.reasons).toEqual(["code-investigation-cut-short"]);
  });

  it("leaves the record alone when the regenerate recorded no retrieval health", async () => {
    const orch = makeOrchestrator();
    await regenerate(orch);
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
    expect(serviceMock.persistAnalysisEnhancement).not.toHaveBeenCalled();
  });

  it("never rewrites the capability on another specialist's regenerate", async () => {
    const orch = makeOrchestrator(health(false));
    await regenerate(orch, { agentKey: "document" });
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
  });
});
