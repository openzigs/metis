/**
 * #2593 — the read side of the impact result page's truthfulness fixes:
 *   - each searched project carries whether the run read its database;
 *   - a list row counts the requirements affected, among the visible projects;
 *   - an item's match grade drops "scattered" when cited files led, as the
 *     engine's does;
 *   - the run's cost is the ledger's sum for the run's session, in its projects.
 */
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  getImpactAnalysisDetail,
  listImpactAnalyses,
  readImpactRunCost,
  toProjectOutcomes,
} from "./impact-analysis-read.js";
import type { LedgerTotals } from "../finops/ledger-totals.js";

describe("toProjectOutcomes — databaseConnected (#2593)", () => {
  it("carries the recorded value on a searched project", () => {
    expect(
      toProjectOutcomes(
        ["a", "b"],
        [
          { projectId: "a", outcome: "affected", databaseConnected: true },
          { projectId: "b", outcome: "checked-none-affected", databaseConnected: false },
        ],
      ),
    ).toEqual([
      { projectId: "a", outcome: "affected", reason: null, databaseConnected: true },
      { projectId: "b", outcome: "checked-none-affected", reason: null, databaseConnected: false },
    ]);
  });

  it("leaves it out before #2593, and on a project the run did not search", () => {
    expect(
      toProjectOutcomes(
        ["a", "b"],
        [
          { projectId: "a", outcome: "affected", databaseConnected: null },
          {
            projectId: "b",
            outcome: "not-checked",
            outcomeReason: "restricted",
            databaseConnected: false,
          },
        ],
      ),
    ).toEqual([
      { projectId: "a", outcome: "affected", reason: null },
      { projectId: "b", outcome: "not-checked", reason: "restricted" },
    ]);
  });
});

describe("listImpactAnalyses — requirementCount (#2593)", () => {
  const row = (items: Array<{ id: string; projectId: string; requirementId: string | null }>) => ({
    id: "ia-1",
    status: "completed",
    documentId: null,
    summary: null,
    totalImpactedSymbols: 3305,
    startedById: "u",
    startedAt: new Date("2026-11-16T00:00:00Z"),
    completedAt: null,
    rerunOfId: null,
    items,
    projects: [{ projectId: "p-a" }, { projectId: "p-b" }],
  });

  it("counts a tracked requirement once across projects, and each untracked change", async () => {
    const findMany = vi.fn(async () => [
      row([
        { id: "i1", projectId: "p-a", requirementId: "r1" },
        { id: "i2", projectId: "p-b", requirementId: "r1" },
        { id: "i3", projectId: "p-a", requirementId: "r2" },
        { id: "i4", projectId: "p-a", requirementId: null },
      ]),
    ]);
    const [summary] = await listImpactAnalyses({}, { impactAnalysis: { findMany } } as never);
    expect(summary!.requirementCount).toBe(3);
  });

  it("counts only the items in projects the reader can see", async () => {
    const findMany = vi.fn(async () => [
      row([
        { id: "i1", projectId: "p-a", requirementId: "r1" },
        { id: "i2", projectId: "p-b", requirementId: "r2" },
      ]),
    ]);
    const [summary] = await listImpactAnalyses({ accessibleProjectIds: ["p-a"] }, {
      impactAnalysis: { findMany },
    } as never);
    expect(summary!.requirementCount).toBe(1);
  });
});

describe("getImpactAnalysisDetail — match quality through the seed evidence (#2593)", () => {
  const direct = (id: string, filePath: string) => ({
    id,
    codeSymbolId: null,
    filePath,
    qualifiedName: `${filePath}#fn`,
    startLine: 1,
    endLine: 2,
    relation: "direct",
    depth: 0,
    confidence: 1,
  });
  const scattered = [
    direct("s1", "internal/api/api_key.go"),
    direct("s2", "internal/storage/feed.go"),
    direct("s3", "internal/ui/settings.go"),
    direct("s4", "internal/model/user.go"),
    direct("s5", "internal/database/migrations.go"),
  ];
  const detailWith = (seedEvidence: string | null) => ({
    impactAnalysis: {
      findFirst: vi.fn(async () => ({
        id: "ia-1",
        status: "completed",
        documentId: null,
        sourceText: "x",
        summary: null,
        errorMessage: null,
        totalImpactedSymbols: 5,
        startedById: "u",
        startedAt: new Date("2026-11-16T00:00:00Z"),
        completedAt: null,
        rerunOfId: null,
        projects: [{ projectId: "p-a" }],
        items: [
          {
            id: "i1",
            projectId: "p-a",
            requirementId: "r1",
            changeType: "added",
            severity: "low",
            impactScore: 0.1,
            confidence: 1,
            affectedFileCount: 5,
            affectedSymbolCount: 5,
            requirement: null,
            seedEvidence,
            affectedSymbols: scattered,
            affectedTables: [],
            feedback: [],
          },
        ],
      })),
    },
  });

  it("reads weak/scattered for scattered word-match seeds", async () => {
    const detail = await getImpactAnalysisDetail("ia-1", detailWith(null) as never);
    expect(detail!.items[0]).toMatchObject({
      matchQuality: "weak",
      matchQualityReason: "scattered",
    });
  });

  it("reads moderate when the code agent's citations led the files to edit", async () => {
    const evidence = JSON.stringify({
      agentCitations: { used: 5, stale: 0, led: 5 },
      editCandidates: [],
    });
    const detail = await getImpactAnalysisDetail("ia-1", detailWith(evidence) as never);
    expect(detail!.items[0]).toMatchObject({ matchQuality: "moderate", matchQualityReason: null });
    expect(detail!.items[0]!.seedEvidence?.agentCitations?.led).toBe(5);
  });
});

describe("readImpactRunCost (#2593)", () => {
  const totals = (over: Partial<LedgerTotals> = {}): LedgerTotals => ({
    totalTokens: 1000,
    costUsd: 0.47,
    unpricedTokens: 0,
    calls: 4,
    ...over,
  });

  it("sums the run's session in the run's projects only", async () => {
    const sum = vi.fn(async (_where: Prisma.TokenUsageWhereInput) => totals());
    const cost = await readImpactRunCost("ia-1", ["p-a", "p-b"], sum);
    expect(sum).toHaveBeenCalledWith({ sessionId: "ia-1", projectId: { in: ["p-a", "p-b"] } });
    expect(cost).toEqual({ calls: 4, costUsd: 0.47, unpricedTokens: 0 });
  });

  it("reads no cost, not $0, for a run with no call", async () => {
    const cost = await readImpactRunCost("ia-1", ["p-a"], async () =>
      totals({ calls: 0, costUsd: 0, totalTokens: 0 }),
    );
    expect(cost).toEqual({ calls: 0, costUsd: null, unpricedTokens: 0 });
  });

  it("keeps the unpriced tokens and a null cost when nothing was priced", async () => {
    const cost = await readImpactRunCost("ia-1", ["p-a"], async () =>
      totals({ costUsd: null, unpricedTokens: 900 }),
    );
    expect(cost).toEqual({ calls: 4, costUsd: null, unpricedTokens: 900 });
  });

  it("asks nothing for a run with no project", async () => {
    const sum = vi.fn(async () => totals());
    expect(await readImpactRunCost("ia-1", [], sum)).toEqual({
      calls: 0,
      costUsd: null,
      unpricedTokens: 0,
    });
    expect(sum).not.toHaveBeenCalled();
  });

  it("is null, never a throw, when the ledger cannot be read", async () => {
    const cost = await readImpactRunCost("ia-1", ["p-a"], async () => {
      throw new Error("ledger down");
    });
    expect(cost).toBeNull();
  });
});
