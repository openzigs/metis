/**
 * #335 — unit tests for the hybrid A/B runner. The provider/judge seam is a
 * MOCKED {@link SectionEvaluator} (no live models): tests assert both arms run
 * over the SAME corpus, the aggregation flows through, and the verdict + exit
 * signal are correct.
 */
import { describe, expect, it, vi } from "vitest";
import { runAbEval } from "./runner.js";
import type { AbCorpusItem, EvalArm, SectionEvalOutcome, SectionEvaluator } from "./types.js";

const CORPUS: AbCorpusItem[] = [
  {
    id: "doc1",
    title: "Doc One",
    sections: [
      { id: "s-lit", label: "Business Rules", tier: "literal" },
      { id: "s-rec", label: "Key Workflows", tier: "reconstruction" },
      { id: "s-nar", label: "Overview", tier: "narrative" },
    ],
  },
];

/** Deterministic evaluator: cloud is always great, local is a touch lower. */
function makeEvaluator(
  overrides?: Partial<Record<EvalArm, Partial<SectionEvalOutcome>>>,
): SectionEvaluator {
  return ({ arm }) => {
    const base: SectionEvalOutcome =
      arm === "all-sonnet"
        ? { faithfulness: 0.92, escalated: false, localTokens: 0, cloudTokens: 1000 }
        : { faithfulness: 0.9, escalated: false, localTokens: 1000, cloudTokens: 0 };
    return { ...base, ...(overrides?.[arm] ?? {}) };
  };
}

describe("runAbEval", () => {
  it("runs BOTH arms over the SAME corpus (identical section set, same order)", async () => {
    const seen: Array<{ arm: EvalArm; sectionId: string }> = [];
    const evaluate: SectionEvaluator = (input) => {
      seen.push({ arm: input.arm, sectionId: input.section.id });
      return { faithfulness: 0.9, escalated: false, localTokens: 10, cloudTokens: 10 };
    };
    await runAbEval({ corpus: CORPUS, evaluate });

    const bySonnet = seen.filter((s) => s.arm === "all-sonnet").map((s) => s.sectionId);
    const byHybrid = seen.filter((s) => s.arm === "local-escalation").map((s) => s.sectionId);
    expect(bySonnet).toEqual(["s-lit", "s-rec", "s-nar"]);
    expect(byHybrid).toEqual(["s-lit", "s-rec", "s-nar"]);
  });

  it("is deterministic for a deterministic evaluator (same input → same result)", async () => {
    const now = () => new Date("2026-06-30T00:00:00.000Z");
    const a = await runAbEval({ corpus: CORPUS, evaluate: makeEvaluator(), now });
    const b = await runAbEval({ corpus: CORPUS, evaluate: makeEvaluator(), now });
    expect(a).toEqual(b);
  });

  it("reports itemCount, sectionCount, and both arm aggregates", async () => {
    const result = await runAbEval({ corpus: CORPUS, evaluate: makeEvaluator() });
    expect(result.itemCount).toBe(1);
    expect(result.sectionCount).toBe(3);
    expect(result.arms.baseline.arm).toBe("all-sonnet");
    expect(result.arms.candidate.arm).toBe("local-escalation");
    expect(result.arms.baseline.overall.mean).toBeCloseTo(0.92);
    expect(result.arms.candidate.overall.mean).toBeCloseTo(0.9);
  });

  it("PASSES the gate when the candidate is close, cheap, and low-escalation", async () => {
    const result = await runAbEval({ corpus: CORPUS, evaluate: makeEvaluator() });
    expect(result.verdict.passed).toBe(true);
    expect(result.deltas.overall).toBeCloseTo(-0.02);
    expect(result.deltas.costReduction).toBeCloseTo(1); // baseline all cloud, candidate all local
  });

  it("FAILS the gate when the candidate degrades badly (drives the non-zero exit)", async () => {
    const evaluate = makeEvaluator({ "local-escalation": { faithfulness: 0.3 } });
    const result = await runAbEval({ corpus: CORPUS, evaluate });
    expect(result.verdict.passed).toBe(false);
    // At least the overall + tier-floor criteria should fail.
    expect(result.verdict.checks.some((c) => !c.passed)).toBe(true);
  });

  it("honours threshold overrides", async () => {
    // With a huge epsilon, even a big drop passes the faithfulness checks; but
    // the tier floor still applies, so disable it too to isolate the epsilon.
    const evaluate = makeEvaluator({ "local-escalation": { faithfulness: 0.5 } });
    const result = await runAbEval({
      corpus: CORPUS,
      evaluate,
      thresholds: { overallEpsilon: 1, tierEpsilon: 1, enforceTierFloor: false },
    });
    const overall = result.verdict.checks.find((c) => c.id === "overall-faithfulness")!;
    expect(overall.passed).toBe(true);
    expect(result.thresholds.overallEpsilon).toBe(1);
  });

  it("records commit + schema version + ISO timestamps", async () => {
    const now = () => new Date("2026-06-30T12:00:00.000Z");
    const result = await runAbEval({
      corpus: CORPUS,
      evaluate: makeEvaluator(),
      now,
      commit: "abc123",
    });
    expect(result.commit).toBe("abc123");
    expect(result.schemaVersion).toBe(1);
    expect(result.startedAt).toBe("2026-06-30T12:00:00.000Z");
    expect(result.completedAt).toBe("2026-06-30T12:00:00.000Z");
  });

  it("awaits async evaluators", async () => {
    const evaluate = vi.fn(async () => ({
      faithfulness: 0.9,
      escalated: false,
      localTokens: 5,
      cloudTokens: 5,
    }));
    const result = await runAbEval({ corpus: CORPUS, evaluate });
    // 3 sections * 2 arms = 6 calls
    expect(evaluate).toHaveBeenCalledTimes(6);
    expect(result.sectionCount).toBe(3);
  });

  it("handles an empty corpus without throwing", async () => {
    const result = await runAbEval({ corpus: [], evaluate: makeEvaluator() });
    expect(result.itemCount).toBe(0);
    expect(result.sectionCount).toBe(0);
    // no evidence → gate passes (never a false regression)
    expect(result.verdict.passed).toBe(true);
  });
});
