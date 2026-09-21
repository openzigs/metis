/**
 * Epic #803 (Epic 09) — Domain Eval scorer.
 *
 * Pure functions kept apart from the runner so they unit-test in isolation:
 *   - {@link rougeL}            ROUGE-L F1 over description text (LCS based).
 *   - {@link tokenSetSimilarity} Jaccard over title token sets (alignment key).
 *   - {@link matchRequirements} greedy expected↔predicted alignment.
 *   - {@link precisionRecallF1} TP/FP/FN → P/R/F1.
 *   - {@link calibrationBins}   confidence-vs-correctness 10-bin histogram.
 *   - {@link scoreItem}         per-corpus-item rollup.
 */
import type {
  DomainCalibrationBin,
  DomainItemResult,
  DomainMatch,
  DomainRequirement,
  DomainDocType,
} from "@metis/shared";

/** Minimum title token-set similarity for a predicted req to count as a TP. */
export const MATCH_THRESHOLD = 0.4;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

/** Jaccard similarity over the unique token sets of two strings ∈ [0,1]. */
export function tokenSetSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect += 1;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/** Length of the longest common subsequence of two token arrays. */
export function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Rolling two-row DP to keep memory at O(min(n,m)).
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[b.length];
}

/**
 * ROUGE-L F1 between a reference and a candidate string. Returns 1 when both
 * are empty and 0 when exactly one is empty. Uses the standard precision =
 * LCS/len(candidate), recall = LCS/len(reference), F1 harmonic mean.
 */
export function rougeL(reference: string, candidate: string): number {
  const ref = tokenize(reference);
  const cand = tokenize(candidate);
  if (ref.length === 0 && cand.length === 0) return 1;
  if (ref.length === 0 || cand.length === 0) return 0;
  const lcs = lcsLength(ref, cand);
  if (lcs === 0) return 0;
  const precision = lcs / cand.length;
  const recall = lcs / ref.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export interface MatchOutcome {
  matches: DomainMatch[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

/**
 * Alignment score for a candidate expected↔predicted pair. A BA requirement is
 * carried by both its short title and its substantive description, so we align
 * on the stronger lexical signal of the two: `max(titleSim, descriptionSim)`.
 * This tolerates a curated terse golden title (e.g. "Accurate proration")
 * matching a verbose extracted statement when their descriptions agree, and
 * vice-versa.
 */
export function alignmentScore(expected: DomainRequirement, predicted: DomainRequirement): number {
  const titleSim = tokenSetSimilarity(expected.title, predicted.title);
  const descSim = tokenSetSimilarity(expected.description, predicted.description);
  return Math.max(titleSim, descSim);
}

/**
 * Greedily align predicted requirements to expected ones. Candidate pairs are
 * ranked by {@link alignmentScore}; the highest-scoring unused pair at or above
 * {@link MATCH_THRESHOLD} is locked in until no pair qualifies. Leftover
 * predictions are false positives; leftover expectations are false negatives.
 */
export function matchRequirements(
  expected: DomainRequirement[],
  predicted: DomainRequirement[],
  threshold = MATCH_THRESHOLD,
): MatchOutcome {
  const pairs: { e: number; p: number; score: number }[] = [];
  for (let e = 0; e < expected.length; e += 1) {
    for (let p = 0; p < predicted.length; p += 1) {
      const score = alignmentScore(expected[e], predicted[p]);
      if (score >= threshold) pairs.push({ e, p, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  const usedE = new Set<number>();
  const usedP = new Set<number>();
  const matches: DomainMatch[] = [];
  for (const { e, p } of pairs) {
    if (usedE.has(e) || usedP.has(p)) continue;
    usedE.add(e);
    usedP.add(p);
    matches.push({
      expectedId: expected[e].id,
      predictedId: predicted[p].id,
      titleSimilarity: tokenSetSimilarity(expected[e].title, predicted[p].title),
      rougeL: rougeL(expected[e].description, predicted[p].description),
      confidence: predicted[p].confidence ?? null,
    });
  }
  // Unmatched expected → false negatives.
  for (let e = 0; e < expected.length; e += 1) {
    if (usedE.has(e)) continue;
    matches.push({
      expectedId: expected[e].id,
      predictedId: null,
      titleSimilarity: 0,
      rougeL: 0,
      confidence: null,
    });
  }
  // Unmatched predicted → false positives.
  for (let p = 0; p < predicted.length; p += 1) {
    if (usedP.has(p)) continue;
    matches.push({
      expectedId: null,
      predictedId: predicted[p].id,
      titleSimilarity: 0,
      rougeL: 0,
      confidence: predicted[p].confidence ?? null,
    });
  }
  return {
    matches,
    truePositives: usedE.size,
    falsePositives: predicted.length - usedP.size,
    falseNegatives: expected.length - usedE.size,
  };
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

export function precisionRecallF1(tp: number, fp: number, fn: number): Prf {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export interface PredictionOutcome {
  confidence: number;
  /** True when the prediction was matched to an expected requirement (a TP). */
  correct: boolean;
}

/**
 * Bucket predictions into ten confidence bins (0.0–0.1 … 0.9–1.0) and report
 * mean confidence vs observed accuracy so the UI can render a reliability
 * (calibration) plot. Predictions without a confidence are skipped.
 */
export function calibrationBins(predictions: PredictionOutcome[]): DomainCalibrationBin[] {
  const bins: DomainCalibrationBin[] = [];
  for (let i = 0; i < 10; i += 1) {
    const lowerBound = i / 10;
    const upperBound = (i + 1) / 10;
    const inBin = predictions.filter((pr) => {
      if (i === 9) return pr.confidence >= lowerBound && pr.confidence <= upperBound;
      return pr.confidence >= lowerBound && pr.confidence < upperBound;
    });
    const count = inBin.length;
    const meanConfidence = count === 0 ? 0 : inBin.reduce((s, pr) => s + pr.confidence, 0) / count;
    const accuracy = count === 0 ? 0 : inBin.filter((pr) => pr.correct).length / count;
    bins.push({
      bucket: `${lowerBound.toFixed(1)}-${upperBound.toFixed(1)}`,
      lowerBound,
      upperBound,
      count,
      meanConfidence,
      accuracy,
    });
  }
  return bins;
}

export interface ScoreItemInput {
  itemId: string;
  docType: DomainDocType;
  title: string;
  expected: DomainRequirement[];
  predicted: DomainRequirement[];
  threshold?: number;
}

export function scoreItem(input: ScoreItemInput): DomainItemResult {
  const outcome = matchRequirements(input.expected, input.predicted, input.threshold);
  const { precision, recall, f1 } = precisionRecallF1(
    outcome.truePositives,
    outcome.falsePositives,
    outcome.falseNegatives,
  );
  const tpMatches = outcome.matches.filter((m) => m.expectedId && m.predictedId);
  const meanRougeL =
    tpMatches.length === 0 ? 0 : tpMatches.reduce((s, m) => s + m.rougeL, 0) / tpMatches.length;
  return {
    itemId: input.itemId,
    docType: input.docType,
    title: input.title,
    truePositives: outcome.truePositives,
    falsePositives: outcome.falsePositives,
    falseNegatives: outcome.falseNegatives,
    precision,
    recall,
    f1,
    meanRougeL,
    matches: outcome.matches,
    expected: input.expected,
    predicted: input.predicted,
  };
}
