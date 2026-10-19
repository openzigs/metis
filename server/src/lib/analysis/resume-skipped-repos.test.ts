/**
 * Issue #741 (Epic #727) — orchestrator-level multi-repo resume.
 *
 * Drives the REAL `AnalysisOrchestrator.resumeSkippedRepos` /
 * `assertCanResumeRepos` against an in-memory Prisma fake. The provider-backed
 * collaborators (`runAgenticCodeAgent`, `runSynthesisAndPersist`) and the
 * degradation helpers (`computeAffectedCode` / `computeEscalations` /
 * `extractRequirementsFromDocAgent`) are spied so the RESUME ORCHESTRATION is
 * the unit under test: which connectors run, at what budget, with append-merge
 * persistence, the capability update, the concurrency guard, and the no-op path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveCapabilityReasons, type AnalysisCapability } from "@metis/shared";

const ANALYSIS_ID = "an_1";
const PROJECT_ID = "pr_1";

function capabilityMeta(skipped: AnalysisCapability["skippedRepos"]): string {
  const base = {
    codeAnalysisRequested: true,
    databaseAnalysisRequested: false,
    codeGraphPresent: true,
    agentMode: "agentic" as const,
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
    quarantineFallbackUsed: false,
    skippedRepos: skipped,
  };
  const capability: AnalysisCapability = { ...base, reasons: deriveCapabilityReasons(base) };
  return JSON.stringify({ capability });
}

const state = {
  status: "completed" as string,
  metadata: capabilityMeta([]) as string | null,
  connectors: [] as Array<{ id: string; label: string }>,
  updates: [] as Array<Record<string, unknown>>,
  /** #1145 — the project's own model, read by an Auto run. */
  aiModel: null as string | null,
};

vi.mock("../prisma.js", () => ({
  resolveDatabaseProvider: () => "sqlite",
  prisma: {
    // #909 — metadata merge-writers run in a transaction; this fake runs it on itself.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn((await import("../prisma.js")).prisma),
    ),
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== ANALYSIS_ID) return null;
        return {
          id: ANALYSIS_ID,
          projectId: PROJECT_ID,
          status: state.status,
          metadata: state.metadata,
          project: {
            name: "Proj",
            description: "desc",
            status: "active",
            aiModel: state.aiModel,
            aiProviderId: null,
          },
        };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.updates.push(data);
        if (typeof data.metadata === "string") state.metadata = data.metadata;
        if (typeof data.status === "string") state.status = data.status as string;
        return { id: ANALYSIS_ID };
      }),
    },
    repoConnection: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        return state.connectors.filter((c) => where.id.in.includes(c.id));
      }),
    },
  },
}));

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));

const { AnalysisOrchestrator, AnalysisNotRegeneratableError } = await import("./orchestrator.js");

function readCapability(): AnalysisCapability | null {
  if (!state.metadata) return null;
  const parsed = JSON.parse(state.metadata) as { capability?: AnalysisCapability };
  return parsed.capability ?? null;
}

/** A private orchestrator collaborator, typed as a callable so `vi.spyOn` can see it. */
type Spyable<K extends string> = Record<K, (...args: unknown[]) => Promise<unknown>>;

function makeOrch(provider: object = {}) {
  const orch = new AnalysisOrchestrator({ provider: provider as never });
  // Heavy / provider-backed collaborators — spied so the resume orchestration is
  // isolated. `runAgenticCodeAgent` returns canned usage; the append-merge it
  // performs is proven separately in resume-persistence.test.ts.
  const runAgenticCodeAgent = vi
    .spyOn(orch as never as Spyable<"runAgenticCodeAgent">, "runAgenticCodeAgent")
    .mockResolvedValue({
      agentKey: "code",
      output: { agentKey: "code", summary: "", notes: [], findings: [] },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      durationMs: 1,
    } as never);
  const runSynthesisAndPersist = vi
    .spyOn(orch as never as Spyable<"runSynthesisAndPersist">, "runSynthesisAndPersist")
    .mockResolvedValue(undefined as never);
  vi.spyOn(
    orch as never as Spyable<"extractRequirementsFromDocAgent">,
    "extractRequirementsFromDocAgent",
  ).mockResolvedValue([{ id: "REQ-001", text: "req" }] as never);
  vi.spyOn(
    orch as never as Spyable<"computeAffectedCode">,
    "computeAffectedCode",
  ).mockResolvedValue({ block: "", tokens: 0, filePaths: [], result: { candidates: [] } } as never);
  vi.spyOn(orch as never as Spyable<"computeEscalations">, "computeEscalations").mockResolvedValue(
    undefined as never,
  );
  return { orch, runAgenticCodeAgent, runSynthesisAndPersist };
}

describe("AnalysisOrchestrator.resumeSkippedRepos (#741)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.status = "completed";
    state.metadata = capabilityMeta([]);
    state.connectors = [];
    state.updates = [];
    state.aiModel = null;
  });

  // #1145 adversarial review — the resume path resolved Auto through the same
  // helper as start/regenerate, but nothing proved it passed the project.
  it("#1145 — an Auto run on a project with aiModel resumes its repos on that model", async () => {
    state.metadata = capabilityMeta([{ connectorId: "c2", label: "worker" }]);
    state.connectors = [{ id: "c2", label: "worker" }];
    state.aiModel = "claude-sonnet-5-5";
    const { orch, runAgenticCodeAgent } = makeOrch({
      key: "anthropic",
      model: "claude-sonnet-5",
      servesRouterModel: () => true,
    });

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(runAgenticCodeAgent).toHaveBeenCalledTimes(1);
    expect((runAgenticCodeAgent.mock.calls[0]![0] as { model?: string }).model).toBe(
      "claude-sonnet-5-5",
    );
  });

  it("re-runs each skipped connector with append-mode + a full budget, then re-synthesizes", async () => {
    state.metadata = capabilityMeta([
      { connectorId: "c2", label: "worker" },
      { connectorId: "c3", label: "api" },
    ]);
    state.connectors = [
      { id: "c2", label: "worker" },
      { id: "c3", label: "api" },
    ];
    const { orch, runAgenticCodeAgent, runSynthesisAndPersist } = makeOrch();

    const result = await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(result.noop).toBe(false);
    expect(result.resumed.map((r) => r.connectorId).sort()).toEqual(["c2", "c3"]);
    expect(result.remaining).toEqual([]);

    // One agentic pass per skipped connector, each append-mode, each with a full
    // per-repo budget (100k / 2 = 50k, the floor — not the starved sub-floor slice).
    expect(runAgenticCodeAgent).toHaveBeenCalledTimes(2);
    for (const call of runAgenticCodeAgent.mock.calls) {
      const arg = call[0] as { persistMode: string; tokenBudget: number; connectorId: string };
      expect(arg.persistMode).toBe("append");
      expect(arg.tokenBudget).toBe(50_000);
    }
    expect(
      runAgenticCodeAgent.mock.calls
        .map((c) => (c[0] as { connectorId: string }).connectorId)
        .sort(),
    ).toEqual(["c2", "c3"]);

    // Synthesis re-runs over the merged finding set.
    expect(runSynthesisAndPersist).toHaveBeenCalledTimes(1);

    // Capability is updated to clear the resumed repos → reason disappears.
    const cap = readCapability();
    expect(cap?.skippedRepos).toEqual([]);
    expect(cap?.reasons).not.toContain("repos-skipped-budget");

    // Tokens committed atomically as an increment delta (2 × 15 = 30 total).
    const finalize = state.updates.find((u) => u.status === "completed");
    expect(finalize?.totalTokens).toEqual({ increment: 30 });
  });

  // PR #1095 panel, T3 — the re-synthesis rewrites every requirement row, so it
  // must be given the run's imported items or every "Imported as" link is lost.
  it("#1063 — hands the run's imported items to the re-synthesis", async () => {
    const sourceRequirements = [
      {
        candidateId: "NR-1",
        requirementId: "req-imported-1",
        title: "Add a button to terminate all sessions",
        externalSource: "github",
        externalId: "4074",
        externalUrl: "https://github.com/miniflux/v2/issues/4074",
      },
    ];
    state.metadata = JSON.stringify({
      ...JSON.parse(capabilityMeta([{ connectorId: "c2", label: "worker" }])),
      sourceRequirements,
    });
    state.connectors = [{ id: "c2", label: "worker" }];
    const { orch, runSynthesisAndPersist } = makeOrch();

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(runSynthesisAndPersist).toHaveBeenCalledTimes(1);
    expect(
      (runSynthesisAndPersist.mock.calls[0]![0] as { sourceRequirements: unknown })
        .sourceRequirements,
    ).toEqual(sourceRequirements);
  });

  it("#1098 — a resumed repo is given the imported items, not the document's other features", async () => {
    state.metadata = JSON.stringify({
      ...JSON.parse(capabilityMeta([{ connectorId: "c2", label: "worker" }])),
      extraInstructions: "- Add a button to terminate all sessions",
      sourceRequirements: [
        {
          candidateId: "NR-1",
          requirementId: "req-imported-1",
          title: "Add a button to terminate all sessions",
          externalSource: "github",
          externalId: "4074",
          externalUrl: null,
        },
      ],
    });
    state.connectors = [{ id: "c2", label: "worker" }];
    const { orch, runAgenticCodeAgent } = makeOrch();

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    const pass = runAgenticCodeAgent.mock.calls[0]![0] as { requirements: Array<{ id: string }> };
    // The document's REQ-001 ("req") restates no imported item.
    expect(pass.requirements.map((r) => r.id)).toEqual(["NR-1"]);
  });

  // #1027 — a resumed repo is analysed with the same plan context as its siblings.
  it("#1027 — hands the run's plan context to each resumed repo, never to the re-synthesis", async () => {
    const agentContext = "Tasks (tasks.md):\n- T01: Add the unique index on feeds";
    state.metadata = JSON.stringify({
      ...JSON.parse(
        capabilityMeta([
          { connectorId: "c2", label: "worker" },
          { connectorId: "c3", label: "api" },
        ]),
      ),
      agentContext,
    });
    state.connectors = [
      { id: "c2", label: "worker" },
      { id: "c3", label: "api" },
    ];
    const { orch, runAgenticCodeAgent, runSynthesisAndPersist } = makeOrch();

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(runAgenticCodeAgent).toHaveBeenCalledTimes(2);
    for (const call of runAgenticCodeAgent.mock.calls) {
      expect((call[0] as { agentContext?: string }).agentContext).toBe(agentContext);
    }
    expect(runSynthesisAndPersist).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runSynthesisAndPersist.mock.calls)).not.toContain("unique index");
  });

  // Review of #1027 (panel) — the test above sees only that the context is
  // forwarded. Feeding the stored context to the requirement splitter or to
  // the affected-code mapping on a resume passed it.
  it("#1027 — derives the same requirements and affected-code input with a context as without", async () => {
    const extraInstructions =
      "AC-1: A user cannot subscribe to the same feed URL twice.\n\nAC-2: The refusal names the existing feed.";
    // Every line is written the way a requirement would be.
    const agentContext = [
      "Tasks (tasks.md):",
      "- T01: The service must add a ZebraIndex on feeds",
      "- T02: Users can see the ZebraNotice message",
    ].join("\n");
    const resume = async (context?: string) => {
      state.status = "completed";
      state.metadata = JSON.stringify({
        ...JSON.parse(capabilityMeta([{ connectorId: "c2", label: "worker" }])),
        extraInstructions,
        ...(context ? { agentContext: context } : {}),
      });
      state.connectors = [{ id: "c2", label: "worker" }];
      const { orch, runAgenticCodeAgent } = makeOrch();
      await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });
      const spies = orch as never as Record<
        "computeAffectedCode" | "computeEscalations",
        { mock: { calls: unknown[][] } }
      >;
      const pass = runAgenticCodeAgent.mock.calls[0]![0] as {
        requirements: Array<{ id: string }>;
        extraInstructions?: string;
        agentContext?: string;
      };
      return {
        pass,
        derived: {
          requirements: pass.requirements,
          extraInstructions: pass.extraInstructions,
          affectedCode: spies.computeAffectedCode.mock.calls,
          escalations: spies.computeEscalations.mock.calls,
        },
      };
    };

    const without = await resume();
    const withContext = await resume(agentContext);

    expect(withContext.derived).toEqual(without.derived);
    // Spelled out, so the comparison cannot pass on two wrong runs.
    expect(withContext.derived.requirements.map((r) => r.id)).toEqual(["REQ-001", "NR-1", "NR-2"]);
    expect(withContext.derived.affectedCode).toEqual([
      [ANALYSIS_ID, PROJECT_ID, extraInstructions],
    ]);
    expect(withContext.derived.escalations[0]![2]).toEqual(withContext.derived.requirements);
    expect(JSON.stringify(withContext.derived)).not.toContain("Zebra");
    // The context still reached the resumed pass.
    expect(withContext.pass.agentContext).toBe(agentContext);
    expect(without.pass).not.toHaveProperty("agentContext");
  });

  it("#1027 — adds no context key when the run was started without one", async () => {
    state.metadata = capabilityMeta([{ connectorId: "c2", label: "worker" }]);
    state.connectors = [{ id: "c2", label: "worker" }];
    const { orch, runAgenticCodeAgent } = makeOrch();

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(runAgenticCodeAgent.mock.calls[0]![0]).not.toHaveProperty("agentContext");
  });

  it("#1063 — hands the re-synthesis no imported items on any other run", async () => {
    state.metadata = capabilityMeta([{ connectorId: "c2", label: "worker" }]);
    state.connectors = [{ id: "c2", label: "worker" }];
    const { orch, runSynthesisAndPersist } = makeOrch();

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(
      (runSynthesisAndPersist.mock.calls[0]![0] as { sourceRequirements: unknown })
        .sourceRequirements,
    ).toEqual([]);
  });

  it("#943 — the analysis reads running until the re-synthesis has written its requirements", async () => {
    state.metadata = capabilityMeta([{ connectorId: "c2", label: "worker" }]);
    state.connectors = [{ id: "c2", label: "worker" }];
    const { orch, runAgenticCodeAgent, runSynthesisAndPersist } = makeOrch();
    const seen: string[] = [];
    runAgenticCodeAgent.mockImplementation((async () => {
      seen.push(state.status);
      return {
        agentKey: "code",
        output: { agentKey: "code", summary: "", notes: [], findings: [] },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        durationMs: 1,
      };
    }) as never);
    runSynthesisAndPersist.mockImplementation((async () => {
      seen.push(state.status);
    }) as never);

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(seen).toEqual(["running", "running"]);
    expect(state.status).toBe("completed");
  });

  // Review of PR #523 (#512) — a resumed forced-tier run sends the model the
  // Model card named: the provider's configured model on a non-Claude provider.
  it("resolves a persisted force-* override through the router with the provider attached", async () => {
    const withModel = JSON.parse(capabilityMeta([{ connectorId: "c2", label: "worker" }])) as {
      model?: string;
    };
    withModel.model = "force-sonnet";
    state.metadata = JSON.stringify(withModel);
    state.connectors = [{ id: "c2", label: "worker" }];
    const { orch, runAgenticCodeAgent } = makeOrch({
      key: "openai",
      model: "gpt-4.1",
      servesRouterModel: () => false,
    });

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(runAgenticCodeAgent).toHaveBeenCalledTimes(1);
    expect((runAgenticCodeAgent.mock.calls[0]![0] as { model?: string }).model).toBe("gpt-4.1");
  });

  it("re-caps an oversized skipped set and persists the still-remaining repos (loop guard)", async () => {
    const skipped = [
      { connectorId: "c2", label: "r2" },
      { connectorId: "c3", label: "r3" },
      { connectorId: "c4", label: "r4" },
    ];
    state.metadata = capabilityMeta(skipped);
    state.connectors = skipped.map((s) => ({ id: s.connectorId, label: s.label }));
    const { orch, runAgenticCodeAgent } = makeOrch();

    const result = await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    // 100k / 50k floor → only 2 of 3 fit; the 3rd stays skipped.
    expect(runAgenticCodeAgent).toHaveBeenCalledTimes(2);
    expect(result.resumed).toHaveLength(2);
    expect(result.remaining.map((r) => r.connectorId)).toEqual(["c4"]);
    const cap = readCapability();
    expect(cap?.skippedRepos.map((r) => r.connectorId)).toEqual(["c4"]);
    expect(cap?.reasons).toContain("repos-skipped-budget");
  });

  // #724 — the resumed repos' and the re-synthesis's model calls are billed to
  // the analysis's project: both run inside its usage scope.
  it("runs the resumed passes inside the analysis's project usage scope", async () => {
    state.metadata = capabilityMeta([{ connectorId: "c2", label: "worker" }]);
    state.connectors = [{ id: "c2", label: "worker" }];
    const { orch, runAgenticCodeAgent, runSynthesisAndPersist } = makeOrch();
    const { currentAnalysisUsageScope } = await import("./analysis-usage.js");
    const scopes: unknown[] = [];
    const capture = <T>(value: T) => {
      scopes.push(currentAnalysisUsageScope());
      return value;
    };
    const agentResult = await runAgenticCodeAgent.getMockImplementation()!();
    runAgenticCodeAgent.mockImplementation(async () => capture(agentResult));
    runSynthesisAndPersist.mockImplementation(async () => capture(undefined));

    await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(scopes).toEqual([
      { projectId: PROJECT_ID, sessionId: ANALYSIS_ID },
      { projectId: PROJECT_ID, sessionId: ANALYSIS_ID },
    ]);
    expect(currentAnalysisUsageScope()).toBeNull();
  });

  it("is an idempotent no-op when nothing was skipped (never registers a run)", async () => {
    state.metadata = capabilityMeta([]);
    const { orch, runAgenticCodeAgent, runSynthesisAndPersist } = makeOrch();

    const result = await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(result).toEqual({ resumed: [], remaining: [], noop: true });
    expect(runAgenticCodeAgent).not.toHaveBeenCalled();
    expect(runSynthesisAndPersist).not.toHaveBeenCalled();
    expect(orch.isActive(ANALYSIS_ID)).toBe(false);
  });

  it("drops connectors deleted since the original run (nothing left to resume clears the list)", async () => {
    state.metadata = capabilityMeta([{ connectorId: "gone", label: "deleted-repo" }]);
    state.connectors = []; // the connector no longer exists
    const { orch, runAgenticCodeAgent } = makeOrch();

    const result = await orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" });

    expect(runAgenticCodeAgent).not.toHaveBeenCalled();
    expect(result.noop).toBe(false);
    expect(result.resumed).toEqual([]);
    expect(readCapability()?.skippedRepos).toEqual([]);
  });

  // #1156 — the finally awaited the database writes before releasing the claim,
  // so one failing write refused every later resume or regenerate until a restart.
  it("#1156 — a failing finalize write still releases the resume's claim", async () => {
    state.metadata = capabilityMeta([{ connectorId: "c2", label: "worker" }]);
    state.connectors = [{ id: "c2", label: "worker" }];
    const { prisma } = await import("../prisma.js");
    const update = prisma.analysis.update as unknown as ReturnType<typeof vi.fn>;
    const original = update.getMockImplementation()!;
    update.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (args.data.totalTokens && typeof args.data.totalTokens === "object") {
        throw new Error("database unavailable");
      }
      return original(args);
    });
    const { orch } = makeOrch();
    try {
      await expect(
        orch.resumeSkippedRepos({ analysisId: ANALYSIS_ID, actorId: "u1" }),
      ).rejects.toThrow("database unavailable");
      expect(orch.isActive(ANALYSIS_ID)).toBe(false);
    } finally {
      update.mockImplementation(original);
    }
  });

  describe("assertCanResumeRepos guards", () => {
    it("rejects a resume while the analysis is already being mutated (double-resume guard)", async () => {
      state.metadata = capabilityMeta([{ connectorId: "c2", label: "worker" }]);
      const { orch } = makeOrch();
      // Simulate an in-flight run/regenerate/resume.
      (orch as never as { active: Map<string, unknown> }).active.set(ANALYSIS_ID, {});
      await expect(orch.assertCanResumeRepos(ANALYSIS_ID)).rejects.toBeInstanceOf(
        AnalysisNotRegeneratableError,
      );
    });

    it("rejects a resume on a non-terminal analysis", async () => {
      state.status = "running";
      const { orch } = makeOrch();
      await expect(orch.assertCanResumeRepos(ANALYSIS_ID)).rejects.toBeInstanceOf(
        AnalysisNotRegeneratableError,
      );
    });

    it("throws not-found for an unknown analysis", async () => {
      const { orch } = makeOrch();
      await expect(orch.assertCanResumeRepos("nope")).rejects.toThrow(/not found/i);
    });

    it("returns the persisted skipped list for a resumable analysis", async () => {
      state.metadata = capabilityMeta([{ connectorId: "c2", label: "worker" }]);
      const { orch } = makeOrch();
      const { skippedRepos } = await orch.assertCanResumeRepos(ANALYSIS_ID);
      expect(skippedRepos).toEqual([{ connectorId: "c2", label: "worker" }]);
    });
  });
});
