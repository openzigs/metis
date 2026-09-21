/**
 * #335 (Epic #331, Phase 4) — Hybrid A/B rollout-gate types.
 *
 * The A/B harness compares TWO docs-gen configurations over the SAME fixture
 * corpus and produces a machine-readable pass/fail verdict that gates the
 * default-flip of #333 (hybrid routing) / #334 (judge-gated escalation):
 *
 *   Arm A — "all-Sonnet" (baseline): every section on the cloud provider
 *           (hybrid routing OFF). This is current production behaviour.
 *   Arm B — "local+escalation" (candidate): literal/reconstruction sections on
 *           the LOCAL provider, narrative on the cloud escalation provider, with
 *           judge-gated escalation re-running a below-threshold local section on
 *           the cloud provider (hybrid routing ON + escalation ON).
 *
 * The reported faithfulness scoring reuses the existing {@link FaithfulnessJudge}
 * substrate (via an injected section evaluator) and the #333/#334 tier +
 * escalation semantics — nothing here re-implements routing/escalation/scoring.
 *
 * These types are intentionally local to the eval lib (NOT in `@metis/shared`):
 * the A/B harness is an operator/CI tool emitting JSON + a table, not a
 * UI-consumed contract, so it needs no shared-package rebuild.
 */
import type { DocWarningTier } from "../../docs-gen/grounding/degraded-warnings.js";

/** Which arm of the A/B comparison a section result belongs to. */
export type EvalArm = "all-sonnet" | "local-escalation";

/**
 * A single fixture corpus item: one document's worth of sections to synthesize.
 * The A/B runner drives the SAME corpus through both arms.
 */
export interface AbCorpusItem {
  /** Stable id for logging / per-item breakdown. */
  id: string;
  /** Human title (used in the report). */
  title: string;
  /** The sections that make up this document. */
  sections: AbCorpusSection[];
}

/** One section of a corpus document, carrying the tier it is gated at. */
export interface AbCorpusSection {
  /** Stable id for logging. */
  id: string;
  /** Human label. */
  label: string;
  /**
   * The faithfulness {@link DocWarningTier} this section is gated at (#333). The
   * gate threshold per tier is resolved from the same constants the synthesizer
   * uses (narrative 0.4 / reconstruction 0.6 / literal 0.8).
   */
  tier: DocWarningTier;
}

/**
 * The outcome of evaluating ONE section on ONE arm. Produced by the injected
 * {@link SectionEvaluator} — in CI this is a deterministic mock; run live by an
 * operator it wraps real provider generation + {@link FaithfulnessJudge} scoring.
 */
export interface SectionEvalOutcome {
  /**
   * The section's faithfulness in [0,1], or `null` when the section was
   * UNVERIFIABLE (offline judge, empty context, no claims) — mirrors
   * {@link SectionGroundingOutcome.score} being null. Unverifiable sections are
   * excluded from the faithfulness aggregates (never counted as a regression).
   */
  faithfulness: number | null;
  /**
   * Whether THIS section escalated to the cloud provider (only ever true on the
   * `local-escalation` arm, when a below-threshold local section was re-run on
   * the escalation provider per #334). Always false on `all-sonnet`.
   */
  escalated: boolean;
  /**
   * A token-count proxy for cost. Local generation is billed as `localTokens`
   * (≈ free), cloud generation as `cloudTokens`. A section that escalated
   * accrues BOTH its local attempt and its cloud re-run.
   */
  localTokens: number;
  cloudTokens: number;
}

/**
 * The injectable seam that produces a {@link SectionEvalOutcome} for one section
 * on one arm. This is the ONLY place real providers/judge are touched, so CI can
 * mock it and operators can wire the real docs-gen synthesis + faithfulness
 * scoring. It is called once per (arm, item, section).
 */
export type SectionEvaluator = (input: {
  arm: EvalArm;
  item: AbCorpusItem;
  section: AbCorpusSection;
}) => Promise<SectionEvalOutcome> | SectionEvalOutcome;

/** Aggregated faithfulness for one tier (or the overall roll-up). */
export interface FaithfulnessAggregate {
  /** Number of VERIFIED sections that contributed to {@link mean}. */
  verifiedCount: number;
  /** Number of sections that were unverifiable (excluded from the mean). */
  unverifiedCount: number;
  /** Mean faithfulness over the verified sections, or `null` when none verified. */
  mean: number | null;
}

/** Per-arm aggregates over the whole corpus. */
export interface ArmAggregate {
  arm: EvalArm;
  /** Total sections evaluated on this arm (verified + unverified). */
  sectionCount: number;
  /** Overall faithfulness aggregate across all tiers. */
  overall: FaithfulnessAggregate;
  /** Per-tier faithfulness aggregates. */
  byTier: Record<DocWarningTier, FaithfulnessAggregate>;
  /**
   * Escalation rate = escalated sections / total sections, in [0,1]. Always 0
   * for the `all-sonnet` arm.
   */
  escalationRate: number;
  /** Token proxies summed over the arm. */
  localTokens: number;
  cloudTokens: number;
  /**
   * Cost proxy: local tokens are treated as free, cloud tokens as billed. This
   * is `cloudTokens * cloudCostPerToken` (see {@link AbThresholds}).
   */
  costProxy: number;
}

/** Configurable pass/fail thresholds for the rollout gate. */
export interface AbThresholds {
  /**
   * Overall faithfulness epsilon: Arm B's overall mean must be within this delta
   * BELOW Arm A's overall mean, i.e. `meanB >= meanA - epsilon`. Default 0.05.
   */
  overallEpsilon: number;
  /**
   * Per-tier epsilon: Arm B's per-tier mean must be within this delta below Arm
   * A's per-tier mean for every tier where BOTH arms produced a verified mean.
   * Default 0.05.
   */
  tierEpsilon: number;
  /**
   * Absolute per-tier floor: Arm B's per-tier mean must not fall below the tier's
   * own gate threshold (narrative 0.4 / reconstruction 0.6 / literal 0.8). This
   * enforces "no section type regressing below its tier threshold" from the epic.
   */
  enforceTierFloor: boolean;
  /**
   * Maximum acceptable escalation rate for Arm B, in [0,1]. A high escalation
   * rate means the local model rarely clears the bar unaided — the hybrid win is
   * illusory. Default 0.5.
   */
  maxEscalationRate: number;
  /**
   * Minimum required cost reduction of Arm B vs Arm A, as a fraction in [0,1].
   * `1 - (costB / costA)` must be >= this. Default 0.6 (≥60% cheaper), matching
   * the epic's example target. Skipped when Arm A's cost proxy is 0.
   */
  minCostReduction: number;
  /** Cost-per-token applied to CLOUD tokens (local tokens are free). Default 1. */
  cloudCostPerToken: number;
}

/** One line of the pass/fail rationale (a single checked criterion). */
export interface GateCheck {
  /** Machine id of the criterion. */
  id:
    | "overall-faithfulness"
    | "tier-faithfulness"
    | "tier-floor"
    | "escalation-rate"
    | "cost-reduction";
  /** Human description of what was checked. */
  label: string;
  passed: boolean;
  /** Human-readable detail (numbers + threshold). */
  detail: string;
}

/** The overall A/B gate verdict. */
export interface AbGateVerdict {
  passed: boolean;
  checks: GateCheck[];
}

/** The full A/B run result — the machine-readable JSON summary. */
export interface AbEvalResult {
  schemaVersion: 1;
  /** ISO timestamps. */
  startedAt: string;
  completedAt: string;
  /** Corpus size (documents / sections). */
  itemCount: number;
  sectionCount: number;
  /** The resolved thresholds this run was gated at. */
  thresholds: AbThresholds;
  arms: {
    /** Arm A — the all-Sonnet baseline. */
    baseline: ArmAggregate;
    /** Arm B — the local+escalation candidate. */
    candidate: ArmAggregate;
  };
  /** Per-tier / overall faithfulness deltas (candidate − baseline). */
  deltas: {
    overall: number | null;
    byTier: Record<DocWarningTier, number | null>;
    /** Cost reduction fraction `1 - costB/costA`, or null when baseline cost 0. */
    costReduction: number | null;
  };
  verdict: AbGateVerdict;
  commit: string | null;
}
