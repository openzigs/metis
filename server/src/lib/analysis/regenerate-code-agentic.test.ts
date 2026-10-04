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
    opts: { analysisId: string; agentKey: string; actorId: string },
    analysis: unknown,
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
  await orch.regenerateLoadedAgent({ analysisId: "an_1", agentKey, actorId: "u1" }, ANALYSIS);
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
    expect(prismaMock.agentResult.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ analysisId: "an_1", agentKey: "code", connectorId: null }),
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
