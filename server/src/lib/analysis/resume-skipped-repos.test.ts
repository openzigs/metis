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
};

vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== ANALYSIS_ID) return null;
        return {
          id: ANALYSIS_ID,
          projectId: PROJECT_ID,
          status: state.status,
          metadata: state.metadata,
          project: { name: "Proj", description: "desc", status: "active" },
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

function makeOrch() {
  const orch = new AnalysisOrchestrator({ provider: {} as never });
  // Heavy / provider-backed collaborators — spied so the resume orchestration is
  // isolated. `runAgenticCodeAgent` returns canned usage; the append-merge it
  // performs is proven separately in resume-persistence.test.ts.
  const runAgenticCodeAgent = vi
    .spyOn(orch as never as { runAgenticCodeAgent: unknown }, "runAgenticCodeAgent")
    .mockResolvedValue({
      agentKey: "code",
      output: { agentKey: "code", summary: "", notes: [], findings: [] },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      durationMs: 1,
    } as never);
  const runSynthesisAndPersist = vi
    .spyOn(orch as never as { runSynthesisAndPersist: unknown }, "runSynthesisAndPersist")
    .mockResolvedValue(undefined as never);
  vi.spyOn(
    orch as never as { extractRequirementsFromDocAgent: unknown },
    "extractRequirementsFromDocAgent",
  ).mockResolvedValue([{ id: "REQ-001", text: "req" }] as never);
  vi.spyOn(
    orch as never as { computeAffectedCode: unknown },
    "computeAffectedCode",
  ).mockResolvedValue({ block: "", tokens: 0, filePaths: [], result: { candidates: [] } } as never);
  vi.spyOn(
    orch as never as { computeEscalations: unknown },
    "computeEscalations",
  ).mockResolvedValue(undefined as never);
  return { orch, runAgenticCodeAgent, runSynthesisAndPersist };
}

describe("AnalysisOrchestrator.resumeSkippedRepos (#741)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.status = "completed";
    state.metadata = capabilityMeta([]);
    state.connectors = [];
    state.updates = [];
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
