/**
 * Epic #726 / Issue #738 — pure precision/recall/F1 scorer for the
 * requirement→code mapping eval.
 *
 * Given a set of PREDICTED files (the mapping's affected-code list) and the set
 * of files the replayed PR ACTUALLY changed (ground truth), compute file-level
 * precision, recall, and F1. These are side-effect-free set operations so the
 * unit test and the offline eval CLI share exactly one definition of "how good
 * was the mapping".
 *
 *   precision = |predicted ∩ actual| / |predicted|   ("of what we flagged, how much was right")
 *   recall    = |predicted ∩ actual| / |actual|      ("of what really changed, how much we found")
 *   f1        = harmonic mean of precision and recall
 *
 * Convention for empty sets (documented so the boundary is unambiguous):
 *   - actual is never empty in a real case (a PR changed ≥1 file); an empty
 *     `actual` yields recall = 1 (nothing to find ⇒ fully recalled) and, when
 *     `predicted` is also empty, precision = 1.
 *   - predicted empty ⇒ precision = 1 when actual is also empty, else 0 (we
 *     flagged nothing, so nothing wrong was flagged, but nothing was found).
 * F1 is 0 whenever precision + recall = 0.
 */

/** Per-case file-level score. */
export interface CaseScore {
  /** The case / replayed-PR id. */
  id: string;
  /** Deduped predicted files (the mapping's retrieved set). */
  predicted: string[];
  /** Deduped actual changed files (the ground-truth relevant set). */
  actual: string[];
  /** Files in both sets. */
  truePositives: string[];
  /** Predicted files that did not actually change. */
  falsePositives: string[];
  /** Actually-changed files the mapping missed. */
  falseNegatives: string[];
  precision: number;
  recall: number;
  f1: number;
  /** True when at least one actually-changed file was predicted (top-k hit). */
  hit: boolean;
}

/** Aggregate scores across every case. */
export interface AggregateScore {
  caseCount: number;
  /** Mean of the per-case precision/recall/F1 (each case weighted equally). */
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  /** Pooled precision/recall/F1 over all TP/FP/FN (each file weighted equally). */
  microPrecision: number;
  microRecall: number;
  microF1: number;
  /** Fraction of cases with ≥1 true positive. */
  hitRate: number;
}

function harmonicMean(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/** Score one case's predicted files against its actual changed files. */
export function scoreCase(id: string, predictedFiles: string[], actualFiles: string[]): CaseScore {
  const predicted = [...new Set(predictedFiles)];
  const actual = [...new Set(actualFiles)];
  const actualSet = new Set(actual);
  const predictedSet = new Set(predicted);

  const truePositives = predicted.filter((f) => actualSet.has(f));
  const falsePositives = predicted.filter((f) => !actualSet.has(f));
  const falseNegatives = actual.filter((f) => !predictedSet.has(f));

  const precision = ratio(truePositives.length, predicted.length);
  const recall = ratio(truePositives.length, actual.length);

  return {
    id,
    predicted,
    actual,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1: harmonicMean(precision, recall),
    hit: truePositives.length > 0,
  };
}

/**
 * Aggregate per-case scores into macro (per-case mean) and micro (pooled by
 * file) precision/recall/F1, plus the hit rate. Returns a zeroed aggregate for
 * an empty case list.
 */
export function aggregateScores(scores: CaseScore[]): AggregateScore {
  if (scores.length === 0) {
    return {
      caseCount: 0,
      macroPrecision: 0,
      macroRecall: 0,
      macroF1: 0,
      microPrecision: 0,
      microRecall: 0,
      microF1: 0,
      hitRate: 0,
    };
  }

  const n = scores.length;
  const mean = (pick: (s: CaseScore) => number): number =>
    scores.reduce((sum, s) => sum + pick(s), 0) / n;

  const totalTp = scores.reduce((sum, s) => sum + s.truePositives.length, 0);
  const totalFp = scores.reduce((sum, s) => sum + s.falsePositives.length, 0);
  const totalFn = scores.reduce((sum, s) => sum + s.falseNegatives.length, 0);

  const microPrecision = ratio(totalTp, totalTp + totalFp);
  const microRecall = ratio(totalTp, totalTp + totalFn);

  return {
    caseCount: n,
    macroPrecision: mean((s) => s.precision),
    macroRecall: mean((s) => s.recall),
    macroF1: mean((s) => s.f1),
    microPrecision,
    microRecall,
    microF1: harmonicMean(microPrecision, microRecall),
    hitRate: scores.filter((s) => s.hit).length / n,
  };
}
