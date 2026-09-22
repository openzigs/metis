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
/** The default in-process embedder (#58). */
const LOCAL_EMBEDDER = {
  embedder: "xenova",
  modelId: "onnx-community/gte-modernbert-base",
} as const;

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
    tracker.record({ phase: "embedding", ...LOCAL_EMBEDDER, embeddingTokens: 100 });
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
    tracker.record({ phase: "embedding", ...LOCAL_EMBEDDER });
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

describe("CoverageCostTracker — embedding usage under the embedder that ran (#58)", () => {
  const scope = { runId: "r1", userId: "u1", projectId: "p1" };

  function tracked(budgetCents = 20) {
    const { db } = makeDb();
    const recorder = makeRecorder();
    const cost = new CoverageCostTracker(scope, {
      db: db as never,
      tracker: recorder.tracker,
      budgetCents,
    });
    return { cost, events: recorder.events };
  }

  it("a local-embedder run's embedding phase adds $0 to the run budget", async () => {
    // 1M tokens: at the Haiku 4.5 input price this was 100 cents — five times
    // the default $0.20 budget, spent before any LLM call was made.
    const { cost, events } = tracked();
    cost.record({
      phase: "embedding",
      embedder: "xenova",
      modelId: "onnx-community/gte-modernbert-base",
      embeddingTokens: 1_000_000,
    });
    await cost.flush();
    expect(cost.usedCents).toBe(0);
    expect(cost.view().unpricedTokens).toBe(0);
    expect(cost.view().breakdown.embeddingTokens).toBe(1_000_000);
    expect(cost.exceeded()).toBe(false);
    // Recorded under the embedder that ran — not offline-stub, not Haiku.
    expect(events.map((e) => [e.provider, e.model, e.agentStep])).toEqual([
      ["embed:xenova", "onnx-community/gte-modernbert-base", "testcoverage.embedding"],
    ]);
  });

  it("prices a cloud embedder at its own published price", () => {
    const { cost } = tracked(1_000);
    // Titan Text Embeddings V2: $0.02 / MTok → 10M tokens = $0.20.
    cost.record({
      phase: "embedding",
      embedder: "bedrock",
      modelId: "amazon.titan-embed-text-v2:0",
      embeddingTokens: 10_000_000,
    });
    expect(cost.usedCents).toBe(20);
    // text-embedding-3-large: $0.13 / MTok → 1M tokens = $0.13.
    cost.record({
      phase: "embedding",
      embedder: "openai",
      modelId: "text-embedding-3-large",
      embeddingTokens: 1_000_000,
    });
    expect(cost.usedCents).toBe(33);
    expect(cost.view().unpricedTokens).toBe(0);
  });

  it("an embedding model with no price is unpriced, but does NOT stop the run (#77)", () => {
    // `bedrock-sdk` also serves Cohere; `openai` also serves Azure deployment
    // names. Embedding is a run's FIRST recorded usage, so failing the budget
    // closed here ended every such run before the judge had started (#77).
    const { cost } = tracked(10_000);
    cost.record({
      phase: "embedding",
      embedder: "bedrock-sdk",
      modelId: "cohere.embed-english-v3",
      embeddingTokens: 400,
    });
    expect(cost.usedCents).toBe(0);
    const view = cost.view();
    expect(view.unpricedTokens).toBe(400);
    expect(view.unpricedEmbeddingTokens).toBe(400);
    expect(view.unpricedLlmTokens).toBe(0);
    // The spend is still unknown and still reported — it just does not veto the
    // LLM phases, which are the unbounded part the cap exists to control.
    expect(cost.exceeded()).toBe(false);
    expect(cost.canAfford(1)).toBe(true);
  });

  it("an unpriced embedder does not excuse unpriced LLM spend (#77)", () => {
    const { cost } = tracked(10_000);
    cost.record({
      phase: "embedding",
      embedder: "openai",
      modelId: "my-azure-deployment",
      embeddingTokens: 400,
    });
    expect(cost.exceeded()).toBe(false);
    cost.record({
      phase: "judge",
      provider: "anthropic",
      modelId: "deepseek-v4-pro",
      promptTokens: 1,
      completionTokens: 1,
    });
    // #43 is untouched: unpriced judge/suggestion spend still fails closed.
    expect(cost.exceeded()).toBe(true);
    expect(cost.canAfford(0)).toBe(false);
    const view = cost.view();
    expect(view.unpricedEmbeddingTokens).toBe(400);
    expect(view.unpricedLlmTokens).toBe(2);
    expect(view.unpricedTokens).toBe(402);
  });

  it("an embedding record that names no embedder is unpriced — never priced as Haiku", () => {
    const { cost } = tracked(10_000);
    cost.record({ phase: "embedding", embeddingTokens: 1_000_000 } as never);
    expect(cost.usedCents).toBe(0);
    expect(cost.view().unpricedTokens).toBe(1_000_000);
    expect(cost.view().unpricedEmbeddingTokens).toBe(1_000_000);
    expect(cost.exceeded()).toBe(false);
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
      unpricedEmbeddingTokens: 0,
      unpricedLlmTokens: 0,
      breakdown: { embeddingTokens: 10, judgeTokens: 5, suggestionTokens: 2 },
    });
  });

  it("reads the run's unpriced tokens back from its ai_token_usages rows (#43)", async () => {
    const { db } = makeDb({ tokenCostCents: 0, judgeTokens: 1_500 });
    db.aITokenUsage.aggregate
      // embedding phase, then the LLM phases — the order readBudget asks in.
      .mockResolvedValueOnce({ _sum: { totalTokens: null } })
      .mockResolvedValueOnce({ _sum: { totalTokens: 1_500 } });
    const out = await readBudget("r1", { db: db as never, budgetCents: 20 });
    expect(db.aITokenUsage.aggregate).toHaveBeenCalledWith({
      where: {
        sessionId: "testCoverageRun:r1",
        estimatedCostUsd: null,
        agentStep: { in: ["testcoverage.judge", "testcoverage.suggestion"] },
      },
      _sum: { totalTokens: true },
    });
    // $0 priced, but not "no spend": 1,500 tokens have no known price.
    expect(out?.usedCents).toBe(0);
    expect(out?.unpricedTokens).toBe(1_500);
    expect(out?.unpricedLlmTokens).toBe(1_500);
  });

  it("splits persisted unpriced tokens into embedding and LLM phases (#77)", async () => {
    // The persisted view must agree with the in-memory one: an unpriced
    // EMBEDDER is reported without being the reason a run stopped.
    const { db } = makeDb({ tokenCostCents: 0, embeddingTokens: 400, judgeTokens: 1_500 });
    db.aITokenUsage.aggregate
      .mockResolvedValueOnce({ _sum: { totalTokens: 400 } })
      .mockResolvedValueOnce({ _sum: { totalTokens: 1_500 } });
    const out = await readBudget("r1", { db: db as never, budgetCents: 20 });
    expect(db.aITokenUsage.aggregate).toHaveBeenCalledWith({
      where: {
        sessionId: "testCoverageRun:r1",
        estimatedCostUsd: null,
        agentStep: "testcoverage.embedding",
      },
      _sum: { totalTokens: true },
    });
    expect(out?.unpricedEmbeddingTokens).toBe(400);
    expect(out?.unpricedLlmTokens).toBe(1_500);
    expect(out?.unpricedTokens).toBe(1_900);
  });

  it("clamps remaining to zero when overspent", async () => {
    const { db } = makeDb({ tokenCostCents: 500 });
    const out = await readBudget("r1", { db: db as never, budgetCents: 100 });
    expect(out?.remainingCents).toBe(0);
  });
});
