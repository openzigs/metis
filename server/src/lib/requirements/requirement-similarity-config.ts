/**
 * Issue #1836 (epic #1828) — the similarity thresholds #1837 labels with,
 * calibrated on METIS-shaped labelled requirement pairs, never copied from a
 * published constant.
 *
 * Run: `pnpm --filter @metis/server eval:req-similarity`, 2026-11-05, model
 * `Alibaba-NLP/gte-modernbert-base` (the default embedder, q8, CLS pooling), over
 * `src/lib/eval/requirement-similarity/__fixtures__/pairs.json`: 124 pairs in 4
 * invented domains (32 duplicate, 24 overlap, 36 related of which 36 are hard
 * negatives, 32 unrelated). Full table on issue #1836.
 *
 *   duplicate (0.80-0.98)           best at recall >= 0.6: 0.80, precision 0.476, recall 0.625
 *                                   (best precision at ANY threshold: 0.500)
 *   duplicate or overlap (0.80-0.98) no threshold keeps recall >= 0.6 (best precision 0.643)
 *   duplicate or overlap (0.50-0.98) 0.78, precision 0.661, recall 0.661
 *   similar at all (0.50-0.98)       0.65, precision 1.000, recall 0.989 at recall >= 0.9
 *
 * What it means: the embedder ranks candidates well (every unrelated pair scores
 * below 0.65, every similar one but one above it) and is a poor final judge.
 * Related-but-different requirements ("Export invoices to CSV" / "to PDF") score
 * as high as true duplicates: 15 of 36 hard negatives score at or above 0.80.
 * Precision for "duplicate" never reaches 0.8, so per #1836 a `duplicate` label
 * from the threshold alone is a CANDIDATE an analyst must confirm (#1838), and
 * the optional LLM verifier (#1837, `REQ_SIMILARITY_VERIFIER`) is the arm to
 * measure next.
 */
import type { SimilarRequirementLabel } from "@metis/shared";

export interface RequirementSimilarityThresholds {
  /** The embedder the numbers were measured on; another model needs its own run. */
  model: string;
  /** Cosine at or above which a candidate is labelled `duplicate`. */
  duplicate: number;
  /** Cosine at or above which a candidate is labelled `overlap` (below `duplicate`). */
  overlap: number;
  /** Cosine below which a candidate is not shown at all; above it and below `overlap`: `related`. */
  related: number;
  /** Precision of the `duplicate` label at that threshold on the labelled set. */
  duplicatePrecision: number;
  /**
   * True when `duplicatePrecision` < 0.8: a `duplicate` label is a suggestion an
   * analyst confirms, never an automatic action.
   */
  analystConfirmRequired: boolean;
}

export const REQUIREMENT_SIMILARITY_THRESHOLDS: RequirementSimilarityThresholds = {
  model: "Alibaba-NLP/gte-modernbert-base",
  duplicate: 0.8,
  overlap: 0.78,
  related: 0.65,
  duplicatePrecision: 0.476,
  analystConfirmRequired: true,
};

/** The label a cosine earns, or `null` below the `related` floor (not similar at all). */
export function labelForScore(
  score: number,
  t: RequirementSimilarityThresholds = REQUIREMENT_SIMILARITY_THRESHOLDS,
): SimilarRequirementLabel | null {
  if (score >= t.duplicate) return "duplicate";
  if (score >= t.overlap) return "overlap";
  if (score >= t.related) return "related";
  return null;
}
