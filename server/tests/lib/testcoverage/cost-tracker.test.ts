/**
 * Tests for the per-run cost tracker (Epic #856 issue #878).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  CoverageCostTracker,
  DEFAULT_BUDGET_CENTS,
  readBudget,
} from "../../../src/lib/testcoverage/cost-tracker.js";
import { __resetTokenTrackerSingleton } from "../../../src/lib/ai/token-tracker.js";

beforeEach(() => {
  __resetTokenTrackerSingleton();
});

function makeDb(
  initial?: Partial<{
    tokenCostCents: number;
    embeddingTokens: number;
    judgeTokens: number;
    suggestionTokens: number;
  }>,
) {
  const state = {
    tokenCostCents: initial?.tokenCostCents ?? 0,
    embeddingTokens: initial?.embeddingTokens ?? 0,
    judgeTokens: initial?.judgeTokens ?? 0,
    suggestionTokens: initial?.suggestionTokens ?? 0,
  };
  return {
    state,
    db: {
      testCoverageRun: {
        update: vi.fn(async ({ data }: { data: typeof state }) => {
          Object.assign(state, data);
          return state;
        }),
        findUnique: vi.fn(async () => ({ ...state })),
      },
    },
  };
}

describe("CoverageCostTracker", () => {
  it("tallies tokens per phase", () => {
    const { db } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "r1", userId: "u1", projectId: "p1" },
      { db: db as never, budgetCents: 1000 },
    );
    tracker.record({ phase: "embedding", embeddingTokens: 100 });
    tracker.record({ phase: "judge", promptTokens: 50, completionTokens: 50 });
    tracker.record({ phase: "suggestion", promptTokens: 30, completionTokens: 20 });
    const view = tracker.view();
    expect(view.breakdown.embeddingTokens).toBe(100);
    expect(view.breakdown.judgeTokens).toBe(100);
    expect(view.breakdown.suggestionTokens).toBe(50);
    expect(view.limitCents).toBe(1000);
    expect(view.remainingCents).toBeGreaterThanOrEqual(0);
  });

  it("ignores zero-token records", () => {
    const { db } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "r1", userId: "u1", projectId: "p1" },
      { db: db as never },
    );
    tracker.record({ phase: "embedding" });
    expect(tracker.view().breakdown.embeddingTokens).toBe(0);
  });

  it("canAfford respects budget", () => {
    const { db } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "r1", userId: "u1", projectId: "p1" },
      { db: db as never, budgetCents: 100 },
    );
    expect(tracker.canAfford(50)).toBe(true);
    expect(tracker.canAfford(1_000_000)).toBe(false);
  });

  it("exceeded() fires once spend reaches the cap (#883 hard-stop)", () => {
    const { db } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "r1", userId: "u1", projectId: "p1" },
      { db: db as never, budgetCents: 1 },
    );
    // Fresh tracker is under budget.
    expect(tracker.exceeded()).toBe(false);
    // A large judge record pushes cumulative spend past the 1-cent cap.
    tracker.record({ phase: "judge", promptTokens: 5_000_000, completionTokens: 5_000_000 });
    expect(tracker.usedCents).toBeGreaterThanOrEqual(tracker.limitCents);
    expect(tracker.exceeded()).toBe(true);
  });

  it("flush persists totals", async () => {
    const { db, state } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "r1", userId: "u1", projectId: "p1" },
      { db: db as never },
    );
    tracker.record({ phase: "judge", promptTokens: 10, completionTokens: 5 });
    await tracker.flush();
    expect(db.testCoverageRun.update).toHaveBeenCalledOnce();
    expect(state.judgeTokens).toBe(15);
  });

  it("uses DEFAULT_BUDGET_CENTS when not provided", () => {
    const { db } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "r1", userId: "u1", projectId: "p1" },
      { db: db as never },
    );
    expect(tracker.limitCents).toBe(DEFAULT_BUDGET_CENTS);
  });

  it("sessionId scopes to runId", () => {
    const { db } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "abc", userId: "u", projectId: "p" },
      { db: db as never },
    );
    expect(tracker.sessionId).toBe("testCoverageRun:abc");
  });
});

describe("readBudget", () => {
  it("returns null when run is missing", async () => {
    const db = {
      testCoverageRun: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    const out = await readBudget("missing", { db: db as never });
    expect(out).toBeNull();
  });

  it("hydrates from persisted row", async () => {
    const { db } = makeDb({
      tokenCostCents: 25,
      embeddingTokens: 10,
      judgeTokens: 5,
      suggestionTokens: 2,
    });
    const out = await readBudget("r1", { db: db as never, budgetCents: 100 });
    expect(out).toEqual({
      limitCents: 100,
      usedCents: 25,
      remainingCents: 75,
      breakdown: { embeddingTokens: 10, judgeTokens: 5, suggestionTokens: 2 },
    });
  });

  it("clamps remaining to zero when overspent", async () => {
    const { db } = makeDb({ tokenCostCents: 500 });
    const out = await readBudget("r1", { db: db as never, budgetCents: 100 });
    expect(out?.remainingCents).toBe(0);
  });
});
