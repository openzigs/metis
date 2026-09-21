/**
 * Epic #780 / Issue #788 — the BAR, and the machine-readable verdict computed
 * against it.
 *
 * ## The bar was fixed BEFORE any arm was run
 *
 * #788 is the hard gate on the default-model flip (#783). A gate whose bar is
 * chosen after seeing the numbers is theatre, so the thresholds below are the
 * ones committed up front, and the corpus was frozen before the first run.
 *
 * Headline metric: **vector-channel nDCG@10** — the vector channel is the ONLY
 * thing the flip changes, and measuring it in isolation is what stops a strong
 * BM25 half from masking a broken embedder.
 *
 * ### Decision gates (all must hold for GO)
 *  - `candidate-beats-incumbent` — candidate vector nDCG@10 ≥ incumbent + 0.05.
 *    A smaller delta on a 30-query corpus is not distinguishable from noise, and
 *    a re-index of every project is not worth a coin-flip.
 *  - `no-recall-regression` — candidate vector recall@5 ≥ incumbent recall@5.
 *    Ranking gains that lose documents entirely are not gains.
 *  - `hybrid-not-worse` — candidate hybrid nDCG@10 ≥ incumbent hybrid nDCG@10.
 *    Hybrid is what a user actually experiences; the flip must not make it worse.
 *
 * ### Validity checks (the eval must be capable of FAILING)
 *  - `discriminates-noise` — incumbent vector nDCG@10 ≥ hash-floor + 0.10. If a
 *    chance-level hash embedder scores like a real one, the corpus/metric cannot
 *    see semantics at all and NOTHING it says means anything.
 *  - `detects-wrong-pooling` — candidate (correct CLS pooling) vector nDCG@10 ≥
 *    wrong-pooling arm + 0.02. #782 measured cosine(cls, mean) = 0.856 on
 *    gte-modernbert: wrong-pooled vectors are unit-norm, finite and entirely
 *    plausible. If this eval cannot tell them apart, it cannot detect the epic's
 *    single biggest risk (silent semantic degradation) and the gate is worthless.
 *
 * A failed validity check yields `INVALID`, NOT `NO-GO` and NEVER `GO`: an eval
 * that cannot fail cannot pass either.
 *
 * ### Secondary question (fp32 vs q8 — deferred to this issue by #782)
 *  - `q8-within-tolerance` — |candidate q8 − candidate fp32| ≤ 0.02 vector
 *    nDCG@10. Reported when the fp32 arm was run; it does not gate the flip.
 */
import type { ChannelMetrics } from "./metrics.js";
import type { ArmRunResult } from "./runner.js";

/** The role an arm plays in the decision. */
export type ArmRole = "incumbent" | "candidate" | "wrong-pooling" | "candidate-fp32" | "hash-floor";

/** Thresholds, fixed before the first run. */
export const VERDICT_BAR = {
  /** Minimum vector nDCG@10 the candidate must add over the incumbent. */
  candidateNdcgGain: 0.05,
  /** Minimum vector nDCG@10 a real embedder must add over chance-level hash. */
  noiseDiscriminationGain: 0.1,
  /** Minimum vector nDCG@10 correct pooling must add over wrong pooling. */
  poolingDetectionGain: 0.02,
  /** Max |q8 − fp32| vector nDCG@10 for q8 to be considered equivalent. */
  q8Tolerance: 0.02,
} as const;

export interface VerdictCheck {
  id: string;
  kind: "gate" | "validity" | "informational";
  description: string;
  value: number | null;
  bar: number | null;
  passed: boolean | null;
}

export type VerdictOutcome = "GO" | "NO-GO" | "INVALID";

export interface Verdict {
  outcome: VerdictOutcome;
  headlineMetric: "vector.ndcgAt10";
  checks: VerdictCheck[];
  summary: string;
}

const NDCG10 = (m: ChannelMetrics): number => m.ndcgAtK[10] ?? 0;
const RECALL5 = (m: ChannelMetrics): number => m.recallAtK[5] ?? 0;

/** Round to 4 dp so JSON artifacts don't carry float noise. */
export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Compute the verdict from the arms that were actually run. Pure. Missing
 * optional arms (`candidate-fp32`) degrade to an informational `null` check;
 * missing REQUIRED arms (incumbent, candidate, wrong-pooling, hash-floor) make
 * the run INVALID — a gate cannot pass on arms it never ran.
 */
export function computeVerdict(arms: Partial<Record<ArmRole, ArmRunResult>>): Verdict {
  const required: ArmRole[] = ["incumbent", "candidate", "wrong-pooling", "hash-floor"];
  const missing = required.filter((r) => !arms[r]);
  if (missing.length > 0) {
    return {
      outcome: "INVALID",
      headlineMetric: "vector.ndcgAt10",
      checks: [
        {
          id: "arms-present",
          kind: "validity",
          description: `Required arms missing: ${missing.join(", ")}`,
          value: null,
          bar: null,
          passed: false,
        },
      ],
      summary: `INVALID — required arms not run: ${missing.join(", ")}`,
    };
  }

  const incumbent = arms.incumbent as ArmRunResult;
  const candidate = arms.candidate as ArmRunResult;
  const wrongPooling = arms["wrong-pooling"] as ArmRunResult;
  const hash = arms["hash-floor"] as ArmRunResult;
  const fp32 = arms["candidate-fp32"];

  const noiseGain = NDCG10(incumbent.channels.vector) - NDCG10(hash.channels.vector);
  const poolingGain = NDCG10(candidate.channels.vector) - NDCG10(wrongPooling.channels.vector);
  const candidateGain = NDCG10(candidate.channels.vector) - NDCG10(incumbent.channels.vector);
  const recallDelta = RECALL5(candidate.channels.vector) - RECALL5(incumbent.channels.vector);
  const hybridDelta = NDCG10(candidate.channels.hybrid) - NDCG10(incumbent.channels.hybrid);
  const q8Delta = fp32 ? NDCG10(candidate.channels.vector) - NDCG10(fp32.channels.vector) : null;

  const checks: VerdictCheck[] = [
    {
      id: "discriminates-noise",
      kind: "validity",
      description:
        "The eval can tell a real embedder from a chance-level hash embedder " +
        "(incumbent vector nDCG@10 − hash floor)",
      value: round4(noiseGain),
      bar: VERDICT_BAR.noiseDiscriminationGain,
      passed: noiseGain >= VERDICT_BAR.noiseDiscriminationGain,
    },
    {
      id: "detects-wrong-pooling",
      kind: "validity",
      description:
        "The eval can tell correct (CLS) pooling from silently-wrong (mean) pooling " +
        "on the candidate model (candidate − wrong-pooling vector nDCG@10)",
      value: round4(poolingGain),
      bar: VERDICT_BAR.poolingDetectionGain,
      passed: poolingGain >= VERDICT_BAR.poolingDetectionGain,
    },
    {
      id: "candidate-beats-incumbent",
      kind: "gate",
      description: "Candidate vector nDCG@10 gain over the incumbent default model",
      value: round4(candidateGain),
      bar: VERDICT_BAR.candidateNdcgGain,
      passed: candidateGain >= VERDICT_BAR.candidateNdcgGain,
    },
    {
      id: "no-recall-regression",
      kind: "gate",
      description: "Candidate vector recall@5 does not regress against the incumbent",
      value: round4(recallDelta),
      bar: 0,
      passed: recallDelta >= 0,
    },
    {
      id: "hybrid-not-worse",
      kind: "gate",
      description: "Candidate hybrid (BM25+vector, production fusion) nDCG@10 does not regress",
      value: round4(hybridDelta),
      bar: 0,
      passed: hybridDelta >= 0,
    },
    {
      id: "q8-within-tolerance",
      kind: "informational",
      description:
        "q8 quantization is within tolerance of fp32 on the candidate (|q8 − fp32| vector nDCG@10)",
      value: q8Delta === null ? null : round4(Math.abs(q8Delta)),
      bar: VERDICT_BAR.q8Tolerance,
      passed: q8Delta === null ? null : Math.abs(q8Delta) <= VERDICT_BAR.q8Tolerance,
    },
  ];

  const validityFailed = checks.some((c) => c.kind === "validity" && c.passed === false);
  const gatesPassed = checks.filter((c) => c.kind === "gate").every((c) => c.passed === true);

  const outcome: VerdictOutcome = validityFailed ? "INVALID" : gatesPassed ? "GO" : "NO-GO";

  const summary = validityFailed
    ? "INVALID — a validity check failed. The eval cannot distinguish what it must " +
      "distinguish, so neither GO nor NO-GO can be concluded from it. Strengthen the eval."
    : gatesPassed
      ? `GO — candidate beats the incumbent by ${round4(candidateGain)} vector nDCG@10 ` +
        `(bar ${VERDICT_BAR.candidateNdcgGain}) with no recall or hybrid regression.`
      : `NO-GO — candidate does not clear the bar (vector nDCG@10 delta ${round4(candidateGain)}, ` +
        `bar +${VERDICT_BAR.candidateNdcgGain}). #783 must not ship on this evidence.`;

  return { outcome, headlineMetric: "vector.ndcgAt10", checks, summary };
}
