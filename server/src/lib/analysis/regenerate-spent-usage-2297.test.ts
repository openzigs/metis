/**
 * #2297 — a regenerate whose document read fails still records what the read
 * spent. `regenerateAgent` added only a finished agent's `result.usage`, so a
 * failed (or cancelled) document read left `Analysis.totalTokens`, which the
 * monthly cap sums, short by every batch it had already paid for.
 *
 * Private seams are stubbed on the instance, as in continue-cut-short-code.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { serviceMock, auditMock } = vi.hoisted(() => ({
  serviceMock: {
    finalizeAnalysisDelta: vi.fn(async (_input: unknown) => undefined),
    markAnalysisRunning: vi.fn(async () => undefined),
    getAnalysisCapability: vi.fn(async () => null),
    persistAnalysisCapability: vi.fn(async () => undefined),
    persistAnalysisEnhancement: vi.fn(async () => undefined),
    persistAgentResult: vi.fn(async () => ({ id: "ar_x", findingIds: [] })),
  },
  auditMock: vi.fn(),
}));

vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("./analysis-service.js", () => serviceMock);
vi.mock("../audit/audit-service.js", () => ({ audit: auditMock }));
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");
const { DocumentReaderError, withSpentUsage } = await import("../document-reader/reader.js");

type Stubbed = {
  regenerateLoadedAgent: (
    opts: { analysisId: string; agentKey: string; actorId: string },
    analysis: unknown,
    controller: AbortController,
  ) => Promise<void>;
  runOneAgent: ReturnType<typeof vi.fn>;
  runSynthesisAndPersist: ReturnType<typeof vi.fn>;
};

const ANALYSIS = {
  id: "an_1",
  projectId: "pr_1",
  metadata: JSON.stringify({ model: "deepseek-flash", documentIds: ["doc_1"] }),
  project: { name: "Clinic", description: "", status: "active" },
};

const SPENT = { promptTokens: 300, completionTokens: 30, totalTokens: 330 };

function orchestratorWhoseAgentFails(err: unknown): Stubbed {
  const orch = new AnalysisOrchestrator({
    provider: { chat: vi.fn() } as never,
    retrieve: async () => [],
  }) as unknown as Stubbed;
  orch.runOneAgent = vi.fn(async () => {
    throw err;
  });
  orch.runSynthesisAndPersist = vi.fn(async () => undefined);
  return orch;
}

const regenerate = (orch: Stubbed) =>
  orch.regenerateLoadedAgent(
    { analysisId: "an_1", agentKey: "document", actorId: "u1" },
    ANALYSIS,
    new AbortController(),
  );

/** The delta the analysis row was finalized with. */
const finalized = () =>
  (serviceMock.finalizeAnalysisDelta.mock.calls.at(-1)?.[0] ?? {}) as {
    status?: string;
    delta?: { promptTokens: number; completionTokens: number; totalTokens: number };
  };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#2297 — a regenerate whose document read fails", () => {
  it("adds what the read spent before failing to the analysis's tokens", async () => {
    const orch = orchestratorWhoseAgentFails(
      withSpentUsage(new DocumentReaderError("none of its sections was read"), SPENT),
    );
    await regenerate(orch);
    expect(finalized()).toMatchObject({
      status: "failed",
      delta: { promptTokens: 300, completionTokens: 30, totalTokens: 330 },
    });
    // The audit row says what the attempt cost, too.
    const row = auditMock.mock.calls
      .map((c) => c[0] as { action: string; metadata: Record<string, unknown> })
      .find((a) => a.action === "analysis.regenerate");
    expect(row?.metadata).toMatchObject({ decision: "failed", tokensConsumed: 330 });
    // Nothing was synthesised from a read that failed.
    expect(orch.runSynthesisAndPersist).not.toHaveBeenCalled();
  });

  it("counts a cancelled read's spend as well", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await regenerate(orchestratorWhoseAgentFails(withSpentUsage(abort, SPENT)));
    expect(finalized().delta?.totalTokens).toBe(330);
  });

  it("adds nothing for a failure that carries no spend", async () => {
    await regenerate(orchestratorWhoseAgentFails(new Error("upstream down")));
    expect(finalized()).toMatchObject({
      status: "failed",
      delta: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  });
});
