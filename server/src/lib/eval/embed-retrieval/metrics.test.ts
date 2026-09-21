import { describe, expect, it } from "vitest";
import {
  aggregate,
  aggregateByStratum,
  cosine,
  ndcgAtK,
  rankByCosine,
  recallAtK,
  reciprocalRank,
  scoreQuery,
  type QueryScore,
} from "./metrics.js";

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("throws loudly on a dimension mismatch (384-d vs 768-d is a real bug class)", () => {
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow(/dimension mismatch/);
  });
});

describe("rankByCosine", () => {
  it("orders documents by similarity, best first", () => {
    const ranked = rankByCosine(
      [1, 0],
      [
        { id: "far", vector: [0, 1] },
        { id: "near", vector: [0.9, 0.1] },
        { id: "mid", vector: [0.6, 0.6] },
      ],
    );
    expect(ranked.map((r) => r.id)).toEqual(["near", "mid", "far"]);
  });

  it("breaks ties deterministically by ascending id", () => {
    const docs = [
      { id: "b", vector: [1, 0] },
      { id: "a", vector: [1, 0] },
    ];
    expect(rankByCosine([1, 0], docs).map((r) => r.id)).toEqual(["a", "b"]);
    expect(rankByCosine([1, 0], [...docs].reverse()).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("recallAtK", () => {
  const ranked = ["d1", "d2", "d3", "d4", "d5"];

  it("counts only relevant docs inside the cut-off", () => {
    expect(recallAtK(ranked, ["d1"], 1)).toBe(1);
    expect(recallAtK(ranked, ["d3"], 1)).toBe(0);
    expect(recallAtK(ranked, ["d1", "d5"], 5)).toBe(1);
    expect(recallAtK(ranked, ["d1", "d5"], 2)).toBe(0.5);
  });

  it("THROWS on an empty relevant set rather than flattering it with a perfect score", () => {
    // A query with no right answer is a corpus bug. Returning 1.0 (the old
    // behaviour) would silently drag a channel's mean UP, so a malformed corpus
    // would read as a retrieval win — in the one file that must never flatter.
    expect(() => recallAtK(ranked, [], 5)).toThrow(/empty relevant set/);
    expect(() => ndcgAtK(ranked, [], 5)).toThrow(/empty relevant set/);
  });
});

describe("reciprocalRank", () => {
  it("is 1/rank of the first relevant hit", () => {
    expect(reciprocalRank(["a", "b", "c"], ["a"])).toBe(1);
    expect(reciprocalRank(["a", "b", "c"], ["c"])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(["a", "b", "c"], ["b", "c"])).toBeCloseTo(1 / 2);
  });

  it("is 0 when nothing relevant was retrieved", () => {
    expect(reciprocalRank(["a", "b"], ["z"])).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("is 1 when the relevant docs occupy the top of the list", () => {
    expect(ndcgAtK(["a", "b", "c"], ["a"], 10)).toBeCloseTo(1);
    expect(ndcgAtK(["a", "b", "c"], ["a", "b"], 10)).toBeCloseTo(1);
  });

  it("discounts a relevant doc found lower down", () => {
    const top = ndcgAtK(["a", "x", "y"], ["a"], 10);
    const lower = ndcgAtK(["x", "y", "a"], ["a"], 10);
    expect(lower).toBeLessThan(top);
    expect(lower).toBeCloseTo(1 / Math.log2(4));
  });

  it("is 0 when no relevant doc is inside the cut-off", () => {
    expect(ndcgAtK(["x", "y", "a"], ["a"], 2)).toBe(0);
  });

  it("normalises against the ideal ordering when relevant docs exceed k", () => {
    // 2 relevant, k = 1 → ideal DCG counts only 1 of them.
    expect(ndcgAtK(["a", "b"], ["a", "b"], 1)).toBeCloseTo(1);
  });
});

describe("scoreQuery", () => {
  it("records the first relevant rank and per-k metrics", () => {
    const score = scoreQuery("Q1", ["x", "target", "y"], ["target"]);
    expect(score.firstRelevantRank).toBe(2);
    expect(score.recallAtK[1]).toBe(0);
    expect(score.recallAtK[5]).toBe(1);
    expect(score.reciprocalRank).toBeCloseTo(0.5);
  });

  it("reports a miss as a null rank rather than a zero rank", () => {
    const score = scoreQuery("Q1", ["x", "y"], ["target"]);
    expect(score.firstRelevantRank).toBeNull();
    expect(score.reciprocalRank).toBe(0);
    expect(score.ndcgAtK[10]).toBe(0);
  });

  it("truncates the stored ranking to the largest cut-off", () => {
    const ranked = Array.from({ length: 50 }, (_, i) => `d${i}`);
    expect(scoreQuery("Q1", ranked, ["d0"]).ranked).toHaveLength(10);
  });
});

describe("aggregate", () => {
  it("macro-averages per-query scores", () => {
    const perfect = scoreQuery("Q1", ["a"], ["a"]);
    const miss = scoreQuery("Q2", ["z"], ["a"]);
    const agg = aggregate([perfect, miss]);
    expect(agg.queryCount).toBe(2);
    expect(agg.mrr).toBeCloseTo(0.5);
    expect(agg.ndcgAtK[10]).toBeCloseTo(0.5);
    expect(agg.recallAtK[10]).toBeCloseTo(0.5);
    expect(agg.hitRateAt10).toBeCloseTo(0.5);
  });

  it("treats a cut-off a query never measured as zero rather than NaN", () => {
    const partial = scoreQuery("Q1", ["a"], ["a"], [1]); // only k=1 measured
    const agg = aggregate([partial], [1, 5, 10]);
    expect(agg.recallAtK[1]).toBe(1);
    expect(agg.recallAtK[10]).toBe(0);
    expect(agg.ndcgAtK[10]).toBe(0);
  });

  it("returns a zeroed aggregate for no queries", () => {
    const agg = aggregate([]);
    expect(agg.queryCount).toBe(0);
    expect(agg.mrr).toBe(0);
    expect(agg.ndcgAtK[10]).toBe(0);
  });

  it("counts a hit below rank 10 as a miss for hitRateAt10", () => {
    const ranked = [...Array.from({ length: 12 }, (_, i) => `d${i}`)];
    // relevant doc sits at rank 12
    const score = scoreQuery("Q1", ranked, ["d11"], [1, 5, 10]);
    expect(aggregate([score]).hitRateAt10).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #1157 — per-stratum slicing. The aggregate hides exactly the thing the epic
// is trying to change, so the strata are reported as their own rows.
// ---------------------------------------------------------------------------

describe("aggregateByStratum", () => {
  const q = (queryId: string, ndcg: number, rr = ndcg): QueryScore => ({
    queryId,
    ranked: [],
    relevant: ["x"],
    firstRelevantRank: null,
    recallAtK: {},
    reciprocalRank: rr,
    ndcgAtK: { 10: ndcg },
  });

  const strata = new Map([
    ["a", { naming: "snake", keywordFree: "true" }],
    ["b", { naming: "snake", keywordFree: "false" }],
    ["c", { naming: "camel", keywordFree: "false" }],
  ]);

  it("slices one score set across every declared dimension", () => {
    const rows = aggregateByStratum([q("a", 1), q("b", 0), q("c", 0.5)], strata);
    expect(rows.map((r) => [r.key, r.value, r.queryCount])).toEqual([
      ["keywordFree", "false", 2],
      ["keywordFree", "true", 1],
      ["naming", "camel", 1],
      ["naming", "snake", 2],
    ]);
  });

  it("macro-averages nDCG@10 and MRR within a stratum", () => {
    const rows = aggregateByStratum([q("a", 1, 1), q("b", 0, 0)], strata);
    const snake = rows.find((r) => r.key === "naming" && r.value === "snake")!;
    expect(snake.ndcgAt10).toBeCloseTo(0.5, 12);
    expect(snake.mrr).toBeCloseTo(0.5, 12);
    expect(snake.perQueryNdcgAt10).toEqual([1, 0]);
  });

  // A query in no stratum is not evidence about any stratum. Bucketing it
  // somewhere "sensible" is how a denominator quietly grows.
  it("drops a query with no declared strata rather than bucketing it", () => {
    const rows = aggregateByStratum([q("a", 1), q("unlabelled", 0)], strata);
    expect(rows.every((r) => r.queryCount === 1)).toBe(true);
    expect(rows.flatMap((r) => r.perQueryNdcgAt10)).toEqual([1, 1]);
  });

  it("returns nothing when no query carries strata", () => {
    expect(aggregateByStratum([q("z", 1)], new Map())).toEqual([]);
    expect(aggregateByStratum([], strata)).toEqual([]);
  });

  // A committed artifact must not churn on Map iteration order.
  it("sorts deterministically by key then value", () => {
    const forward = aggregateByStratum([q("a", 1), q("b", 0), q("c", 0.5)], strata);
    const reversed = aggregateByStratum([q("c", 0.5), q("b", 0), q("a", 1)], strata);
    expect(reversed.map((r) => `${r.key}:${r.value}`)).toEqual(
      forward.map((r) => `${r.key}:${r.value}`),
    );
  });
});
