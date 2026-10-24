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
    finding: {
      findMany: vi.fn(async (_args?: unknown) => [] as Array<{ evidence: string | null }>),
      deleteMany: vi.fn(async (_args?: unknown) => ({ count: 0 })),
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

const {
  AnalysisOrchestrator,
  CodeInvestigationContinueLimitError,
  CodeInvestigationContinueNotOfferedError,
  CONTINUE_BUDGET_MULTIPLIER,
  resolvePassTurnCaps,
} = await import("./orchestrator.js");
const { MAX_CODE_INVESTIGATION_CONTINUATIONS } = await import("@metis/shared");
const { resolveAgenticMaxTurns } = await import("./agentic-pass-context.js");
const { createCapabilityTracker, finalizeCapability } = await import("./analysis-capability.js");
const { classifyUnverifiedRequirements } = await import("./retrieval-health.js");

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const OUTPUT = { agentKey: "code", summary: "s", findings: [], notes: [] };
const REQS = [{ id: "REQ-1", text: "A user cannot subscribe to the same feed URL twice." }];

type Stubbed = {
  regenerateLoadedAgent: (
    opts: { analysisId: string; agentKey: string; actorId: string; extendBudget?: boolean },
    analysis: unknown,
    controller: AbortController,
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
  readCodeFindingVerdicts: ReturnType<typeof vi.fn>;
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
  // #1131 — the persisted code findings a continuation scopes itself by. None
  // by default: every requirement is unreached.
  orch.readCodeFindingVerdicts = vi.fn(async () => []);
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
    new AbortController(),
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

/**
 * PR #1095 panel, T3 — a regenerate re-runs synthesis, which rewrites every
 * requirement row. Without the run's imported items it cannot be asked which
 * item each requirement restates, and every "Imported as" link is lost.
 */
describe("#1063 a regenerate hands the run's imported items to synthesis", () => {
  const sourceRequirements = [
    {
      candidateId: "NR-1",
      requirementId: "req-imported-1",
      title: "Add a button to terminate all sessions",
      externalSource: "github",
      externalId: "4074",
      externalUrl: "https://github.com/miniflux/v2/issues/4074",
    },
    {
      candidateId: "NR-2",
      requirementId: "req-imported-2",
      title: "Mark all as read older than X",
      externalSource: "github",
      externalId: "3838",
      externalUrl: null,
    },
  ];
  const imported = {
    ...ANALYSIS,
    metadata: JSON.stringify({ model: "deepseek-flash", sourceRequirements }),
  };
  const regenerateOn = (orch: Stubbed, analysis: unknown, agentKey = "code") =>
    orch.regenerateLoadedAgent(
      { analysisId: "an_1", agentKey, actorId: "u1" },
      analysis,
      new AbortController(),
    );

  it.each(["code", "document"])("on a %s regenerate", async (agentKey) => {
    const orch = makeOrchestrator();
    await regenerateOn(orch, imported, agentKey);
    expect(orch.runSynthesisAndPersist).toHaveBeenCalledTimes(1);
    expect(orch.runSynthesisAndPersist.mock.calls[0][0].sourceRequirements).toEqual(
      sourceRequirements,
    );
  });

  it("hands it none on a run that was not started from imported items", async () => {
    const orch = makeOrchestrator();
    await regenerateOn(orch, ANALYSIS);
    expect(orch.runSynthesisAndPersist.mock.calls[0][0].sourceRequirements).toEqual([]);
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
    // #1131 — counted over the whole analysis's code findings after the rerun,
    // not over the rerun's own (smaller) requirement set.
    const orch = makeOrchestrator({ ...health(true), unverifiedRequirements: 9 });
    await regenerate(orch, { extendBudget: true });
    expect(persisted()).toMatchObject({
      codeInvestigationCutShort: true,
      codeInvestigationContinuations: 1,
      codeInvestigationUnreached: { unreached: 1, inconclusive: 0, total: 1 },
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

  it("records the analysis's gap even when the cut-short pass reported no count", async () => {
    // #1131 — read from the persisted findings, not from the pass's own report.
    const orch = makeOrchestrator(health(true));
    await regenerate(orch, { extendBudget: true });
    expect(persisted().codeInvestigationUnreached).toEqual({
      unreached: 1,
      inconclusive: 0,
      total: 1,
    });
    expect(persisted().codeInvestigationContinuations).toBe(1);
  });

  it("an ordinary regenerate that ran out records no gap when its pass counted none", async () => {
    const orch = makeOrchestrator(health(true));
    await regenerate(orch);
    expect(persisted()).not.toHaveProperty("codeInvestigationUnreached");
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

/**
 * #1131 — #706 run 8: Continue re-ran the whole code pass and synthesis, and
 * in one case cost more than the run it continued. It now re-investigates only
 * the requirements the pass never reached, keeping the findings it has.
 */
describe("#1131 Continue re-investigates only the requirements left unreached", () => {
  const THREE = [
    { id: "REQ-1", text: "A user cannot subscribe to the same feed URL twice." },
    { id: "REQ-2", text: "Publishing goes only to the openzigs/flux-v2 repository." },
    { id: "REQ-3", text: "The CLI accepts -flush-sessions to remove every session." },
  ];
  // REQ-2 was looked at (its finding cites code) but is not settled: inconclusive.
  // REQ-3 was never reached: the agentic prompt's VERDICT_RULE still has the
  // model write an uncited could-not-verify placeholder for it (review of #1451).
  const BEFORE = [
    { requirementId: "REQ-1", verdict: "implemented" },
    { requirementId: "REQ-2", verdict: "could-not-verify", codeCited: true },
    { requirementId: "REQ-3", verdict: "could-not-verify", codeCited: false },
  ];
  const persisted = () =>
    serviceMock.persistAnalysisCapability.mock.calls.at(-1)![1] as AnalysisCapability;
  const threeRequirements = (passHealth?: AnalysisRetrievalHealth) => {
    const orch = makeOrchestrator(passHealth);
    orch.extractRequirementsFromDocAgent = vi.fn(async () => THREE);
    return orch;
  };

  it("runs the code pass on the unreached requirements alone, appending its findings", async () => {
    const orch = threeRequirements();
    orch.readCodeFindingVerdicts = vi.fn(async () => BEFORE);
    await regenerate(orch, { extendBudget: true });
    const input = orch.runAgenticCodeAgent.mock.calls[0][0];
    expect(input.requirements.map((r: { id: string }) => r.id)).toEqual(["REQ-3"]);
    expect(input.persistMode).toBe("append");
    // The earlier rows hold the findings it keeps: nothing is deleted.
    expect(prismaMock.agentResult.deleteMany).not.toHaveBeenCalled();
    // Synthesis runs again, over every finding, so the new ones reach requirements.
    expect(orch.runSynthesisAndPersist).toHaveBeenCalledTimes(1);
  });

  it("escalates only the requirements it re-investigates", async () => {
    const orch = threeRequirements();
    orch.readCodeFindingVerdicts = vi.fn(async () => BEFORE);
    await regenerate(orch, { extendBudget: true });
    expect(orch.computeEscalations.mock.calls[0][2].map((r: { id: string }) => r.id)).toEqual([
      "REQ-3",
    ]);
  });

  it("an ordinary regenerate still re-runs every requirement and replaces the rows", async () => {
    const orch = threeRequirements();
    orch.readCodeFindingVerdicts = vi.fn(async () => BEFORE);
    await regenerate(orch);
    const input = orch.runAgenticCodeAgent.mock.calls[0][0];
    expect(input.requirements).toHaveLength(3);
    expect(input.persistMode).toBeUndefined();
    expect(orch.readCodeFindingVerdicts).not.toHaveBeenCalled();
  });

  it("records the whole analysis's gap after the rerun, inconclusive apart", async () => {
    const orch = threeRequirements({ ...health(true), unverifiedRequirements: 1 });
    orch.readCodeFindingVerdicts = vi
      .fn()
      .mockResolvedValueOnce(BEFORE)
      .mockResolvedValueOnce([
        ...BEFORE,
        { requirementId: "REQ-3", verdict: "could-not-verify", codeCited: true },
      ]);
    await regenerate(orch, { extendBudget: true });
    expect(persisted()).toMatchObject({
      codeInvestigationContinuations: 1,
      codeInvestigationUnreached: { unreached: 0, inconclusive: 2, total: 3 },
      // Every requirement was reached: no Continue, and they are named inconclusive.
      reasons: ["code-investigation-inconclusive"],
    });
  });

  it("spends nothing when no requirement is unreached, and corrects the banner", async () => {
    // A record written before #1131 counted inconclusive requirements as unreached.
    const orch = threeRequirements();
    orch.readCodeFindingVerdicts = vi.fn(async () => [
      ...BEFORE,
      { requirementId: "REQ-3", verdict: "could-not-verify", codeCited: true },
    ]);
    await regenerate(orch, { extendBudget: true });
    expect(orch.runAgenticCodeAgent).not.toHaveBeenCalled();
    expect(orch.runOneAgent).not.toHaveBeenCalled();
    expect(orch.runSynthesisAndPersist).not.toHaveBeenCalled();
    expect(persisted()).toMatchObject({
      codeInvestigationUnreached: { unreached: 0, inconclusive: 2, total: 3 },
      reasons: ["code-investigation-inconclusive"],
    });
    // Not counted: nothing was spent.
    expect(persisted()).not.toHaveProperty("codeInvestigationContinuations");
    expect(serviceMock.finalizeAnalysisDelta).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("shows the rerun's scope on the live entry while it runs", async () => {
    const { readLiveAgents } = await import("./live-agent-progress.js");
    const orch = threeRequirements();
    orch.readCodeFindingVerdicts = vi.fn(async () => BEFORE);
    let seen: unknown;
    orch.runAgenticCodeAgent.mockImplementation(async () => {
      seen = readLiveAgents("an_1");
      return { agentKey: "code", output: OUTPUT, usage: USAGE, durationMs: 1 };
    });
    await regenerate(orch, { extendBudget: true });
    expect(seen).toEqual([
      expect.objectContaining({
        agentKey: "code",
        rerun: true,
        continuation: { requirements: 1, total: 3 },
      }),
    ]);
  });

  it("a single-shot code pass cannot be scoped, so it re-runs whole as before", async () => {
    const orch = threeRequirements();
    orch.detectAgentMode = vi.fn(async () => "single-shot");
    orch.readCodeFindingVerdicts = vi.fn(async () => BEFORE);
    await regenerate(orch, { extendBudget: true });
    expect(orch.runOneAgent).toHaveBeenCalledTimes(1);
    expect(orch.runOneAgent.mock.calls[0][0].knownRequirementIds).toEqual([
      "REQ-1",
      "REQ-2",
      "REQ-3",
    ]);
  });
});

/**
 * Review of PR #1451 (blocking) — a continuation APPENDS, so the first pass's
 * uncited could-not-verify placeholder for a re-investigated requirement stayed
 * beside the new finding, and could-not-verify outranks implemented
 * (`deriveRequirementVerdict`): a requirement the continuation confirmed still
 * read "Could not verify", and the record called it inconclusive. Driven
 * against an in-memory finding store, through the real reader and the real
 * delete, with a mock that honours every filter the queries send.
 */
describe("#1131 a successful continuation supersedes the placeholders it re-investigated", () => {
  type Row = {
    id: string;
    analysisId: string;
    agentKey: string;
    status: string;
    connectorId: string | null;
    createdAt: Date;
    published: boolean;
    evidence: string;
  };
  let rows: Row[] = [];
  const OLD = new Date(0);
  const row = (
    id: string,
    evidence: Record<string, unknown>,
    extra: Partial<Omit<Row, "id" | "evidence">> = {},
  ): Row => ({
    id,
    analysisId: "an_1",
    agentKey: "code",
    status: "completed",
    connectorId: "repo_1",
    createdAt: OLD,
    published: false,
    evidence: JSON.stringify(evidence),
    ...extra,
  });
  const CITE = [{ filePath: "internal/storage/feed.go", startLine: 1, endLine: 9 }];
  const PLACEHOLDER = (requirementId: string) => ({
    requirementId,
    verdict: "could-not-verify",
    citations: [],
  });
  const CONFIRMED = {
    requirementId: "REQ-3",
    verdict: "implemented",
    citations: CITE,
  };
  const THREE = [
    {
      id: "REQ-1",
      text: "A user cannot subscribe to the same feed URL twice.",
    },
    {
      id: "REQ-2",
      text: "Publishing goes only to the openzigs/flux-v2 repository.",
    },
    {
      id: "REQ-3",
      text: "The CLI accepts -flush-sessions to remove every session.",
    },
  ];

  type AgentResultWhere = {
    analysisId?: string;
    agentKey?: string;
    status?: string;
    createdAt?: { lt: Date };
    OR?: Array<{ connectorId: string | null }>;
  };
  const matches = (
    r: Row,
    where: { agentResult: AgentResultWhere; issueLinks?: { none: object } },
  ) => {
    const a = where.agentResult;
    if (a.analysisId !== undefined && r.analysisId !== a.analysisId) return false;
    if (a.agentKey !== undefined && r.agentKey !== a.agentKey) return false;
    if (a.status !== undefined && r.status !== a.status) return false;
    if (a.createdAt && !(r.createdAt < a.createdAt.lt)) return false;
    if (a.OR && !a.OR.some((c) => c.connectorId === r.connectorId)) return false;
    if (where.issueLinks?.none && r.published) return false;
    return true;
  };

  beforeEach(() => {
    rows = [
      row("f1", {
        requirementId: "REQ-1",
        verdict: "implemented",
        citations: CITE,
      }),
      row("f2", {
        requirementId: "REQ-2",
        verdict: "could-not-verify",
        citations: CITE,
      }),
      // The placeholder the first pass wrote for the requirement it never reached.
      row("f3", PLACEHOLDER("REQ-3")),
    ];
    prismaMock.finding.findMany.mockImplementation((async (args: {
      where: { agentResult: AgentResultWhere; issueLinks?: { none: object } };
    }) =>
      rows
        .filter((r) => matches(r, args.where))
        .map((r) => ({
          id: r.id,
          evidence: r.evidence,
          agentResult: { connectorId: r.connectorId },
        }))) as never);
    prismaMock.finding.deleteMany.mockImplementation((async (args: {
      where: { id: { in: string[] } };
    }) => {
      const before = rows.length;
      rows = rows.filter((r) => !args.where.id.in.includes(r.id));
      return { count: before - rows.length };
    }) as never);
  });

  const continuingOrchestrator = (newFinding: Record<string, unknown> | null) => {
    // The rerun is cut short as well, so the record keeps counting what is left.
    const orch = makeOrchestrator(health(true));
    orch.extractRequirementsFromDocAgent = vi.fn(async () => THREE);
    // Use the REAL reader over the in-memory store.
    delete (orch as Partial<Stubbed>).readCodeFindingVerdicts;
    const recordHealth = orch.runAgenticCodeAgent.getMockImplementation() as (input: {
      analysisId: string;
    }) => Promise<unknown>;
    orch.runAgenticCodeAgent.mockImplementation(
      async (input: { analysisId: string; connectorId?: string }) => {
        if (newFinding) {
          rows.push(
            row(`f_new_${input.connectorId ?? "none"}`, newFinding, {
              connectorId: input.connectorId ?? null,
              createdAt: new Date(Date.now() + 60_000),
            }),
          );
        }
        return recordHealth(input);
      },
    );
    return orch;
  };

  it("a requirement the continuation confirmed is no longer inconclusive", async () => {
    const orch = continuingOrchestrator(CONFIRMED);
    await regenerate(orch, { extendBudget: true });
    expect(
      orch.runAgenticCodeAgent.mock.calls[0][0].requirements.map((r: { id: string }) => r.id),
    ).toEqual(["REQ-3"]);
    // The placeholder is gone; the first pass's other findings are kept.
    expect(rows.map((r) => r.id).sort()).toEqual(["f1", "f2", "f_new_repo_1"]);
    const persisted = serviceMock.persistAnalysisCapability.mock.calls.at(
      -1,
    )![1] as AnalysisCapability;
    // The rerun ran out too, but REQ-3 is settled: only REQ-2 is left, inconclusive.
    expect(persisted.codeInvestigationUnreached).toEqual({
      unreached: 0,
      inconclusive: 1,
      total: 3,
    });
    expect(persisted.reasons).toEqual(["code-investigation-inconclusive"]);
  });

  it("the reader then classifies the confirmed requirement as settled", async () => {
    const orch = continuingOrchestrator(CONFIRMED);
    await regenerate(orch, { extendBudget: true });
    const reader = (
      orch as unknown as {
        readCodeFindingVerdicts: (
          id: string,
        ) => Promise<Parameters<typeof classifyUnverifiedRequirements>[0]>;
      }
    ).readCodeFindingVerdicts.bind(orch);
    expect(
      classifyUnverifiedRequirements(await reader("an_1"), ["REQ-1", "REQ-2", "REQ-3"]),
    ).toEqual({ unreached: [], inconclusive: ["REQ-2"] });
  });

  it("queries exactly this analysis's earlier, unpublished code rows of this repository or none", async () => {
    const orch = continuingOrchestrator(CONFIRMED);
    await regenerate(orch, { extendBudget: true });
    const supersede = prismaMock.finding.findMany.mock.calls
      .map((c) => (c as unknown as [{ where: { agentResult: AgentResultWhere } }])[0])
      .find((args) => args.where.agentResult.createdAt !== undefined)!;
    expect(supersede).toEqual({
      where: {
        agentResult: {
          analysisId: "an_1",
          agentKey: "code",
          createdAt: { lt: expect.any(Date) },
          OR: [{ connectorId: "repo_1" }, { connectorId: null }],
        },
        issueLinks: { none: {} },
      },
      select: { id: true, evidence: true },
    });
  });

  it("deletes only the placeholders its filters admit", async () => {
    rows.push(
      // Another repository's placeholder for the same requirement.
      row("keep_repo2", PLACEHOLDER("REQ-3"), { connectorId: "repo_2" }),
      // Written after the continuation started (by the continuation itself).
      row("keep_new", PLACEHOLDER("REQ-3"), {
        createdAt: new Date(Date.now() + 30_000),
      }),
      // Another analysis's placeholder.
      row("keep_other_analysis", PLACEHOLDER("REQ-3"), { analysisId: "an_2" }),
      // Another agent's finding of the same shape.
      row("keep_other_agent", PLACEHOLDER("REQ-3"), { agentKey: "document" }),
      // A placeholder published as an issue: its link would cascade away.
      row("keep_published", PLACEHOLDER("REQ-3"), { published: true }),
      // A cited could-not-verify, and a requirement the continuation did not re-run.
      // (On a failed row, which the reader skips, so REQ-3 still counts as unreached.)
      row(
        "keep_cited",
        { requirementId: "REQ-3", verdict: "could-not-verify", citations: CITE },
        { status: "failed" },
      ),
      row("keep_unscoped", PLACEHOLDER("REQ-9")),
      // A connector-less row counts for every repository: its placeholder goes.
      row("gone_connectorless", PLACEHOLDER("REQ-3"), { connectorId: null }),
    );
    const orch = continuingOrchestrator(CONFIRMED);
    await regenerate(orch, { extendBudget: true });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("f3");
    expect(ids).not.toContain("gone_connectorless");
    for (const kept of [
      "keep_repo2",
      "keep_new",
      "keep_other_analysis",
      "keep_other_agent",
      "keep_published",
      "keep_cited",
      "keep_unscoped",
    ]) {
      expect(ids).toContain(kept);
    }
  });

  it("deletes nothing when the continuation pass fails", async () => {
    const orch = continuingOrchestrator(null);
    orch.runAgenticCodeAgent.mockRejectedValue(new Error("model down"));
    await regenerate(orch, { extendBudget: true });
    expect(prismaMock.finding.deleteMany).not.toHaveBeenCalled();
    expect(rows.map((r) => r.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("deletes nothing when the continuation is cancelled", async () => {
    const orch = continuingOrchestrator(CONFIRMED);
    const controller = new AbortController();
    const pass = orch.runAgenticCodeAgent.getMockImplementation() as (input: {
      analysisId: string;
    }) => Promise<unknown>;
    orch.runAgenticCodeAgent.mockImplementation(async (input: { analysisId: string }) => {
      const out = await pass(input);
      controller.abort();
      return out;
    });
    await orch.regenerateLoadedAgent(
      {
        analysisId: "an_1",
        agentKey: "code",
        actorId: "u1",
        extendBudget: true,
      },
      ANALYSIS,
      controller,
    );
    expect(prismaMock.finding.deleteMany).not.toHaveBeenCalled();
  });

  /**
   * Review of PR #1451, cycle 2 (blocking) — the recorded scope is an upper
   * bound. A continuation that failed part-way leaves the record unrefreshed
   * and the retry allowed; the retry must not re-investigate what the first
   * attempt's successful repository already reached.
   */
  it("a retry after a partial failure skips what the first attempt reached", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([
      { id: "repo_1", label: "api" },
      { id: "repo_2", label: "web" },
    ]);
    rows.push(row("f3_repo2", PLACEHOLDER("REQ-3"), { connectorId: "repo_2" }));
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationUnreached: { unreached: 1, inconclusive: 1, total: 3 },
      codeInvestigationScope: { repo_1: ["REQ-3"], repo_2: ["REQ-3"] },
    });
    const orch = continuingOrchestrator(CONFIRMED);
    const pass = orch.runAgenticCodeAgent.getMockImplementation() as (input: {
      analysisId: string;
      connectorId?: string;
    }) => Promise<unknown>;
    let attempt = 1;
    orch.runAgenticCodeAgent.mockImplementation(
      async (input: { analysisId: string; connectorId?: string }) => {
        if (attempt === 1 && input.connectorId === "repo_2") throw new Error("repo_2 failed");
        return pass(input);
      },
    );
    await regenerate(orch, { extendBudget: true });
    expect(serviceMock.finalizeAnalysisDelta).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed" }),
    );

    attempt = 2;
    orch.runAgenticCodeAgent.mockClear();
    await regenerate(orch, { extendBudget: true });
    const retried = orch.runAgenticCodeAgent.mock.calls.map((c) => ({
      connectorId: c[0].connectorId,
      ids: c[0].requirements.map((r: { id: string }) => r.id),
    }));
    expect(retried).toEqual([{ connectorId: "repo_2", ids: ["REQ-3"] }]);
    // repo_1's confirmation is not duplicated.
    expect(rows.filter((r) => r.id === "f_new_repo_1")).toHaveLength(1);
  });
});

/**
 * Review of PR #1451 — the scope the page quotes (the run's record) bounds the
 * scope that runs: the persisted findings would re-run more, the record wins.
 */
describe("#1131 a continuation runs the scope the run recorded", () => {
  const TWO = [
    {
      id: "REQ-1",
      text: "A user cannot subscribe to the same feed URL twice.",
    },
    {
      id: "REQ-2",
      text: "Publishing goes only to the openzigs/flux-v2 repository.",
    },
  ];

  it("re-investigates only the recorded requirements", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationUnreached: { unreached: 1, inconclusive: 0, total: 2 },
      codeInvestigationScope: { repo_1: ["REQ-1"] },
    });
    const orch = makeOrchestrator();
    orch.extractRequirementsFromDocAgent = vi.fn(async () => TWO);
    // No findings at all: the findings alone would re-run both.
    orch.readCodeFindingVerdicts = vi.fn(async () => []);
    await regenerate(orch, { extendBudget: true });
    expect(
      orch.runAgenticCodeAgent.mock.calls[0][0].requirements.map((r: { id: string }) => r.id),
    ).toEqual(["REQ-1"]);
  });

  it("falls back to the findings when the record's repositories match none of today's", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationUnreached: { unreached: 1, inconclusive: 0, total: 2 },
      codeInvestigationScope: { repo_gone: ["REQ-1"] },
    });
    const orch = makeOrchestrator();
    orch.extractRequirementsFromDocAgent = vi.fn(async () => TWO);
    orch.readCodeFindingVerdicts = vi.fn(async () => []);
    await regenerate(orch, { extendBudget: true });
    expect(orch.runAgenticCodeAgent).toHaveBeenCalledTimes(1);
    expect(
      orch.runAgenticCodeAgent.mock.calls[0][0].requirements.map((r: { id: string }) => r.id),
    ).toEqual(["REQ-1", "REQ-2"]);
  });
});
describe("#1131 the persisted code findings a continuation is scoped by", () => {
  it("reads each completed code finding's repository, requirement, verdict and code citation", async () => {
    prismaMock.finding.findMany.mockResolvedValue([
      {
        evidence: JSON.stringify({
          requirementId: "REQ-1",
          verdict: "could-not-verify",
          citations: [{ filePath: "internal/storage/feed.go", startLine: 1, endLine: 9 }],
        }),
        agentResult: { connectorId: "repo_1" },
      },
      {
        evidence: JSON.stringify({ requirementId: "REQ-2", citations: [{ documentId: "d1" }] }),
        agentResult: { connectorId: null },
      },
      { evidence: null, agentResult: null },
      { evidence: "{not json", agentResult: { connectorId: "repo_2" } },
    ] as never);
    const orch = new AnalysisOrchestrator({
      provider: { chat: vi.fn() } as never,
      retrieve: async () => [],
    }) as unknown as { readCodeFindingVerdicts: (id: string) => Promise<unknown> };
    await expect(orch.readCodeFindingVerdicts("an_1")).resolves.toEqual([
      {
        connectorId: "repo_1",
        requirementId: "REQ-1",
        verdict: "could-not-verify",
        codeCited: true,
      },
      { connectorId: null, requirementId: "REQ-2", verdict: null, codeCited: false },
      { connectorId: null, requirementId: null, verdict: null, codeCited: false },
      { connectorId: "repo_2", requirementId: null, verdict: null, codeCited: false },
    ]);
    expect(prismaMock.finding.findMany).toHaveBeenCalledWith({
      where: { agentResult: { analysisId: "an_1", agentKey: "code", status: "completed" } },
      select: { evidence: true, agentResult: { select: { connectorId: true } } },
    });
  });
});

/**
 * PR panel (#1131, over-blocking advisory) — the run decides the offer per
 * repository (one pass each), so the continuation is scoped per repository
 * too: a requirement one repository settled can still be unreached in another.
 */
describe("#1131 a multi-repository continuation is scoped per repository", () => {
  const TWO = [
    { id: "REQ-1", text: "A user cannot subscribe to the same feed URL twice." },
    { id: "REQ-2", text: "Publishing goes only to the openzigs/flux-v2 repository." },
  ];

  it("re-runs each repository on what its own pass left unreached, and skips one with none", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([
      { id: "repo_1", label: "api" },
      { id: "repo_2", label: "web" },
      { id: "repo_3", label: "docs" },
    ]);
    const orch = makeOrchestrator();
    orch.extractRequirementsFromDocAgent = vi.fn(async () => TWO);
    orch.readCodeFindingVerdicts = vi.fn(async () => [
      // repo_1 looked at both; repo_2 reached REQ-1 only; repo_3 reached neither.
      { connectorId: "repo_1", requirementId: "REQ-1", verdict: "implemented", codeCited: true },
      {
        connectorId: "repo_1",
        requirementId: "REQ-2",
        verdict: "could-not-verify",
        codeCited: true,
      },
      {
        connectorId: "repo_2",
        requirementId: "REQ-1",
        verdict: "could-not-verify",
        codeCited: true,
      },
      { connectorId: "repo_3", requirementId: "REQ-1", verdict: "could-not-verify" },
    ]);
    await regenerate(orch, { extendBudget: true });
    const calls = orch.runAgenticCodeAgent.mock.calls.map((c) => ({
      connectorId: c[0].connectorId,
      ids: c[0].requirements.map((r: { id: string }) => r.id),
    }));
    expect(calls).toEqual([
      { connectorId: "repo_2", ids: ["REQ-2"] },
      { connectorId: "repo_3", ids: ["REQ-1", "REQ-2"] },
    ]);
  });
});

/**
 * PR panel (#1131, test-falsifiability advisory) — a failed or cancelled
 * APPEND must not delete the row whose findings it was adding to.
 */
describe("#1131 a failed appended pass keeps the rows it was adding to", () => {
  it("records the failure row in append mode", async () => {
    const orch = new AnalysisOrchestrator({
      provider: { chat: vi.fn() } as never,
      retrieve: async () => [],
    }) as unknown as {
      runAgenticCodeAgent: (input: Record<string, unknown>) => Promise<unknown>;
      deps: { prepareRepoClone?: unknown };
    };
    // The first thing the pass does after starting is resolve the clone: fail there.
    orch.deps.prepareRepoClone = vi.fn(async () => {
      throw new Error("clone failed");
    });
    for (const persistMode of ["append", undefined] as const) {
      await expect(
        orch.runAgenticCodeAgent({
          analysisId: "an_1",
          projectId: "pr_1",
          projectName: "Miniflux",
          projectDescription: "feed reader",
          requirements: [],
          signal: new AbortController().signal,
          connectorId: "repo_1",
          ...(persistMode ? { persistMode } : {}),
        }),
      ).rejects.toThrow("clone failed");
    }
    const modes = serviceMock.persistAgentResult.mock.calls.map((c) => c[0]);
    expect(modes).toEqual([
      expect.objectContaining({ status: "failed", mode: "append" }),
      expect.objectContaining({ status: "failed", mode: "replace" }),
    ]);
  });
});

describe("#1131 Continue is refused where a larger budget cannot help", () => {
  const asOrch = (orch: Stubbed) =>
    orch as unknown as { assertCanContinueInvestigation: (id: string) => Promise<void> };

  it("refuses an inconclusive-only run, naming why", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationUnreached: { unreached: 0, inconclusive: 3, total: 19 },
      reasons: ["code-investigation-inconclusive"],
    });
    await expect(
      asOrch(makeOrchestrator()).assertCanContinueInvestigation("an_1"),
    ).rejects.toMatchObject({
      code: "CODE_INVESTIGATION_CONTINUE_NOT_OFFERED",
      message: expect.stringContaining("inconclusive"),
    });
  });

  it("refuses a run that was not cut short at all", async () => {
    serviceMock.getAnalysisCapability.mockResolvedValue({
      ...CUT_SHORT,
      codeInvestigationCutShort: false,
      reasons: [],
    });
    await expect(
      asOrch(makeOrchestrator()).assertCanContinueInvestigation("an_1"),
    ).rejects.toBeInstanceOf(CodeInvestigationContinueNotOfferedError);
  });
});

/**
 * Review of PR #1451, cycle 2 — a resume of budget-skipped repositories
 * records pass health and reach that it never reads; the next regenerate must
 * not take them for its own.
 */
describe("#1131 a resume leaves no per-pass records behind", () => {
  it("clears the pass reaches and retrieval healths it recorded", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_2", label: "web" }]);
    const orch = makeOrchestrator(health(true)) as unknown as Stubbed & {
      resumeLoadedRepos: (
        o: { analysisId: string; actorId: string },
        loaded: unknown,
      ) => Promise<unknown>;
      passReaches: Map<string, unknown[]>;
    };
    orch.runAgenticCodeAgent.mockImplementation(async (input: { analysisId: string }) => {
      orch.recordRetrievalHealth(input.analysisId, health(true));
      orch.passReaches.set(input.analysisId, [{ repo: "repo_2" }]);
      return { agentKey: "code", output: OUTPUT, usage: USAGE, durationMs: 1 };
    });
    await orch.resumeLoadedRepos(
      { analysisId: "an_1", actorId: "u1" },
      { analysis: ANALYSIS, skippedRepos: [{ connectorId: "repo_2", label: "web" }] },
    );
    expect(orch.runAgenticCodeAgent).toHaveBeenCalledTimes(1);
    expect(orch.passReaches.has("an_1")).toBe(false);
    expect(orch.retrievalHealths.has("an_1")).toBe(false);
  });
});
