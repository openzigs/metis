import { describe, expect, it } from "vitest";
import {
  PAIR_SPECIAL_TOKENS,
  profileRerankBudget,
  RERANK_MODEL,
  RERANK_TOKEN_BUDGET,
  renderRerankBudget,
} from "./rerank-budget.js";

/** A deterministic stand-in: one token per 4 characters, the usual rule of thumb. */
const fourCharsPerToken = (text: string): number => Math.ceil(text.length / 4);

describe("the budget constants", () => {
  it("names the reranker's actual default model", () => {
    expect(RERANK_MODEL).toBe("Xenova/ms-marco-MiniLM-L-6-v2");
  });

  it("uses the 512-token BERT budget and the three pair specials", () => {
    expect(RERANK_TOKEN_BUDGET).toBe(512);
    expect(PAIR_SPECIAL_TOKENS).toBe(3);
  });
});

describe("profileRerankBudget", () => {
  it("counts nothing as truncated when every chunk fits", async () => {
    const p = await profileRerankBudget(768, ["x".repeat(400)], fourCharsPerToken, 20);
    expect(p.truncatedChunks).toBe(0);
    expect(p.truncatedFraction).toBe(0);
    expect(p.meanSurvivingFraction).toBe(1);
  });

  /**
   * The routed #1158 question: 2048-character chunks are ≈512 tokens, and the query
   * plus specials come out of the SAME 512, so the passage tail is cut.
   */
  it("flags a 2048-character chunk as over budget once the query is charged to it", async () => {
    const p = await profileRerankBudget(2048, ["x".repeat(2048)], fourCharsPerToken, 20);
    expect(p.medianTokens).toBe(512);
    expect(p.truncatedChunks).toBe(1);
    expect(p.meanSurvivingFraction).toBeLessThan(1);
  });

  it("charges the query's tokens against the passage budget", async () => {
    const text = "x".repeat(2000);
    const short = await profileRerankBudget(2048, [text], fourCharsPerToken, 1);
    const long = await profileRerankBudget(2048, [text], fourCharsPerToken, 200);
    expect(long.meanSurvivingFraction).toBeLessThan(short.meanSurvivingFraction);
  });

  it("reports the median rather than the mean, so one huge chunk cannot skew it", async () => {
    const p = await profileRerankBudget(
      1024,
      ["a".repeat(40), "b".repeat(80), "c".repeat(40000)],
      fourCharsPerToken,
      10,
    );
    expect(p.medianTokens).toBe(20);
    expect(p.maxTokens).toBe(10000);
  });

  it("averages the two middle values for an even chunk count", async () => {
    const p = await profileRerankBudget(
      1024,
      ["a".repeat(40), "b".repeat(80)],
      fourCharsPerToken,
      10,
    );
    expect(p.medianTokens).toBe(15);
  });

  it("handles an empty arm without dividing by zero", async () => {
    const p = await profileRerankBudget(1024, [], fourCharsPerToken, 10);
    expect(p).toMatchObject({
      chunkCount: 0,
      medianTokens: 0,
      maxTokens: 0,
      truncatedFraction: 0,
      meanSurvivingFraction: 1,
    });
  });

  it("accepts an async token counter, since the real tokenizer may be async", async () => {
    const p = await profileRerankBudget(1024, ["hello"], async (t) => Promise.resolve(t.length), 1);
    expect(p.medianTokens).toBe(5);
  });

  it("never leaves a negative passage budget even for an absurd query", async () => {
    const p = await profileRerankBudget(1024, ["x".repeat(40)], fourCharsPerToken, 100000);
    expect(p.meanSurvivingFraction).toBeGreaterThan(0);
    expect(p.meanSurvivingFraction).toBeLessThanOrEqual(1);
  });
});

describe("renderRerankBudget", () => {
  it("renders nothing when the profile could not be taken", () => {
    expect(renderRerankBudget([])).toBe("");
  });

  it("says the truncation is silent and cites where it happens", async () => {
    const md = renderRerankBudget([
      await profileRerankBudget(2048, ["x".repeat(2048)], fourCharsPerToken, 20),
    ]);
    expect(md).toContain("silently");
    expect(md).toContain("reranker.ts:222");
    expect(md).toContain("RAG_RERANK=1");
  });

  it("scopes itself to input truncation, not rerank quality", async () => {
    const md = renderRerankBudget([
      await profileRerankBudget(2048, ["x".repeat(2048)], fourCharsPerToken, 20),
    ]);
    expect(md).toContain("INPUT TRUNCATION");
    expect(md).toContain("#1158");
  });

  it("prints one row per arm with its over-budget percentage", async () => {
    const md = renderRerankBudget([
      await profileRerankBudget(768, ["x".repeat(700)], fourCharsPerToken, 20),
      await profileRerankBudget(2048, ["x".repeat(2048)], fourCharsPerToken, 20),
    ]);
    expect(md).toContain("| 768 |");
    expect(md).toContain("| 2048 |");
    expect(md).toContain("0.0%");
    expect(md).toContain("100.0%");
  });
});
