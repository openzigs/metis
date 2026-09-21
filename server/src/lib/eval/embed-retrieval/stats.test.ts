/**
 * Stats tests — the significance numbers appear in a committed artifact that #783
 * cites, so they are pinned against CLOSED-FORM answers, not against whatever the
 * implementation happens to emit. A bootstrap that quietly returns the wrong
 * interval would otherwise be indistinguishable from one that returns the right
 * one.
 */
import { describe, expect, it } from "vitest";
import type { ArmRunResult } from "./runner.js";
import {
  bootstrapMean,
  bootstrapMeanCi,
  compareArms,
  computeSignificance,
  mulberry32,
  queriesNeededForHalfWidth,
  signTest,
  Z_95,
} from "./stats.js";

const scores = (pairs: Array<[string, number]>): Map<string, number> => new Map(pairs);

describe("mulberry32", () => {
  it("is deterministic for a seed and spreads over [0,1)", () => {
    const a = Array.from({ length: 5 }, mulberry32(42));
    const b = Array.from({ length: 5 }, mulberry32(42));
    expect(a).toEqual(b);
    expect(Array.from({ length: 200 }, mulberry32(7)).every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("gives different streams for different seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("signTest", () => {
  // Closed-form: 2 * P(X <= min(w,l)) for X ~ Binomial(w+l, 0.5).
  it("matches the exact binomial tail", () => {
    // 5 wins, 0 losses → 2 * (1/32) = 0.0625
    expect(signTest(5, 0)).toBeCloseTo(0.0625, 6);
    // 6 wins, 0 losses → 2 * (1/64) = 0.03125
    expect(signTest(6, 0)).toBeCloseTo(0.03125, 6);
    // 8 wins, 1 loss → 2 * ((C(9,0) + C(9,1)) / 512) = 2 * (10/512) = 0.0390625
    expect(signTest(8, 1)).toBeCloseTo(0.0390625, 6);
  });

  it("is symmetric in wins and losses (two-sided)", () => {
    expect(signTest(9, 2)).toBeCloseTo(signTest(2, 9), 12);
  });

  it("is 1 for an even split and never exceeds 1", () => {
    expect(signTest(5, 5)).toBe(1);
    expect(signTest(1, 1)).toBe(1);
  });

  it("is 1 when every query ties (no directional evidence at all)", () => {
    expect(signTest(0, 0)).toBe(1);
  });
});

describe("bootstrapMeanCi", () => {
  it("brackets the sample mean", () => {
    const deltas = [0.1, 0.2, 0.3, 0.05, 0.25, 0.15];
    const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const [low, high] = bootstrapMeanCi(deltas, { resamples: 2000 });
    expect(low).toBeLessThanOrEqual(mean);
    expect(high).toBeGreaterThanOrEqual(mean);
  });

  it("collapses to a point interval when every delta is identical", () => {
    // No variance ⇒ every resample has the same mean ⇒ the CI is a point.
    const [low, high] = bootstrapMeanCi([0.2, 0.2, 0.2, 0.2], { resamples: 500 });
    expect(low).toBeCloseTo(0.2, 10);
    expect(high).toBeCloseTo(0.2, 10);
  });

  it("EXCLUDES zero for a consistent positive effect and INCLUDES it for a null one", () => {
    const [posLow] = bootstrapMeanCi([0.2, 0.25, 0.18, 0.3, 0.22, 0.27, 0.19, 0.24], {
      resamples: 4000,
    });
    expect(posLow).toBeGreaterThan(0);

    const [nullLow, nullHigh] = bootstrapMeanCi([0.3, -0.28, 0.1, -0.15, 0.02, -0.05], {
      resamples: 4000,
    });
    expect(nullLow).toBeLessThan(0);
    expect(nullHigh).toBeGreaterThan(0);
  });

  it("is reproducible across runs (a committed CI must not move)", () => {
    const deltas = [0.1, -0.2, 0.35, 0, 0.05, -0.1, 0.4];
    expect(bootstrapMeanCi(deltas)).toEqual(bootstrapMeanCi(deltas));
  });

  it("returns a zero interval for an empty sample", () => {
    expect(bootstrapMeanCi([])).toEqual([0, 0]);
  });

  it("widens as the confidence level rises", () => {
    const deltas = [0.1, -0.2, 0.35, 0, 0.05, -0.1, 0.4, 0.2, -0.3];
    const [l95, h95] = bootstrapMeanCi(deltas, { confidence: 0.95, resamples: 4000 });
    const [l80, h80] = bootstrapMeanCi(deltas, { confidence: 0.8, resamples: 4000 });
    expect(h95 - l95).toBeGreaterThan(h80 - l80);
  });
});

describe("compareArms", () => {
  it("pairs by query id and counts wins/losses/ties", () => {
    const c = compareArms(
      "b vs a",
      "B",
      "A",
      scores([
        ["q1", 1.0],
        ["q2", 0.5],
        ["q3", 0.2],
      ]),
      scores([
        ["q1", 0.4],
        ["q2", 0.5],
        ["q3", 0.9],
      ]),
      { resamples: 500 },
    );

    expect(c.n).toBe(3);
    expect(c.wins).toBe(1);
    expect(c.losses).toBe(1);
    expect(c.ties).toBe(1);
    // (0.6 + 0 - 0.7) / 3
    expect(c.meanDelta).toBeCloseTo(-0.1 / 3, 10);
    // Only the non-tied queries count: 1 win, 1 loss ⇒ p = 1.
    expect(c.signTestP).toBe(1);
  });

  it("ignores queries the other arm did not score (no silent borrowing)", () => {
    const c = compareArms(
      "b vs a",
      "B",
      "A",
      scores([
        ["q1", 1],
        ["q2", 1],
      ]),
      scores([["q1", 0]]),
      { resamples: 200 },
    );
    expect(c.n).toBe(1);
    expect(c.meanDelta).toBe(1);
  });

  it("throws when the arms share no queries — a comparison over nothing is not a comparison", () => {
    expect(() =>
      compareArms("x", "B", "A", scores([["q1", 1]]), scores([["q9", 1]]), { resamples: 10 }),
    ).toThrow(/share no queries/);
  });
});

// --- computeSignificance -----------------------------------------------------

function makeArm(armId: string, ndcgByQuery: Array<[string, number]>): ArmRunResult {
  const empty = { queryCount: 0, recallAtK: {}, mrr: 0, ndcgAtK: {}, hitRateAt10: 0 };
  return {
    armId,
    channels: { vector: empty, hybrid: empty, bm25: empty },
    vectorQueries: ndcgByQuery.map(([queryId, ndcg]) => ({
      queryId,
      ranked: [],
      relevant: [],
      firstRelevantRank: null,
      recallAtK: {},
      reciprocalRank: 0,
      ndcgAtK: { 10: ndcg },
    })),
    docCount: 0,
    queryCount: ndcgByQuery.length,
  };
}

describe("computeSignificance", () => {
  const qs = (base: number): Array<[string, number]> =>
    Array.from({ length: 8 }, (_, i) => [`q${i}`, base + i * 0.01] as [string, number]);

  it("compares the four headline pairs on per-query vector nDCG@10", () => {
    const sig = computeSignificance(
      {
        incumbent: makeArm("A", qs(0.25)),
        candidate: makeArm("B", qs(0.4)),
        "wrong-pooling": makeArm("C", qs(0.26)),
        "hash-floor": makeArm("E", qs(0.03)),
        "candidate-fp32": makeArm("D", qs(0.36)),
      },
      { resamples: 500 },
    );

    expect(sig.map((c) => `${c.armA}-${c.armB}`)).toEqual(["B-A", "B-C", "A-E", "B-D"]);
    // Candidate beats incumbent on every query ⇒ a clean positive interval.
    const gate = sig[0];
    expect(gate.meanDelta).toBeCloseTo(0.15, 6);
    expect(gate.ciLow).toBeGreaterThan(0);
    expect(gate.wins).toBe(8);
    expect(gate.losses).toBe(0);
  });

  it("omits comparisons whose arms were not run (fp32 is optional)", () => {
    const sig = computeSignificance(
      {
        incumbent: makeArm("A", qs(0.25)),
        candidate: makeArm("B", qs(0.4)),
        "wrong-pooling": makeArm("C", qs(0.26)),
        "hash-floor": makeArm("E", qs(0.03)),
      },
      { resamples: 200 },
    );
    expect(sig).toHaveLength(3);
    expect(sig.some((c) => c.armB === "D")).toBe(false);
  });

  it("returns nothing when no arms were run", () => {
    expect(computeSignificance({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #1157 — the UNPAIRED interval around a single aggregate.
// ---------------------------------------------------------------------------

describe("bootstrapMean", () => {
  it("returns the sample mean and the sample (n-1) standard deviation", () => {
    const stats = bootstrapMean([0, 0.5, 1]);
    expect(stats.mean).toBeCloseTo(0.5, 12);
    expect(stats.sd).toBeCloseTo(0.5, 12);
    expect(stats.n).toBe(3);
  });

  it("brackets the mean and reports halfWidth as half the interval", () => {
    const stats = bootstrapMean([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(stats.ciLow).toBeLessThanOrEqual(stats.mean);
    expect(stats.ciHigh).toBeGreaterThanOrEqual(stats.mean);
    expect(stats.halfWidth).toBeCloseTo((stats.ciHigh - stats.ciLow) / 2, 12);
  });

  it("narrows as n grows, which is the whole reason #1157 enlarged the corpus", () => {
    const pattern = [0, 0.25, 0.5, 0.75, 1];
    const small = bootstrapMean(pattern);
    const large = bootstrapMean(Array.from({ length: 20 }, (_, i) => pattern[i % 5]));
    expect(large.halfWidth).toBeLessThan(small.halfWidth);
  });

  it("is deterministic — a committed interval must be reproducible", () => {
    const values = [0.1, 0.9, 0.3, 0.7, 0.5];
    expect(bootstrapMean(values)).toEqual(bootstrapMean(values));
  });

  it("gives a single observation a ZERO-width interval rather than flattering it", () => {
    const stats = bootstrapMean([0.42]);
    expect(stats.mean).toBe(0.42);
    expect(stats.sd).toBe(0);
    expect(stats.halfWidth).toBe(0);
    expect(stats.n).toBe(1);
  });

  it("returns zeros for an empty sample", () => {
    expect(bootstrapMean([])).toMatchObject({ mean: 0, ciLow: 0, ciHigh: 0, halfWidth: 0, n: 0 });
  });

  it("honours an explicit resample count and confidence level", () => {
    const stats = bootstrapMean([0, 1, 0, 1], { resamples: 1000, confidence: 0.9 });
    expect(stats.resamples).toBe(1000);
    expect(stats.confidence).toBe(0.9);
  });

  it("defaults to at least the 1000 resamples #1157 requires", () => {
    expect(bootstrapMean([0, 1]).resamples).toBeGreaterThanOrEqual(1000);
  });
});

describe("queriesNeededForHalfWidth", () => {
  it("inverts z*sd/sqrt(n) — the closed form, not whatever the code emits", () => {
    const stats = bootstrapMean([0, 1, 0, 1, 0, 1, 0, 1]);
    const expected = Math.ceil(((Z_95 * stats.sd) / 0.03) ** 2);
    expect(queriesNeededForHalfWidth(stats, 0.03)).toBe(expected);
  });

  it("demands more queries for a tighter target", () => {
    const stats = bootstrapMean([0, 1, 0, 1]);
    expect(queriesNeededForHalfWidth(stats, 0.01)!).toBeGreaterThan(
      queriesNeededForHalfWidth(stats, 0.05)!,
    );
  });

  it("returns null when the sample has no spread to extrapolate from", () => {
    expect(queriesNeededForHalfWidth(bootstrapMean([0.5, 0.5, 0.5]), 0.03)).toBeNull();
    expect(queriesNeededForHalfWidth(bootstrapMean([0.5]), 0.03)).toBeNull();
    expect(queriesNeededForHalfWidth(bootstrapMean([]), 0.03)).toBeNull();
  });

  it("returns null for a non-positive target rather than dividing by zero", () => {
    expect(queriesNeededForHalfWidth(bootstrapMean([0, 1]), 0)).toBeNull();
    expect(queriesNeededForHalfWidth(bootstrapMean([0, 1]), -0.1)).toBeNull();
  });
});
