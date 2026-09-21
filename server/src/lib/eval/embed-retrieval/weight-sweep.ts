/**
 * Epic #780 / Issue #797, PR #803 review (B1) — settle `DEFAULT_WEIGHTS` empirically.
 *
 * ## The finding this exists to answer
 *
 * #797 wired the vector channel, and the vector channel WORKS: on the flagship
 * keyword-free requirement it ranks `assertWithinBudget` 14th of 183, where BM25
 * cannot retrieve it at any depth. But RRF at the incumbent `bm25Weight: 0.4`
 * DEMOTED that hit to rank 30 — and `search_code_symbols` returns the top
 * {@link DEFAULT_LIMIT} (15). So the agent still never saw the symbol: the same
 * user-visible outcome as the BM25-only defect the issue was raised to fix.
 *
 * The demotion is structural, not noise. RRF gives a symbol found by BOTH channels
 * `w_b/(k+r_b) + w_v/(k+r_v)`, and a symbol found by ONE channel only the single
 * term. A lexically-plausible-but-wrong symbol (`projectMonthEnd`, `projectCosts`,
 * `startAlertEngine` — they share "project"/"month"/"start" with the requirement's
 * ORDINARY ENGLISH) draws both terms and outranks a correct vector-only hit. The
 * higher `bm25Weight` is, the more that noise is worth.
 *
 * ## What this module does, and what it deliberately does not do
 *
 * It sweeps the weight ratio over the committed corpus and reports, per setting:
 *
 *   - `hybridNdcg10` — retrieval quality over ALL corpus queries. The thing to maximise.
 *   - `exactNameTop1` — the REGRESSION GUARD. For every ground-truth symbol, query
 *     its exact name and check it still comes back RANKED #1. Developers type exact
 *     names constantly; a weighting that wins on NL prose and loses `getEmbedder`
 *     from the top slot is not a win, it is a trade nobody asked for. This is a hard
 *     constraint, not a metric to balance.
 *   - `flagshipRank` / `flagshipWithinDefaultLimit` — does the agent ACTUALLY GET the
 *     symbol, at the limit the tool actually uses? That is the whole question.
 *
 * It does NOT pick the winner by argmax and call it settled. {@link chooseWeights}
 * applies the constraint first and the metric second, and returns `null` when no
 * setting satisfies both — an honest "RRF cannot get there" is a legitimate result
 * and the caller must be able to report it rather than round it away.
 *
 * Pure and injectable: the searcher is a seam, so this is unit-tested with no
 * weights, no network and no store. The CLI (`--sweep`) drives it with the real
 * production searcher over real ONNX vectors.
 */
import type { SearchWeights } from "../../code-graph/hybrid-search.js";
import { DEFAULT_LIMIT } from "../../analysis/tools/search-symbols.js";
import type { EmbedRetrievalCorpus } from "./corpus.js";
import { ndcgAtK, reciprocalRank } from "./metrics.js";
import { bootstrapMean, type MeanWithCi } from "./stats.js";

/** Rank depth the sweep scores quality at (matches the eval's `HYBRID_LIMIT`). */
export const SWEEP_K = 10;

/**
 * The flagship query — the one the issue is about, and the one the review measured.
 * It shares NONE of `assert` / `within` / `budget`, the only tokens production BM25
 * indexes for the target, so it is unretrievable by the lexical channel at any depth.
 */
export const FLAGSHIP_QUERY =
  "The system must refuse to start a new AI call once a project has burned " +
  "through its allowance for the month";

export const FLAGSHIP_TARGET = {
  name: "assertWithinBudget",
  filePath: "finops/budget-enforcer.ts",
} as const;

/**
 * The grid. `vectorWeight = 1 - bm25Weight` throughout: RRF is scale-free, only the
 * RATIO of the two weights can change a ranking, so a two-dimensional sweep would be
 * a grid of duplicates. `0.4` is the incumbent; `0.0` is the pure-vector arm the
 * review asked for explicitly.
 */
export const WEIGHT_GRID: readonly SearchWeights[] = [
  { bm25Weight: 1.0, vectorWeight: 0.0 },
  { bm25Weight: 0.6, vectorWeight: 0.4 },
  { bm25Weight: 0.5, vectorWeight: 0.5 },
  { bm25Weight: 0.4, vectorWeight: 0.6 },
  { bm25Weight: 0.3, vectorWeight: 0.7 },
  { bm25Weight: 0.25, vectorWeight: 0.75 },
  { bm25Weight: 0.2, vectorWeight: 0.8 },
  { bm25Weight: 0.15, vectorWeight: 0.85 },
  { bm25Weight: 0.1, vectorWeight: 0.9 },
  { bm25Weight: 0.05, vectorWeight: 0.95 },
  { bm25Weight: 0.0, vectorWeight: 1.0 },
];

/** Rank a query and return the ranked symbol ids, at the given weights and depth. */
export type WeightedSearch = (
  query: string,
  weights: SearchWeights,
  limit: number,
) => Promise<string[]>;

export interface SweepRow {
  weights: SearchWeights;
  /** nDCG@10 over every corpus query. */
  hybridNdcg10: number;
  /**
   * #1157 — the bootstrap 95% CI around `hybridNdcg10`.
   *
   * The sweep's whole output is a column of numbers a reader compares to each
   * other; without intervals, two adjacent rows differing by 0.01 look like a
   * ranking. They are usually the same row measured twice.
   */
  hybridNdcg10Ci: MeanWithCi;
  /** Mean reciprocal rank over every corpus query. */
  hybridMrr: number;
  /** Fraction of exact-name lookups whose target is RANKED #1. */
  exactNameTop1: number;
  /** How many exact-name lookups were scored (the denominator of the above). */
  exactNameCount: number;
  /** The exact-name lookups that did NOT come back #1 — named, not just counted. */
  exactNameMisses: string[];
  /** The flagship symbol, looked up by its EXACT NAME, still ranks #1. Hard gate. */
  flagshipExactNameTop1: boolean;
  /** 1-based rank of the flagship target in the full ranking; `null` = absent. */
  flagshipRank: number | null;
  /** Does the agent actually receive it, at `search_code_symbols`'s DEFAULT limit? */
  flagshipWithinDefaultLimit: boolean;
}

export interface SweepReport {
  rows: SweepRow[];
  /** The incumbent setting's row, for the before/after comparison. */
  incumbent: SweepRow;
  /** The setting that wins under {@link chooseWeights}, or `null` if none qualifies. */
  chosen: SweepRow | null;
}

/**
 * The exact-name miss SET, compared against the incumbent's — not the count (PR #803
 * review, M4).
 *
 * {@link chooseWeights} gates on `exactNameTop1`, a SCALAR, and an unchanged fraction
 * says only that the number of misses is unchanged: a setting could lose `getEmbedder`
 * from the top slot and recover `parseBudget` and still score an identical 34/41. That
 * is a materially different regression profile, and the count cannot see it. So compare
 * the sets and report the names that MOVED, in either direction.
 */
export interface MissSetDelta {
  /** Ranked #1 under the incumbent, NOT #1 here — the regressions. */
  regressed: string[];
  /** Missed by the incumbent, ranked #1 here — the recoveries. */
  recovered: string[];
  /** True iff the two miss sets contain exactly the same names. */
  identical: boolean;
}

export function compareMissSets(incumbent: SweepRow, row: SweepRow): MissSetDelta {
  const before = new Set(incumbent.exactNameMisses);
  const after = new Set(row.exactNameMisses);
  const regressed = [...after].filter((n) => !before.has(n)).sort();
  const recovered = [...before].filter((n) => !after.has(n)).sort();
  return { regressed, recovered, identical: regressed.length === 0 && recovered.length === 0 };
}

/** Depth the flagship is ranked to — deep enough that "absent" means absent. */
const FLAGSHIP_DEPTH = 500;

/**
 * The choice rule, stated as code so it cannot drift from the prose.
 *
 * 1. HARD CONSTRAINTS — a setting that breaks either is discarded, however good its
 *    nDCG is:
 *      a. the flagship symbol, looked up BY ITS EXACT NAME, still ranks #1;
 *      b. the exact-name suite does not REGRESS against the incumbent.
 *
 *    (b) is a no-regression bar, deliberately NOT an absolute "100% of exact names
 *    rank #1" bar. The measured truth is that the INCUMBENT weighting already misses
 *    ~17% of them, and the only setting that scores 100% is `bm25Weight: 1.0` — i.e.
 *    turning the vector channel off, which is the defect this issue exists to fix. An
 *    absolute bar would therefore "prove" that the correct action is to ship nothing.
 *    The decision-relevant question is whether a retune makes exact-name lookup WORSE
 *    than what users have today, and that is what this measures.
 *
 * 2. Among the survivors, maximise nDCG@10 over the corpus.
 *
 * 3. Ties (within {@link TIE_EPS}) go to the HIGHER `bm25Weight` — stay as close to
 *    the incumbent as the evidence allows. A weight change is a behaviour change for
 *    every caller; it must be paid for by a measured improvement, not by a rounding
 *    artefact on a 24-query corpus.
 */
const TIE_EPS = 0.005;

export function chooseWeights(rows: readonly SweepRow[], incumbent: SweepRow): SweepRow | null {
  const eligible = rows.filter(
    (r) => r.flagshipExactNameTop1 && r.exactNameTop1 >= incumbent.exactNameTop1,
  );
  if (eligible.length === 0) return null;
  const best = Math.max(...eligible.map((r) => r.hybridNdcg10));
  const contenders = eligible.filter((r) => r.hybridNdcg10 >= best - TIE_EPS);
  return contenders.reduce((a, b) => (b.weights.bm25Weight > a.weights.bm25Weight ? b : a));
}

/** Resolve the flagship target's symbol id in the corpus. Throws if it moved. */
export function flagshipTargetId(corpus: EmbedRetrievalCorpus): string {
  const target = corpus.symbols.find(
    (s) => s.name === FLAGSHIP_TARGET.name && s.filePath === FLAGSHIP_TARGET.filePath,
  );
  if (!target) {
    throw new Error(
      `flagship target ${FLAGSHIP_TARGET.name} is not in the corpus snapshot — ` +
        `the sweep would silently score nothing`,
    );
  }
  return target.id;
}

/**
 * The exact-name regression suite: one lookup per ground-truth symbol, querying the
 * symbol's own NAME. Deduplicated, and names shared by more than one symbol are
 * DROPPED — "rank #1" is not a well-defined requirement when two symbols answer the
 * query equally well, and keeping them would make the guard fail for the wrong reason.
 */
export function exactNameProbes(corpus: EmbedRetrievalCorpus): Array<{
  query: string;
  targetId: string;
}> {
  const byName = new Map<string, string[]>();
  for (const s of corpus.symbols) {
    byName.set(s.name, [...(byName.get(s.name) ?? []), s.id]);
  }
  const targets = new Set(corpus.queries.flatMap((q) => q.relevant));
  const probes: Array<{ query: string; targetId: string }> = [];
  for (const id of targets) {
    const sym = corpus.symbols.find((s) => s.id === id);
    if (!sym) continue;
    if ((byName.get(sym.name) ?? []).length !== 1) continue;
    probes.push({ query: sym.name, targetId: id });
  }
  return probes;
}

/** Score one weight setting. */
export async function scoreWeights(
  corpus: EmbedRetrievalCorpus,
  weights: SearchWeights,
  search: WeightedSearch,
): Promise<SweepRow> {
  const ndcgs: number[] = [];
  const rrs: number[] = [];
  for (const q of corpus.queries) {
    const ranked = await search(q.requirement, weights, SWEEP_K);
    ndcgs.push(ndcgAtK(ranked, q.relevant, SWEEP_K));
    rrs.push(reciprocalRank(ranked, q.relevant));
  }

  const targetId = flagshipTargetId(corpus);
  const probes = exactNameProbes(corpus);
  const misses: string[] = [];
  let top1 = 0;
  let flagshipExactNameTop1 = false;
  for (const probe of probes) {
    const ranked = await search(probe.query, weights, SWEEP_K);
    const hit = ranked[0] === probe.targetId;
    if (hit) top1 += 1;
    else misses.push(probe.query);
    if (probe.targetId === targetId) flagshipExactNameTop1 = hit;
  }

  const deep = await search(FLAGSHIP_QUERY, weights, FLAGSHIP_DEPTH);
  const idx = deep.indexOf(targetId);
  const flagshipRank = idx < 0 ? null : idx + 1;

  // Asked at the TOOL's default limit, not sliced from the deep ranking: the tool
  // passes `limit` down into the searcher, and `limit` also sizes the vector fetch
  // (`limit * 2`), so a shallow call is not merely a prefix of a deep one. Measure
  // what the agent actually gets.
  const atDefault = await search(FLAGSHIP_QUERY, weights, DEFAULT_LIMIT);

  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  return {
    weights,
    hybridNdcg10: mean(ndcgs),
    hybridNdcg10Ci: bootstrapMean(ndcgs),
    hybridMrr: mean(rrs),
    exactNameTop1: probes.length === 0 ? 0 : top1 / probes.length,
    exactNameCount: probes.length,
    exactNameMisses: misses,
    flagshipExactNameTop1,
    flagshipRank,
    flagshipWithinDefaultLimit: atDefault.includes(targetId),
  };
}

/**
 * The weighting shipped BEFORE this sweep — the baseline every row is judged against.
 * Kept as a literal (not read from `DEFAULT_WEIGHTS`) precisely so that retuning
 * `DEFAULT_WEIGHTS` cannot silently redefine the baseline it was measured against.
 */
export const INCUMBENT_WEIGHTS: SearchWeights = { bm25Weight: 0.4, vectorWeight: 0.6 };

/** Sweep the whole grid and apply {@link chooseWeights}. */
export async function runWeightSweep(
  corpus: EmbedRetrievalCorpus,
  search: WeightedSearch,
  grid: readonly SearchWeights[] = WEIGHT_GRID,
  incumbent: SearchWeights = INCUMBENT_WEIGHTS,
): Promise<SweepReport> {
  const rows: SweepRow[] = [];
  for (const weights of grid) {
    rows.push(await scoreWeights(corpus, weights, search));
  }
  const incumbentRow =
    rows.find((r) => r.weights.bm25Weight === incumbent.bm25Weight) ??
    (await scoreWeights(corpus, incumbent, search));
  return { rows, incumbent: incumbentRow, chosen: chooseWeights(rows, incumbentRow) };
}

/** Render the sweep as the markdown table the PR quotes. */
export function renderSweep(report: SweepReport): string {
  const lines = [
    `| bm25 | vector | nDCG@10 | 95% CI | MRR | exact-name #1 | miss set vs incumbent | flagship by name #1 | flagship NL rank | in default top-${DEFAULT_LIMIT}? |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const r of report.rows) {
    const chosen = report.chosen && r.weights === report.chosen.weights ? " **←**" : "";
    const d = compareMissSets(report.incumbent, r);
    // The COUNT can hold while the NAMES move; say which, in the artifact itself.
    const missCell = d.identical
      ? "identical"
      : [
          d.regressed.length > 0 ? `lost ${d.regressed.join(", ")}` : "",
          d.recovered.length > 0 ? `recovered ${d.recovered.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; ");
    lines.push(
      `| ${r.weights.bm25Weight.toFixed(2)} | ${r.weights.vectorWeight.toFixed(2)} | ` +
        `${r.hybridNdcg10.toFixed(3)} | ` +
        `[${r.hybridNdcg10Ci.ciLow.toFixed(3)}, ${r.hybridNdcg10Ci.ciHigh.toFixed(3)}] | ` +
        `${r.hybridMrr.toFixed(3)} | ` +
        `${(r.exactNameTop1 * 100).toFixed(0)}% (${r.exactNameCount}) | ` +
        `${missCell} | ` +
        `${r.flagshipExactNameTop1 ? "yes" : "NO"} | ` +
        `${r.flagshipRank ?? "absent"} | ${r.flagshipWithinDefaultLimit ? "YES" : "no"}${chosen} |`,
    );
  }
  return lines.join("\n");
}

/**
 * The miss sets themselves, named — so a reader can check the "unchanged" claim rather
 * than take it on trust. `renderSweep` previously dropped `exactNameMisses` entirely,
 * which is how an unsupported "bit-for-bit unchanged" claim reached the PR body (M4).
 */
export function renderMissSets(report: SweepReport): string {
  const lines = [
    `Incumbent (bm25=${report.incumbent.weights.bm25Weight}) exact-name misses ` +
      `(${report.incumbent.exactNameMisses.length}/${report.incumbent.exactNameCount}): ` +
      `${[...report.incumbent.exactNameMisses].sort().join(", ") || "none"}`,
  ];
  if (report.chosen) {
    const d = compareMissSets(report.incumbent, report.chosen);
    lines.push(
      `Chosen (bm25=${report.chosen.weights.bm25Weight}) exact-name misses ` +
        `(${report.chosen.exactNameMisses.length}/${report.chosen.exactNameCount}): ` +
        `${[...report.chosen.exactNameMisses].sort().join(", ") || "none"}`,
      d.identical
        ? `Miss SET vs incumbent: IDENTICAL (same names, not merely the same count).`
        : `Miss SET vs incumbent: CHANGED — newly missed: ` +
            `${d.regressed.join(", ") || "none"}; recovered: ${d.recovered.join(", ") || "none"}.`,
    );
  }
  return lines.join("\n");
}
