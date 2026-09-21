/**
 * Epic #803 (Epic 09) — Domain Eval scorer unit tests.
 */
import { describe, expect, it } from "vitest";
import type { DomainRequirement } from "@metis/shared";
import {
  MATCH_THRESHOLD,
  alignmentScore,
  calibrationBins,
  lcsLength,
  matchRequirements,
  precisionRecallF1,
  rougeL,
  scoreItem,
  tokenSetSimilarity,
  tokenize,
} from "./scorer.js";

function req(partial: Partial<DomainRequirement> & { id: string }): DomainRequirement {
  return {
    type: "feature",
    title: partial.title ?? partial.id,
    description: partial.description ?? "a requirement description",
    priority: "medium",
    ...partial,
  };
}

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumerics", () => {
    expect(tokenize("Reset Password, via Email!")).toEqual(["reset", "password", "via", "email"]);
  });
  it("returns an empty array for whitespace", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("tokenSetSimilarity", () => {
  it("is 1 for two empty strings", () => {
    expect(tokenSetSimilarity("", "")).toBe(1);
  });
  it("is 0 when exactly one is empty", () => {
    expect(tokenSetSimilarity("hello", "")).toBe(0);
    expect(tokenSetSimilarity("", "hello")).toBe(0);
  });
  it("is 1 for identical token sets regardless of order/case", () => {
    expect(tokenSetSimilarity("Reset password", "password RESET")).toBe(1);
  });
  it("computes Jaccard for partial overlap", () => {
    // {a,b,c} vs {b,c,d} -> intersect 2, union 4 -> 0.5
    expect(tokenSetSimilarity("a b c", "b c d")).toBeCloseTo(0.5, 5);
  });
  it("is 0 for disjoint sets", () => {
    expect(tokenSetSimilarity("alpha beta", "gamma delta")).toBe(0);
  });
});

describe("lcsLength", () => {
  it("is 0 when either side is empty", () => {
    expect(lcsLength([], ["a"])).toBe(0);
    expect(lcsLength(["a"], [])).toBe(0);
  });
  it("finds the longest common subsequence length", () => {
    expect(lcsLength(["a", "b", "c", "d"], ["a", "x", "c", "d"])).toBe(3);
  });
});

describe("rougeL", () => {
  it("is 1 for identical text", () => {
    expect(rougeL("the cat sat", "the cat sat")).toBe(1);
  });
  it("is 1 for two empty strings and 0 for one empty", () => {
    expect(rougeL("", "")).toBe(1);
    expect(rougeL("hi", "")).toBe(0);
  });
  it("is 0 when there is no common subsequence", () => {
    expect(rougeL("alpha beta", "gamma delta")).toBe(0);
  });
  it("computes an F1 between 0 and 1 for partial overlap", () => {
    const score = rougeL("the quick brown fox", "the brown fox");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("alignmentScore", () => {
  it("uses the stronger of title or description similarity", () => {
    const e = req({
      id: "E",
      title: "Accurate proration",
      description: "plan changes are prorated to the day",
    });
    const p = req({
      id: "P",
      title: "Billing must prorate plan changes to the day",
      description: "billing must prorate plan changes to the day",
    });
    const titleSim = tokenSetSimilarity(e.title, p.title);
    const descSim = tokenSetSimilarity(e.description, p.description);
    expect(alignmentScore(e, p)).toBeCloseTo(Math.max(titleSim, descSim), 5);
  });
});

describe("matchRequirements", () => {
  it("matches by description when titles diverge", () => {
    const expected = [
      req({ id: "E1", title: "Sign in", description: "users sign in with email and password" }),
    ];
    const predicted = [
      req({
        id: "P1",
        title: "The system must allow users to sign in",
        description: "users sign in with email and password",
      }),
    ];
    const out = matchRequirements(expected, predicted);
    expect(out.truePositives).toBe(1);
    expect(out.falsePositives).toBe(0);
    expect(out.falseNegatives).toBe(0);
    const tp = out.matches.find((m) => m.expectedId === "E1");
    expect(tp?.predictedId).toBe("P1");
  });

  it("counts unmatched predictions as false positives and unmatched expected as false negatives", () => {
    const expected = [req({ id: "E1", title: "alpha one", description: "alpha one only" })];
    const predicted = [req({ id: "P1", title: "zeta nine", description: "zeta nine only" })];
    const out = matchRequirements(expected, predicted);
    expect(out.truePositives).toBe(0);
    expect(out.falsePositives).toBe(1);
    expect(out.falseNegatives).toBe(1);
    expect(out.matches).toHaveLength(2);
  });

  it("greedily picks the highest-scoring pair first", () => {
    const expected = [
      req({ id: "E1", title: "reset password email", description: "reset password via email" }),
      req({ id: "E2", title: "reset password sms", description: "reset password via sms" }),
    ];
    const predicted = [
      req({ id: "P1", title: "reset password via email", description: "reset password via email" }),
    ];
    const out = matchRequirements(expected, predicted);
    expect(out.truePositives).toBe(1);
    const matched = out.matches.find((m) => m.predictedId === "P1");
    expect(matched?.expectedId).toBe("E1");
  });

  it("respects a custom threshold", () => {
    const expected = [req({ id: "E1", title: "a b c d", description: "a b c d" })];
    const predicted = [req({ id: "P1", title: "a b x y", description: "a b x y" })];
    // sim = 2/6 ≈ 0.33: below default 0.4 but above 0.3.
    expect(matchRequirements(expected, predicted).truePositives).toBe(0);
    expect(matchRequirements(expected, predicted, 0.3).truePositives).toBe(1);
  });

  it("exposes the default match threshold", () => {
    expect(MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(MATCH_THRESHOLD).toBeLessThan(1);
  });
});

describe("precisionRecallF1", () => {
  it("returns zeros when there are no predictions or expectations", () => {
    expect(precisionRecallF1(0, 0, 0)).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
  it("computes precision, recall, and F1", () => {
    const prf = precisionRecallF1(8, 2, 2);
    expect(prf.precision).toBeCloseTo(0.8, 5);
    expect(prf.recall).toBeCloseTo(0.8, 5);
    expect(prf.f1).toBeCloseTo(0.8, 5);
  });
  it("handles precision/recall of zero without NaN", () => {
    expect(precisionRecallF1(0, 3, 3).f1).toBe(0);
  });
});

describe("calibrationBins", () => {
  it("produces ten bins", () => {
    expect(calibrationBins([])).toHaveLength(10);
  });
  it("buckets predictions and reports accuracy per bin", () => {
    const bins = calibrationBins([
      { confidence: 0.95, correct: true },
      { confidence: 0.92, correct: false },
      { confidence: 0.55, correct: true },
    ]);
    const top = bins[9];
    expect(top.count).toBe(2);
    expect(top.accuracy).toBeCloseTo(0.5, 5);
    expect(top.meanConfidence).toBeGreaterThanOrEqual(0.9);
    const mid = bins[5];
    expect(mid.count).toBe(1);
    expect(mid.accuracy).toBe(1);
  });
  it("includes the upper bound only in the final bin", () => {
    const bins = calibrationBins([{ confidence: 1, correct: true }]);
    expect(bins[9].count).toBe(1);
  });
});

describe("scoreItem", () => {
  it("rolls up per-item precision/recall/F1 and ROUGE-L over matched pairs", () => {
    const result = scoreItem({
      itemId: "item-1",
      docType: "prd",
      title: "Item 1",
      expected: [
        req({ id: "E1", title: "sign in", description: "users sign in with email and password" }),
        req({
          id: "E2",
          title: "reset password",
          description: "users reset a forgotten password by email",
        }),
      ],
      predicted: [
        req({
          id: "P1",
          title: "users must sign in",
          description: "users sign in with email and password",
        }),
      ],
    });
    expect(result.truePositives).toBe(1);
    expect(result.falseNegatives).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.recall).toBeCloseTo(0.5, 5);
    expect(result.meanRougeL).toBeGreaterThan(0);
  });
  it("reports zero ROUGE-L when nothing matches", () => {
    const result = scoreItem({
      itemId: "i",
      docType: "brd",
      title: "t",
      expected: [req({ id: "E1", title: "alpha", description: "alpha beta gamma" })],
      predicted: [req({ id: "P1", title: "omega", description: "delta epsilon zeta" })],
    });
    expect(result.meanRougeL).toBe(0);
  });
});
