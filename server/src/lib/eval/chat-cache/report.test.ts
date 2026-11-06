import { describe, expect, it } from "vitest";
import {
  formatChatCacheReport,
  summarizePromptCache,
  summarizeToolCache,
  type ChatCacheSession,
  type SessionToolCall,
} from "./report.js";
import type { ReplayResult } from "./semantic-replay.js";

function session(over: Partial<ChatCacheSession>): ChatCacheSession {
  return {
    arm: "on",
    pass: "before",
    questionId: "q1",
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 1,
    },
    costUsd: 0,
    toolCalls: [],
    ...over,
  };
}

const call = (tool: string, q: string, outcome: SessionToolCall["outcome"], seq?: number) => ({
  tool,
  args: { query: q },
  outcome,
  ...(seq === undefined ? {} : { seq }),
});

describe("summarizePromptCache", () => {
  it("sums each arm and pass, counting every input token kind", () => {
    const out = summarizePromptCache([
      session({
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          cacheReadTokens: 800,
          cacheWriteTokens: 100,
          calls: 3,
        },
        costUsd: 0.02,
      }),
      session({
        questionId: "q2",
        usage: {
          promptTokens: 300,
          completionTokens: 30,
          cacheReadTokens: 0,
          cacheWriteTokens: 700,
          calls: 2,
        },
        costUsd: 0.04,
      }),
      session({
        arm: "off",
        usage: {
          promptTokens: 1000,
          completionTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          calls: 4,
        },
        costUsd: 0.1,
      }),
    ]);
    const on = out.find((p) => p.arm === "on")!;
    expect(on).toMatchObject({
      sessions: 2,
      modelCalls: 5,
      inputTokens: 2000,
      uncachedInputTokens: 400,
      cacheReadTokens: 800,
      cacheWriteTokens: 800,
      outputTokens: 40,
      inputTokensPerSession: 1000,
    });
    expect(on.cacheReadShare).toBeCloseTo(0.4);
    expect(on.costUsd).toBeCloseTo(0.06);
    expect(on.costPerSessionUsd).toBeCloseTo(0.03);
    expect(out.find((p) => p.arm === "off")).toMatchObject({ cacheReadShare: 0, sessions: 1 });
  });

  it("reports an unpriced group's cost as unknown, never as $0", () => {
    const [p] = summarizePromptCache([session({ costUsd: 0.5 }), session({ costUsd: null })]);
    expect(p.costUsd).toBeNull();
    expect(p.costPerSessionUsd).toBeNull();
  });

  it("a group with no input reads a zero share, not NaN", () => {
    expect(summarizePromptCache([session({})])[0].cacheReadShare).toBe(0);
  });
});

describe("summarizeToolCache", () => {
  const sessions = [
    session({
      toolCalls: [
        call("search", "a", "miss", 0),
        call("search", "a", "hit", 2),
        call("load_skill", "x", "uncached"),
      ],
    }),
    session({
      questionId: "q2",
      toolCalls: [call("read", "b", "miss", 1), call("read", "c", "bypass", 3)],
    }),
    session({
      pass: "after",
      toolCalls: [
        // Ran before the re-ingest, first time in this pass: a miss, and a repeat.
        call("search", "a", "miss", 10),
        // Second time in this pass: a hit, from this pass's own entry.
        call("search", "a", "hit", 11),
        call("read", "new", "miss", 12),
      ],
    }),
  ];

  it("counts hits, misses and bypasses over cacheable calls only", () => {
    expect(summarizeToolCache(sessions, "on", "before")).toEqual({
      arm: "on",
      pass: "before",
      lookups: 4,
      hits: 1,
      misses: 2,
      bypasses: 1,
      hitRate: 0.25,
      uncached: 1,
    });
  });

  it("counts calls repeated across the re-ingest, and no hit served from before it", () => {
    expect(summarizeToolCache(sessions, "on", "after", "before")).toMatchObject({
      lookups: 3,
      hits: 1,
      repeatsAcrossReingest: 1,
      hitsFromPreviousPass: 0,
    });
  });

  it("flags a hit whose arguments had not run in this pass (served from before the re-ingest)", () => {
    const leaked = [
      ...sessions,
      session({ pass: "after", toolCalls: [call("read", "b", "hit", 13)] }),
    ];
    expect(summarizeToolCache(leaked, "on", "after", "before")).toMatchObject({
      repeatsAcrossReingest: 2,
      hitsFromPreviousPass: 1,
    });
  });

  it("orders by run sequence, not by session, when sessions ran concurrently", () => {
    // Session order puts the hit first; the run order puts the miss first.
    const concurrent = [
      session({ pass: "after", toolCalls: [call("search", "z", "hit", 21)] }),
      session({ pass: "after", questionId: "q2", toolCalls: [call("search", "z", "miss", 20)] }),
    ];
    expect(summarizeToolCache(concurrent, "on", "after", "before").hitsFromPreviousPass).toBe(0);
  });

  it("reads an empty pass as a zero rate", () => {
    expect(summarizeToolCache([], "off", "before").hitRate).toBe(0);
  });
});

describe("formatChatCacheReport", () => {
  it("renders every table, with unknown costs and empty buckets spelt out", () => {
    const semantic: ReplayResult = {
      variant: "question-only",
      threshold: 0.95,
      lookups: 4,
      stored: 3,
      hits: 1,
      wrongHits: 1,
      exactHits: 0,
      staleHits: 1,
      meanJaccard: 0,
      byKind: { "near-miss": { hits: 1, wrong: 1 } },
      detail: [],
    };
    const md = formatChatCacheReport({
      title: "T",
      provider: "anthropic",
      model: "m",
      promptCache: summarizePromptCache([session({ costUsd: null })]),
      toolCache: [summarizeToolCache([], "on", "before")],
      semantic: [semantic],
      agreement: [
        { pass: "before", label: "paraphrase", pairs: 2, sameFiles: 1 },
        { pass: "before", label: "near-miss", pairs: 3, sameFiles: 0, meanJaccard: 0.25 },
      ],
      similarities: [
        { a: "q1", b: "q3", label: "near-miss", similarity: 0.91 },
        { a: "q1", b: "q2", label: "paraphrase", similarity: 0.95 },
      ],
      spentUsd: 0.1234,
    });
    expect(md).toContain("# T");
    expect(md).toContain("Spend: $0.1234");
    expect(md).toContain("| on | before | 1 | 1 | 0 | 0.0% | 0 | unpriced | unpriced |");
    expect(md).toContain(
      "| question-only | 0.95 | 4 | 3 | 1 | 0 | 1 | 1 | 0.00 | 1/1 | 0/0 | 0/0 | 0/0 |",
    );
    expect(md).toContain("| before | paraphrase | 2 | 1 | — |");
    expect(md).toContain("| before | near-miss | 3 | 0 | 0.25 |");
    expect(md.indexOf("q1–q2")).toBeLessThan(md.indexOf("q1–q3"));
  });

  it("leaves the similarity table out when there is none", () => {
    const md = formatChatCacheReport({
      title: "T",
      provider: "p",
      model: "m",
      promptCache: [],
      toolCache: [],
      semantic: [],
      agreement: [],
      spentUsd: 0,
    });
    expect(md).not.toContain("Question similarity");
    expect(
      formatChatCacheReport({
        title: "T",
        provider: "p",
        model: "m",
        promptCache: [],
        toolCache: [],
        semantic: [
          {
            variant: "shipped",
            threshold: 0.97,
            lookups: 1,
            stored: 0,
            hits: 0,
            wrongHits: 0,
            exactHits: 0,
            staleHits: 0,
            meanJaccard: null,
            byKind: {},
            detail: [],
          },
        ],
        agreement: [],
        spentUsd: 0,
      }),
    ).toContain("| shipped | 0.97 | 1 | 0 | 0 | 0 | 0 | 0 | — |");
  });
});
