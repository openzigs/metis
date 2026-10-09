/**
 * #977 — a running analysis's snapshot carries its live ledger spend, read
 * for its own project AND session; a failed read never fails the snapshot.
 * Mocked sibling of `tests/usage-numbers-977.sqlite.test.ts` (skipped on the
 * postgres-adapter job).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sumLedgerUsage = vi.hoisted(() => vi.fn());
vi.mock("../finops/ledger-totals.js", () => ({ sumLedgerUsage }));
vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async () => ({
        id: "an-1",
        projectId: "p-1",
        status: "running",
        startedById: "u",
        startedAt: new Date("2026-10-01T00:00:00Z"),
        completedAt: null,
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

import { getAnalysisSnapshot } from "./analysis-service.js";

describe("getAnalysisSnapshot ledgerUsage (#977)", () => {
  beforeEach(() => {
    sumLedgerUsage.mockReset();
  });

  it("reads the ledger for the analysis's own project and session", async () => {
    sumLedgerUsage.mockResolvedValue({
      totalTokens: 41_000,
      costUsd: 0.0123,
      unpricedTokens: 0,
      calls: 7,
    });
    const snap = await getAnalysisSnapshot("an-1");
    expect(sumLedgerUsage).toHaveBeenCalledWith({ projectId: "p-1", sessionId: "an-1" });
    expect(snap?.totalTokens).toBe(0);
    expect(snap?.ledgerUsage).toEqual({ totalTokens: 41_000, costUsd: 0.0123, unpricedTokens: 0 });
  });

  it("returns the snapshot with ledgerUsage null when the ledger read fails", async () => {
    sumLedgerUsage.mockRejectedValue(new Error("db down"));
    const snap = await getAnalysisSnapshot("an-1");
    expect(snap?.id).toBe("an-1");
    expect(snap?.ledgerUsage).toBeNull();
  });
});
