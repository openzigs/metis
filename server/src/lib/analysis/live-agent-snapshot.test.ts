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
