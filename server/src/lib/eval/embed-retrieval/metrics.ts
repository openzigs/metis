/**
 * Epic #780 / Issue #788 — pure ranking metrics for the NL-requirement → code
 * retrieval eval.
 *
 * The thing being measured is METIS's ACTUAL retrieval use case: an analyst
 * writes a natural-language requirement ("soft-throttle a workflow that exceeds
 * its cost cap") and `search_code_symbols` must surface the symbol that
 * implements it. Everything here is side-effect free set/rank arithmetic so the
 * CI unit tests and the (weights-downloading) CLI share exactly one definition
 * of "how good was the retrieval".
 *
 * Metrics (binary relevance — a symbol is either the requirement's implementer
 * or it is not):
 *
 *   recall@k — fraction of the query's relevant symbols found in the top k.
 *              "Did we surface the code at all?" — the metric that actually
 *              matters when the ranked list is fed to an LLM as context.
 *   MRR      — 1 / rank of the FIRST relevant symbol (0 if none). Sensitive to
 *              whether the right answer is #1 vs #9.
 *   nDCG@k   — discounted cumulative gain over binary gains, normalised by the
 *              ideal ordering. The headline metric (it is also what the CoIR
 *              numbers in the epic are reported in, so directions are
 *              comparable, though the absolute values are NOT).
 *
 * Determinism: ranking ties are broken by ascending document id, so two arms
 * that produce identical scores produce identical rankings and the eval never
 * flickers between runs.
 */

/** Cut-offs reported for every arm. */
export const EVAL_KS = [1, 5, 10] as const;
export type EvalK = (typeof EVAL_KS)[number];

/** A scored document in a ranked list. */
export interface ScoredDoc {
  id: string;
  score: number;
}

/** Per-query score for one arm/channel. */
export interface QueryScore {
  queryId: string;
  /** Ranked document ids, best first (truncated to the eval's max cut-off). */
  ranked: string[];
  /** The hand-authored relevant symbol ids for this query. */
  relevant: string[];
  /** 1-based rank of the first relevant hit, or null when none was retrieved. */
  firstRelevantRank: number | null;
  recallAtK: Record<number, number>;
  reciprocalRank: number;
  ndcgAtK: Record<number, number>;
}

/** Aggregate (macro-averaged) scores across every query in a channel. */
export interface ChannelMetrics {
  queryCount: number;
  recallAtK: Record<number, number>;
  mrr: number;
  ndcgAtK: Record<number, number>;
  /** Fraction of queries with ≥1 relevant symbol anywhere in the top-10. */
  hitRateAt10: number;
}

/**
 * Cosine similarity of two equal-length vectors. Throws on a length mismatch —
 * silently comparing a 384-d vector against a 768-d one is exactly the class of
 * bug this eval exists to catch, so it must be loud.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Rank documents against a query vector by cosine similarity, descending.
 * Ties break by ascending id so the ranking is total and reproducible.
 */
export function rankByCosine(
  queryVector: readonly number[],
  docs: ReadonlyArray<{ id: string; vector: readonly number[] }>,
): ScoredDoc[] {
  return docs
    .map((d) => ({ id: d.id, score: cosine(queryVector, d.vector) }))
    .sort((x, y) => (y.score === x.score ? (x.id < y.id ? -1 : 1) : y.score - x.score));
}

/**
 * Fraction of the relevant set present in the top `k` of the ranked list.
 *
 * A query with an EMPTY relevant set throws. It used to return 1.0 — a perfect
 * score for a question with no right answer — which is unreachable today (the
 * corpus loader rejects a query with no relevant symbols) but is exactly the
 * shape of bug this file exists to catch: an eval that flatters itself when its
 * input is malformed. A silent 1.0 would drag a channel's mean UP, so a corpus
 * bug would look like a retrieval win.
 */
export function recallAtK(
  ranked: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (relevant.length === 0) {
    throw new Error("recallAtK: empty relevant set — a query with no right answer is a corpus bug");
  }
  const top = new Set(ranked.slice(0, k));
  const found = relevant.filter((id) => top.has(id)).length;
  return found / relevant.length;
}

/** 1 / (1-based rank of the first relevant document); 0 when none is ranked. */
export function reciprocalRank(ranked: readonly string[], relevant: readonly string[]): number {
  const rel = new Set(relevant);
  const idx = ranked.findIndex((id) => rel.has(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/**
 * nDCG@k with binary gains. DCG = Σ 1/log2(rank+1) over relevant hits in the
 * top k; IDCG is the same sum for the ideal ordering (every relevant document
 * packed at the top, capped at k).
 *
 * Throws on an empty relevant set, for the same reason {@link recallAtK} does: a
 * perfect score for a query with no right answer is silent flattery, and this is
 * the last file in the repo that should contain any.
 */
export function ndcgAtK(ranked: readonly string[], relevant: readonly string[], k: number): number {
  if (relevant.length === 0) {
    throw new Error("ndcgAtK: empty relevant set — a query with no right answer is a corpus bug");
  }
  const rel = new Set(relevant);
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    if (rel.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(relevant.length, k); i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Score one query's ranked list against its relevant set at every cut-off. */
export function scoreQuery(
  queryId: string,
  ranked: readonly string[],
  relevant: readonly string[],
  ks: readonly number[] = EVAL_KS,
): QueryScore {
  const rel = new Set(relevant);
  const firstIdx = ranked.findIndex((id) => rel.has(id));
  const maxK = Math.max(...ks);
  const recall: Record<number, number> = {};
  const ndcg: Record<number, number> = {};
  for (const k of ks) {
    recall[k] = recallAtK(ranked, relevant, k);
    ndcg[k] = ndcgAtK(ranked, relevant, k);
  }
  return {
    queryId,
    ranked: ranked.slice(0, maxK),
    relevant: [...relevant],
    firstRelevantRank: firstIdx === -1 ? null : firstIdx + 1,
    recallAtK: recall,
    reciprocalRank: reciprocalRank(ranked, relevant),
    ndcgAtK: ndcg,
  };
}

/**
 * Epic #1156 / Issue #1157 — one stratum's slice of a channel.
 *
 * The aggregate hides exactly the thing the epic is trying to change. Sub-issue
 * #1159 improves lexical matching on snake_case names; if snake_case queries are a
 * fifth of the corpus, a large win there moves the aggregate by a fifth of itself
 * and reads as noise. So the strata are reported as their own rows, with their own
 * `queryCount` — a stratum's number is only as trustworthy as its denominator, and
 * hiding that denominator is how a 4-query "stratum" gets quoted as a result.
 */
export interface StratumMetrics {
  /** Stratum dimension, e.g. `naming`. */
  key: string;
  /** Stratum value within that dimension, e.g. `snake`. */
  value: string;
  queryCount: number;
  ndcgAt10: number;
  mrr: number;
  /** The per-query nDCG@10 values, so a caller can put a CI around this row. */
  perQueryNdcgAt10: number[];
}

/** A query's stratum assignment: dimension → value. Queries with none are skipped. */
export type StrataByQueryId = ReadonlyMap<string, Readonly<Record<string, string>>>;

/**
 * Slice per-query scores by every declared stratum dimension.
 *
 * Rows come out sorted by `key` then `value` so a committed results file does not
 * churn on Map iteration order. A query whose id is absent from `strata`
 * contributes to NO row — it is not silently bucketed, because a query that
 * declares no stratum is not evidence about any stratum.
 */
export function aggregateByStratum(
  scores: readonly QueryScore[],
  strata: StrataByQueryId,
): StratumMetrics[] {
  const buckets = new Map<string, { key: string; value: string; scores: QueryScore[] }>();
  for (const score of scores) {
    const assignment = strata.get(score.queryId);
    if (!assignment) continue;
    for (const [key, value] of Object.entries(assignment)) {
      // NUL separates the dimension from the value so two different pairs
      // cannot collapse onto one bucket key. Written as an ESCAPE, never as a
      // literal byte: a literal NUL makes git treat the file as binary and
      // Semgrep skip it (scripts/lib/check-no-nul.mjs).
      const id = `${key}\u0000${value}`;
      const bucket = buckets.get(id) ?? { key, value, scores: [] };
      bucket.scores.push(score);
      buckets.set(id, bucket);
    }
  }

  return [...buckets.values()]
    .map(({ key, value, scores: bucketScores }) => {
      const agg = aggregate(bucketScores);
      return {
        key,
        value,
        queryCount: bucketScores.length,
        ndcgAt10: agg.ndcgAtK[10] ?? 0,
        mrr: agg.mrr,
        perQueryNdcgAt10: bucketScores.map((s) => s.ndcgAtK[10] ?? 0),
      };
    })
    .sort((a, b) =>
      a.key === b.key ? a.value.localeCompare(b.value) : a.key.localeCompare(b.key),
    );
}

/** Macro-average per-query scores into one channel's aggregate. */
export function aggregate(
  scores: readonly QueryScore[],
  ks: readonly number[] = EVAL_KS,
): ChannelMetrics {
  const n = scores.length;
  const empty: ChannelMetrics = {
    queryCount: 0,
    recallAtK: Object.fromEntries(ks.map((k) => [k, 0])),
    mrr: 0,
    ndcgAtK: Object.fromEntries(ks.map((k) => [k, 0])),
    hitRateAt10: 0,
  };
  if (n === 0) return empty;

  const mean = (pick: (s: QueryScore) => number): number =>
    scores.reduce((sum, s) => sum + pick(s), 0) / n;

  return {
    queryCount: n,
    recallAtK: Object.fromEntries(ks.map((k) => [k, mean((s) => s.recallAtK[k] ?? 0)])),
    mrr: mean((s) => s.reciprocalRank),
    ndcgAtK: Object.fromEntries(ks.map((k) => [k, mean((s) => s.ndcgAtK[k] ?? 0)])),
    hitRateAt10: mean((s) => (s.firstRelevantRank !== null && s.firstRelevantRank <= 10 ? 1 : 0)),
  };
}
