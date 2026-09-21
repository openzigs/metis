/**
 * Epic #780 / Issue #788 — paired significance tests over the per-query scores.
 *
 * The verdict gates on a DIFFERENCE OF MEANS across 30 queries. A mean delta with
 * no interval around it cannot answer the only question that matters for a gate
 * that small: "could this have come out the other way?" So every headline
 * comparison also reports a paired bootstrap CI and an exact sign test.
 *
 * Both tests are PAIRED — the arms are scored on the SAME queries, so the unit of
 * resampling is the query, and each resample carries both arms' scores together.
 * Comparing two independent unpaired samples would throw away exactly the
 * correlation (some requirements are simply harder than others) that makes a
 * 30-query corpus usable at all.
 *
 * - **Paired bootstrap CI** — resample the 30 per-query DELTAS with replacement
 *   `B` times, take the percentile interval of the resampled means. Non-parametric:
 *   nDCG deltas are bounded, skewed and lumpy at 0, so a t-interval's normality
 *   assumption is not one this data earns.
 * - **Exact sign test** — two-sided binomial on the queries where the arms differ
 *   at all (ties are dropped, per convention). It assumes nothing about the size
 *   of the differences, only their direction, so it is the conservative check: if
 *   the bootstrap and the sign test disagree, believe the sign test.
 *
 * Determinism: the bootstrap uses a seeded PRNG (mulberry32), so the CI in a
 * committed artifact is reproducible byte-for-byte. An eval whose numbers move
 * between runs cannot be a gate.
 *
 * Reading the output: a CI that EXCLUDES zero means the direction is real. A CI
 * that excludes zero but straddles the decision bar means the direction is real
 * and the MAGNITUDE is not established — which is a materially different thing to
 * say, and the report says it.
 */

import type { ArmRunResult } from "./runner.js";
import type { ArmRole } from "./verdict.js";

/** One paired comparison between two arms on one metric. */
export interface PairedComparison {
  /** Human-readable label, e.g. "B-candidate vs A-incumbent". */
  label: string;
  /** Arm ids being compared (a − b). */
  armA: string;
  armB: string;
  /** Queries contributing to the comparison (paired, so identical for both arms). */
  n: number;
  /** Mean of the per-query deltas (armA − armB). */
  meanDelta: number;
  /** Percentile bootstrap CI of the mean delta. */
  ciLow: number;
  ciHigh: number;
  /** Confidence level, e.g. 0.95. */
  confidence: number;
  /** Bootstrap resample count. */
  resamples: number;
  /** Queries where armA scored strictly higher / lower / the same. */
  wins: number;
  losses: number;
  ties: number;
  /** Two-sided exact sign-test p-value over the non-tied queries. */
  signTestP: number;
}

/** Deterministic PRNG — a committed CI must be reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Binomial coefficient (exact for the small n this eval uses). */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result = (result * (n - k + i)) / i;
  }
  return result;
}

/**
 * Two-sided exact sign test. `wins`/`losses` are the counts of strictly-positive
 * and strictly-negative differences; ties are excluded (standard practice — a tie
 * carries no directional information).
 *
 * p = 2 · P(X ≤ min(wins, losses)) under X ~ Binomial(wins + losses, 0.5), capped
 * at 1. With no non-tied observations there is no evidence of anything, so p = 1.
 */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const smaller = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= smaller; i += 1) {
    tail += choose(n, i);
  }
  const p = 2 * (tail / 2 ** n);
  return Math.min(1, p);
}

/**
 * Percentile bootstrap CI for the mean of a paired delta vector.
 * Returns `[low, high]`. An empty sample yields `[0, 0]` (nothing to infer).
 */
export function bootstrapMeanCi(
  deltas: readonly number[],
  opts: { resamples?: number; confidence?: number; seed?: number } = {},
): [number, number] {
  const { resamples = 20000, confidence = 0.95, seed = 20260713 } = opts;
  const n = deltas.length;
  if (n === 0) return [0, 0];

  const rand = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += deltas[Math.floor(rand() * n)];
    }
    means[b] = sum / n;
  }
  means.sort();

  const alpha = (1 - confidence) / 2;
  const lowIdx = Math.floor(alpha * (resamples - 1));
  const highIdx = Math.ceil((1 - alpha) * (resamples - 1));
  return [means[lowIdx], means[highIdx]];
}

/**
 * Epic #1156 / Issue #1157 — the UNPAIRED bootstrap CI on an aggregate.
 *
 * Everything above this line compares two arms. This compares an arm to nothing:
 * it puts an interval around the single headline number a results file reports,
 * which no committed artifact carried before #1157. Without it a reader cannot
 * tell whether 0.474 means "0.474" or "somewhere near 0.47, give or take a tenth",
 * and every ±0.02–0.06 claim the epic goes on to make is unreadable.
 *
 * Note it answers a DIFFERENT question from {@link compareArms}, and the two must
 * not be confused: this is the precision of one absolute score; that is the
 * precision of a DIFFERENCE, which is narrower whenever the arms agree on a query
 * (and a surgical change leaves most queries untouched). A sub-issue is decided on
 * the paired interval; the corpus is described by this one.
 */
export interface MeanWithCi {
  mean: number;
  ciLow: number;
  ciHigh: number;
  /** `(ciHigh − ciLow) / 2` — the "± this much" a reader actually wants. */
  halfWidth: number;
  /** Sample standard deviation of the per-query values (n−1). */
  sd: number;
  n: number;
  confidence: number;
  resamples: number;
  /**
   * Fraction of per-query values that are EXACTLY zero.
   *
   * Carried because it is the tell for a FLOOR EFFECT, which makes an interval
   * look precise when it is only compressed. The BM25-only channel on
   * `embedretrieval-02` scores 0.000 on 88 of 127 queries; sd collapses to 0.156
   * and the half-width reads ±0.027, comfortably inside #1157's ±0.03 bar — while
   * the same corpus scored with real vectors would have roughly twice that spread.
   * Reporting "bar met" off a floored sample is the same class of error as
   * reporting a point estimate with no interval at all, pointed the other way.
   */
  zeroFraction: number;
}

/** #1157 requires ≥1000 resamples; 20000 is what {@link bootstrapMeanCi} already used. */
export const DEFAULT_RESAMPLES = 20000;

/**
 * Percentile bootstrap CI around the MEAN of a per-query metric.
 *
 * A single value yields a zero-width interval, which is honest rather than
 * flattering: one observation carries no information about its own spread, and the
 * `n` travels with the result so a reader can see that. An empty sample yields
 * zeros for the same reason.
 */
export function bootstrapMean(
  values: readonly number[],
  opts: { resamples?: number; confidence?: number; seed?: number } = {},
): MeanWithCi {
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const confidence = opts.confidence ?? 0.95;
  const n = values.length;
  if (n === 0) {
    return {
      mean: 0,
      ciLow: 0,
      ciHigh: 0,
      halfWidth: 0,
      sd: 0,
      n: 0,
      confidence,
      resamples,
      zeroFraction: 0,
    };
  }
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const [ciLow, ciHigh] = bootstrapMeanCi(values, { ...opts, resamples, confidence });
  return {
    mean,
    ciLow,
    ciHigh,
    halfWidth: (ciHigh - ciLow) / 2,
    sd,
    n,
    confidence,
    resamples,
    zeroFraction: values.filter((v) => v === 0).length / n,
  };
}

/**
 * The query count a corpus would need for a given CI half-width, at the spread
 * this sample actually showed: `n ≈ (z·sd / target)²`.
 *
 * This exists so "the interval is too wide" can be reported as a NUMBER OF QUERIES
 * rather than as a complaint. #1157's acceptance bar is a half-width ≤ 0.03, and
 * whether 90 queries reach it is an empirical question this answers directly.
 *
 * It is a NORMAL approximation (`z·sd/√n`) while the interval itself is a
 * percentile bootstrap, so treat it as a sizing estimate rather than a guarantee —
 * it is reported next to the measured half-width precisely so the two can be
 * compared. Returns `null` when the sample has no usable spread (n < 2, sd = 0).
 */
export const Z_95 = 1.959963984540054;

export function queriesNeededForHalfWidth(
  stats: MeanWithCi,
  targetHalfWidth: number,
): number | null {
  if (targetHalfWidth <= 0 || stats.n < 2 || stats.sd === 0) return null;
  return Math.ceil(((Z_95 * stats.sd) / targetHalfWidth) ** 2);
}

/** Per-query score of one arm, keyed by query id. */
export type ScoresByQuery = ReadonlyMap<string, number>;

/**
 * Compare two arms on one metric, paired by query id.
 *
 * Only queries present in BOTH arms contribute — an arm that failed to score a
 * query must not silently borrow the other's value. Throws when the arms share no
 * queries at all, because a comparison over nothing is not a comparison.
 */
export function compareArms(
  label: string,
  armA: string,
  armB: string,
  scoresA: ScoresByQuery,
  scoresB: ScoresByQuery,
  opts: { resamples?: number; confidence?: number; seed?: number } = {},
): PairedComparison {
  const deltas: number[] = [];
  let wins = 0;
  let losses = 0;
  let ties = 0;

  for (const [queryId, a] of scoresA) {
    const b = scoresB.get(queryId);
    if (b === undefined) continue;
    const delta = a - b;
    deltas.push(delta);
    if (delta > 0) wins += 1;
    else if (delta < 0) losses += 1;
    else ties += 1;
  }

  if (deltas.length === 0) {
    throw new Error(`compareArms(${label}): arms "${armA}" and "${armB}" share no queries`);
  }

  const meanDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const [ciLow, ciHigh] = bootstrapMeanCi(deltas, opts);

  return {
    label,
    armA,
    armB,
    n: deltas.length,
    meanDelta,
    ciLow,
    ciHigh,
    confidence: opts.confidence ?? 0.95,
    resamples: opts.resamples ?? 20000,
    wins,
    losses,
    ties,
    signTestP: signTest(wins, losses),
  };
}

/** Per-query vector nDCG@10 for one arm, keyed by query id. */
function vectorNdcg10ByQuery(arm: ArmRunResult): ScoresByQuery {
  return new Map(arm.vectorQueries.map((q) => [q.queryId, q.ndcgAtK[10] ?? 0]));
}

/**
 * The paired comparisons the verdict's headline checks rest on, computed on the
 * SAME per-query vector nDCG@10 values the verdict means-averages.
 *
 * These do not gate anything — the bar was pre-registered on mean deltas and is
 * not being moved after the fact. They exist so a reader can see whether each
 * pre-registered delta is distinguishable from zero on 30 queries, which the mean
 * alone cannot tell them. Comparisons whose arms were not run are omitted.
 */
export function computeSignificance(
  arms: Partial<Record<ArmRole, ArmRunResult>>,
  opts: { resamples?: number; confidence?: number; seed?: number } = {},
): PairedComparison[] {
  const pairs: Array<{ label: string; a: ArmRole; b: ArmRole }> = [
    { label: "candidate beats incumbent (the gate)", a: "candidate", b: "incumbent" },
    { label: "detects wrong pooling (validity)", a: "candidate", b: "wrong-pooling" },
    { label: "discriminates noise (validity)", a: "incumbent", b: "hash-floor" },
    { label: "q8 vs fp32 (informational)", a: "candidate", b: "candidate-fp32" },
  ];

  const out: PairedComparison[] = [];
  for (const { label, a, b } of pairs) {
    const armA = arms[a];
    const armB = arms[b];
    if (!armA || !armB) continue;
    out.push(
      compareArms(
        label,
        armA.armId,
        armB.armId,
        vectorNdcg10ByQuery(armA),
        vectorNdcg10ByQuery(armB),
        opts,
      ),
    );
  }
  return out;
}
