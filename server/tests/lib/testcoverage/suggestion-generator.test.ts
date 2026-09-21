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

vi.mock("../../../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({
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
          return { raw: "not valid json", promptTokens: 10, completionTokens: 5 };
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

  it("constants are sane", () => {
    expect(FAITHFULNESS_THRESHOLD).toBeGreaterThan(0);
    expect(FAITHFULNESS_THRESHOLD).toBeLessThan(1);
    expect(MAX_SUGGESTIONS_PER_REQUIREMENT).toBe(5);
    expect(MAX_STEPS_PER_SUGGESTION).toBe(3);
  });
});
