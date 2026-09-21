/**
 * Epic #1156 / Issue #1158 — unit tests for the rerank measurement.
 *
 * The classification rule is the part worth testing hardest, because it is what turns a
 * number into a decision and #1156's revert rule reads off it. In particular:
 * a bootstrap interval that excludes zero while the exact sign test declines to reject
 * must come out NOT-ESTABLISHED — `stats.ts`'s header says the sign test wins on
 * disagreement, and #1158's own pool-20 arm hit exactly that case.
 */
import { describe, expect, it } from "vitest";
import {
  classifyDelta,
  compareRerankArm,
  MIN_IMPORTANT_DELTA,
  percentile,
  renderRerankDecision,
  renderRerankSweep,
  RERANK_POOL_DEPTHS,
  sampleSd,
  scoreRerankArm,
  testsAgree,
  type RerankArmResult,
  type RerankSweepReport,
} from "./rerank-sweep.js";
import type { EmbedRetrievalCorpus } from "./corpus.js";

// ---- The decision rule ----------------------------------------------------

describe("classifyDelta (#1158)", () => {
  it("SHIPs when the CI excludes zero, the sign test agrees, and the lower bound clears the bar", () => {
    expect(classifyDelta({ ciLow: 0.05, ciHigh: 0.12, signTestP: 0.001 })).toBe("SHIP");
  });

  it("is direction-only when the CI excludes zero but the lower bound is under the bar", () => {
    expect(classifyDelta({ ciLow: 0.01, ciHigh: 0.11, signTestP: 0.01 })).toBe(
      "DIRECTION-ESTABLISHED-MAGNITUDE-NOT",
    );
  });

  it("is direction-only for an established NEGATIVE effect (it can never SHIP)", () => {
    expect(classifyDelta({ ciLow: -0.18, ciHigh: -0.06, signTestP: 0.001 })).toBe(
      "DIRECTION-ESTABLISHED-MAGNITUDE-NOT",
    );
  });

  it("is NOT-ESTABLISHED when the CI straddles zero", () => {
    expect(classifyDelta({ ciLow: -0.02, ciHigh: 0.08, signTestP: 0.4 })).toBe("NOT-ESTABLISHED");
  });

  it("believes the SIGN TEST when it disagrees with the bootstrap", () => {
    // #1158's measured pool-20 arm: CI [-0.106, -0.013] with sign p = 0.117.
    expect(classifyDelta({ ciLow: -0.106, ciHigh: -0.013, signTestP: 0.117 })).toBe(
      "NOT-ESTABLISHED",
    );
    // …and a positive one that would otherwise have SHIPped.
    expect(classifyDelta({ ciLow: 0.06, ciHigh: 0.14, signTestP: 0.2 })).toBe("NOT-ESTABLISHED");
  });

  it("falls back to the CI alone when no sign test is supplied", () => {
    expect(classifyDelta({ ciLow: 0.05, ciHigh: 0.12 })).toBe("SHIP");
  });

  it("honours a caller-supplied minimum delta", () => {
    expect(classifyDelta({ ciLow: 0.02, ciHigh: 0.09, signTestP: 0.01 }, 0.01)).toBe("SHIP");
  });

  it("pins the pre-registered bar and the swept depths", () => {
    expect(MIN_IMPORTANT_DELTA).toBe(0.04);
    expect(RERANK_POOL_DEPTHS).toEqual([20, 50, 100]);
  });
});

describe("testsAgree (#1158)", () => {
  it("agrees when both reject", () => {
    expect(testsAgree({ ciLow: 0.02, ciHigh: 0.1, signTestP: 0.01 })).toBe(true);
  });
  it("agrees when neither rejects", () => {
    expect(testsAgree({ ciLow: -0.02, ciHigh: 0.1, signTestP: 0.5 })).toBe(true);
  });
  it("flags the disagreement", () => {
    expect(testsAgree({ ciLow: -0.106, ciHigh: -0.013, signTestP: 0.117 })).toBe(false);
  });
});

// ---- Summary statistics ---------------------------------------------------

describe("percentile / sampleSd (#1158)", () => {
  it("takes the nearest-rank value, not an interpolation", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile(xs, 1)).toBe(10);
  });

  it("does not mutate its input", () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("returns zero for an empty sample rather than NaN", () => {
    expect(percentile([], 50)).toBe(0);
    expect(sampleSd([])).toBe(0);
    expect(sampleSd([1])).toBe(0);
  });

  it("computes the n−1 standard deviation", () => {
    expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });
});

// ---- Scoring an arm -------------------------------------------------------

function corpusOf(
  queries: Array<{ id: string; requirement: string; relevant: string[] }>,
): EmbedRetrievalCorpus {
  return {
    queries: queries.map((q) => ({ ...q, strata: null })),
    symbols: [],
    docs: [],
  } as unknown as EmbedRetrievalCorpus;
}

describe("scoreRerankArm (#1158)", () => {
  const corpus = corpusOf([
    { id: "q1", requirement: "first", relevant: ["a"] },
    { id: "q2", requirement: "second", relevant: ["b"] },
    { id: "q3", requirement: "third", relevant: ["c"] },
  ]);

  it("scores nDCG@10 and MRR, and separates the cold first query from the warm rest", async () => {
    let clock = 0;
    // 100 ms for the first query, 10 ms thereafter — a model load then steady state.
    const ticks = [0, 100, 100, 110, 110, 120];
    const arm = await scoreRerankArm(
      corpus,
      async (q) => (q === "first" ? ["a"] : q === "second" ? ["x", "b"] : ["y", "z"]),
      "arm",
      50,
      { now: () => ticks[clock++], skipExactName: true },
    );

    expect(arm.poolSize).toBe(50);
    expect(arm.latency.coldMs).toBe(100);
    expect(arm.latency.warmMs).toEqual([10, 10]);
    // q1 perfect, q2 at rank 2, q3 nothing.
    expect(arm.mrr).toBeCloseTo((1 + 0.5 + 0) / 3, 6);
    expect(arm.ndcg10).toBeGreaterThan(0);
    expect(arm.perQuery.map((p) => p.queryId)).toEqual(["q1", "q2", "q3"]);
    expect(arm.ndcg10Ci.n).toBe(3);
  });

  it("times with the real clock when none is injected", async () => {
    const arm = await scoreRerankArm(corpus, async () => ["a"], "arm", 20, { skipExactName: true });
    expect(arm.latency.coldMs).toBeGreaterThanOrEqual(0);
    expect(arm.latency.warmMs).toHaveLength(2);
  });

  it("reports a zero cold time for a corpus with no queries rather than undefined", async () => {
    const empty = corpusOf([]);
    const arm = await scoreRerankArm(empty, async () => [], "arm", 20, { skipExactName: true });
    expect(arm.latency.coldMs).toBe(0);
    expect(arm.ndcg10).toBe(0);
    expect(arm.mrr).toBe(0);
  });

  it("skips the exact-name suite when asked, and reports a zero denominator", async () => {
    const arm = await scoreRerankArm(corpus, async () => ["a"], "arm", null, {
      skipExactName: true,
    });
    expect(arm.exactNameCount).toBe(0);
    expect(arm.exactNameTop1).toBe(0);
    expect(arm.exactNameMisses).toEqual([]);
  });

  it("runs the exact-name suite and names the misses", async () => {
    const withSymbols = {
      queries: [{ id: "q1", requirement: "first", relevant: ["a", "b"], strata: null }],
      symbols: [
        { id: "a", name: "alpha", qualifiedName: "alpha", kind: "function", filePath: "a.ts" },
        { id: "b", name: "bravo", qualifiedName: "bravo", kind: "function", filePath: "b.ts" },
      ],
      docs: [],
    } as unknown as EmbedRetrievalCorpus;

    // `alpha` comes back #1; `bravo` does not.
    const arm = await scoreRerankArm(
      withSymbols,
      async (q) => (q === "alpha" ? ["a"] : q === "bravo" ? ["a", "b"] : ["a"]),
      "arm",
      20,
    );
    expect(arm.exactNameCount).toBe(2);
    expect(arm.exactNameTop1).toBe(0.5);
    expect(arm.exactNameMisses).toEqual(["bravo"]);
  });
});

// ---- Comparing arms -------------------------------------------------------

function armOf(
  label: string,
  poolSize: number | null,
  ndcgs: Record<string, number>,
  opts: { warmMs?: number[]; coldMs?: number; misses?: string[] } = {},
): RerankArmResult {
  const values = Object.values(ndcgs);
  return {
    poolSize,
    label,
    ndcg10: values.reduce((a, b) => a + b, 0) / values.length,
    ndcg10Ci: {
      mean: 0,
      ciLow: 0,
      ciHigh: 0,
      halfWidth: 0,
      sd: 0,
      n: values.length,
      confidence: 0.95,
      resamples: 0,
      zeroFraction: 0,
    },
    mrr: 0,
    perQuery: Object.entries(ndcgs).map(([queryId, v]) => ({
      queryId,
      ranked: [],
      relevant: [],
      firstRelevantRank: null,
      recallAtK: {},
      reciprocalRank: 0,
      ndcgAtK: { 10: v },
    })),
    exactNameTop1: 0,
    exactNameCount: 0,
    exactNameMisses: opts.misses ?? [],
    latency: { coldMs: opts.coldMs ?? 0, warmMs: opts.warmMs ?? [] },
  };
}

describe("compareRerankArm (#1158)", () => {
  const off = armOf(
    "off",
    null,
    { q1: 0.5, q2: 0.5, q3: 0.5, q4: 0.5 },
    {
      warmMs: [10, 10, 10],
      coldMs: 20,
      misses: ["alpha", "bravo"],
    },
  );

  it("pairs by query id and counts the non-zero deltas", () => {
    const on = armOf(
      "on-50",
      50,
      { q1: 0.5, q2: 0.9, q3: 0.5, q4: 0.1 },
      {
        warmMs: [110, 210, 310],
        coldMs: 120,
      },
    );
    const cmp = compareRerankArm(off, on);
    expect(cmp.poolSize).toBe(50);
    expect(cmp.paired.n).toBe(4);
    // q1 and q3 are exact ties — the column that tells a reader the bootstrap is
    // resampling a sparse vector.
    expect(cmp.nonZeroDeltas).toBe(2);
    expect(cmp.paired.wins).toBe(1);
    expect(cmp.paired.losses).toBe(1);
    expect(cmp.paired.ties).toBe(2);
    expect(cmp.pairedSd).toBeGreaterThan(0);
  });

  it("reports PAIRED added latency, not a difference of means", () => {
    const on = armOf(
      "on-50",
      50,
      { q1: 0.5, q2: 0.5, q3: 0.5, q4: 0.5 },
      {
        warmMs: [110, 210, 310],
        coldMs: 120,
      },
    );
    const cmp = compareRerankArm(off, on);
    // per-query added: 100, 200, 300
    expect(cmp.addedWarmP50Ms).toBe(200);
    expect(cmp.addedWarmP95Ms).toBe(300);
    expect(cmp.addedColdMs).toBe(100);
  });

  it("compares the exact-name miss SET by name, not by count", () => {
    const on = armOf(
      "on-50",
      50,
      { q1: 0.5, q2: 0.5, q3: 0.5, q4: 0.5 },
      {
        misses: ["alpha", "charlie"],
      },
    );
    const cmp = compareRerankArm(off, on);
    expect(cmp.missSet.identical).toBe(false);
    expect(cmp.missSet.regressed).toEqual(["charlie"]);
    expect(cmp.missSet.recovered).toEqual(["bravo"]);
  });

  it("drops a query the OTHER arm did not score rather than borrowing a value", () => {
    const on = armOf("on-50", 50, { q1: 0.9, q5: 0.9 }, { warmMs: [110] });
    const cmp = compareRerankArm(off, on);
    expect(cmp.paired.n).toBe(1);
    expect(cmp.nonZeroDeltas).toBe(1);
  });

  it("keeps the fused score when the reranker returned no score for a candidate", () => {
    // `addedWarmP50Ms` over an empty paired latency vector is 0, not NaN.
    const on = armOf("on-50", 50, { q1: 0.5, q2: 0.5, q3: 0.5, q4: 0.5 }, { warmMs: [] });
    const cmp = compareRerankArm(off, on);
    expect(cmp.addedWarmP50Ms).toBe(0);
    expect(cmp.addedWarmP95Ms).toBe(0);
    expect(cmp.pairedSd).toBe(0);
  });

  it("refuses to compare an arm carrying no pool size", () => {
    expect(() => compareRerankArm(off, armOf("also-off", null, { q1: 0.5 }))).toThrow(
      /must carry a pool size/,
    );
  });
});

// ---- Rendering ------------------------------------------------------------

describe("renderRerankSweep / renderRerankDecision (#1158)", () => {
  const off = armOf("off", null, { q1: 0.4, q2: 0.2 }, { misses: ["alpha"], warmMs: [10] });
  const on = armOf("on-100", 100, { q1: 0.1, q2: 0.1 }, { misses: [], warmMs: [510] });
  const report: RerankSweepReport = {
    off,
    on: [on],
    comparisons: [compareRerankArm(off, on)],
    minDelta: MIN_IMPORTANT_DELTA,
    coldModelLoadMs: 49,
    modelBytes: 23_856_961,
  };

  it("renders the OFF baseline and each ON arm", () => {
    const md = renderRerankSweep(report);
    expect(md).toContain("rerank OFF (production today)");
    expect(md).toContain("| rerank ON | 100 |");
    // The miss set moved in the RECOVERED direction — named, not counted.
    expect(md).toContain("recovered alpha");
  });

  it("renders the verdict row with the sign test and the non-zero delta count", () => {
    const md = renderRerankDecision(report);
    expect(md).toContain("non-zero Δ / n");
    expect(md).toContain("sign p");
    expect(md).toMatch(/\*\*(SHIP|DIRECTION-ESTABLISHED-MAGNITUDE-NOT|NOT-ESTABLISHED)\*\*/);
  });

  it("renders a positive delta with a leading +", () => {
    const better = armOf("on-20", 20, { q1: 0.9, q2: 0.9 }, { misses: ["alpha"], warmMs: [20] });
    const md = renderRerankDecision({
      ...report,
      on: [better],
      comparisons: [compareRerankArm(off, better)],
    });
    expect(md).toContain("| +0.");
  });

  it("renders `yes` when the two tests agree", () => {
    const md = renderRerankDecision({
      ...report,
      comparisons: [{ ...report.comparisons[0], testsAgree: true }],
    });
    expect(md).toContain("| yes |");
  });

  it("flags a bootstrap/sign-test disagreement in the table rather than hiding it", () => {
    const md = renderRerankDecision({
      ...report,
      comparisons: [{ ...report.comparisons[0], testsAgree: false }],
    });
    expect(md).toContain("**NO — sign test wins**");
  });

  it("names BOTH the lost and the recovered exact names", () => {
    const swapped = armOf("on-20", 20, { q1: 0.4, q2: 0.2 }, { misses: ["charlie"], warmMs: [20] });
    const md = renderRerankSweep({
      ...report,
      on: [swapped],
      comparisons: [compareRerankArm(off, swapped)],
    });
    expect(md).toContain("lost charlie");
    expect(md).toContain("recovered alpha");
  });

  it("renders an em dash when an arm has no comparison row", () => {
    const md = renderRerankSweep({ ...report, comparisons: [] });
    expect(md).toContain("| rerank ON | 100 |");
    expect(md).toContain("| — |");
  });

  it("marks an identical miss set as identical", () => {
    const same = armOf("on-20", 20, { q1: 0.4, q2: 0.2 }, { misses: ["alpha"], warmMs: [20] });
    const md = renderRerankSweep({
      ...report,
      on: [same],
      comparisons: [compareRerankArm(off, same)],
    });
    expect(md).toContain("identical");
  });
});
