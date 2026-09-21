/**
 * Epic #856 — Issue #857 — Coverage matcher.
 *
 * Pure (no I/O) deterministic matcher that classifies requirement→test-case
 * pairs into COVERED / UNCOVERED / AMBIGUOUS buckets using a hybrid signal
 * (dense cosine + sparse BM25 fused via reciprocal-rank-fusion) with a
 * threshold cascade described in
 * `docs/research/2026-05-27-test-coverage-gap-analysis.md` §6.
 *
 * The matcher consumes pre-embedded inputs so it can be exercised in pure
 * unit tests without an embedder, vector store, or BM25 index dependency.
 * The {@link CoverageService} (#858) is responsible for hydration and
 * persistence — this module knows nothing about Prisma.
 */
import MiniSearch from "minisearch";

import { cosineSimilarity } from "../rag/vector-store.js";
import { reciprocalRankFusion } from "../rag/bm25-index.js";

/** Threshold cascade — tweakable via config but defaults match the research doc. */
export interface MatcherThresholds {
  /** cos≥ → straight COVERED. Default 0.85. */
  coveredCosine: number;
  /** cos≥ AND bm25≥ → COVERED via hybrid. Defaults 0.78 / 0.5. */
  coveredHybridCosine: number;
  coveredHybridBm25: number;
  /** cos< → straight UNCOVERED. Default 0.62. */
  uncoveredCosine: number;
}

export const DEFAULT_THRESHOLDS: MatcherThresholds = {
  coveredCosine: 0.85,
  coveredHybridCosine: 0.78,
  coveredHybridBm25: 0.5,
  uncoveredCosine: 0.62,
};

/** One requirement to be matched against the candidate corpus. */
export interface RequirementInput {
  id: string;
  /** Free-form text used to compute the BM25 query. */
  text: string;
  embedding: number[];
}

/** One test case in the candidate corpus. */
export interface TestCaseInput {
  id: string;
  /** Free-form text used as a BM25 document and stored alongside the score. */
  text: string;
  embedding: number[];
}

export type MatcherStatus = "COVERED" | "UNCOVERED" | "AMBIGUOUS";

/** Per-cell score with the bucket assignment baked in. */
export interface MatcherCell {
  requirementId: string;
  testCaseDocId: string;
  cosine: number;
  bm25: number;
  fused: number;
  /** Populated by the judge phase (#863); the matcher always leaves it null. */
  judgeConfidence: number | null;
  status: MatcherStatus;
}

/** Per-requirement summary used to populate {@link GapItem}. */
export interface RequirementVerdict {
  requirementId: string;
  status: MatcherStatus;
  /** Top-K cells sorted by `fused` desc, capped at {@link MatcherOptions.k}. */
  cells: MatcherCell[];
}

export interface MatcherOptions {
  /** Top-K cases retained per requirement (default 8). */
  k?: number;
  thresholds?: Partial<MatcherThresholds>;
}

export interface MatcherResult {
  /** Per-requirement verdicts in the order they were submitted. */
  verdicts: RequirementVerdict[];
  /** Flat lists for convenience — same cells appear in `verdicts[i].cells`. */
  covered: MatcherCell[];
  uncovered: MatcherCell[];
  ambiguous: MatcherCell[];
  /** `ambiguous.length / candidates.length` — surfaced for budget assertions. */
  ambiguousRatio: number;
}

/** Internal — score one (req, case) pair into a {@link MatcherCell}. */
function scorePair(
  req: RequirementInput,
  tc: TestCaseInput,
  bmScore: number,
  thresholds: MatcherThresholds,
): MatcherCell {
  // `cosineSimilarity` throws on dimension mismatch — bubble that up so the
  // caller learns about the bug rather than silently miscounting.
  const cosine = cosineSimilarity(req.embedding, tc.embedding);
  return {
    requirementId: req.id,
    testCaseDocId: tc.id,
    cosine,
    bm25: bmScore,
    // Fused score is populated downstream by RRF — leave 0 here so the cell
    // shape is stable for callers that only care about cosine/bm25.
    fused: 0,
    judgeConfidence: null,
    status: bucket(cosine, bmScore, thresholds),
  };
}

/** Threshold cascade — see research doc §6.2 for the rationale. */
export function bucket(
  cosine: number,
  bm25: number,
  thresholds: MatcherThresholds = DEFAULT_THRESHOLDS,
): MatcherStatus {
  if (cosine >= thresholds.coveredCosine) return "COVERED";
  if (cosine >= thresholds.coveredHybridCosine && bm25 >= thresholds.coveredHybridBm25) {
    return "COVERED";
  }
  if (cosine < thresholds.uncoveredCosine) return "UNCOVERED";
  return "AMBIGUOUS";
}

/**
 * Aggregate per-cell statuses up to a requirement verdict. Many-to-many
 * semantics: any COVERED cell wins; any AMBIGUOUS cell promotes to AMBIGUOUS
 * unless a COVERED beat it; only when all cells are UNCOVERED does the
 * requirement land in UNCOVERED.
 */
export function aggregateVerdict(cells: readonly MatcherCell[]): MatcherStatus {
  let saw: { covered: boolean; ambiguous: boolean } = { covered: false, ambiguous: false };
  for (const cell of cells) {
    if (cell.status === "COVERED") saw = { ...saw, covered: true };
    if (cell.status === "AMBIGUOUS") saw = { ...saw, ambiguous: true };
  }
  if (saw.covered) return "COVERED";
  if (saw.ambiguous) return "AMBIGUOUS";
  return "UNCOVERED";
}

/**
 * Match requirements against the candidate test-case corpus.
 *
 * The matcher is deterministic given identical inputs — RRF tie-breaking
 * falls back to test-case id sort so repeated runs always produce the same
 * ordering. Suitable for content-hashed caching downstream.
 */
export function matchRequirements(
  requirements: readonly RequirementInput[],
  testCases: readonly TestCaseInput[],
  options: MatcherOptions = {},
): MatcherResult {
  const thresholds: MatcherThresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const k = Math.max(1, options.k ?? 8);

  // Empty corpus: every requirement is uncovered, no cells produced.
  if (testCases.length === 0) {
    return {
      verdicts: requirements.map((r) => ({
        requirementId: r.id,
        status: "UNCOVERED",
        cells: [],
      })),
      covered: [],
      uncovered: [],
      ambiguous: [],
      ambiguousRatio: 0,
    };
  }

  // Build BM25 over the case texts. We instantiate a throwaway MiniSearch
  // index per call so the matcher stays pure — no cross-call state, safe to
  // parallelise, and the heavy KnowledgeChunk-backed `BM25Index` is avoided.
  const bm = new MiniSearch<{ id: string; text: string }>({
    fields: ["text"],
    storeFields: ["id"],
    searchOptions: { combineWith: "OR", boost: { text: 1 }, fuzzy: 0, prefix: true },
  });
  bm.addAll(testCases.map((tc) => ({ id: tc.id, text: tc.text })));

  const verdicts: RequirementVerdict[] = [];
  const covered: MatcherCell[] = [];
  const uncovered: MatcherCell[] = [];
  const ambiguous: MatcherCell[] = [];

  for (const req of requirements) {
    // Dense + sparse rankings over the *whole* corpus first; RRF fuses
    // them before we top-K trim. This keeps the bottom of the candidate
    // pool from being silently dropped by either signal alone.
    const dense = [...testCases]
      .map((tc) => ({ chunkId: tc.id, score: cosineSimilarity(req.embedding, tc.embedding) }))
      // Stable order: score desc, then id asc to make RRF deterministic.
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));

    const sparseHits = bm.search(req.text);
    // Normalise raw MiniSearch BM25 scores into [0,1] via the per-query max
    // so the hybrid threshold (`coveredHybridBm25: 0.5`) is interpretable.
    const sparseMax = sparseHits.reduce((m, h) => Math.max(m, h.score), 0);
    const sparse = sparseHits
      .map((h) => ({ chunkId: h.id as string, score: sparseMax > 0 ? h.score / sparseMax : 0 }))
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));

    const fused = reciprocalRankFusion(
      [dense.map((d) => ({ chunkId: d.chunkId })), sparse.map((s) => ({ chunkId: s.chunkId }))],
      { topK: testCases.length },
    );

    const bmById = new Map(sparse.map((s) => [s.chunkId, s.score]));
    const tcById = new Map(testCases.map((tc) => [tc.id, tc]));
    const fusedById = new Map(fused.map((f) => [f.chunkId, f.score]));

    const cells: MatcherCell[] = dense
      .map((d) => {
        const tc = tcById.get(d.chunkId);
        if (!tc) return null;
        const cell = scorePair(req, tc, bmById.get(d.chunkId) ?? 0, thresholds);
        cell.fused = fusedById.get(d.chunkId) ?? 0;
        return cell;
      })
      .filter((c): c is MatcherCell => c !== null)
      // Final ordering: fused desc, cosine desc, id asc for determinism.
      .sort(
        (a, b) =>
          b.fused - a.fused ||
          b.cosine - a.cosine ||
          a.testCaseDocId.localeCompare(b.testCaseDocId),
      )
      .slice(0, k);

    for (const cell of cells) {
      if (cell.status === "COVERED") covered.push(cell);
      else if (cell.status === "AMBIGUOUS") ambiguous.push(cell);
      else uncovered.push(cell);
    }

    verdicts.push({
      requirementId: req.id,
      status: aggregateVerdict(cells),
      cells,
    });
  }

  const totalCells = covered.length + uncovered.length + ambiguous.length;
  const ambiguousRatio = totalCells === 0 ? 0 : ambiguous.length / totalCells;
  return { verdicts, covered, uncovered, ambiguous, ambiguousRatio };
}
