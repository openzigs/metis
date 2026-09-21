/**
 * Epic #726 / Issue #738 — unit tests for the pure precision/recall/F1 scorer.
 *
 * Hand-verified cases: perfect match, zero overlap, partial overlap, dedupe,
 * and the documented empty-set boundaries. Aggregation is checked for both the
 * macro (per-case mean) and micro (pooled-by-file) definitions.
 */
import { describe, expect, it } from "vitest";
import { aggregateScores, scoreCase, type CaseScore } from "./scorer.js";

describe("scoreCase", () => {
  it("perfect match ⇒ precision = recall = f1 = 1", () => {
    const s = scoreCase("c", ["a.ts", "b.ts"], ["a.ts", "b.ts"]);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.hit).toBe(true);
    expect(s.falsePositives).toEqual([]);
    expect(s.falseNegatives).toEqual([]);
  });

  it("zero overlap ⇒ precision = recall = f1 = 0", () => {
    const s = scoreCase("c", ["x.ts"], ["a.ts", "b.ts"]);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.hit).toBe(false);
    expect(s.falsePositives).toEqual(["x.ts"]);
    expect(s.falseNegatives).toEqual(["a.ts", "b.ts"]);
  });

  it("partial overlap ⇒ hand-verified precision/recall/f1", () => {
    // predicted {a,b,c}; actual {a,b,d}. TP={a,b}, FP={c}, FN={d}.
    const s = scoreCase("c", ["a.ts", "b.ts", "c.ts"], ["a.ts", "b.ts", "d.ts"]);
    expect(s.truePositives).toEqual(["a.ts", "b.ts"]);
    expect(s.falsePositives).toEqual(["c.ts"]);
    expect(s.falseNegatives).toEqual(["d.ts"]);
    expect(s.precision).toBeCloseTo(2 / 3, 10);
    expect(s.recall).toBeCloseTo(2 / 3, 10);
    expect(s.f1).toBeCloseTo(2 / 3, 10);
    expect(s.hit).toBe(true);
  });

  it("over-prediction lowers precision but keeps recall high", () => {
    // predicted {a,b,c,d}; actual {a,b}. TP={a,b}, FP={c,d}.
    const s = scoreCase("c", ["a.ts", "b.ts", "c.ts", "d.ts"], ["a.ts", "b.ts"]);
    expect(s.precision).toBe(0.5);
    expect(s.recall).toBe(1);
    expect(s.f1).toBeCloseTo(2 / 3, 10);
  });

  it("dedupes both predicted and actual sets", () => {
    const s = scoreCase("c", ["a.ts", "a.ts", "b.ts"], ["a.ts", "a.ts"]);
    expect(s.predicted).toEqual(["a.ts", "b.ts"]);
    expect(s.actual).toEqual(["a.ts"]);
    expect(s.truePositives).toEqual(["a.ts"]);
    expect(s.precision).toBe(0.5);
    expect(s.recall).toBe(1);
  });

  it("empty predicted with non-empty actual ⇒ precision 1 (nothing wrong flagged), recall 0", () => {
    const s = scoreCase("c", [], ["a.ts"]);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.hit).toBe(false);
  });

  it("both sets empty ⇒ precision = recall = 1, f1 = 1", () => {
    const s = scoreCase("c", [], []);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
  });
});

describe("aggregateScores", () => {
  it("empty list ⇒ fully zeroed aggregate", () => {
    const agg = aggregateScores([]);
    expect(agg).toEqual({
      caseCount: 0,
      macroPrecision: 0,
      macroRecall: 0,
      macroF1: 0,
      microPrecision: 0,
      microRecall: 0,
      microF1: 0,
      hitRate: 0,
    });
  });

  it("macro is the per-case mean; micro pools TP/FP/FN across cases", () => {
    const scores: CaseScore[] = [
      // Case 1: predicted {a}; actual {a}. TP=1, FP=0, FN=0.  P=1 R=1 F1=1.
      scoreCase("1", ["a.ts"], ["a.ts"]),
      // Case 2: predicted {b,c,d}; actual {b}. TP=1, FP=2, FN=0. P=1/3 R=1 F1=0.5.
      scoreCase("2", ["b.ts", "c.ts", "d.ts"], ["b.ts"]),
    ];
    const agg = aggregateScores(scores);
    expect(agg.caseCount).toBe(2);
    // macro = mean of per-case metrics.
    expect(agg.macroPrecision).toBeCloseTo((1 + 1 / 3) / 2, 10);
    expect(agg.macroRecall).toBe(1);
    expect(agg.macroF1).toBeCloseTo((1 + 0.5) / 2, 10);
    // micro: totalTP=2, totalFP=2, totalFN=0 ⇒ P=2/4=0.5, R=2/2=1.
    expect(agg.microPrecision).toBe(0.5);
    expect(agg.microRecall).toBe(1);
    expect(agg.microF1).toBeCloseTo(2 / 3, 10);
    expect(agg.hitRate).toBe(1);
  });

  it("hitRate is the fraction of cases with ≥1 true positive", () => {
    const scores: CaseScore[] = [
      scoreCase("1", ["a.ts"], ["a.ts"]), // hit
      scoreCase("2", ["z.ts"], ["b.ts"]), // miss
    ];
    expect(aggregateScores(scores).hitRate).toBe(0.5);
  });
});
