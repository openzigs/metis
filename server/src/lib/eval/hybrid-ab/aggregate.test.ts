/**
 * #335 — unit tests for the hybrid A/B rollout-gate aggregation + gate math.
 * Pure functions, no providers — the full comparison/decision logic is covered
 * here with deterministic stub scores (no live models).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AB_THRESHOLDS,
  TIERS,
  aggregateArm,
  aggregateFaithfulness,
  computeDeltas,
  evaluateGate,
  resolveThresholds,
  tierFloor,
  type TaggedOutcome,
} from "./aggregate.js";
import type { DocWarningTier } from "../../docs-gen/grounding/degraded-warnings.js";
import type { SectionEvalOutcome } from "./types.js";

function outcome(p: Partial<SectionEvalOutcome> = {}): SectionEvalOutcome {
  return {
    faithfulness: p.faithfulness === undefined ? 1 : p.faithfulness,
    escalated: p.escalated ?? false,
    localTokens: p.localTokens ?? 0,
    cloudTokens: p.cloudTokens ?? 0,
  };
}

function tagged(tier: DocWarningTier, p: Partial<SectionEvalOutcome> = {}): TaggedOutcome {
  return { tier, outcome: outcome(p) };
}

describe("tierFloor", () => {
  it("maps each tier to its production gate constant", () => {
    expect(tierFloor("narrative")).toBe(0.4);
    expect(tierFloor("reconstruction")).toBe(0.6);
    expect(tierFloor("literal")).toBe(0.8);
  });
});

describe("resolveThresholds", () => {
  it("returns documented defaults when nothing is passed", () => {
    expect(resolveThresholds()).toEqual(DEFAULT_AB_THRESHOLDS);
  });

  it("merges partial overrides over the defaults", () => {
    const t = resolveThresholds({ overallEpsilon: 0.1, maxEscalationRate: 0.9 });
    expect(t.overallEpsilon).toBe(0.1);
    expect(t.maxEscalationRate).toBe(0.9);
    // untouched fields keep defaults
    expect(t.minCostReduction).toBe(DEFAULT_AB_THRESHOLDS.minCostReduction);
    expect(t.tierEpsilon).toBe(DEFAULT_AB_THRESHOLDS.tierEpsilon);
  });
});

describe("aggregateFaithfulness", () => {
  it("means over verified sections and excludes unverified from the mean", () => {
    const agg = aggregateFaithfulness([
      outcome({ faithfulness: 1 }),
      outcome({ faithfulness: 0.5 }),
      outcome({ faithfulness: null }),
    ]);
    expect(agg.verifiedCount).toBe(2);
    expect(agg.unverifiedCount).toBe(1);
    expect(agg.mean).toBeCloseTo(0.75);
  });

  it("returns null mean when nothing is verified", () => {
    const agg = aggregateFaithfulness([
      outcome({ faithfulness: null }),
      outcome({ faithfulness: null }),
    ]);
    expect(agg.mean).toBeNull();
    expect(agg.verifiedCount).toBe(0);
    expect(agg.unverifiedCount).toBe(2);
  });

  it("handles an empty set", () => {
    const agg = aggregateFaithfulness([]);
    expect(agg.mean).toBeNull();
    expect(agg.verifiedCount).toBe(0);
  });
});

describe("aggregateArm", () => {
  it("rolls up overall + per-tier means, escalation rate, tokens, and cost proxy", () => {
    const arm = aggregateArm(
      "local-escalation",
      [
        tagged("literal", { faithfulness: 0.9, localTokens: 100 }),
        tagged("literal", {
          faithfulness: 0.7,
          localTokens: 100,
          cloudTokens: 200,
          escalated: true,
        }),
        tagged("narrative", { faithfulness: 0.5, cloudTokens: 300 }),
      ],
      2, // cloudCostPerToken
    );
    expect(arm.arm).toBe("local-escalation");
    expect(arm.sectionCount).toBe(3);
    expect(arm.overall.mean).toBeCloseTo((0.9 + 0.7 + 0.5) / 3);
    expect(arm.byTier.literal.mean).toBeCloseTo(0.8);
    expect(arm.byTier.narrative.mean).toBeCloseTo(0.5);
    expect(arm.byTier.reconstruction.mean).toBeNull();
    expect(arm.escalationRate).toBeCloseTo(1 / 3);
    expect(arm.localTokens).toBe(200);
    expect(arm.cloudTokens).toBe(500);
    expect(arm.costProxy).toBe(500 * 2);
  });

  it("reports a 0 escalation rate for an empty arm", () => {
    const arm = aggregateArm("all-sonnet", [], 1);
    expect(arm.escalationRate).toBe(0);
    expect(arm.costProxy).toBe(0);
  });

  it("covers every declared tier key", () => {
    const arm = aggregateArm("all-sonnet", [tagged("literal", { faithfulness: 1 })], 1);
    for (const t of TIERS) {
      expect(arm.byTier[t]).toBeDefined();
    }
  });
});

describe("computeDeltas", () => {
  it("computes candidate - baseline for overall + tiers + cost reduction", () => {
    const baseline = aggregateArm(
      "all-sonnet",
      [tagged("literal", { faithfulness: 0.9, cloudTokens: 1000 })],
      1,
    );
    const candidate = aggregateArm(
      "local-escalation",
      [tagged("literal", { faithfulness: 0.85, localTokens: 900, cloudTokens: 200 })],
      1,
    );
    const d = computeDeltas(baseline, candidate);
    expect(d.overall).toBeCloseTo(-0.05);
    expect(d.byTier.literal).toBeCloseTo(-0.05);
    expect(d.byTier.narrative).toBeNull();
    expect(d.costReduction).toBeCloseTo(1 - 200 / 1000); // 0.8
  });

  it("returns null cost reduction when baseline cost is zero", () => {
    const baseline = aggregateArm("all-sonnet", [tagged("literal", { faithfulness: 1 })], 1);
    const candidate = aggregateArm("local-escalation", [tagged("literal", { faithfulness: 1 })], 1);
    expect(computeDeltas(baseline, candidate).costReduction).toBeNull();
  });

  it("returns null tier delta when either arm lacks a verified mean", () => {
    const baseline = aggregateArm("all-sonnet", [tagged("literal", { faithfulness: null })], 1);
    const candidate = aggregateArm(
      "local-escalation",
      [tagged("literal", { faithfulness: 0.9 })],
      1,
    );
    expect(computeDeltas(baseline, candidate).byTier.literal).toBeNull();
    expect(computeDeltas(baseline, candidate).overall).toBeNull();
  });
});

describe("evaluateGate", () => {
  const thresholds = DEFAULT_AB_THRESHOLDS;

  function armFrom(tags: TaggedOutcome[], arm: "all-sonnet" | "local-escalation") {
    return aggregateArm(arm, tags, thresholds.cloudCostPerToken);
  }

  it("PASSES when candidate is within epsilon, above floors, low escalation, cheaper", () => {
    const baseline = armFrom(
      [
        tagged("literal", { faithfulness: 0.9, cloudTokens: 1000 }),
        tagged("reconstruction", { faithfulness: 0.85, cloudTokens: 1000 }),
        tagged("narrative", { faithfulness: 0.6, cloudTokens: 1000 }),
      ],
      "all-sonnet",
    );
    const candidate = armFrom(
      [
        tagged("literal", { faithfulness: 0.88, localTokens: 1000 }),
        tagged("reconstruction", { faithfulness: 0.82, localTokens: 1000 }),
        tagged("narrative", { faithfulness: 0.58, cloudTokens: 500 }),
      ],
      "local-escalation",
    );
    const verdict = evaluateGate(baseline, candidate, thresholds);
    expect(verdict.passed).toBe(true);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
    expect(verdict.checks.map((c) => c.id).sort()).toEqual(
      [
        "cost-reduction",
        "escalation-rate",
        "overall-faithfulness",
        "tier-faithfulness",
        "tier-floor",
      ].sort(),
    );
  });

  it("FAILS the overall-faithfulness check when candidate degrades beyond epsilon", () => {
    const baseline = armFrom(
      [tagged("literal", { faithfulness: 0.9, cloudTokens: 1000 })],
      "all-sonnet",
    );
    const candidate = armFrom(
      [tagged("literal", { faithfulness: 0.8, localTokens: 100 })],
      "local-escalation",
    );
    const verdict = evaluateGate(baseline, candidate, thresholds);
    expect(verdict.passed).toBe(false);
    const overall = verdict.checks.find((c) => c.id === "overall-faithfulness")!;
    expect(overall.passed).toBe(false);
  });

  it("FAILS the tier-faithfulness check on a single tier regression beyond epsilon", () => {
    const baseline = armFrom(
      [
        tagged("literal", { faithfulness: 0.95, cloudTokens: 1000 }),
        tagged("narrative", { faithfulness: 0.95, cloudTokens: 1000 }),
      ],
      "all-sonnet",
    );
    // overall stays within epsilon (0.9 vs 0.95), but literal tanks
    const candidate = armFrom(
      [
        tagged("literal", { faithfulness: 0.8, localTokens: 100 }),
        tagged("narrative", { faithfulness: 1.0, localTokens: 100 }),
      ],
      "local-escalation",
    );
    const verdict = evaluateGate(baseline, candidate, thresholds);
    const tierCheck = verdict.checks.find((c) => c.id === "tier-faithfulness")!;
    expect(tierCheck.passed).toBe(false);
    expect(tierCheck.detail).toContain("literal");
    expect(verdict.passed).toBe(false);
  });

  it("FAILS the tier-floor check when a candidate tier drops below its gate threshold", () => {
    const baseline = armFrom(
      [tagged("literal", { faithfulness: 0.82, cloudTokens: 1000 })],
      "all-sonnet",
    );
    // within epsilon of baseline, but below the 0.8 literal floor
    const candidate = armFrom(
      [tagged("literal", { faithfulness: 0.78, localTokens: 100 })],
      "local-escalation",
    );
    const verdict = evaluateGate(baseline, candidate, thresholds);
    const floor = verdict.checks.find((c) => c.id === "tier-floor")!;
    expect(floor.passed).toBe(false);
    expect(floor.detail).toContain("literal");
  });

  it("omits the tier-floor check when enforceTierFloor is false", () => {
    const baseline = armFrom(
      [tagged("literal", { faithfulness: 0.82, cloudTokens: 1000 })],
      "all-sonnet",
    );
    const candidate = armFrom(
      [tagged("literal", { faithfulness: 0.78, localTokens: 100 })],
      "local-escalation",
    );
    const verdict = evaluateGate(baseline, candidate, { ...thresholds, enforceTierFloor: false });
    expect(verdict.checks.find((c) => c.id === "tier-floor")).toBeUndefined();
  });

  it("FAILS the escalation-rate check when escalation exceeds the bound", () => {
    const baseline = armFrom(
      [tagged("literal", { faithfulness: 0.9, cloudTokens: 1000 })],
      "all-sonnet",
    );
    const candidate = armFrom(
      [
        tagged("literal", {
          faithfulness: 0.9,
          localTokens: 100,
          cloudTokens: 100,
          escalated: true,
        }),
        tagged("literal", {
          faithfulness: 0.9,
          localTokens: 100,
          cloudTokens: 100,
          escalated: true,
        }),
      ],
      "local-escalation",
    );
    const verdict = evaluateGate(baseline, candidate, { ...thresholds, maxEscalationRate: 0.5 });
    const esc = verdict.checks.find((c) => c.id === "escalation-rate")!;
    expect(esc.passed).toBe(false); // 100% > 50%
    expect(verdict.passed).toBe(false);
  });

  it("FAILS the cost-reduction check when candidate is not cheap enough", () => {
    const baseline = armFrom(
      [tagged("literal", { faithfulness: 0.9, cloudTokens: 1000 })],
      "all-sonnet",
    );
    // candidate uses 900 cloud tokens → only 10% reduction, below the 60% target
    const candidate = armFrom(
      [tagged("literal", { faithfulness: 0.9, cloudTokens: 900 })],
      "local-escalation",
    );
    const verdict = evaluateGate(baseline, candidate, thresholds);
    const cost = verdict.checks.find((c) => c.id === "cost-reduction")!;
    expect(cost.passed).toBe(false);
    expect(verdict.passed).toBe(false);
  });

  it("skips (passes) the cost-reduction check when baseline cost is zero", () => {
    const baseline = armFrom([tagged("literal", { faithfulness: 0.9 })], "all-sonnet");
    const candidate = armFrom([tagged("literal", { faithfulness: 0.9 })], "local-escalation");
    const verdict = evaluateGate(baseline, candidate, thresholds);
    const cost = verdict.checks.find((c) => c.id === "cost-reduction")!;
    expect(cost.passed).toBe(true);
    expect(cost.detail).toContain("skipped");
  });

  it("treats insufficient data (no verified sections) as a PASS, never a false regression", () => {
    const baseline = armFrom([tagged("literal", { faithfulness: null })], "all-sonnet");
    const candidate = armFrom([tagged("literal", { faithfulness: null })], "local-escalation");
    const verdict = evaluateGate(baseline, candidate, thresholds);
    const overall = verdict.checks.find((c) => c.id === "overall-faithfulness")!;
    expect(overall.passed).toBe(true);
    expect(overall.detail).toContain("insufficient data");
  });
});
