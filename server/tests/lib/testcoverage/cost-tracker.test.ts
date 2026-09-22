/**
 * Tests for the per-run cost tracker (Epic #856 issue #878).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The TokenTracker writes `ai_token_usages` through the Prisma singleton; keep
// that write inside the test (#876 — an escaped write's failure log is the
// `EnvironmentTeardownError` shape CLAUDE.md describes for this file).
vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
  },
}));

import {
  CoverageCostTracker,
  DEFAULT_BUDGET_CENTS,
  readBudget,
} from "../../../src/lib/testcoverage/cost-tracker.js";
import {
  __resetTokenTrackerSingleton,
  estimateUsageCostUsd,
  type TokenEvent,
} from "../../../src/lib/ai/token-tracker.js";
import { HAIKU_MODEL_ID } from "../../../src/lib/ai/model-router.js";

beforeEach(() => {
  __resetTokenTrackerSingleton();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** What served the judge/suggestion calls on the default Bedrock deployment. */
const BEDROCK = { provider: "bedrock-gateway", modelId: HAIKU_MODEL_ID } as const;

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
      aISession: {
        upsert: vi.fn(async ({ create }: { create: { id: string } }) => create),
      },
      aITokenUsage: {
        aggregate: vi.fn(async () => ({ _sum: { totalTokens: null } })),
      },
    },
  };
}

/** A TokenTracker double that keeps every event it is asked to persist. */
function makeRecorder() {
  const events: TokenEvent[] = [];
  const recordAndFlush = vi.fn(async (e: TokenEvent) => {
    events.push(e);
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  });
  return { events, tracker: { record: vi.fn(), recordAndFlush } as never };
}

describe("CoverageCostTracker", () => {
  it("tallies tokens per phase", () => {
    const { db } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "r1", userId: "u1", projectId: "p1" },
      { db: db as never, budgetCents: 1000 },
    );
    tracker.record({ phase: "embedding", embeddingTokens: 100 });
    tracker.record({ phase: "judge", ...BEDROCK, promptTokens: 50, completionTokens: 50 });
    tracker.record({ phase: "suggestion", ...BEDROCK, promptTokens: 30, completionTokens: 20 });
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
    tracker.record({
      phase: "judge",
      ...BEDROCK,
      promptTokens: 5_000_000,
      completionTokens: 5_000_000,
    });
    expect(tracker.usedCents).toBeGreaterThanOrEqual(tracker.limitCents);
    expect(tracker.exceeded()).toBe(true);
  });

  it("flush persists totals", async () => {
    const { db, state } = makeDb();
    const tracker = new CoverageCostTracker(
      { runId: "r1", userId: "u1", projectId: "p1" },
      { db: db as never },
    );
    tracker.record({ phase: "judge", ...BEDROCK, promptTokens: 10, completionTokens: 5 });
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

describe("CoverageCostTracker — served provider and unpriced usage (#43)", () => {
  const scope = { runId: "r1", userId: "u1", projectId: "p1" };

  it("records judge and suggestion usage under the provider and model that served it", async () => {
    const { db } = makeDb();
    const { events, tracker } = makeRecorder();
    const cost = new CoverageCostTracker(scope, { db: db as never, tracker });
    cost.record({
      phase: "judge",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      promptTokens: 100,
      completionTokens: 20,
    });
    cost.record({
      phase: "suggestion",
      provider: "openai",
      modelId: "gpt-4o",
      promptTokens: 10,
      completionTokens: 5,
    });
    await cost.flush();
    expect(events.map((e) => [e.provider, e.model, e.agentStep])).toEqual([
      ["anthropic", "claude-haiku-4-5", "testcoverage.judge"],
      ["openai", "gpt-4o", "testcoverage.suggestion"],
    ]);
  });

  it("creates the backing AI session the usage rows reference, once", async () => {
    // `ai_token_usages.sessionId` is a foreign key to `ai_sessions`. Before #43
    // no session existed for `testCoverageRun:<id>`, so every row failed it.
    const { db } = makeDb();
    const { events, tracker } = makeRecorder();
    const cost = new CoverageCostTracker(scope, { db: db as never, tracker });
    cost.record({ phase: "judge", ...BEDROCK, promptTokens: 1, completionTokens: 1 });
    cost.record({ phase: "suggestion", ...BEDROCK, promptTokens: 1, completionTokens: 1 });
    await cost.flush();
    expect(db.aISession.upsert).toHaveBeenCalledOnce();
    expect(db.aISession.upsert.mock.calls[0][0]).toMatchObject({
      where: { id: "testCoverageRun:r1" },
      create: { id: "testCoverageRun:r1", userId: "u1", projectId: "p1" },
    });
    expect(events.map((e) => e.sessionId)).toEqual(["testCoverageRun:r1", "testCoverageRun:r1"]);
  });

  it("keeps the budget working when the session cannot be created", async () => {
    const { db } = makeDb();
    db.aISession.upsert.mockRejectedValueOnce(new Error("db down"));
    const { events, tracker } = makeRecorder();
    const cost = new CoverageCostTracker(scope, { db: db as never, tracker, budgetCents: 1 });
    cost.record({ phase: "judge", ...BEDROCK, promptTokens: 5_000_000, completionTokens: 0 });
    await cost.flush();
    expect(events).toHaveLength(0);
    expect(cost.exceeded()).toBe(true);
  });

  it("prices from the same source as the persisted ai_token_usages row", () => {
    const { db } = makeDb();
    const cost = new CoverageCostTracker(scope, {
      db: db as never,
      tracker: makeRecorder().tracker,
    });
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    cost.record({ phase: "judge", ...BEDROCK, ...usage });
    const usd = estimateUsageCostUsd(HAIKU_MODEL_ID, usage, "bedrock-gateway");
    // Bedrock's Regional Haiku 4.5 SKU: $1.10 + $5.50 = $6.60.
    expect(usd).toBeCloseTo(6.6, 10);
    expect(cost.usedCents).toBe(660);
  });

  it("records a model served behind a third-party ANTHROPIC_BASE_URL as unpriced, not at Haiku list", () => {
    // DeepSeek serves and bills `claude-haiku-4-5` as its own deepseek-flash.
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic");
    const { db } = makeDb();
    const cost = new CoverageCostTracker(scope, {
      db: db as never,
      tracker: makeRecorder().tracker,
    });
    cost.record({
      phase: "judge",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      promptTokens: 1_000,
      completionTokens: 500,
    });
    expect(cost.usedCents).toBe(0);
    expect(cost.view().unpricedTokens).toBe(1_500);
  });

  it("an all-unpriced run cannot overspend: the budget refuses once usage is unpriced", () => {
    const { db } = makeDb();
    const cost = new CoverageCostTracker(scope, {
      db: db as never,
      tracker: makeRecorder().tracker,
      budgetCents: 20,
    });
    expect(cost.exceeded()).toBe(false);
    cost.record({
      phase: "judge",
      provider: "anthropic",
      modelId: "deepseek-v4-pro",
      promptTokens: 1,
      completionTokens: 1,
    });
    // $0 of priced spend — but the spend is unknown, so the cap cannot be shown
    // to hold: fail closed (#43), as the autopilot ceiling does (PR #41).
    expect(cost.usedCents).toBe(0);
    expect(cost.exceeded()).toBe(true);
    expect(cost.canAfford(0)).toBe(false);
  });

  it("an LLM record with no provider is unpriced — never priced by model name alone", () => {
    const { db } = makeDb();
    const cost = new CoverageCostTracker(scope, {
      db: db as never,
      tracker: makeRecorder().tracker,
    });
    cost.record({
      phase: "judge",
      modelId: HAIKU_MODEL_ID,
      promptTokens: 10,
      completionTokens: 10,
    } as never);
    expect(cost.usedCents).toBe(0);
    expect(cost.exceeded()).toBe(true);
  });
});

describe("readBudget", () => {
  it("returns null when run is missing", async () => {
    const db = {
      testCoverageRun: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      aITokenUsage: { aggregate: vi.fn() },
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
      unpricedTokens: 0,
      breakdown: { embeddingTokens: 10, judgeTokens: 5, suggestionTokens: 2 },
    });
  });

  it("reads the run's unpriced tokens back from its ai_token_usages rows (#43)", async () => {
    const { db } = makeDb({ tokenCostCents: 0, judgeTokens: 1_500 });
    db.aITokenUsage.aggregate.mockResolvedValueOnce({ _sum: { totalTokens: 1_500 } });
    const out = await readBudget("r1", { db: db as never, budgetCents: 20 });
    expect(db.aITokenUsage.aggregate).toHaveBeenCalledWith({
      where: { sessionId: "testCoverageRun:r1", estimatedCostUsd: null },
      _sum: { totalTokens: true },
    });
    // $0 priced, but not "no spend": 1,500 tokens have no known price.
    expect(out?.usedCents).toBe(0);
    expect(out?.unpricedTokens).toBe(1_500);
  });

  it("clamps remaining to zero when overspent", async () => {
    const { db } = makeDb({ tokenCostCents: 500 });
    const out = await readBudget("r1", { db: db as never, budgetCents: 100 });
    expect(out?.remainingCents).toBe(0);
  });
});
