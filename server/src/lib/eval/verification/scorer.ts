/**
 * Epic #1107 / Issue #1108 — pure scorer for the verification-layer eval.
 *
 * ── WHAT COUNTS AS A POSITIVE ───────────────────────────────────────────────
 *
 * The positive class is **"this finding is NOT supported by the run's evidence,
 * so a reader should be warned about it"**. A verifier "detects" a case when its
 * verdict would down-weight the finding.
 *
 *   verdict            → flagged?  why
 *   `unverified`       → yes       it claimed code evidence; none survived
 *   `could-not-verify` → yes       it claimed an absence nothing can back (#773)
 *   `confirmed`        → no        the verifier asserts the claim is grounded
 *   `null`             → no        NO SIGNAL — no code-evidence claim to verify
 *
 * `null` counting as NOT flagged is the load-bearing convention. It is not a
 * negative verdict, it is an abstention, and the UI renders it badge-free — so
 * from the reader's point of view an unsupported finding labelled `null` is
 * exactly as unprotected as one labelled `confirmed`. Scoring abstention as a
 * detection would credit the verifier for saying nothing. #1114 applies the same
 * rule to the panel's own failures: an unparseable verdict is no signal, never a
 * negative verdict.
 *
 * ── PRECISION AND RECALL ARE REPORTED SEPARATELY, NEVER BLENDED ─────────────
 *
 *   recall    = TP / (TP + FN)   of the findings that DESERVE a warning, how many got one
 *   precision = TP / (TP + FP)   of the findings that GOT a warning, how many deserved it
 *
 * #1108 forbids a single blended score because METIS is recall-first: a lost
 * requirement is invisible, so recall is the metric the product is tuned for —
 * but over-flagging is the failure mode that erodes reviewer trust fastest, so
 * precision cannot be traded away silently. An F1 would let one hide inside the
 * other. {@link overFlagRate} is reported as a third, independent axis: the share
 * of genuinely-supported findings that were down-weighted anyway.
 *
 * Empty-denominator convention (matching the #930 impact-recall scorer, so the
 * two harnesses agree on the boundary): a ratio with a zero denominator is 1.
 * Nothing to detect ⇒ fully detected; nothing flagged ⇒ nothing wrongly flagged.
 * The raw TP/FP/FN/TN counts are always reported alongside, so a vacuous 1.00 is
 * never mistaken for a win.
 */
import type { FindingFaithfulness, FindingVerificationStatus } from "@metis/shared";
import {
  meanFaithfulness,
  unverifiableMetric,
  type FaithfulnessAggregate,
  type FaithfulnessMetric,
} from "../../grounding/faithfulness-metric.js";
import type { VerificationCase } from "./corpus.js";

/** The four confusion-matrix outcomes for one case. */
export type CaseOutcome =
  /** Unsupported and flagged — the verifier protected the reader. */
  | "TP"
  /** Supported but flagged — an over-flag; erodes trust. */
  | "FP"
  /** Unsupported and NOT flagged — the dangerous miss. */
  | "FN"
  /** Supported and not flagged — correctly left alone. */
  | "TN";

/**
 * Does this verdict down-weight the finding? `null` (no signal) does not — see
 * the module doc for why abstention must not be scored as detection.
 */
export function isFlagged(status: FindingVerificationStatus | null): boolean {
  return status === "unverified" || status === "could-not-verify";
}

/** Classify one case's outcome from the ground-truth label and the verdict. */
export function outcomeFor(
  expectedSupported: boolean,
  status: FindingVerificationStatus | null,
): CaseOutcome {
  const flagged = isFlagged(status);
  if (!expectedSupported) return flagged ? "TP" : "FN";
  return flagged ? "FP" : "TN";
}

/** One scored case — enough detail to inspect the disagreement without re-running. */
export interface CaseScore {
  id: string;
  hardCase: VerificationCase["hardCase"];
  title: string;
  /** Ground truth: does the run's evidence back the claim? */
  expectedSupported: boolean;
  /** The arm's verdict (`null` = no signal). */
  status: FindingVerificationStatus | null;
  flagged: boolean;
  outcome: CaseOutcome;
  /**
   * Epic #1316 (#1318) — the arm's claim-level faithfulness for this case.
   * `undefined` ⇒ this arm does not compute the metric; `null` or a metric with
   * `score: null` ⇒ it tried and could not verify.
   */
  faithfulness?: FindingFaithfulness | null;
}

/** Confusion counts plus the three independent quality axes. */
export interface VerificationAggregate {
  caseCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** TP / (TP + FN) — of the findings that deserve a warning, how many got one. */
  recall: number;
  /** TP / (TP + FP) — of the findings that got a warning, how many deserved it. */
  precision: number;
  /**
   * FP / (FP + TN) — of the genuinely-SUPPORTED findings, how many were
   * down-weighted anyway. Reported as its own axis because "over-flagging is the
   * failure mode that erodes trust fastest" (#1108) and precision alone hides it
   * when the corpus is unbalanced.
   */
  overFlagRate: number;
  /**
   * Share of cases the arm ABSTAINED on (`null`). Not a quality metric — a
   * diagnostic. A high abstention rate with high precision means the arm is
   * mostly declining to judge, which is a very different result from judging well.
   */
  abstentionRate: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/** Score one case against its label. Pure. */
export function scoreCase(
  c: Pick<VerificationCase, "id" | "hardCase" | "title" | "expected">,
  status: FindingVerificationStatus | null,
  faithfulness?: FindingFaithfulness | null,
): CaseScore {
  return {
    id: c.id,
    hardCase: c.hardCase,
    title: c.title,
    expectedSupported: c.expected.supported,
    status,
    flagged: isFlagged(status),
    outcome: outcomeFor(c.expected.supported, status),
    // Spread so an arm that does not compute the metric produces a CaseScore
    // byte-identical to its pre-#1318 shape — no `"faithfulness": null` key in
    // the JSON artifact, so before/after report diffs stay clean.
    ...(faithfulness === undefined ? {} : { faithfulness }),
  };
}

/**
 * Epic #1316 (#1318) — fold the per-case metrics into one aggregate, or `null`
 * when this arm does not compute the metric at all.
 *
 * The `null`-exclusion rule lives in exactly ONE place — the shared
 * {@link meanFaithfulness} — so the eval harness, the analysis pipeline and the
 * `RagasJudge` seam cannot drift into three different definitions of "mean
 * faithfulness". A case the arm tried and could not verify is EXCLUDED from the
 * denominator, never counted as a pass.
 */
export function aggregateFaithfulness(scores: CaseScore[]): FaithfulnessAggregate | null {
  const computed = scores.filter((s) => s.faithfulness !== undefined);
  if (computed.length === 0) return null;
  const metrics: FaithfulnessMetric[] = computed.map((s) => {
    const f = s.faithfulness;
    if (!f) return unverifiableMetric("no-evidence");
    return {
      faithfulness: f.score,
      totalClaims: f.totalClaims,
      supportedClaims: f.supportedClaims,
      ...(f.unverifiableReason ? { unverifiableReason: f.unverifiableReason } : {}),
    };
  });
  return meanFaithfulness(metrics);
}

/** Fold per-case scores into the confusion matrix + the three quality axes. Pure. */
export function aggregateCaseScores(scores: CaseScore[]): VerificationAggregate {
  const count = (o: CaseOutcome): number => scores.filter((s) => s.outcome === o).length;
  const tp = count("TP");
  const fp = count("FP");
  const fn = count("FN");
  const tn = count("TN");
  const abstained = scores.filter((s) => s.status === null).length;
  return {
    caseCount: scores.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    recall: ratio(tp, tp + fn),
    precision: ratio(tp, tp + fp),
    overFlagRate: fp + tn === 0 ? 0 : fp / (fp + tn),
    abstentionRate: scores.length === 0 ? 0 : abstained / scores.length,
  };
}

/**
 * Per-hard-case recall/precision, so the four cases #1108 names are individually
 * inspectable in aggregate as well as case by case. Keyed by hard-case kind.
 */
export function aggregateByHardCase(
  scores: CaseScore[],
): Record<string, VerificationAggregate & { kind: string }> {
  const out: Record<string, VerificationAggregate & { kind: string }> = {};
  for (const kind of new Set(scores.map((s) => s.hardCase))) {
    const subset = scores.filter((s) => s.hardCase === kind);
    out[kind] = { kind, ...aggregateCaseScores(subset) };
  }
  return out;
}
