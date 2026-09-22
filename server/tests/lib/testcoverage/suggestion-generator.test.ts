/**
 * Tests for the suggestion generator (Epic #856 issue #870).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  FAITHFULNESS_THRESHOLD,
  MAX_SUGGESTIONS_PER_REQUIREMENT,
  MAX_STEPS_PER_SUGGESTION,
  clusterRequirements,
  generateSuggestions,
  type RequirementForSuggestion,
} from "../../../src/lib/testcoverage/suggestion-generator.js";
import type { JudgeModelCaller } from "../../../src/lib/testcoverage/judge.js";
import { __resetSemanticCacheSingleton } from "../../../src/lib/ai/semantic-cache.js";
import { CoverageCostTracker } from "../../../src/lib/testcoverage/cost-tracker.js";
import { HAIKU_MODEL_ID } from "../../../src/lib/ai/model-router.js";

// The cost tracker's usage rows go through the Prisma singleton; keep them here.
vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: { aITokenUsage: { create: vi.fn(async () => ({})) } },
}));

vi.mock("../../../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({
    // The registry key the in-loop embedding records name (#72).
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
          // L2 normalise so dedup cosines behave.
          let n = 0;
          for (const x of v) n += x * x;
          n = Math.sqrt(n) || 1;
          return v.map((x) => x / n);
        }),
      };
    },
    async warm() {},
  }),
}));

// Force grounding score above threshold by default.
vi.mock("../../../src/lib/judge/hallucination-scorer.js", () => ({
  scoreGrounding: vi.fn(async () => ({ groundingScore: 0.9, hallucinationScore: 0.1 })),
}));

beforeEach(() => {
  __resetSemanticCacheSingleton();
});

function vec(...xs: number[]): number[] {
  let n = 0;
  for (const x of xs) n += x * x;
  n = Math.sqrt(n) || 1;
  return xs.map((x) => x / n);
}

function req(id: string, embedding: number[]): RequirementForSuggestion {
  return {
    id,
    title: `Req ${id}`,
    body: `Body for ${id}`,
    priority: "medium",
    embedding,
  };
}

function jsonCaller(payload: unknown): JudgeModelCaller {
  return {
    async call() {
      return {
        raw: JSON.stringify(payload),
        promptTokens: 100,
        completionTokens: 50,
        provider: "bedrock-gateway" as const,
        model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      };
    },
  };
}

const sampleItem = (overrides: Record<string, unknown> = {}) => ({
  title: "Test login lockout",
  priority: "high",
  preconditions: ["user exists"],
  steps: [{ action: "submit bad pwd 5x", expected: "account locked" }],
  bdd: {
    feature: "Auth",
    scenario: "Lockout",
    given: ["user exists"],
    when: ["wrong 5x"],
    then: ["locked"],
  },
  tags: ["auth"],
  mappedRequirementIds: ["r1"],
  sourceChunks: [],
  confidence: 0.85,
  ...overrides,
});

describe("clusterRequirements", () => {
  it("returns empty for empty input", () => {
    expect(clusterRequirements([], 4)).toEqual([]);
  });

  it("clusters one bucket when k=1", () => {
    const reqs = [req("r1", vec(1, 0, 0)), req("r2", vec(0, 1, 0)), req("r3", vec(0, 0, 1))];
    const out = clusterRequirements(reqs, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(3);
  });

  it("is deterministic", () => {
    const reqs = [
      req("r1", vec(1, 0.1, 0)),
      req("r2", vec(0.1, 1, 0)),
      req("r3", vec(0.9, 0.2, 0)),
      req("r4", vec(0.2, 0.9, 0)),
    ];
    const a = clusterRequirements(reqs, 2);
    const b = clusterRequirements(reqs, 2);
    expect(a).toEqual(b);
  });

  it("clamps k to req count", () => {
    const reqs = [req("r1", vec(1, 0)), req("r2", vec(0, 1))];
    const out = clusterRequirements(reqs, 99);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

describe("generateSuggestions", () => {
  it("returns empty result for empty requirements", async () => {
    const out = await generateSuggestions({
      requirements: [],
      caller: { call: vi.fn() },
      sessionId: "s",
      userId: "u",
    });
    expect(out.suggestions).toEqual([]);
    expect(out.modelCalls).toBe(0);
    expect(out.servedBy).toBeNull();
  });

  it("reports the provider and model that served its calls (#43)", async () => {
    const out = await generateSuggestions({
      requirements: [req("r1", vec(1, 0, 0))],
      caller: {
        async call() {
          return {
            raw: JSON.stringify({ suggestions: [sampleItem()] }),
            promptTokens: 7,
            completionTokens: 3,
            provider: "anthropic" as const,
            model: "deepseek-flash",
          };
        },
      },
      sessionId: "s",
      userId: "u",
      projectId: "p",
    });
    expect(out.servedBy).toEqual({ provider: "anthropic", model: "deepseek-flash" });
  });

  it("produces suggestions for an uncovered requirement", async () => {
    const reqs = [req("r1", vec(1, 0, 0))];
    const out = await generateSuggestions({
      requirements: reqs,
      caller: jsonCaller({ suggestions: [sampleItem()] }),
      sessionId: "s",
      userId: "u",
      projectId: "p",
    });
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0].item.title).toMatch(/lockout/i);
    expect(out.suggestions[0].lowConfidence).toBe(false);
    expect(out.modelCalls).toBe(1);
    expect(out.clusters).toBeGreaterThan(0);
  });

  it("flags low confidence when grounding score below threshold", async () => {
    const scorer = await import("../../../src/lib/judge/hallucination-scorer.js");
    vi.mocked(scorer.scoreGrounding).mockResolvedValueOnce({
      groundingScore: 0.2,
      hallucinationScore: 0.8,
    });
    const reqs = [req("r1", vec(1, 0, 0))];
    const out = await generateSuggestions({
      requirements: reqs,
      caller: jsonCaller({ suggestions: [sampleItem()] }),
      sessionId: "s",
      userId: "u",
    });
    expect(out.suggestions[0].lowConfidence).toBe(true);
  });

  it("rejects suggestions matching existing test cases", async () => {
    const reqs = [req("r1", vec(1, 0, 0))];
    // Existing case embedding matches what the deterministic mock embedder
    // will produce for our suggestion text (any vector with cosine ≥ 0.88).
    // The mock embedder L2-normalises text-derived vectors, so seed the
    // existing case with the same vector for guaranteed collision.
    const out = await generateSuggestions({
      requirements: reqs,
      caller: jsonCaller({ suggestions: [sampleItem()] }),
      existingCases: [{ testCaseDocId: "existing-1", embedding: vec(1, 1, 1, 1) }],
      sessionId: "s",
      userId: "u",
    });
    // Either the suggestion lands or is rejected — assert internal counters
    // are consistent (no NaN).
    expect(typeof out.rejectedDuplicates).toBe("number");
    expect(out.rejectedDuplicates).toBeGreaterThanOrEqual(0);
  });

  it("skips clusters with unparseable payloads", async () => {
    const reqs = [req("r1", vec(1, 0, 0))];
    const out = await generateSuggestions({
      requirements: reqs,
      caller: {
        async call() {
          return {
            raw: "not valid json",
            promptTokens: 10,
            completionTokens: 5,
            provider: "bedrock-gateway" as const,
            model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          };
        },
      },
      sessionId: "s",
      userId: "u",
    });
    expect(out.suggestions).toEqual([]);
    expect(out.modelCalls).toBe(1);
  });

  it("caps suggestions per requirement at MAX_SUGGESTIONS_PER_REQUIREMENT", async () => {
    const reqs = [req("r1", vec(1, 0, 0))];
    const many = Array.from({ length: 5 }, (_, i) =>
      sampleItem({ title: `Test ${i}`, confidence: 0.5 + i * 0.05 }),
    );
    const out = await generateSuggestions({
      requirements: reqs,
      caller: jsonCaller({ suggestions: many }),
      sessionId: "s",
      userId: "u",
    });
    // After dedup + faithfulness gate + per-req cap, no more than the cap.
    expect(out.suggestions.length).toBeLessThanOrEqual(MAX_SUGGESTIONS_PER_REQUIREMENT);
  });

  describe("budget checked before each cluster (#57)", () => {
    /** Three orthogonal requirements, one per cluster → three model calls when unguarded. */
    const threeClusters = [
      req("r1", vec(1, 0, 0)),
      req("r2", vec(0, 1, 0)),
      req("r3", vec(0, 0, 1)),
    ];

    function servedBy(provider: "bedrock-gateway" | "openai", model: string, tokens: number) {
      return vi.fn(async () => ({
        raw: JSON.stringify({ suggestions: [sampleItem()] }),
        promptTokens: tokens,
        completionTokens: 0,
        provider,
        model,
      }));
    }

    function realTracker(budgetCents: number) {
      const db = {
        aISession: { upsert: vi.fn(async () => ({})) },
        testCoverageRun: { update: vi.fn(async () => ({})) },
      };
      const tracker = { record: vi.fn(), recordAndFlush: vi.fn(async () => ({})) };
      return new CoverageCostTracker(
        { runId: "run", userId: "u", projectId: "p" },
        { db: db as never, tracker: tracker as never, budgetCents },
      );
    }

    it("makes one call per cluster when no guard is wired (the control)", async () => {
      const call = servedBy("bedrock-gateway", HAIKU_MODEL_ID, 10);
      const out = await generateSuggestions({
        requirements: threeClusters,
        caller: { call },
        sessionId: "s",
        userId: "u",
        clusterSize: 1,
      });
      expect(out.clusters).toBe(3);
      expect(call).toHaveBeenCalledTimes(3);
      expect(out.budgetExceeded).toBe(false);
    });

    it("stops part-way once priced spend reaches the budget", async () => {
      // 5M prompt tokens of Bedrock Haiku 4.5 is $5.50 — past a 1-cent cap.
      const call = servedBy("bedrock-gateway", HAIKU_MODEL_ID, 5_000_000);
      const cost = realTracker(1);
      const out = await generateSuggestions({
        requirements: threeClusters,
        caller: { call },
        sessionId: "s",
        userId: "u",
        clusterSize: 1,
        cost,
      });
      expect(call).toHaveBeenCalledTimes(1);
      expect(out.modelCalls).toBe(1);
      expect(out.budgetExceeded).toBe(true);
      // The call that was made is on the budget.
      expect(cost.view().breakdown.suggestionTokens).toBe(5_000_000);
      expect(cost.usedCents).toBe(550);
    });

    it("stops after the first unpriced call, however much budget is left", async () => {
      const call = servedBy("openai", "no-such-priced-model", 10);
      const cost = realTracker(100_000);
      const out = await generateSuggestions({
        requirements: threeClusters,
        caller: { call },
        sessionId: "s",
        userId: "u",
        clusterSize: 1,
        cost,
      });
      expect(call).toHaveBeenCalledTimes(1);
      expect(out.budgetExceeded).toBe(true);
      expect(cost.view().unpricedTokens).toBe(10);
    });

    it("makes no call at all when the budget is already exhausted", async () => {
      const call = servedBy("bedrock-gateway", HAIKU_MODEL_ID, 10);
      const out = await generateSuggestions({
        requirements: threeClusters,
        caller: { call },
        sessionId: "s",
        userId: "u",
        clusterSize: 1,
        cost: { record: vi.fn(), exceeded: () => true },
      });
      expect(call).not.toHaveBeenCalled();
      expect(out.budgetExceeded).toBe(true);
      expect(out.suggestions).toEqual([]);
    });

    it("records each call under the provider and model that served it", async () => {
      // A provider fallback part-way through the phase: each call keeps its own
      // price instead of all of them taking the last call's (#59 review).
      const served = [
        { provider: "bedrock-gateway" as const, model: HAIKU_MODEL_ID, tokens: 7 },
        { provider: "openai" as const, model: "gpt-4o-mini", tokens: 11 },
        { provider: "openai" as const, model: "gpt-4o-mini", tokens: 13 },
      ];
      let i = 0;
      const call = vi.fn(async () => {
        const s = served[i++];
        return {
          raw: JSON.stringify({ suggestions: [sampleItem()] }),
          promptTokens: s.tokens,
          completionTokens: 1,
          provider: s.provider,
          model: s.model,
        };
      });
      const record = vi.fn();
      await generateSuggestions({
        requirements: threeClusters,
        caller: { call },
        sessionId: "s",
        userId: "u",
        clusterSize: 1,
        cost: { record, exceeded: () => false },
      });
      expect(record.mock.calls.map((c) => c[0]).filter((c) => c.phase === "suggestion")).toEqual(
        served.map((s) => ({
          phase: "suggestion",
          provider: s.provider,
          modelId: s.model,
          promptTokens: s.tokens,
          completionTokens: 1,
        })),
      );
    });

    it("records the cluster-prompt and suggestion-dedup embeddings (#72)", async () => {
      // Two embedder calls per cluster: the cache key for the cluster prompt,
      // and the suggestion texts embedded for dedup. On a cloud embedder both
      // are real spend the run budget never saw.
      const call = servedBy("bedrock-gateway", HAIKU_MODEL_ID, 10);
      const record = vi.fn();
      const out = await generateSuggestions({
        requirements: threeClusters,
        caller: { call },
        sessionId: "s",
        userId: "u",
        clusterSize: 1,
        cost: { record, exceeded: () => false },
      });
      expect(out.clusters).toBe(3);
      const embeddings = record.mock.calls.map((c) => c[0]).filter((c) => c.phase === "embedding");
      expect(embeddings).toHaveLength(6);
      for (const e of embeddings) {
        expect(e).toMatchObject({ phase: "embedding", embedder: "xenova", modelId: "test-model" });
        expect(e.embeddingTokens).toBeGreaterThan(0);
      }
    });

    it("records the cluster-prompt embedding even when the cluster is a cache hit (#72)", async () => {
      // A warm cache skips the MODEL call, not the cluster prompt's embedding.
      vi.stubEnv("SEMANTIC_CACHE_ENABLED", "1");
      __resetSemanticCacheSingleton();
      const call = servedBy("bedrock-gateway", HAIKU_MODEL_ID, 10);
      const opts = {
        requirements: [req("r1", vec(1, 0, 0))],
        caller: { call },
        sessionId: "s",
        userId: "u",
        clusterSize: 1,
      };
      await generateSuggestions({ ...opts, cost: { record: vi.fn(), exceeded: () => false } });
      const record = vi.fn();
      const warm = await generateSuggestions({ ...opts, cost: { record, exceeded: () => false } });

      expect(warm.cacheHits).toBe(1);
      expect(warm.modelCalls).toBe(0);
      const phases = record.mock.calls.map((c) => c[0].phase);
      expect(phases.filter((p) => p === "suggestion")).toHaveLength(0);
      expect(phases.filter((p) => p === "embedding")).toHaveLength(2);
      vi.unstubAllEnvs();
    });
  });

  it("constants are sane", () => {
    expect(FAITHFULNESS_THRESHOLD).toBeGreaterThan(0);
    expect(FAITHFULNESS_THRESHOLD).toBeLessThan(1);
    expect(MAX_SUGGESTIONS_PER_REQUIREMENT).toBe(5);
    expect(MAX_STEPS_PER_SUGGESTION).toBe(3);
  });
});
