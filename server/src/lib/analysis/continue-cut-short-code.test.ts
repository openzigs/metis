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

const {
  AnalysisOrchestrator,
  CodeInvestigationContinueLimitError,
  CONTINUE_BUDGET_MULTIPLIER,
  resolvePassTurnCaps,
} = await import("./orchestrator.js");
const { MAX_CODE_INVESTIGATION_CONTINUATIONS } = await import("@metis/shared");
const { resolveAgenticMaxTurns } = await import("./agentic-pass-context.js");
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

  it("also scales the turn cap, so a pass that ran out of turns can get further", async () => {
    const orch = makeOrchestrator();
    await regenerate(orch, { extendBudget: true });
    expect(orch.runAgenticCodeAgent.mock.calls[0][0].turnMultiplier).toBe(
      CONTINUE_BUDGET_MULTIPLIER,
    );
  });

  it("the turn caps the pass runs with are multiplied by the turn multiplier", () => {
    // The stubbed pass above only sees the multiplier; this pins the arithmetic.
    const base = resolvePassTurnCaps({ standardCount: 4, deepCount: 2, totalCount: 6 });
    expect(base).toEqual({
      standardTurns: resolveAgenticMaxTurns(4),
      deepTurns: resolveAgenticMaxTurns(2),
    });
    expect(
      resolvePassTurnCaps({
        standardCount: 4,
        deepCount: 2,
        totalCount: 6,
        turnMultiplier: CONTINUE_BUDGET_MULTIPLIER,
      }),
    ).toEqual({
      standardTurns: base.standardTurns * CONTINUE_BUDGET_MULTIPLIER,
      deepTurns: base.deepTurns * CONTINUE_BUDGET_MULTIPLIER,
    });
  });

  it("scales an escalation policy's own turn caps too", () => {
    expect(
      resolvePassTurnCaps({
        standardCount: 4,
        deepCount: 2,
        totalCount: 6,
        policy: { standardMaxTurns: 12, deepMaxTurns: 30 },
        turnMultiplier: CONTINUE_BUDGET_MULTIPLIER,
      }),
    ).toEqual({
      standardTurns: 12 * CONTINUE_BUDGET_MULTIPLIER,
      deepTurns: 30 * CONTINUE_BUDGET_MULTIPLIER,
    });
  });

  it("an ordinary regenerate leaves the turn cap alone", async () => {
    const orch = makeOrchestrator();
    await regenerate(orch);
    expect(orch.runAgenticCodeAgent.mock.calls[0][0].turnMultiplier).toBeUndefined();
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

  it("a failed capability read does not fail a regenerate that already persisted", async () => {
    serviceMock.getAnalysisCapability.mockRejectedValue(new Error("db down"));
    const orch = makeOrchestrator(health(false));
    await expect(regenerate(orch, { extendBudget: true })).resolves.toBeUndefined();
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
    expect(serviceMock.finalizeAnalysisDelta).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("leaves the record alone when the regenerate recorded no retrieval health", async () => {
    const orch = makeOrchestrator();
    await regenerate(orch);
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
    expect(serviceMock.persistAnalysisEnhancement).not.toHaveBeenCalled();
  });

  it("never rewrites the capability on another specialist's regenerate", async () => {
    const orch = makeOrchestrator();
    // Give the non-code pass retrieval health, so only the code-only guard keeps
    // the regenerate from rewriting the code agent's capability flags.
    orch.runOneAgent.mockImplementation(async (input: { analysisId: string }) => {
      orch.recordRetrievalHealth(input.analysisId, health(false));
      return { agentKey: "document", output: OUTPUT, usage: USAGE, durationMs: 1 };
    });
    await regenerate(orch, { agentKey: "document" });
    expect(orch.runOneAgent).toHaveBeenCalledTimes(1);
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
    expect(serviceMock.persistAnalysisEnhancement).not.toHaveBeenCalled();
  });

  it("drops the pass's retrieval health when the regenerate fails", async () => {
    const orch = makeOrchestrator(health(true));
    orch.runSynthesisAndPersist.mockRejectedValue(new Error("synthesis failed"));
    await regenerate(orch, { extendBudget: true });
    expect(serviceMock.finalizeAnalysisDelta).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(serviceMock.persistAnalysisCapability).not.toHaveBeenCalled();
    expect(orch.retrievalHealths.has("an_1")).toBe(false);
  });
});

/**
 * #1062 — #706 run 7: the continued pass used 270k tokens, was cut short again,
 * and the page showed the same notice and the same Continue button as before.
 */
describe("#1062 a rerun that is cut short too says so, and Continue is limited", () => {
  const persisted = () =>
    serviceMock.persistAnalysisCapability.mock.calls[0][1] as AnalysisCapability;
  const asOrch = (orch: Stubbed) =>
    orch as unknown as {
      assertCanContinueInvestigation: (id: string) => Promise<void>;
      regenerateAgent: (o: {
        analysisId: string;
        agentKey: string;
        actorId: string;
        extendBudget?: boolean;
      }) => Promise<void>;
      assertCanRegenerate: ReturnType<typeof vi.fn>;
    };

  it("records what the continued pass left unreached when it ran out again", async () => {
    const orch = makeOrchestrator({ ...health(true), unverifiedRequirements: 9 });
    await regenerate(orch, { extendBudget: true });
    expect(persisted()).toMatchObject({
      codeInvestigationCutShort: true,
      codeInvestigationContinuations: 1,
      codeInvestigationUnreached: { unreached: 9, total: 16 },
      reasons: ["code-investigation-cut-short"],
    });
  });

  it("counts the continuation and drops the gap once the continued pass finishes", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationUnreached: { unreached: 9, total: 16 },
    });
    const orch = makeOrchestrator(health(false));
    await regenerate(orch, { extendBudget: true });
    const next = persisted();
    expect(next.codeInvestigationContinuations).toBe(1);
    expect(next.codeInvestigationCutShort).toBe(false);
    expect(next).not.toHaveProperty("codeInvestigationUnreached");
    expect(next.reasons).toEqual([]);
  });

  it("records no gap when the cut-short pass reported no unverified count", async () => {
    const orch = makeOrchestrator(health(true));
    await regenerate(orch, { extendBudget: true });
    expect(persisted()).not.toHaveProperty("codeInvestigationUnreached");
    expect(persisted().codeInvestigationContinuations).toBe(1);
  });

  it("an ordinary regenerate is not counted as a continuation", async () => {
    const orch = makeOrchestrator(health(true));
    await regenerate(orch);
    expect(persisted()).not.toHaveProperty("codeInvestigationContinuations");
  });

  it("an ordinary regenerate after a continuation starts the count again", async () => {
    // Continue finished, then a plain 1× regenerate is cut short: continuing THAT
    // pass is a larger run, so it must be offered — and it is not "the rerun".
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationCutShort: false,
      codeInvestigationContinuations: 1,
      reasons: [],
    });
    const orch = makeOrchestrator({ ...health(true), unverifiedRequirements: 4 });
    await regenerate(orch);
    const next = persisted();
    expect(next).not.toHaveProperty("codeInvestigationContinuations");
    expect(next.codeInvestigationCutShort).toBe(true);
    expect(next.codeInvestigationUnreached).toEqual({ unreached: 4, total: 16 });
  });

  it("counts a continuation that recorded no retrieval health, and keeps the flag", async () => {
    // A single-shot rerun records nothing: uncounted, Continue could be clicked forever.
    const orch = makeOrchestrator();
    await regenerate(orch, { extendBudget: true });
    expect(serviceMock.persistAnalysisEnhancement).not.toHaveBeenCalled();
    expect(persisted()).toMatchObject({
      codeInvestigationCutShort: true,
      codeInvestigationContinuations: 1,
      reasons: ["code-investigation-cut-short"],
    });
  });

  it("refuses another continuation once the limit is reached, naming the reason", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationContinuations: MAX_CODE_INVESTIGATION_CONTINUATIONS,
    });
    const orch = asOrch(makeOrchestrator());
    await expect(orch.assertCanContinueInvestigation("an_1")).rejects.toMatchObject({
      code: "CODE_INVESTIGATION_CONTINUE_LIMIT",
      continuations: MAX_CODE_INVESTIGATION_CONTINUATIONS,
      message: expect.stringContaining(`${CONTINUE_BUDGET_MULTIPLIER}× the configured budget`),
    });
    await expect(orch.assertCanContinueInvestigation("an_1")).rejects.toBeInstanceOf(
      CodeInvestigationContinueLimitError,
    );
  });

  it("allows the first continuation, and one on a record with no capability", async () => {
    const orch = asOrch(makeOrchestrator());
    await expect(orch.assertCanContinueInvestigation("an_1")).resolves.toBeUndefined();
    serviceMock.getAnalysisCapability.mockResolvedValue(null);
    await expect(orch.assertCanContinueInvestigation("an_1")).resolves.toBeUndefined();
  });

  it("regenerateAgent itself refuses a continuation past the limit, before any model call", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationContinuations: MAX_CODE_INVESTIGATION_CONTINUATIONS,
    });
    const stub = makeOrchestrator();
    const orch = asOrch(stub);
    orch.assertCanRegenerate = vi.fn(async () => ({ analysis: ANALYSIS }));
    await expect(
      orch.regenerateAgent({
        analysisId: "an_1",
        agentKey: "code",
        actorId: "u1",
        extendBudget: true,
      }),
    ).rejects.toBeInstanceOf(CodeInvestigationContinueLimitError);
    expect(stub.runAgenticCodeAgent).not.toHaveBeenCalled();
    expect(stub.runOneAgent).not.toHaveBeenCalled();
  });
});
