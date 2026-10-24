/**
 * #766 — "Regenerate" on the code agent re-ran an AGENTIC pass as one
 * retrieval-only single-shot call (3 info/low findings over symbol stubs, "no
 * storage layer was retrieved"). It now goes through the mode the pipeline
 * would pick, reconstructing the agentic inputs from persisted state.
 *
 * The private seams are stubbed on the instance so this pins the ROUTING; the
 * agentic pass itself is covered by the pipeline tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    repoConnection: { findMany: vi.fn() },
    agentResult: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));
vi.mock("./analysis-service.js", () => ({
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  // #943 — a regenerate marks the analysis running first.
  markAnalysisRunning: vi.fn(async () => undefined),
}));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const OUTPUT = { agentKey: "code", summary: "s", findings: [], notes: [] };
const REQS = [{ id: "REQ-1", text: "A user cannot subscribe to the same feed URL twice." }];

type Stubbed = {
  regenerateLoadedAgent: (
    opts: { analysisId: string; agentKey: string; actorId: string; extendBudget?: boolean },
    analysis: unknown,
    controller: AbortController,
  ) => Promise<void>;
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

function makeOrchestrator(mode: "agentic" | "single-shot" | "requirement-grounded") {
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
  orch.runAgenticCodeAgent = vi.fn(async () => ({
    agentKey: "code",
    output: OUTPUT,
    usage: USAGE,
    durationMs: 1,
  }));
  orch.runSynthesisAndPersist = vi.fn(async () => undefined);
  orch.extractRequirementsFromDocAgent = vi.fn(async () => REQS);
  orch.detectAgentMode = vi.fn(async () => mode);
  orch.computeAffectedCode = vi.fn(async () => ({
    block: "",
    tokens: 0,
    filePaths: [],
    result: { candidates: [] },
  }));
  orch.computeEscalations = vi.fn(async () => undefined);
  orch.resolveDatabaseAware = vi.fn(async () => ({ enabled: true }));
  orch.computeAffectedSchema = vi.fn(async () => SCHEMA);
  // #1131 — a continuation is scoped by the persisted code findings: none here.
  (
    orch as unknown as { readCodeFindingVerdicts: () => Promise<unknown[]> }
  ).readCodeFindingVerdicts = vi.fn(async () => []);
  return orch;
}

const SCHEMA = { block: "AFFECTED SCHEMA: feeds(user_id, feed_url)", tokens: 10, rows: [] };

const ANALYSIS = {
  id: "an_1",
  projectId: "pr_1",
  metadata: JSON.stringify({ model: "deepseek-flash", extraInstructions: null }),
  project: {
    name: "Miniflux",
    description: "feed reader",
    status: "active",
    databaseAwareAnalysis: "on",
  },
};

async function regenerate(orch: Stubbed, agentKey = "code") {
  await orch.regenerateLoadedAgent(
    { analysisId: "an_1", agentKey, actorId: "u1" },
    ANALYSIS,
    new AbortController(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("regenerate the code agent through its pipeline mode (#766)", () => {
  it("runs the agentic pass, not single-shot, when the run would be agentic", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "miniflux" }]);
    const orch = makeOrchestrator("agentic");
    await regenerate(orch);

    expect(orch.runOneAgent).not.toHaveBeenCalled();
    expect(orch.runAgenticCodeAgent).toHaveBeenCalledTimes(1);
    expect(orch.runAgenticCodeAgent.mock.calls[0][0]).toMatchObject({
      analysisId: "an_1",
      projectId: "pr_1",
      requirements: REQS,
      connectorId: "repo_1",
      // The pipeline's AFFECTED SCHEMA seed, resolved from the project setting.
      affectedSchema: SCHEMA,
    });
    expect(orch.resolveDatabaseAware).toHaveBeenCalledWith("an_1", "pr_1", "on");
    expect(orch.computeAffectedSchema).toHaveBeenCalledWith("an_1", "pr_1", undefined, true);
    expect(orch.detectAgentMode).toHaveBeenCalledWith("pr_1", "code", REQS);
    // A stale connector-less row from an earlier single-shot regenerate goes.
    // #1131 — and so does a row a continuation appended for the repo it re-ran.
    expect(prismaMock.agentResult.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        analysisId: "an_1",
        agentKey: "code",
        OR: [{ connectorId: null }, { connectorId: { in: ["repo_1"] } }],
      }),
    });
    expect(orch.runSynthesisAndPersist).toHaveBeenCalledTimes(1);
  });

  it("runs one budgeted pass per repo on a multi-repo project", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([
      { id: "repo_1", label: "api" },
      { id: "repo_2", label: "web" },
    ]);
    const orch = makeOrchestrator("agentic");
    await regenerate(orch);

    expect(orch.runAgenticCodeAgent).toHaveBeenCalledTimes(2);
    const calls = orch.runAgenticCodeAgent.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.connectorId)).toEqual(["repo_1", "repo_2"]);
    expect(calls[0].projectName).toBe("Miniflux [repo: api]");
    expect(typeof calls[0].tokenBudget).toBe("number");
  });

  it("keeps the single-shot path when the run would not be agentic", async () => {
    const orch = makeOrchestrator("single-shot");
    await regenerate(orch);
    expect(orch.runOneAgent).toHaveBeenCalledTimes(1);
    expect(orch.runAgenticCodeAgent).not.toHaveBeenCalled();
  });

  it("never routes another specialist through the code path", async () => {
    const orch = makeOrchestrator("agentic");
    await regenerate(orch, "document");
    expect(orch.extractRequirementsFromDocAgent).not.toHaveBeenCalled();
    expect(orch.runOneAgent).toHaveBeenCalledTimes(1);
  });

  it("does not purge prior rows when there is no repo connection", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([]);
    const orch = makeOrchestrator("agentic");
    await regenerate(orch);
    expect(orch.runAgenticCodeAgent).toHaveBeenCalledTimes(1);
    expect(orch.runAgenticCodeAgent.mock.calls[0][0].connectorId).toBeUndefined();
    expect(prismaMock.agentResult.deleteMany).not.toHaveBeenCalled();
  });
});

// #1027 — a regenerate must read the run's plan context back from its stored
// metadata, or the regenerated code pass works from less than the original.
describe("regenerate carries the run's plan context (#1027)", () => {
  const CONTEXT = "Plan components (plan.md):\n- FeedStore — Extends storage/feed.go (AC-1)";
  const WITH_CONTEXT = {
    ...ANALYSIS,
    metadata: JSON.stringify({ model: "deepseek-flash", agentContext: CONTEXT }),
  };
  const run = (orch: Stubbed, analysis: unknown, agentKey = "code") =>
    orch.regenerateLoadedAgent(
      { analysisId: "an_1", agentKey, actorId: "u1" },
      analysis,
      new AbortController(),
    );

  it("hands it to every agentic pass", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([
      { id: "repo_1", label: "api" },
      { id: "repo_2", label: "web" },
    ]);
    const orch = makeOrchestrator("agentic");
    await run(orch, WITH_CONTEXT);
    const calls = orch.runAgenticCodeAgent.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.agentContext)).toEqual([CONTEXT, CONTEXT]);
  });

  it("hands it to the single-shot path", async () => {
    const orch = makeOrchestrator("single-shot");
    await run(orch, WITH_CONTEXT);
    expect(orch.runOneAgent.mock.calls[0][0].agentContext).toBe(CONTEXT);
  });

  it("never reaches the re-synthesis, which writes the requirements", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "api" }]);
    const orch = makeOrchestrator("agentic");
    await run(orch, WITH_CONTEXT);
    expect(orch.runSynthesisAndPersist).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(orch.runSynthesisAndPersist.mock.calls)).not.toContain("FeedStore");
  });

  // Review of #1027 — "Continue code investigation" is a regenerate with a
  // larger budget; it is the third way a code pass is re-run and had no test
  // of its own for carrying the context.
  it("hands it to a continued investigation, with the larger budget", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "api" }]);
    const plain = makeOrchestrator("agentic");
    await run(plain, WITH_CONTEXT);
    const orch = makeOrchestrator("agentic");
    await orch.regenerateLoadedAgent(
      { analysisId: "an_1", agentKey: "code", actorId: "u1", extendBudget: true },
      WITH_CONTEXT,
      new AbortController(),
    );

    expect(orch.runAgenticCodeAgent).toHaveBeenCalledTimes(1);
    const continued = orch.runAgenticCodeAgent.mock.calls[0][0];
    expect(continued.agentContext).toBe(CONTEXT);
    // It is the continue path: more turns, and more budget than a plain rerun.
    const rerun = plain.runAgenticCodeAgent.mock.calls[0][0];
    expect(continued.turnMultiplier).toBeGreaterThan(1);
    expect(rerun.turnMultiplier).toBeUndefined();
    expect(continued.tokenBudget).toBe(rerun.tokenBudget * continued.turnMultiplier);
  });

  it("hands a continued single-shot pass the context too", async () => {
    const orch = makeOrchestrator("single-shot");
    await orch.regenerateLoadedAgent(
      { analysisId: "an_1", agentKey: "code", actorId: "u1", extendBudget: true },
      WITH_CONTEXT,
      new AbortController(),
    );
    expect(orch.runOneAgent.mock.calls[0][0].agentContext).toBe(CONTEXT);
  });

  // Review of #1027 (panel) — the tests above see only that the context is
  // forwarded. Feeding the stored context to the requirement splitter, or to
  // the affected-code mapping, passed all of them.
  describe("changes nothing the rerun derives from the requirements", () => {
    const EXTRA =
      "AC-1: Entries can be marked read in bulk.\n\nAC-2: The refusal names the existing feed.";
    // Every line is written the way a requirement would be.
    const REQUIREMENT_SHAPED = [
      "Plan components (plan.md):",
      "- ZebraFeedGuard — the system shall reject duplicates in storage/feed.go",
      "Tasks (tasks.md):",
      "- T01: The service must add a unique index on feeds",
    ].join("\n");
    const analysisWith = (agentContext?: string) => ({
      ...ANALYSIS,
      metadata: JSON.stringify({
        model: "deepseek-flash",
        extraInstructions: EXTRA,
        ...(agentContext ? { agentContext } : {}),
      }),
    });
    const derived = (orch: Stubbed, pass: "runAgenticCodeAgent" | "runOneAgent") => ({
      mode: orch.detectAgentMode.mock.calls,
      affectedCode: orch.computeAffectedCode.mock.calls,
      affectedSchema: orch.computeAffectedSchema.mock.calls,
      escalations: orch.computeEscalations.mock.calls,
      requirements: orch[pass].mock.calls.map((c) => c[0].requirements),
      extraInstructions: orch[pass].mock.calls.map((c) => c[0].extraInstructions),
      knownRequirementIds: orch[pass].mock.calls.map((c) => c[0].knownRequirementIds),
    });

    it("agentic: the same requirement set, affected-code input, schema input and escalation", async () => {
      prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "api" }]);
      const without = makeOrchestrator("agentic");
      await run(without, analysisWith());
      const withContext = makeOrchestrator("agentic");
      await run(withContext, analysisWith(REQUIREMENT_SHAPED));

      const got = derived(withContext, "runAgenticCodeAgent");
      expect(got).toEqual(derived(without, "runAgenticCodeAgent"));
      // Spelled out, so the comparison above cannot pass on two wrong runs.
      expect(got.requirements[0].map((r: { id: string }) => r.id)).toEqual([
        "REQ-1",
        "NR-1",
        "NR-2",
      ]);
      expect(got.affectedCode).toEqual([["an_1", "pr_1", EXTRA]]);
      expect(got.affectedSchema).toEqual([["an_1", "pr_1", EXTRA, true]]);
      expect(got.escalations[0][2]).toEqual(got.requirements[0]);
      expect(JSON.stringify(got)).not.toContain("Zebra");
      expect(JSON.stringify(got)).not.toContain("T01");
      // The context still reached the pass.
      expect(withContext.runAgenticCodeAgent.mock.calls[0][0].agentContext).toBe(
        REQUIREMENT_SHAPED,
      );
    });

    it("single-shot fallback: the same requirement ids, and none from the context", async () => {
      const without = makeOrchestrator("requirement-grounded");
      await run(without, analysisWith());
      const withContext = makeOrchestrator("requirement-grounded");
      await run(withContext, analysisWith(REQUIREMENT_SHAPED));

      const got = derived(withContext, "runOneAgent");
      expect(got).toEqual(derived(without, "runOneAgent"));
      // The ids a finding of the rerun may name: the run's, nothing else.
      expect(got.knownRequirementIds).toEqual([["REQ-1", "NR-1", "NR-2"]]);
      expect(got.extraInstructions).toEqual([EXTRA]);
      expect(withContext.runOneAgent.mock.calls[0][0].agentContext).toBe(REQUIREMENT_SHAPED);
    });
  });

  it("adds no key on a run started without context", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "api" }]);
    const agentic = makeOrchestrator("agentic");
    await run(agentic, ANALYSIS);
    expect(agentic.runAgenticCodeAgent.mock.calls[0][0]).not.toHaveProperty("agentContext");

    const single = makeOrchestrator("single-shot");
    await run(single, { ...ANALYSIS, metadata: JSON.stringify({ agentContext: "   " }) });
    expect(single.runOneAgent.mock.calls[0][0]).not.toHaveProperty("agentContext");
  });
});

// #1098 — a regenerate works from the same scoped set the pipeline used.
describe("regenerate on a run started from imported items (#1098)", () => {
  it("gives the agentic pass the imported items, not the document's other features", async () => {
    prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "miniflux" }]);
    const orch = makeOrchestrator("agentic");
    orch.extractRequirementsFromDocAgent = vi.fn(async () => [
      ...REQS,
      { id: "REQ-2", text: "A user can mute a feed." },
    ]);
    await orch.regenerateLoadedAgent(
      { analysisId: "an_1", agentKey: "code", actorId: "u1" },
      {
        ...ANALYSIS,
        metadata: JSON.stringify({
          model: "deepseek-flash",
          extraInstructions: "- Mute feeds",
          sourceRequirements: [
            {
              candidateId: "NR-1",
              requirementId: "imp-1",
              title: "Mute feeds",
              externalSource: "github",
              externalId: "1",
              externalUrl: null,
            },
          ],
        }),
      },
      new AbortController(),
    );

    expect(
      orch.runAgenticCodeAgent.mock.calls[0][0].requirements.map((r: { id: string }) => r.id),
    ).toEqual(["NR-1"]);
  });
});

describe("the agent card shows a re-run while it runs (#766)", () => {
  it("reads the agent as re-running, then re-synthesising, and clears when done", async () => {
    const { readLiveAgents } = await import("./live-agent-progress.js");
    prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "miniflux" }]);
    const orch = makeOrchestrator("agentic");
    const during: unknown[] = [];
    orch.runAgenticCodeAgent.mockImplementation(async () => {
      during.push(readLiveAgents("an_1"));
      return { agentKey: "code", output: OUTPUT, usage: USAGE, durationMs: 1 };
    });
    orch.runSynthesisAndPersist.mockImplementation(async () => {
      during.push(readLiveAgents("an_1"));
    });

    await regenerate(orch);

    expect(during).toEqual([
      [expect.objectContaining({ agentKey: "code", rerun: true, phase: "investigating" })],
      [expect.objectContaining({ agentKey: "code", rerun: true, phase: "synthesizing" })],
    ]);
    expect(readLiveAgents("an_1")).toEqual([]);
  });

  it("clears the live entry before the terminal status write can be read (#766 review)", async () => {
    const { readLiveAgents } = await import("./live-agent-progress.js");
    const service = await import("./analysis-service.js");
    const atFinalize: unknown[] = [];
    vi.mocked(service.finalizeAnalysisDelta).mockImplementationOnce(async () => {
      atFinalize.push(readLiveAgents("an_1"));
    });
    prismaMock.repoConnection.findMany.mockResolvedValue([{ id: "repo_1", label: "miniflux" }]);

    await regenerate(makeOrchestrator("agentic"));

    expect(atFinalize).toEqual([[]]);
  });

  it("clears the live entry when the re-run fails", async () => {
    const { readLiveAgents } = await import("./live-agent-progress.js");
    const orch = makeOrchestrator("single-shot");
    orch.runOneAgent.mockRejectedValue(new Error("provider down"));

    await regenerate(orch, "database");

    expect(readLiveAgents("an_1")).toEqual([]);
  });
});
