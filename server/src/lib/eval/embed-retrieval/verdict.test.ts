import { describe, expect, it } from "vitest";
import type { ChannelMetrics } from "./metrics.js";
import type { ArmRunResult } from "./runner.js";
import { computeVerdict, round4, VERDICT_BAR, type ArmRole } from "./verdict.js";

function channel(ndcg10: number, recall5 = ndcg10): ChannelMetrics {
  return {
    queryCount: 30,
    recallAtK: { 1: recall5 / 2, 5: recall5, 10: recall5 },
    mrr: ndcg10,
    ndcgAtK: { 1: ndcg10, 5: ndcg10, 10: ndcg10 },
    hitRateAt10: recall5,
  };
}

function arm(
  id: string,
  vectorNdcg: number,
  hybridNdcg = vectorNdcg,
  recall5?: number,
): ArmRunResult {
  return {
    armId: id,
    channels: {
      vector: channel(vectorNdcg, recall5 ?? vectorNdcg),
      hybrid: channel(hybridNdcg),
      bm25: channel(0.4),
    },
    vectorQueries: [],
    docCount: 183,
    queryCount: 30,
  };
}

const healthy: Partial<Record<ArmRole, ArmRunResult>> = {
  incumbent: arm("A", 0.5),
  candidate: arm("B", 0.62),
  "wrong-pooling": arm("C", 0.5),
  "hash-floor": arm("E", 0.05),
};

describe("computeVerdict", () => {
  it("GO when both validity checks and all three gates pass", () => {
    const v = computeVerdict(healthy);
    expect(v.outcome).toBe("GO");
    expect(v.headlineMetric).toBe("vector.ndcgAt10");
    expect(v.checks.filter((c) => c.kind === "gate").every((c) => c.passed)).toBe(true);
    expect(v.summary).toContain("GO —");
  });

  it("NO-GO when the candidate's gain is below the stated bar", () => {
    const v = computeVerdict({ ...healthy, candidate: arm("B", 0.53) });
    expect(v.outcome).toBe("NO-GO");
    expect(v.checks.find((c) => c.id === "candidate-beats-incumbent")?.passed).toBe(false);
    expect(v.summary).toContain("#783 must not ship");
  });

  it("NO-GO when the candidate wins on nDCG but loses recall@5", () => {
    const v = computeVerdict({
      ...healthy,
      incumbent: arm("A", 0.5, 0.5, 0.9),
      candidate: arm("B", 0.62, 0.62, 0.8),
    });
    expect(v.outcome).toBe("NO-GO");
    expect(v.checks.find((c) => c.id === "no-recall-regression")?.passed).toBe(false);
  });

  it("NO-GO when the user-visible hybrid ranking regresses", () => {
    const v = computeVerdict({
      ...healthy,
      incumbent: arm("A", 0.5, 0.7),
      candidate: arm("B", 0.62, 0.65),
    });
    expect(v.outcome).toBe("NO-GO");
    expect(v.checks.find((c) => c.id === "hybrid-not-worse")?.passed).toBe(false);
  });

  it("INVALID (never GO) when wrong pooling is indistinguishable from correct pooling", () => {
    const v = computeVerdict({ ...healthy, "wrong-pooling": arm("C", 0.62) });
    expect(v.outcome).toBe("INVALID");
    expect(v.checks.find((c) => c.id === "detects-wrong-pooling")?.passed).toBe(false);
    expect(v.summary).toContain("Strengthen the eval");
  });

  it("INVALID when the incumbent barely beats the chance-level hash floor", () => {
    const v = computeVerdict({ ...healthy, "hash-floor": arm("E", 0.45) });
    expect(v.outcome).toBe("INVALID");
    expect(v.checks.find((c) => c.id === "discriminates-noise")?.passed).toBe(false);
  });

  it("INVALID when a required arm was never run — a gate cannot pass on missing evidence", () => {
    const v = computeVerdict({ incumbent: arm("A", 0.5), candidate: arm("B", 0.62) });
    expect(v.outcome).toBe("INVALID");
    expect(v.summary).toContain("wrong-pooling");
    expect(v.summary).toContain("hash-floor");
  });

  it("reports the q8-vs-fp32 delta as informational when the fp32 arm was run", () => {
    const v = computeVerdict({ ...healthy, "candidate-fp32": arm("D", 0.63) });
    const q8 = v.checks.find((c) => c.id === "q8-within-tolerance");
    expect(q8?.value).toBeCloseTo(0.01);
    expect(q8?.passed).toBe(true);
    expect(v.outcome).toBe("GO");
  });

  it("flags q8 as out of tolerance without blocking the flip verdict", () => {
    const v = computeVerdict({ ...healthy, "candidate-fp32": arm("D", 0.75) });
    expect(v.checks.find((c) => c.id === "q8-within-tolerance")?.passed).toBe(false);
    // Informational only — it does not gate.
    expect(v.outcome).toBe("GO");
  });

  it("leaves the q8 check null when no fp32 arm was run", () => {
    const q8 = computeVerdict(healthy).checks.find((c) => c.id === "q8-within-tolerance");
    expect(q8?.passed).toBeNull();
    expect(q8?.value).toBeNull();
  });

  it("exposes the bar as committed constants", () => {
    expect(VERDICT_BAR.candidateNdcgGain).toBe(0.05);
    expect(VERDICT_BAR.poolingDetectionGain).toBe(0.02);
    expect(VERDICT_BAR.noiseDiscriminationGain).toBe(0.1);
    expect(VERDICT_BAR.q8Tolerance).toBe(0.02);
  });
});

describe("round4", () => {
  it("rounds to 4 decimal places", () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(1)).toBe(1);
  });
});
