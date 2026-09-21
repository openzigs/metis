/**
 * Epic #157 — RAGAS judge / harness unit tests.
 *
 * #1317 rewrote the "vacuous denominator" contract: a metric whose denominator
 * is zero is now `null` (UNVERIFIABLE) and is EXCLUDED from the mean, where it
 * used to be `1.0` and counted as a pass. The assertions below were flipped
 * deliberately — the old ones encoded the defect.
 */
import { describe, expect, it } from "vitest";
import {
  averageScores,
  computeDeltas,
  fixtureSetDigest,
  REGRESSION_THRESHOLD,
  runEval,
  StubRagasJudge,
  type RagasFixture,
} from "../src/lib/rag/ragas.js";

const fxA: RagasFixture = {
  id: "a",
  question: "what is metis",
  groundTruthContexts: ["metis is a rag"],
  expectedAnswerKeywords: ["metis", "rag"],
  generatedAnswer: "metis is a rag platform",
  retrievedChunks: ["metis is a rag built for enterprise"],
};

const fxB: RagasFixture = {
  id: "b",
  question: "what is metis",
  groundTruthContexts: ["metis is a rag"],
  expectedAnswerKeywords: ["alpaca"],
  generatedAnswer: "irrelevant",
  retrievedChunks: ["bus schedule for tuesday"],
};

describe("StubRagasJudge.scoreFixture", () => {
  const judge = new StubRagasJudge();

  it("scores a perfectly aligned fixture at 1.0 across the board", () => {
    const s = judge.scoreFixture(fxA);
    expect(s.context_precision).toBe(1);
    expect(s.context_recall).toBe(1);
    expect(s.faithfulness).toBe(1);
    expect(s.answer_relevancy).toBe(1);
  });

  it("flags retrieval misses with low precision/recall and irrelevant answers low relevancy", () => {
    const s = judge.scoreFixture(fxB);
    expect(s.context_precision).toBe(0);
    expect(s.context_recall).toBe(0);
    expect(s.answer_relevancy).toBe(0);
  });

  it("#1317 — reports a vacuous denominator as null, NOT as a 1.0 pass", () => {
    const s = judge.scoreFixture({
      id: "empty",
      question: "?",
      groundTruthContexts: [],
      expectedAnswerKeywords: [],
      retrievedChunks: [],
    });
    expect(s.context_precision).toBeNull();
    expect(s.context_recall).toBeNull();
    expect(s.faithfulness).toBeNull();
    expect(s.answer_relevancy).toBeNull();
  });

  it("#1317 — an answer matching no expected keyword is unverifiable, not faithful", () => {
    // fxB's answer contains none of its expected keywords, so the old
    // implementation divided 0 by 0 and reported a perfect faithfulness for an
    // answer whose claims it had never inspected.
    expect(judge.scoreFixture(fxB).faithfulness).toBeNull();
  });
});

describe("averageScores", () => {
  it("returns a null mean on empty input — nothing was measured, so there is no 0", () => {
    const a = averageScores([]);
    expect(a.mean).toEqual({
      context_precision: null,
      context_recall: null,
      faithfulness: null,
      answer_relevancy: null,
    });
    expect(a.scored.faithfulness).toBe(0);
  });

  it("computes the arithmetic mean per metric", () => {
    const a = averageScores([
      { context_precision: 1, context_recall: 0, faithfulness: 1, answer_relevancy: 0 },
      { context_precision: 0, context_recall: 1, faithfulness: 0, answer_relevancy: 1 },
    ]);
    expect(a.mean.context_precision).toBeCloseTo(0.5);
    expect(a.mean.context_recall).toBeCloseTo(0.5);
    expect(a.mean.faithfulness).toBeCloseTo(0.5);
    expect(a.mean.answer_relevancy).toBeCloseTo(0.5);
    expect(a.scored.faithfulness).toBe(2);
    expect(a.unverifiable.faithfulness).toBe(0);
  });

  it("#1317 — EXCLUDES unverifiable values from the mean rather than scoring them 1.0", () => {
    const a = averageScores([
      { context_precision: 0, context_recall: 0, faithfulness: 0, answer_relevancy: 0 },
      { context_precision: null, context_recall: null, faithfulness: null, answer_relevancy: null },
    ]);
    // Counting the null as a pass would give 0.5; counting it as 0 would give 0.
    // Excluding it gives 0 over ONE scored fixture — the count is what separates them.
    expect(a.mean.faithfulness).toBe(0);
    expect(a.scored.faithfulness).toBe(1);
    expect(a.unverifiable.faithfulness).toBe(1);
  });
});

describe("computeDeltas", () => {
  it("returns null deltas when no baseline", () => {
    expect(
      computeDeltas(null, {
        context_precision: 1,
        context_recall: 1,
        faithfulness: 1,
        answer_relevancy: 1,
      }),
    ).toEqual({ deltas: null, regressions: [] });
  });

  it("flags any metric that drops more than the threshold", () => {
    const baseline = {
      context_precision: 0.9,
      context_recall: 0.9,
      faithfulness: 0.9,
      answer_relevancy: 0.9,
    };
    const current = { ...baseline, context_precision: 0.9 - REGRESSION_THRESHOLD - 0.01 };
    const result = computeDeltas(baseline, current);
    expect(result.regressions.map((r) => r.metric)).toEqual(["context_precision"]);
  });

  it("#1317 — reports a null delta and NO regression when either side is unverifiable", () => {
    const baseline = {
      context_precision: 0.9,
      context_recall: 0.9,
      faithfulness: 0.9,
      answer_relevancy: 0.9,
    };
    const current = { ...baseline, faithfulness: null };
    const result = computeDeltas(baseline, current);
    expect(result.deltas?.faithfulness).toBeNull();
    // Coercing the null to 0 would manufacture a -0.9 regression out of a run
    // that simply could not measure the metric.
    expect(result.regressions).toEqual([]);
  });

  it("treats sub-threshold drift as acceptable", () => {
    const baseline = {
      context_precision: 0.9,
      context_recall: 0.9,
      faithfulness: 0.9,
      answer_relevancy: 0.9,
    };
    const current = { ...baseline, context_precision: 0.88 };
    const result = computeDeltas(baseline, current);
    expect(result.regressions).toEqual([]);
  });
});

describe("runEval", () => {
  it("returns aggregated results + fixture count", async () => {
    const report = await runEval({ fixtures: [fxA, fxB] });
    expect(report.fixtures).toBe(2);
    expect(report.current.context_precision).toBeCloseTo(0.5);
    expect(report.regressions).toEqual([]);
  });

  it("propagates regressions when a baseline is supplied", async () => {
    const baseline = {
      context_precision: 1,
      context_recall: 1,
      faithfulness: 1,
      answer_relevancy: 1,
    };
    const report = await runEval({ fixtures: [fxB], baseline });
    expect(report.regressions.length).toBeGreaterThan(0);
  });

  it("#1317 — carries per-metric verifiability counts into the committed artifact", async () => {
    const report = await runEval({ fixtures: [fxA, fxB] });
    // fxB's answer matches none of its expected keywords → faithfulness unverifiable.
    expect(report.scored?.faithfulness).toBe(1);
    expect(report.unverifiable?.faithfulness).toBe(1);
  });

  it("#1317 — awaits an ASYNC judge behind the seam", async () => {
    const report = await runEval({
      fixtures: [fxA],
      judge: {
        scoreFixture: async () => ({
          context_precision: 0.25,
          context_recall: 0.25,
          faithfulness: 0.25,
          answer_relevancy: 0.25,
        }),
      },
    });
    expect(report.current.faithfulness).toBe(0.25);
  });
});

describe("fixtureSetDigest", () => {
  it("is stable for identical input", () => {
    const a = fixtureSetDigest([fxA, fxB]);
    const b = fixtureSetDigest([fxA, fxB]);
    expect(a).toBe(b);
  });

  it("changes when fixtures change", () => {
    const a = fixtureSetDigest([fxA]);
    const b = fixtureSetDigest([fxA, fxB]);
    expect(a).not.toBe(b);
  });
});
