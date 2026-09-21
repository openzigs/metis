/**
 * Epic #856 — Issue #870 — Deduplication helpers for AI-generated test
 * suggestions.
 *
 * Two-tier dedup:
 *   1. Cosine ≥ {@link DUPLICATE_COSINE_THRESHOLD} against any existing
 *      {@link TestCaseDoc} → reject (already covered by a real test).
 *   2. Cosine ≥ {@link DUPLICATE_COSINE_THRESHOLD} against another
 *      *suggestion* in the same batch → keep the higher-confidence one.
 */
import { cosineSimilarity } from "../rag/vector-store.js";

/** Same threshold the indexer's content-hash dedup falls back to. */
export const DUPLICATE_COSINE_THRESHOLD = 0.88;

export interface ExistingCaseVector {
  testCaseDocId: string;
  embedding: number[];
}

export interface SuggestionVector<T = unknown> {
  /** Caller-defined payload — the suggestion itself. */
  suggestion: T;
  embedding: number[];
  confidence: number;
}

/** True when `candidate` matches any existing case above the threshold. */
export function isDuplicateOfExisting(
  candidate: number[],
  existing: readonly ExistingCaseVector[],
  threshold = DUPLICATE_COSINE_THRESHOLD,
): { duplicate: boolean; testCaseDocId?: string; cosine?: number } {
  let best = -1;
  let bestId: string | undefined;
  for (const e of existing) {
    const cos = cosineSimilarity(candidate, e.embedding);
    if (cos > best) {
      best = cos;
      bestId = e.testCaseDocId;
    }
  }
  if (best >= threshold) return { duplicate: true, testCaseDocId: bestId, cosine: best };
  return { duplicate: false, cosine: best === -1 ? undefined : best };
}

/**
 * Collapse duplicate suggestions in the same batch. When two suggestions are
 * within `threshold` cosine of each other, the higher-confidence wins. Tie
 * → first one in the input order.
 */
export function dedupeWithinBatch<T>(
  suggestions: readonly SuggestionVector<T>[],
  threshold = DUPLICATE_COSINE_THRESHOLD,
): SuggestionVector<T>[] {
  const kept: SuggestionVector<T>[] = [];
  for (const s of suggestions) {
    let collided = false;
    for (let i = 0; i < kept.length; i += 1) {
      const cos = cosineSimilarity(s.embedding, kept[i].embedding);
      if (cos >= threshold) {
        collided = true;
        if (s.confidence > kept[i].confidence) kept[i] = s;
        break;
      }
    }
    if (!collided) kept.push(s);
  }
  return kept;
}
