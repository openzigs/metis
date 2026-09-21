/**
 * Epic #1156 / Issue #1158 — the cross-encoder rerank measurement.
 *
 * ## The decision rule, pre-registered before anything was run
 *
 * `interval-report.ts` (#1157) settles how a sub-issue of this epic is decided, and
 * this module implements that rule rather than re-deriving one:
 *
 *   1. PRE-REGISTER a minimum practically-important delta — {@link MIN_IMPORTANT_DELTA},
 *      +0.040 nDCG@10, taken from #1158's own stated target. It is a constant in this
 *      file, committed before the first arm ran, precisely so it cannot be adjusted to
 *      whatever the measurement turned out to be.
 *   2. Report the PAIRED bootstrap CI **and** the exact sign test **and** the count of
 *      NON-ZERO per-query deltas. A surgical change leaves most queries untouched, and
 *      a bootstrap over a mostly-zero vector has degraded tail coverage — which is why
 *      `stats.ts`'s header says to believe the sign test when the two disagree, and why
 *      the non-zero count is a reported column here rather than a footnote.
 *   3. Classify explicitly ({@link classifyDelta}): **SHIP** / **DIRECTION ESTABLISHED,
 *      MAGNITUDE NOT** / **NOT ESTABLISHED**.
 *
 * The absolute CI half-width on `embedretrieval-02-nl-to-code` is ±0.0587 at n=127 and
 * ±0.03 needs ~487 queries, so a paired comparison is the only instrument this corpus
 * can support for a delta this size. The paired sd is NOT assumed to collapse — the one
 * measured paired spread in this repo narrows 11% (0.337 → 0.301), so the paired sd for
 * THIS comparison is measured and reported, not projected.
 *
 * ## Why the exact-name miss SET, not the miss count
 *
 * Developers type exact symbol names constantly. A stage that holds `34/41` while
 * swapping WHICH names it loses is a regression the count cannot see (PR #803 review,
 * M4). {@link compareMissSets} is reused from `weight-sweep.ts` rather than reimplemented.
 *
 * ## Latency is measured, never estimated
 *
 * Every search is timed. `cold` is a single observation that includes the ONNX session
 * construction; `warm` is the steady state, reported as p50/p95 of the PAIRED per-query
 * added milliseconds (ON minus OFF on the same query), because "added" is the number the
 * deployment decision needs and an unpaired mean of two arms is not it.
 *
 * Pure and injectable: the searcher and the clock are seams, so all of this is unit
 * tested with no weights, no network and no store.
 */
import type { EmbedRetrievalCorpus } from "./corpus.js";
import { scoreQuery, type QueryScore } from "./metrics.js";
import { bootstrapMean, compareArms, type MeanWithCi, type PairedComparison } from "./stats.js";
import {
  compareMissSets,
  exactNameProbes,
  type MissSetDelta,
  type SweepRow,
} from "./weight-sweep.js";

/** Rank depth every arm is scored at — the `@10` in nDCG@10. */
export const RERANK_K = 10;

/**
 * The candidate pool depths #1158 sweeps, each trimmed back to {@link RERANK_K}.
 *
 * A cross-encoder over exactly `limit` candidates can only reorder the answer; it can
 * never recover a symbol fusion placed at rank `limit + 1`. So the depth IS the
 * experiment, and 20/50/100 spans "barely wider than the answer" to "10× the answer".
 */
export const RERANK_POOL_DEPTHS: readonly number[] = [20, 50, 100];

/**
 * The minimum practically-important delta, PRE-REGISTERED (#1158's target).
 *
 * Chosen — before measuring — as the epic's own stated bar: +0.04 nDCG@10 over the
 * re-baselined 0.276, which is also the value that clears #1157's measured absolute CI
 * half-width of ±0.0587 by being large enough to matter at all. Anything smaller is a
 * change this corpus cannot separate from a cost.
 */
export const MIN_IMPORTANT_DELTA = 0.04;

/** How a measured comparison is classified. Exactly the three #1157 defined. */
export type RerankVerdict = "SHIP" | "DIRECTION-ESTABLISHED-MAGNITUDE-NOT" | "NOT-ESTABLISHED";

export interface LatencySamples {
  /** Milliseconds for the FIRST query of the arm — includes any model load. */
  coldMs: number;
  /** Milliseconds for every query after the first, in corpus order. */
  warmMs: number[];
}

export interface RerankArmResult {
  /** Candidate pool depth, or `null` for the rerank-OFF production baseline. */
  poolSize: number | null;
  label: string;
  ndcg10: number;
  ndcg10Ci: MeanWithCi;
  mrr: number;
  /** Per-query scores, keyed for the paired comparison. */
  perQuery: QueryScore[];
  /** Fraction of exact-name lookups whose target came back RANKED #1. */
  exactNameTop1: number;
  exactNameCount: number;
  /** The exact-name lookups that did NOT come back #1 — named, not counted. */
  exactNameMisses: string[];
  latency: LatencySamples;
}

export interface RerankComparison {
  poolSize: number;
  ndcgOff: number;
  ndcgOn: number;
  /** Paired bootstrap CI + exact sign test over the per-query nDCG@10 deltas. */
  paired: PairedComparison;
  /** Per-query deltas that are not exactly zero — the bootstrap's effective sample. */
  nonZeroDeltas: number;
  /** Sample sd of the per-query deltas — the paired spread, measured not assumed. */
  pairedSd: number;
  verdict: RerankVerdict;
  /** False when the bootstrap CI and the exact sign test disagree — reported, never hidden. */
  testsAgree: boolean;
  missSet: MissSetDelta;
  /** Paired added milliseconds per query (ON − OFF), warm steady state. */
  addedWarmP50Ms: number;
  addedWarmP95Ms: number;
  /** Added milliseconds on the FIRST query — the cold model load. */
  addedColdMs: number;
}

/** Rank a query through one arm and return the ranked symbol ids. */
export type RerankSearch = (query: string, limit: number) => Promise<string[]>;

export interface ScoreArmOptions {
  /** Injectable clock so latency assertions are deterministic in tests. */
  now?: () => number;
  /** Skip the exact-name probes (they cost one search per ground-truth symbol). */
  skipExactName?: boolean;
}

/**
 * Linear-interpolation-free percentile: the value at the `p`-th position of the sorted
 * sample (nearest-rank). Deliberately the simple definition — p95 of 126 warm samples
 * is a data point, not an interpolation, and a reader can recompute it.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Sample standard deviation (n−1). Zero for fewer than two observations. */
export function sampleSd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (values.length - 1));
}

/** Conventional two-sided threshold for the exact sign test. */
export const SIGN_TEST_ALPHA = 0.05;

/**
 * The classification rule (#1157's step 3), as code so it cannot drift from the prose.
 *
 * A CI that excludes zero establishes DIRECTION. It establishes MAGNITUDE only when its
 * lower bound also clears the pre-registered floor — so "+0.03, CI [+0.005, +0.06]" is
 * reported as direction-only rather than as a win, which is exactly the case #1156's
 * revert rule was written for.
 *
 * **The sign test breaks ties, and it can only ever make the verdict weaker.**
 * `stats.ts`'s header is explicit that the sign test wins on disagreement, because it
 * assumes nothing about the SIZE of the differences and the bootstrap's tail coverage
 * degrades on a sparse delta vector. So a bootstrap interval that excludes zero while
 * the sign test declines to reject at {@link SIGN_TEST_ALPHA} is reported as
 * NOT-ESTABLISHED, not as a direction. That case is real, not hypothetical: #1158's
 * pool-20 arm measured CI [−0.106, −0.013] with sign p = 0.117.
 */
export function classifyDelta(
  paired: Pick<PairedComparison, "ciLow" | "ciHigh"> & { signTestP?: number },
  minDelta: number = MIN_IMPORTANT_DELTA,
): RerankVerdict {
  const excludesZero = paired.ciLow > 0 || paired.ciHigh < 0;
  if (!excludesZero) return "NOT-ESTABLISHED";
  if (paired.signTestP !== undefined && paired.signTestP >= SIGN_TEST_ALPHA) {
    return "NOT-ESTABLISHED";
  }
  if (paired.ciLow >= minDelta) return "SHIP";
  return "DIRECTION-ESTABLISHED-MAGNITUDE-NOT";
}

/** True when the bootstrap interval and the exact sign test point the same way. */
export function testsAgree(
  paired: Pick<PairedComparison, "ciLow" | "ciHigh" | "signTestP">,
): boolean {
  return (paired.ciLow > 0 || paired.ciHigh < 0) === paired.signTestP < SIGN_TEST_ALPHA;
}

/** Score one arm: nDCG@10, MRR, exact-name #1 (with its miss set), and latency. */
export async function scoreRerankArm(
  corpus: EmbedRetrievalCorpus,
  search: RerankSearch,
  label: string,
  poolSize: number | null,
  opts: ScoreArmOptions = {},
): Promise<RerankArmResult> {
  const now = opts.now ?? ((): number => performance.now());
  const perQuery: QueryScore[] = [];
  const times: number[] = [];

  for (const q of corpus.queries) {
    const t0 = now();
    const ranked = await search(q.requirement, RERANK_K);
    times.push(now() - t0);
    // `scoreQuery` is the harness's ONE scoring function — reusing it keeps the strata
    // slice (`aggregateByStratum`) available on these arms for free, and `keywordFree`
    // is the slice #1157 named as where a cross-encoder has to earn its latency.
    perQuery.push(scoreQuery(q.id, ranked, q.relevant));
  }

  const probes = opts.skipExactName ? [] : exactNameProbes(corpus);
  const exactNameMisses: string[] = [];
  let top1 = 0;
  for (const probe of probes) {
    const ranked = await search(probe.query, RERANK_K);
    if (ranked[0] === probe.targetId) top1 += 1;
    else exactNameMisses.push(probe.query);
  }

  const ndcgs = perQuery.map((s) => s.ndcgAtK[RERANK_K] ?? 0);
  return {
    poolSize,
    label,
    ndcg10: ndcgs.reduce((a, b) => a + b, 0) / (ndcgs.length || 1),
    ndcg10Ci: bootstrapMean(ndcgs),
    mrr: perQuery.reduce((s, q) => s + q.reciprocalRank, 0) / (perQuery.length || 1),
    perQuery,
    exactNameTop1: probes.length === 0 ? 0 : top1 / probes.length,
    exactNameCount: probes.length,
    exactNameMisses,
    latency: { coldMs: times[0] ?? 0, warmMs: times.slice(1) },
  };
}

/** Per-query nDCG@10 keyed by query id — the unit of the paired comparison. */
function ndcgByQuery(arm: RerankArmResult): ReadonlyMap<string, number> {
  return new Map(arm.perQuery.map((q) => [q.queryId, q.ndcgAtK[RERANK_K] ?? 0]));
}

/**
 * `compareMissSets` speaks {@link SweepRow}; an arm carries the same two fields under
 * the same names. Adapting rather than reimplementing keeps ONE definition of "the miss
 * set moved" in the repo.
 */
function asSweepRow(arm: RerankArmResult): Pick<SweepRow, "exactNameMisses"> {
  return { exactNameMisses: arm.exactNameMisses };
}

/** Compare one rerank-ON arm against the rerank-OFF production baseline. */
export function compareRerankArm(
  off: RerankArmResult,
  on: RerankArmResult,
  minDelta: number = MIN_IMPORTANT_DELTA,
): RerankComparison {
  if (on.poolSize === null) {
    throw new Error("compareRerankArm: the ON arm must carry a pool size");
  }
  const paired = compareArms(
    `rerank ON (pool ${on.poolSize}) vs OFF`,
    on.label,
    off.label,
    ndcgByQuery(on),
    ndcgByQuery(off),
  );

  const offByQuery = ndcgByQuery(off);
  const deltas: number[] = [];
  for (const [id, v] of ndcgByQuery(on)) {
    const b = offByQuery.get(id);
    if (b !== undefined) deltas.push(v - b);
  }

  // Paired added latency: the SAME query timed under both arms, subtracted.
  const n = Math.min(on.latency.warmMs.length, off.latency.warmMs.length);
  const addedWarm = Array.from(
    { length: n },
    (_, i) => on.latency.warmMs[i] - off.latency.warmMs[i],
  );

  return {
    poolSize: on.poolSize,
    ndcgOff: off.ndcg10,
    ndcgOn: on.ndcg10,
    paired,
    nonZeroDeltas: deltas.filter((d) => d !== 0).length,
    pairedSd: sampleSd(deltas),
    verdict: classifyDelta(paired, minDelta),
    testsAgree: testsAgree(paired),
    missSet: compareMissSets(asSweepRow(off) as SweepRow, asSweepRow(on) as SweepRow),
    addedWarmP50Ms: percentile(addedWarm, 50),
    addedWarmP95Ms: percentile(addedWarm, 95),
    addedColdMs: on.latency.coldMs - off.latency.coldMs,
  };
}

export interface RerankSweepReport {
  off: RerankArmResult;
  on: RerankArmResult[];
  comparisons: RerankComparison[];
  minDelta: number;
  /** Wall-clock ms for one cold cross-encoder load, measured directly. */
  coldModelLoadMs: number | null;
  /** Bytes the cross-encoder occupies on disk, measured. `null` when not resolvable. */
  modelBytes: number | null;
}

const f3 = (n: number): string => n.toFixed(3);
const f1 = (n: number): string => n.toFixed(1);

/** The results table the PR and the issue comment quote. */
export function renderRerankSweep(report: RerankSweepReport): string {
  const lines = [
    `| arm | pool | nDCG@10 | 95% CI (absolute) | MRR | exact-name #1 | miss set vs OFF |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    `| rerank OFF (production today) | — | ${f3(report.off.ndcg10)} | ` +
      `[${f3(report.off.ndcg10Ci.ciLow)}, ${f3(report.off.ndcg10Ci.ciHigh)}] | ` +
      `${f3(report.off.mrr)} | ${(report.off.exactNameTop1 * 100).toFixed(0)}% ` +
      `(${report.off.exactNameCount}) | — |`,
  ];
  for (const arm of report.on) {
    const cmp = report.comparisons.find((c) => c.poolSize === arm.poolSize);
    const miss = cmp?.missSet;
    const missCell = !miss
      ? "—"
      : miss.identical
        ? "identical"
        : [
            miss.regressed.length > 0 ? `lost ${miss.regressed.join(", ")}` : "",
            miss.recovered.length > 0 ? `recovered ${miss.recovered.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ");
    lines.push(
      `| rerank ON | ${arm.poolSize} | ${f3(arm.ndcg10)} | ` +
        `[${f3(arm.ndcg10Ci.ciLow)}, ${f3(arm.ndcg10Ci.ciHigh)}] | ${f3(arm.mrr)} | ` +
        `${(arm.exactNameTop1 * 100).toFixed(0)}% (${arm.exactNameCount}) | ${missCell} |`,
    );
  }
  return lines.join("\n");
}

/** The paired-decision table — the one the revert rule is read off. */
export function renderRerankDecision(report: RerankSweepReport): string {
  const lines = [
    `| pool | Δ nDCG@10 | paired 95% CI | paired sd | non-zero Δ / n | wins/losses/ties | sign p | tests agree? | added p50 ms | added p95 ms | verdict |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const c of report.comparisons) {
    lines.push(
      `| ${c.poolSize} | ${c.paired.meanDelta >= 0 ? "+" : ""}${f3(c.paired.meanDelta)} | ` +
        `[${f3(c.paired.ciLow)}, ${f3(c.paired.ciHigh)}] | ${f3(c.pairedSd)} | ` +
        `${c.nonZeroDeltas}/${c.paired.n} | ` +
        `${c.paired.wins}/${c.paired.losses}/${c.paired.ties} | ${c.paired.signTestP.toFixed(3)} | ` +
        `${c.testsAgree ? "yes" : "**NO — sign test wins**"} | ` +
        `${f1(c.addedWarmP50Ms)} | ${f1(c.addedWarmP95Ms)} | **${c.verdict}** |`,
    );
  }
  return lines.join("\n");
}
