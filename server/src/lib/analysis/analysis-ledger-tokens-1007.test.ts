/**
 * Issue #1007 — the analysis page's run list and run header read a run's
 * tokens from the ledger, by one definition, for the run's own project and
 * session; a failed ledger read never fails either.
 *
 * Mocked sibling of `tests/runs-ledger-tokens-1007.sqlite.test.ts` (skipped on
 * the postgres-adapter job). The fake ledger evaluates the `where` it is given,
 * so removing the project or session scope from production lets a foreign row
 * through and these go red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface LedgerRow {
  projectId: string;
  sessionId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestTokens: string | null;
  costCents: number | null;
  costUsd: number | null;
}

const state = vi.hoisted(() => ({
  ledger: [] as unknown[],
  ledgerFails: false,
  analyses: [] as unknown[],
  /** How many times the ledger's ROWS were loaded. */
  rowReads: 0,
}));
const sumLedgerUsage = vi.hoisted(() => vi.fn());
vi.mock("../finops/ledger-totals.js", () => ({ sumLedgerUsage }));
vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        projectId: "p-1",
        status: "running",
        startedById: "u",
        startedAt: new Date("2026-10-09T00:00:00Z"),
        completedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        errorMessage: null,
        metadata: null,
        agentResults: [],
        requirements: [],
      })),
      findMany: vi.fn(async () => state.analyses),
    },
    requirement: { findMany: vi.fn(async () => []) },
    crossDocFinding: { findMany: vi.fn(async () => []) },
    tokenUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { projectId: string; sessionId: string | { in: string[] } };
        }) => {
          if (state.ledgerFails) throw new Error("ledger unavailable");
          const sessions =
            typeof where.sessionId === "string" ? [where.sessionId] : where.sessionId?.in;
          if (typeof where.projectId !== "string" || !Array.isArray(sessions)) {
            throw new Error("fake ledger: the read must name a project and its sessions");
          }
          state.rowReads += 1;
          return (state.ledger as LedgerRow[]).filter(
            (r) =>
              r.projectId === where.projectId &&
              r.sessionId !== null &&
              sessions.includes(r.sessionId),
          );
        },
      ),
    },
  },
  resolveDatabaseProvider: () => "sqlite",
}));

import { getAnalysisSnapshot, listAnalysesForProject } from "./analysis-service.js";
import { clearSessionLedgerSummaryCache } from "../finops/ledger-usage-summary.js";

function usage(sessionId: string, row: Partial<LedgerRow> = {}): LedgerRow {
  return {
    projectId: "p-1",
    sessionId,
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requestTokens: null,
    costCents: null,
    costUsd: null,
    ...row,
  };
}

const analysis = (id: string, status: string, totalTokens: number) => ({
  id,
  projectId: "p-1",
  status,
  startedAt: new Date("2026-10-09T00:00:00Z"),
  completedAt: status === "running" ? null : new Date("2026-10-09T01:00:00Z"),
  inputTokens: 0,
  outputTokens: 0,
  totalTokens,
  errorMessage: null,
  metadata: null,
});

beforeEach(() => {
  clearSessionLedgerSummaryCache();
  state.rowReads = 0;
  state.ledgerFails = false;
  state.analyses = [
    analysis("an-done", "completed", 439_244),
    analysis("an-going", "running", 0),
    analysis("an-quiet", "running", 0),
  ];
  state.ledger = [
    // The finished run: 457,901 without cache, 545,197 with (#706 run 5).
    usage("an-done", {
      inputTokens: 238_621,
      outputTokens: 219_280,
      cacheReadTokens: 87_296,
      costUsd: 0.3352,
      costCents: 34,
    }),
    // An OpenAI-convention row: its 900 prompt tokens include 400 cache reads.
    usage("an-going", {
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 400,
    }),
    // The same session id under another project.
    usage("an-done", { projectId: "p-other", inputTokens: 7_000 }),
    // A row with no session.
    usage("an-done", { sessionId: null, inputTokens: 9_000 }),
  ];
  sumLedgerUsage.mockReset();
  sumLedgerUsage.mockResolvedValue({
    totalTokens: 545_197,
    costUsd: 0.3352,
    unpricedTokens: 0,
    calls: 77,
  });
});

describe("listAnalysesForProject ledgerTokens (#1007)", () => {
  it("gives each run the ledger's tokens, not the total stored at finish", async () => {
    const runs = await listAnalysesForProject("p-1");
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get("an-done")).toMatchObject({
      totalTokens: 439_244,
      ledgerTokens: { withoutCache: 457_901, withCache: 545_197 },
    });
    // A run that is going has its total so far; its stored total is still 0.
    expect(byId.get("an-going")).toMatchObject({
      totalTokens: 0,
      ledgerTokens: { withoutCache: 600, withCache: 1_000 },
    });
    // No ledger row yet: zero from the ledger (the page says "in progress").
    expect(byId.get("an-quiet")!.ledgerTokens).toEqual({ withoutCache: 0, withCache: 0 });
  });

  it("still lists the runs, with ledgerTokens null, when the ledger cannot be read", async () => {
    state.ledgerFails = true;
    const runs = await listAnalysesForProject("p-1");
    expect(runs.map((r) => r.id)).toEqual(["an-done", "an-going", "an-quiet"]);
    expect(runs.every((r) => r.ledgerTokens === null)).toBe(true);
    expect(runs[0]!.totalTokens).toBe(439_244);
  });

  it("reads nothing for a project with no runs", async () => {
    state.analyses = [];
    expect(await listAnalysesForProject("p-1")).toEqual([]);
  });
});

describe("getAnalysisSnapshot ledgerUsage.tokens (#1007)", () => {
  it("carries the same two figures the run list shows", async () => {
    const snap = await getAnalysisSnapshot("an-done");
    expect(snap?.ledgerUsage).toEqual({
      totalTokens: 545_197,
      costUsd: expect.closeTo(0.3352, 10),
      unpricedTokens: 0,
      tokens: { withoutCache: 457_901, withCache: 545_197 },
    });
    const listed = (await listAnalysesForProject("p-1")).find((r) => r.id === "an-done")!;
    expect(snap?.ledgerUsage?.tokens).toEqual(listed.ledgerTokens);
  });

  it("takes the cost and the unpriced tokens from the same rows as the tokens", async () => {
    // A second row the ledger holds unpriced, and a stale aggregate cost: the
    // header must say what the row summary says, as `/runs` does.
    (state.ledger as LedgerRow[]).push(
      usage("an-done", { inputTokens: 60_000, cacheReadTokens: 40_000 }),
    );
    sumLedgerUsage.mockResolvedValue({
      totalTokens: 645_197,
      costUsd: 9.99,
      unpricedTokens: 1,
      calls: 78,
    });
    const snap = await getAnalysisSnapshot("an-done");
    expect(snap?.ledgerUsage).toEqual({
      totalTokens: 645_197,
      costUsd: expect.closeTo(0.3352, 10),
      unpricedTokens: 100_000,
      tokens: { withoutCache: 517_901, withCache: 645_197 },
    });
  });

  it("says the cost is unknown, not $0, when no row of the run was priced", async () => {
    state.ledger = [usage("an-done", { inputTokens: 500 })];
    const snap = await getAnalysisSnapshot("an-done");
    expect(snap?.ledgerUsage).toMatchObject({ costUsd: null, unpricedTokens: 500 });
  });

  describe("polled every 2.5 s while a run goes", () => {
    it("loads the session's rows once while its ledger has not moved", async () => {
      for (let poll = 0; poll < 5; poll += 1) await getAnalysisSnapshot("an-done");
      expect(state.rowReads).toBe(1);
      expect(sumLedgerUsage).toHaveBeenCalledTimes(5);
    });

    it("loads them again as soon as a row is added, and shows the new figures", async () => {
      await getAnalysisSnapshot("an-done");
      (state.ledger as LedgerRow[]).push(usage("an-done", { inputTokens: 99, costUsd: 0.01 }));
      sumLedgerUsage.mockResolvedValue({
        totalTokens: 545_296,
        costUsd: 0.3452,
        unpricedTokens: 0,
        calls: 78,
      });
      const snap = await getAnalysisSnapshot("an-done");
      expect(state.rowReads).toBe(2);
      expect(snap?.ledgerUsage?.tokens).toEqual({ withoutCache: 458_000, withCache: 545_296 });
      expect(snap?.ledgerUsage?.costUsd).toBeCloseTo(0.3452, 10);
    });

    it("keeps each session's rows apart", async () => {
      await getAnalysisSnapshot("an-done");
      const quiet = await getAnalysisSnapshot("an-quiet");
      expect(quiet?.ledgerUsage?.tokens).toEqual({ withoutCache: 0, withCache: 0 });
      expect(state.rowReads).toBe(2);
    });
  });

  it("is zero, not absent, for a run with no ledger rows", async () => {
    const snap = await getAnalysisSnapshot("an-quiet");
    expect(snap?.ledgerUsage?.tokens).toEqual({ withoutCache: 0, withCache: 0 });
  });

  it("keeps the totals when only the per-row read fails", async () => {
    state.ledgerFails = true;
    const snap = await getAnalysisSnapshot("an-done");
    expect(snap?.ledgerUsage).toEqual({ totalTokens: 545_197, costUsd: 0.3352, unpricedTokens: 0 });
  });
});
// #1143 — the run list and the snapshot name the agents that failed, so a run
// whose agents failed no longer reads as a clean completion.
describe("failedAgents (#1143)", () => {
  it("lists the failed agents of each run, once each, and none for a clean run", async () => {
    state.analyses = [
      {
        ...analysis("an-errors", "completed", 10),
        agentResults: [
          { agentKey: "document", status: "failed" },
          { agentKey: "code", status: "failed" },
          { agentKey: "code", status: "failed" },
          { agentKey: "database", status: "completed" },
        ],
      },
      { ...analysis("an-clean", "completed", 10), agentResults: [] },
    ];
    const runs = await listAnalysesForProject("p-1");
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get("an-errors")!.failedAgents).toEqual(["document", "code"]);
    expect(byId.get("an-clean")!.failedAgents).toEqual([]);
    // The rows are summarised, not returned.
    expect(byId.get("an-errors")).not.toHaveProperty("agentResults");
  });

  it("names them on the snapshot too", async () => {
    const snap = await getAnalysisSnapshot("an-any");
    expect(snap!.failedAgents).toEqual([]);
  });
});
