/**
 * #335 — pure aggregation + gate math for the hybrid A/B rollout gate.
 *
 * Everything here is a pure function of {@link SectionEvalOutcome} arrays and
 * thresholds — no providers, no IO — so it is exhaustively unit-testable.
 */
import {
  DEFAULT_FAITHFULNESS_THRESHOLD,
  NARRATIVE_FAITHFULNESS_THRESHOLD,
  RECONSTRUCTION_FAITHFULNESS_THRESHOLD,
  type DocWarningTier,
} from "../../docs-gen/grounding/degraded-warnings.js";
import type {
  AbGateVerdict,
  AbThresholds,
  ArmAggregate,
  EvalArm,
  FaithfulnessAggregate,
  GateCheck,
  SectionEvalOutcome,
} from "./types.js";

/** All tiers, in a stable order for reporting. */
export const TIERS: readonly DocWarningTier[] = ["literal", "reconstruction", "narrative"];

/**
 * The absolute gate threshold ("floor") for a tier — the SAME constants the
 * synthesizer gates sections at (#283), reused so the A/B floor can never drift
 * from the production gate.
 */
export function tierFloor(tier: DocWarningTier): number {
  switch (tier) {
    case "narrative":
      return NARRATIVE_FAITHFULNESS_THRESHOLD;
    case "reconstruction":
      return RECONSTRUCTION_FAITHFULNESS_THRESHOLD;
    case "literal":
      return DEFAULT_FAITHFULNESS_THRESHOLD;
  }
}

/** Documented default thresholds. See {@link AbThresholds} for the rationale. */
export const DEFAULT_AB_THRESHOLDS: AbThresholds = {
  overallEpsilon: 0.05,
  tierEpsilon: 0.05,
  enforceTierFloor: true,
  maxEscalationRate: 0.5,
  minCostReduction: 0.6,
  cloudCostPerToken: 1,
};

/** Merge partial thresholds over the documented defaults. */
export function resolveThresholds(partial?: Partial<AbThresholds>): AbThresholds {
  return { ...DEFAULT_AB_THRESHOLDS, ...(partial ?? {}) };
}

/**
 * Aggregate faithfulness over a set of outcomes. Unverifiable sections
 * (`faithfulness === null`) are EXCLUDED from the mean — they are neither a pass
 * nor a regression — but counted in {@link FaithfulnessAggregate.unverifiedCount}.
 */
export function aggregateFaithfulness(outcomes: SectionEvalOutcome[]): FaithfulnessAggregate {
  let sum = 0;
  let verifiedCount = 0;
  let unverifiedCount = 0;
  for (const o of outcomes) {
    if (o.faithfulness == null) {
      unverifiedCount += 1;
      continue;
    }
    sum += o.faithfulness;
    verifiedCount += 1;
  }
  return {
    verifiedCount,
    unverifiedCount,
    mean: verifiedCount === 0 ? null : sum / verifiedCount,
  };
}

/** The section outcomes for one arm, tagged with the tier of each section. */
export interface TaggedOutcome {
  tier: DocWarningTier;
  outcome: SectionEvalOutcome;
}

/**
 * Roll one arm's tagged section outcomes up into an {@link ArmAggregate}:
 * overall + per-tier faithfulness, escalation rate, token proxies, cost proxy.
 */
export function aggregateArm(
  arm: EvalArm,
  tagged: TaggedOutcome[],
  cloudCostPerToken: number,
): ArmAggregate {
  const all = tagged.map((t) => t.outcome);
  const overall = aggregateFaithfulness(all);

  const byTier = {} as Record<DocWarningTier, FaithfulnessAggregate>;
  for (const tier of TIERS) {
    byTier[tier] = aggregateFaithfulness(
      tagged.filter((t) => t.tier === tier).map((t) => t.outcome),
    );
  }

  const sectionCount = all.length;
  const escalatedCount = all.filter((o) => o.escalated).length;
  const escalationRate = sectionCount === 0 ? 0 : escalatedCount / sectionCount;
  const localTokens = all.reduce((s, o) => s + o.localTokens, 0);
  const cloudTokens = all.reduce((s, o) => s + o.cloudTokens, 0);

  return {
    arm,
    sectionCount,
    overall,
    byTier,
    escalationRate,
    localTokens,
    cloudTokens,
    costProxy: cloudTokens * cloudCostPerToken,
  };
}

/** Compute candidate − baseline for a pair of aggregates (null if either null). */
function meanDelta(
  baseline: FaithfulnessAggregate,
  candidate: FaithfulnessAggregate,
): number | null {
  if (baseline.mean == null || candidate.mean == null) return null;
  return candidate.mean - baseline.mean;
}

/** Per-tier + overall faithfulness deltas and the cost-reduction fraction. */
export function computeDeltas(
  baseline: ArmAggregate,
  candidate: ArmAggregate,
): {
  overall: number | null;
  byTier: Record<DocWarningTier, number | null>;
  costReduction: number | null;
} {
  const byTier = {} as Record<DocWarningTier, number | null>;
  for (const tier of TIERS) {
    byTier[tier] = meanDelta(baseline.byTier[tier], candidate.byTier[tier]);
  }
  const costReduction =
    baseline.costProxy === 0 ? null : 1 - candidate.costProxy / baseline.costProxy;
  return {
    overall: meanDelta(baseline.overall, candidate.overall),
    byTier,
    costReduction,
  };
}

function pct(n: number | null): string {
  return n == null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

function signedPct(n: number | null): string {
  if (n == null) return "n/a";
  const s = (n * 100).toFixed(1);
  return n >= 0 ? `+${s}%` : `${s}%`;
}

/**
 * Evaluate the rollout gate. Arm B (candidate) PASSES iff ALL of:
 *   1. overall faithfulness within `overallEpsilon` below Arm A;
 *   2. every tier (where both arms have a verified mean) within `tierEpsilon`
 *      below Arm A's tier mean;
 *   3. (when `enforceTierFloor`) no candidate tier mean below the tier's floor;
 *   4. candidate escalation rate <= `maxEscalationRate`;
 *   5. cost reduction >= `minCostReduction` (skipped when baseline cost is 0).
 *
 * Each criterion becomes a {@link GateCheck} line so the report explains WHY the
 * gate passed or failed. A criterion with insufficient data (e.g. no verified
 * sections for a tier) is treated as PASSED — the gate never fails on missing
 * evidence, only on measured regression.
 */
export function evaluateGate(
  baseline: ArmAggregate,
  candidate: ArmAggregate,
  thresholds: AbThresholds,
): AbGateVerdict {
  const checks: GateCheck[] = [];

  // 1. Overall faithfulness within epsilon.
  {
    const b = baseline.overall.mean;
    const c = candidate.overall.mean;
    let passed = true;
    let detail = "insufficient data (no verified sections)";
    if (b != null && c != null) {
      passed = c >= b - thresholds.overallEpsilon;
      detail = `candidate ${pct(c)} vs baseline ${pct(b)} (Δ ${signedPct(c - b)}), epsilon ${pct(thresholds.overallEpsilon)}`;
    }
    checks.push({
      id: "overall-faithfulness",
      label: "Overall faithfulness within epsilon of baseline",
      passed,
      detail,
    });
  }

  // 2. Per-tier faithfulness within epsilon (only tiers with both means).
  {
    const failing: string[] = [];
    for (const tier of TIERS) {
      const b = baseline.byTier[tier].mean;
      const c = candidate.byTier[tier].mean;
      if (b == null || c == null) continue;
      if (c < b - thresholds.tierEpsilon) {
        failing.push(`${tier} ${pct(c)}<${pct(b - thresholds.tierEpsilon)}`);
      }
    }
    checks.push({
      id: "tier-faithfulness",
      label: "Per-tier faithfulness within epsilon of baseline",
      passed: failing.length === 0,
      detail:
        failing.length === 0
          ? `all tiers within ${pct(thresholds.tierEpsilon)} epsilon`
          : `regressed: ${failing.join(", ")}`,
    });
  }

  // 3. Per-tier floor.
  if (thresholds.enforceTierFloor) {
    const below: string[] = [];
    for (const tier of TIERS) {
      const c = candidate.byTier[tier].mean;
      if (c == null) continue;
      const floor = tierFloor(tier);
      if (c < floor) below.push(`${tier} ${pct(c)}<${pct(floor)}`);
    }
    checks.push({
      id: "tier-floor",
      label: "No candidate tier below its gate threshold",
      passed: below.length === 0,
      detail: below.length === 0 ? "all tiers >= their floor" : `below floor: ${below.join(", ")}`,
    });
  }

  // 4. Escalation rate.
  {
    const passed = candidate.escalationRate <= thresholds.maxEscalationRate;
    checks.push({
      id: "escalation-rate",
      label: "Candidate escalation rate within bound",
      passed,
      detail: `escalation ${pct(candidate.escalationRate)}, max ${pct(thresholds.maxEscalationRate)}`,
    });
  }

  // 5. Cost reduction.
  {
    let passed = true;
    let detail = "baseline cost is 0 — cost-reduction check skipped";
    if (baseline.costProxy !== 0) {
      const reduction = 1 - candidate.costProxy / baseline.costProxy;
      passed = reduction >= thresholds.minCostReduction;
      detail = `reduction ${signedPct(reduction)} (candidate ${candidate.costProxy} vs baseline ${baseline.costProxy}), min ${pct(thresholds.minCostReduction)}`;
    }
    checks.push({
      id: "cost-reduction",
      label: "Cost reduction meets target",
      passed,
      detail,
    });
  }

  return { passed: checks.every((c) => c.passed), checks };
}
