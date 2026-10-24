/**
 * Issue #766 — the snapshot the results page polls carries the agents running
 * right now, so a Regenerate shows on its card instead of a stale `completed`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../finops/ledger-totals.js", () => ({ sumLedgerUsage: vi.fn(async () => null) }));
vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async () => ({
        id: "an-1",
        projectId: "p-1",
        status: "running",
        startedById: "u",
        startedAt: new Date("2026-10-21T00:00:00Z"),
        completedAt: new Date("2026-10-21T00:05:00Z"),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        errorMessage: null,
        metadata: null,
        agentResults: [],
        requirements: [],
      })),
    },
    crossDocFinding: { findMany: vi.fn(async () => []) },
  },
  resolveDatabaseProvider: () => "sqlite",
}));

const { getAnalysisSnapshot } = await import("./analysis-service.js");
const { prisma } = await import("../prisma.js");
const { __resetConfigSingleton } = await import("../config/config-service.js");
const { beginLiveAgent, recordLiveToolCall, resetLiveAgentsForTests } =
  await import("./live-agent-progress.js");

afterEach(() => resetLiveAgentsForTests());

describe("analysis snapshot live agents (#766)", () => {
  it("carries a Regenerate in progress, with the code agent's tool calls so far", async () => {
    beginLiveAgent("an-1", "code", { rerun: true, now: new Date("2026-10-21T00:06:00Z") });
    recordLiveToolCall("an-1", "code");

    const snap = await getAnalysisSnapshot("an-1");

    expect(snap?.liveAgents).toEqual([
      {
        agentKey: "code",
        startedAt: "2026-10-21T00:06:00.000Z",
        toolCalls: 1,
        rerun: true,
        phase: "investigating",
      },
    ]);
  });

  it("is empty when nothing runs, and never another analysis's agents", async () => {
    beginLiveAgent("an-2", "code", { rerun: false });
    const snap = await getAnalysisSnapshot("an-1");
    expect(snap?.liveAgents).toEqual([]);
  });
});

/**
 * Issue #1131 — the page quotes the continuation's budget before the analyst
 * confirms, so the snapshot carries it while Continue is offered, and only then.
 */
describe("analysis snapshot continuation quote (#1131)", () => {
  const withCapability = async (capability: Record<string, unknown>) => {
    const row = await prisma.analysis.findFirst({} as never);
    vi.mocked(prisma.analysis.findFirst).mockResolvedValueOnce({
      ...row,
      metadata: JSON.stringify({ capability }),
    } as never);
  };
  const CAPABILITY = {
    codeAnalysisRequested: true,
    codeInvestigationCutShort: true,
    skippedRepos: [],
    reasons: ["code-investigation-cut-short"],
  };
  const prior = process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  afterEach(() => {
    if (prior === undefined) delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
    else process.env.ANALYSIS_AGENT_TOKEN_BUDGET = prior;
    __resetConfigSingleton();
  });

  it("quotes the enlarged code-pass budget while Continue is offered", async () => {
    process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "150000";
    __resetConfigSingleton();
    await withCapability(CAPABILITY);
    const snap = await getAnalysisSnapshot("an-1");
    expect(snap?.codeContinuation).toEqual({ tokenBudget: 300_000, budgetMultiplier: 2 });
  });

  it("quotes nothing where Continue is not offered", async () => {
    await withCapability({ ...CAPABILITY, reasons: ["code-investigation-inconclusive"] });
    expect((await getAnalysisSnapshot("an-1"))?.codeContinuation).toBeNull();
    await withCapability({ ...CAPABILITY, codeInvestigationContinuations: 1 });
    expect((await getAnalysisSnapshot("an-1"))?.codeContinuation).toBeNull();
    // No capability record at all.
    expect((await getAnalysisSnapshot("an-1"))?.codeContinuation).toBeNull();
  });
});
