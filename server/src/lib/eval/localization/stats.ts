/**
 * #1753 — paired statistics for comparing an arm with A0 on the SAME items.
 *
 *   - Hit/miss at k: the exact (binomial) McNemar test on the discordant pairs.
 *   - Continuous metrics (Recall@k, edit precision, reciprocal rank): a paired
 *     bootstrap over items, with a 95% percentile interval for the mean
 *     difference and a two-sided bootstrap p-value.
 *
 * The bootstrap is SEEDED, so a report reproduces byte for byte. And the size of
 * gap the sample can see is stated with every comparison
 * ({@link minimumDetectableGap}). One corpus is small: at 25 items a difference
 * needs roughly 20 to 28 points, at 15 roughly 26 to 36. The held-out corpora
 * are therefore also compared POOLED ({@link stratifiedPairedBootstrap}), where
 * 40 items bring the bar down to roughly 16 to 22 points (#1770). Anything
 * smaller is reported as "no measurable difference", never as a win.
 */

/** Two-sided exact McNemar p-value for `b` and `c` discordant pairs. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // P(X ≤ k) for X ~ Binomial(n, 1/2), summed in log space so n in the
  // hundreds does not overflow.
  let logC = 0; // log C(n, 0)
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

/** A seeded PRNG in [0, 1): mulberry32. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface BootstrapOptions {
  iterations?: number;
  seed?: number;
  /** 0.05 ⇒ a 95% interval. */
  alpha?: number;
}

export interface PairedDifference {
  /** mean(arm) − mean(baseline) over the paired items. */
  meanDifference: number;
  ci: [number, number];
  /** Two-sided bootstrap p-value for "no difference". */
  p: number;
  n: number;
}

/**
 * Paired bootstrap of `mean(arm − baseline)`. The two arrays are the SAME items
 * in the same order; they must be the same length.
 */
export function pairedBootstrap(
  baseline: readonly number[],
  arm: readonly number[],
  opts: BootstrapOptions = {},
): PairedDifference {
  return stratifiedPairedBootstrap([{ baseline, arm }], opts);
}

/** One stratum of a pooled comparison: the same items, in the same order, under both arms. */
export interface PairedStratum {
  baseline: readonly number[];
  arm: readonly number[];
}

/**
 * #1770 — paired bootstrap of `mean(arm − baseline)` over items POOLED from
 * several strata (corpora), resampling WITHIN each stratum so every replicate
 * keeps each corpus's share of the items. The mean weights every item equally.
 * With one stratum it is exactly {@link pairedBootstrap}, draw for draw.
 */
export function stratifiedPairedBootstrap(
  strata: readonly PairedStratum[],
  opts: BootstrapOptions = {},
): PairedDifference {
  const diffs = strata.map((s, i) => {
    if (s.baseline.length !== s.arm.length) {
      throw new Error(
        `paired bootstrap needs equal lengths (${s.baseline.length} vs ${s.arm.length}` +
          `${strata.length > 1 ? ` in stratum ${i}` : ""})`,
      );
    }
    return s.arm.map((v, j) => v - s.baseline[j]!);
  });
  const n = diffs.reduce((sum, d) => sum + d.length, 0);
  if (n === 0) return { meanDifference: 0, ci: [0, 0], p: 1, n };
  const meanDifference = diffs.flat().reduce((a, b) => a + b, 0) / n;
  const iterations = opts.iterations ?? 10_000;
  const alpha = opts.alpha ?? 0.05;
  const rand = seededRandom(opts.seed ?? 1753);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (const d of diffs) {
      const m = d.length;
      for (let j = 0; j < m; j++) sum += d[Math.floor(rand() * m)]!;
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const atOrBelow = means.filter((m) => m <= 0).length / iterations;
  const atOrAbove = means.filter((m) => m >= 0).length / iterations;
  return {
    meanDifference,
    ci: [quantile(means, alpha / 2), quantile(means, 1 - alpha / 2)],
    p: Math.min(1, 2 * Math.min(atOrBelow, atOrAbove)),
    n,
  };
}

/** A bootstrap interval for one arm's mean (not a comparison). */
export function bootstrapMeanCi(
  values: readonly number[],
  opts: BootstrapOptions = {},
): [number, number] {
  const zeros = values.map(() => 0);
  return pairedBootstrap(zeros, values, opts).ci;
}

/** How large a gap the sample can resolve, at a hit rate of `p`. */
export interface DetectableGap {
  n: number;
  /** Standard error of one arm's rate, √(p(1−p)/n). */
  sePerArm: number;
  /** 2 × SE: the low end of the gap a test will call significant. */
  gapLow: number;
  /** 1.96 × √2 × SE: the gap two independent arms need at α = 0.05. */
  gapHigh: number;
}

export function minimumDetectableGap(n: number, p = 0.5): DetectableGap {
  const sePerArm = n > 0 ? Math.sqrt((p * (1 - p)) / n) : 1;
  return { n, sePerArm, gapLow: 2 * sePerArm, gapHigh: 1.96 * Math.SQRT2 * sePerArm };
}

/** The sentence every report carries. */
export function minimumDetectableGapStatement(n: number): string {
  const g = minimumDetectableGap(n);
  const pts = (x: number) => Math.round(x * 100);
  return (
    `At ${n} items and a hit rate near 0.5 the standard error is about ` +
    `${(g.sePerArm * 100).toFixed(1)} points per arm, so a gap needs roughly ` +
    `${pts(g.gapLow)} to ${pts(g.gapHigh)} points to be significant. A smaller ` +
    `difference is reported as "no measurable difference", not as a win.`
  );
}

export type ComparisonVerdict = "better" | "worse" | "no measurable difference";

/** Read a paired difference: significant only when p < α and the CI excludes 0. */
export function readDifference(d: PairedDifference, alpha = 0.05): ComparisonVerdict {
  if (d.p >= alpha || (d.ci[0] <= 0 && d.ci[1] >= 0)) return "no measurable difference";
  return d.meanDifference > 0 ? "better" : "worse";
}
