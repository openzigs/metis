/**
 * Tests for the LLM judge (Epic #856 issue #863).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_COVERAGE_CONFIDENCE,
  buildUserPrompt,
  judgeAmbiguous,
  type JudgeBudgetGuard,
  type JudgeModelCaller,
  type JudgePair,
} from "../../../src/lib/testcoverage/judge.js";
import type { MatcherCell } from "../../../src/lib/testcoverage/coverage-matcher.js";
import { __resetTokenTrackerSingleton } from "../../../src/lib/ai/token-tracker.js";
import { __resetSemanticCacheSingleton } from "../../../src/lib/ai/semantic-cache.js";

vi.mock("../../../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({
    // The registry key the in-loop embedding record names (#72).
    key: "xenova",
    model: "test-model",
    dimension: 4,
    async embed(texts: string[]) {
      return {
        model: "test-model",
        dimension: 4,
        vectors: texts.map((t) => {
          const v = [0, 0, 0, 0];
          for (let i = 0; i < t.length; i += 1) v[i % 4] += t.charCodeAt(i) / 1000;
          return v;
        }),
      };
    },
    async warm() {},
  }),
}));

beforeEach(() => {
  __resetTokenTrackerSingleton();
  __resetSemanticCacheSingleton();
});

function ambCell(id: string): MatcherCell {
  return {
    requirementId: `req-${id}`,
    testCaseDocId: `tc-${id}`,
    cosine: 0.7,
    bm25: 0.4,
    fused: 0.5,
    judgeConfidence: null,
    status: "AMBIGUOUS",
  };
}

function pair(id: string): JudgePair {
  return {
    cell: ambCell(id),
    requirementText: `Requirement ${id}: must do X`,
    testCaseText: `Test ${id}: does X`,
  };
}

function makeCaller(verdicts: { idx: number; isCovered: boolean; confidence: number }[]): {
  caller: JudgeModelCaller;
  calls: number;
} {
  let calls = 0;
  return {
    caller: {
      async call() {
        calls += 1;
        return {
          raw: JSON.stringify({ verdicts }),
          promptTokens: 100,
          completionTokens: 50,
          provider: "bedrock-gateway" as const,
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        };
      },
    },
    get calls() {
      return calls;
    },
  };
}

describe("buildUserPrompt", () => {
  it("includes one section per pair", () => {
    const prompt = buildUserPrompt([pair("a"), pair("b")]);
    expect(prompt).toMatch(/idx=0/);
    expect(prompt).toMatch(/idx=1/);
    expect(prompt).toMatch(/Requirement a/);
    expect(prompt).toMatch(/Test b/);
  });

  it("is deterministic", () => {
    const a = buildUserPrompt([pair("x")]);
    const b = buildUserPrompt([pair("x")]);
    expect(a).toBe(b);
  });
});

describe("judgeAmbiguous", () => {
  it("returns empty result for empty input", async () => {
    const out = await judgeAmbiguous([], {
      caller: { call: vi.fn() },
      sessionId: "s",
      userId: "u",
    });
    expect(out.pairs).toEqual([]);
    expect(out.modelCalls).toBe(0);
  });

  it("flips cells to COVERED above confidence threshold", async () => {
    const pairs = [pair("a"), pair("b")];
    const { caller } = makeCaller([
      { idx: 0, isCovered: true, confidence: 0.9 },
      { idx: 1, isCovered: false, confidence: 0.1 },
    ]);
    const out = await judgeAmbiguous(pairs, {
      caller,
      sessionId: "s",
      userId: "u",
      projectId: "p",
    });
    expect(out.pairs[0].cell.status).toBe("COVERED");
    expect(out.pairs[0].cell.judgeConfidence).toBe(0.9);
    expect(out.pairs[1].cell.status).toBe("UNCOVERED");
    expect(out.pairs[1].cell.judgeConfidence).toBe(0.1);
    expect(out.modelCalls).toBe(1);
    expect(out.batches).toBe(1);
  });

  it("strips markdown code fences from response", async () => {
    const pairs = [pair("a")];
    const caller: JudgeModelCaller = {
      async call() {
        return {
          raw:
            "```json\n" +
            JSON.stringify({ verdicts: [{ idx: 0, isCovered: true, confidence: 0.8 }] }) +
            "\n```",
          promptTokens: 10,
          completionTokens: 5,
          provider: "bedrock-gateway" as const,
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        };
      },
    };
    const out = await judgeAmbiguous(pairs, { caller, sessionId: "s", userId: "u" });
    expect(out.pairs[0].cell.status).toBe("COVERED");
  });

  it("retries once on parse failure", async () => {
    let n = 0;
    const caller: JudgeModelCaller = {
      async call() {
        n += 1;
        if (n === 1) {
          return {
            raw: "not json",
            promptTokens: 10,
            completionTokens: 5,
            provider: "bedrock-gateway" as const,
            model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          };
        }
        return {
          raw: JSON.stringify({ verdicts: [{ idx: 0, isCovered: true, confidence: 0.7 }] }),
          promptTokens: 10,
          completionTokens: 5,
          provider: "bedrock-gateway" as const,
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        };
      },
    };
    const out = await judgeAmbiguous([pair("a")], { caller, sessionId: "s", userId: "u" });
    expect(out.pairs[0].cell.status).toBe("COVERED");
    expect(out.modelCalls).toBe(2);
  });

  it("batches into multiple model calls", async () => {
    const pairs = [pair("a"), pair("b"), pair("c"), pair("d")];
    let batchCount = 0;
    const caller: JudgeModelCaller = {
      async call() {
        batchCount += 1;
        return {
          raw: JSON.stringify({
            verdicts: Array.from({ length: 2 }, (_, i) => ({
              idx: i,
              isCovered: true,
              confidence: 0.8,
            })),
          }),
          promptTokens: 10,
          completionTokens: 5,
          provider: "bedrock-gateway" as const,
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        };
      },
    };
    const out = await judgeAmbiguous(pairs, {
      caller,
      sessionId: "s",
      userId: "u",
      batchSize: 2,
    });
    expect(out.batches).toBe(2);
    expect(batchCount).toBe(2);
  });

  it("constants are sane", () => {
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(0);
    expect(DEFAULT_COVERAGE_CONFIDENCE).toBeGreaterThan(0);
    expect(DEFAULT_COVERAGE_CONFIDENCE).toBeLessThanOrEqual(1);
  });

  it("stops issuing model calls mid-loop once the budget is exceeded (#883)", async () => {
    const pairs = [pair("a"), pair("b"), pair("c")];
    const call = vi.fn(async () => ({
      raw: JSON.stringify({ verdicts: [{ idx: 0, isCovered: true, confidence: 0.9 }] }),
      promptTokens: 100,
      completionTokens: 50,
      provider: "bedrock-gateway" as const,
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    }));

    // Budget guard that trips as soon as the first batch records its spend.
    let records = 0;
    const cost: JudgeBudgetGuard = {
      record() {
        records += 1;
      },
      exceeded() {
        return records >= 1;
      },
    };

    const out = await judgeAmbiguous(pairs, {
      caller: { call },
      sessionId: "s",
      userId: "u",
      batchSize: 1, // one (req, case) pair per batch → three potential calls
      cost,
    });

    // Only the first batch's model call happened; the loop broke before the
    // second and third batches, so no further LLM calls were issued.
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.modelCalls).toBe(1);
    expect(out.batches).toBe(1);
    expect(out.budgetExceeded).toBe(true);

    // First pair was judged; the budget cut-off leaves the rest AMBIGUOUS.
    expect(out.pairs[0].cell.status).toBe("COVERED");
    expect(out.pairs[1].cell.status).toBe("AMBIGUOUS");
    expect(out.pairs[2].cell.status).toBe("AMBIGUOUS");
  });

  it("judges every batch when the budget is never exceeded (#883)", async () => {
    const pairs = [pair("a"), pair("b"), pair("c")];
    const call = vi.fn(async () => ({
      raw: JSON.stringify({ verdicts: [{ idx: 0, isCovered: true, confidence: 0.9 }] }),
      promptTokens: 1,
      completionTokens: 1,
      provider: "bedrock-gateway" as const,
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    }));
    const cost: JudgeBudgetGuard = {
      record() {},
      exceeded() {
        return false;
      },
    };

    const out = await judgeAmbiguous(pairs, {
      caller: { call },
      sessionId: "s",
      userId: "u",
      batchSize: 1,
      cost,
    });

    expect(call).toHaveBeenCalledTimes(3);
    expect(out.batches).toBe(3);
    expect(out.budgetExceeded).toBe(false);
  });

  it("records each batch under the provider and model that served it (#43)", async () => {
    const pairs = [pair("a"), pair("b")];
    const call = vi.fn(async () => ({
      raw: JSON.stringify({ verdicts: [{ idx: 0, isCovered: true, confidence: 0.9 }] }),
      promptTokens: 10,
      completionTokens: 5,
      provider: "anthropic" as const,
      model: "deepseek-flash",
    }));
    const recorded: Parameters<JudgeBudgetGuard["record"]>[0][] = [];
    const cost: JudgeBudgetGuard = {
      record(input) {
        recorded.push(input);
      },
      exceeded: () => false,
    };

    await judgeAmbiguous(pairs, {
      caller: { call },
      sessionId: "s",
      userId: "u",
      batchSize: 1,
      cost,
    });

    expect(recorded.filter((r) => r.phase === "judge")).toEqual([
      {
        phase: "judge",
        provider: "anthropic",
        modelId: "deepseek-flash",
        promptTokens: 10,
        completionTokens: 5,
      },
      {
        phase: "judge",
        provider: "anthropic",
        modelId: "deepseek-flash",
        promptTokens: 10,
        completionTokens: 5,
      },
    ]);
  });

  it("an all-unpriced run stops after the call that revealed it (#43)", async () => {
    vi.doMock("../../../src/lib/prisma.js", () => ({ prisma: {} }));
    const { CoverageCostTracker } = await import("../../../src/lib/testcoverage/cost-tracker.js");
    const pairs = [pair("a"), pair("b"), pair("c")];
    const call = vi.fn(async () => ({
      raw: JSON.stringify({ verdicts: [{ idx: 0, isCovered: true, confidence: 0.9 }] }),
      promptTokens: 1,
      completionTokens: 1,
      provider: "anthropic" as const,
      model: "deepseek-v4-pro",
    }));
    const cost = new CoverageCostTracker(
      { runId: "r", userId: "u", projectId: "p" },
      {
        budgetCents: 20,
        db: { aISession: { upsert: vi.fn(async () => ({})) } } as never,
        tracker: { record: vi.fn(), recordAndFlush: vi.fn(async () => ({})) } as never,
      },
    );

    const out = await judgeAmbiguous(pairs, {
      caller: { call },
      sessionId: "s",
      userId: "u",
      batchSize: 1,
      cost,
    });

    expect(call).toHaveBeenCalledTimes(1);
    expect(out.budgetExceeded).toBe(true);
    expect(cost.usedCents).toBe(0);
    expect(cost.view().unpricedTokens).toBe(2);
  });

  it("records each batch's cache-key embedding through the cost guard (#72)", async () => {
    // The judge embeds every batch prompt to build the semantic-cache key. On a
    // cloud embedder that is real spend the run budget never saw.
    const pairs = [pair("a"), pair("b"), pair("c")];
    const { caller } = makeCaller([{ idx: 0, isCovered: true, confidence: 0.9 }]);
    const recorded: Parameters<JudgeBudgetGuard["record"]>[0][] = [];
    const cost: JudgeBudgetGuard = {
      record(input) {
        recorded.push(input);
      },
      exceeded: () => false,
    };

    const out = await judgeAmbiguous(pairs, {
      caller,
      sessionId: "s",
      userId: "u",
      batchSize: 1,
      cost,
    });

    expect(out.batches).toBe(3);
    const embeddings = recorded.filter((r) => r.phase === "embedding");
    // One cache-key embedding per batch, under the embedder that ran and the
    // model IT reported — not the configured one, not an LLM provider.
    expect(embeddings).toHaveLength(3);
    for (const e of embeddings) {
      expect(e).toMatchObject({ phase: "embedding", embedder: "xenova", modelId: "test-model" });
      expect((e as { embeddingTokens?: number }).embeddingTokens).toBeGreaterThan(0);
    }
  });

  it("records the cache-key embedding even when the batch is a cache hit (#72)", async () => {
    // A warm cache skips the MODEL call, not the embedding: the key is what the
    // lookup needs, so the embedder runs (and bills) either way.
    // The cache is opt-in; without it a repeat batch is a fresh model call.
    vi.stubEnv("SEMANTIC_CACHE_ENABLED", "1");
    __resetSemanticCacheSingleton();
    const pairs = [pair("a")];
    const { caller } = makeCaller([{ idx: 0, isCovered: true, confidence: 0.9 }]);
    const guard = () => {
      const recorded: Parameters<JudgeBudgetGuard["record"]>[0][] = [];
      return {
        recorded,
        cost: { record: (i: (typeof recorded)[number]) => recorded.push(i), exceeded: () => false },
      };
    };
    const opts = { caller, sessionId: "s", userId: "u", batchSize: 1 };

    const cold = guard();
    await judgeAmbiguous(pairs, { ...opts, cost: cold.cost });
    const warm = guard();
    const second = await judgeAmbiguous(pairs, { ...opts, cost: warm.cost });

    expect(second.cacheHits).toBe(1);
    expect(second.modelCalls).toBe(0);
    expect(warm.recorded.filter((r) => r.phase === "judge")).toHaveLength(0);
    expect(warm.recorded.filter((r) => r.phase === "embedding")).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});
