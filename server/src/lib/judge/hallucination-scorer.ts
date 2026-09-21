/**
 * Epic #194 (C.3) — Judge-LLM v2 hallucination scorer.
 *
 * Given an LLM output and a list of source RAG chunks, returns a grounding
 * score ∈ [0,1]. Two signals are blended:
 *
 *   1. **Citation overlap** — fraction of n-grams from the output that appear
 *      verbatim in the source chunks. Cheap, deterministic, and catches the
 *      common case where the model cites real text.
 *   2. **Entailment** — optional async judge call that asks the configured
 *      judge LLM whether the source supports each declarative claim. The
 *      judge is injected so callers can wire it to the project's existing
 *      judge provider (no new provider keys per the AC).
 *
 * The hallucination score is `1 - groundingScore` (so high means hallucinated).
 *
 * Used by:
 *   - Best-of-N selection — penalises ungrounded candidates.
 *   - security-eval judge — flags fabricated tool outputs.
 *   - PR-reviewer agent — confirms cited line numbers exist in the diff.
 */

export interface JudgeLike {
  /**
   * Returns a 0–1 entailment score for the given claim against the source.
   * Implementations should fail closed (return 0) on any error.
   */
  entail(input: { claim: string; source: string }): Promise<number>;
}

export interface ScoreGroundingInput {
  output: string;
  sources: string[];
  judge?: JudgeLike;
  /** N-gram size for citation overlap (default 4). */
  ngramSize?: number;
  /** Cap claims sent to the judge to bound cost (default 8). */
  maxClaims?: number;
}

export interface GroundingScore {
  /** 0..1 — higher is more grounded. */
  groundingScore: number;
  /** 0..1 — higher is more hallucinated (= 1 - groundingScore). */
  hallucinationScore: number;
  /** Citation-overlap component. */
  citationOverlap: number;
  /** Entailment component (1 when no judge supplied). */
  entailmentScore: number;
  /** Per-claim entailment breakdown for debugging. */
  claims: { claim: string; entailment: number }[];
}

const DEFAULT_NGRAM = 4;
const DEFAULT_MAX_CLAIMS = 8;

export async function scoreGrounding(input: ScoreGroundingInput): Promise<GroundingScore> {
  const ngramSize = input.ngramSize ?? DEFAULT_NGRAM;
  const maxClaims = input.maxClaims ?? DEFAULT_MAX_CLAIMS;
  const citationOverlap = computeCitationOverlap(input.output, input.sources, ngramSize);
  const claims = extractClaims(input.output).slice(0, maxClaims);
  let entailmentScore = 1;
  const claimResults: { claim: string; entailment: number }[] = [];
  if (input.judge && claims.length > 0) {
    const joinedSource = input.sources.join("\n---\n");
    let total = 0;
    for (const claim of claims) {
      let score = 0;
      try {
        score = clamp01(await input.judge.entail({ claim, source: joinedSource }));
      } catch {
        score = 0;
      }
      claimResults.push({ claim, entailment: score });
      total += score;
    }
    entailmentScore = total / claims.length;
  } else {
    for (const claim of claims) claimResults.push({ claim, entailment: 1 });
  }
  // Blend signals 50/50. Empty-output edge case: fully grounded vacuously.
  const groundingScore = clamp01(0.5 * citationOverlap + 0.5 * entailmentScore);
  return {
    groundingScore,
    hallucinationScore: clamp01(1 - groundingScore),
    citationOverlap,
    entailmentScore,
    claims: claimResults,
  };
}

/**
 * Citation overlap = |out_ngrams ∩ src_ngrams| / |out_ngrams|.
 * Returns 1 when the output has no n-grams (e.g. very short output).
 */
export function computeCitationOverlap(
  output: string,
  sources: string[],
  ngramSize: number,
): number {
  const outTokens = tokenize(output);
  if (outTokens.length < ngramSize) return 1;
  const outGrams = ngrams(outTokens, ngramSize);
  if (outGrams.size === 0) return 1;
  const srcGrams = new Set<string>();
  for (const src of sources) {
    for (const g of ngrams(tokenize(src), ngramSize)) srcGrams.add(g);
  }
  let matched = 0;
  for (const g of outGrams) {
    if (srcGrams.has(g)) matched += 1;
  }
  return matched / outGrams.size;
}

/**
 * Lightweight claim extractor: split on sentence boundaries, drop questions,
 * imperatives, and very short fragments. Production callers can swap in a
 * smarter extractor by passing pre-extracted claims (future work).
 */
export function extractClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .filter((s) => !s.endsWith("?"))
    .filter((s) => !/^(please|let|do|don't|note|hint)\b/i.test(s));
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  if (tokens.length < n) return out;
  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
