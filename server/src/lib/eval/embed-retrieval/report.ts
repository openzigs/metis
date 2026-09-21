/**
 * Epic #780 / Issue #788 — markdown rendering of the results table + verdict.
 *
 * Pure string building: the CLI writes this to `eval-results/` and the same text
 * is pasted into `docs/EMBEDDINGS_BACKENDS.md` as the decision-matrix evidence
 * row, so the #783 PR can cite one artifact rather than a screenshot of a
 * terminal.
 */
import type { ArmSpec } from "./arms.js";
import { renderIntervalSection, renderStrataSection } from "./interval-report.js";
import type { ChannelMetrics, StratumMetrics } from "./metrics.js";
import type { ArmRunResult } from "./runner.js";
import type { MeanWithCi, PairedComparison } from "./stats.js";
import { round4, type Verdict } from "./verdict.js";

export interface RenderInput {
  corpusId: string;
  docCount: number;
  queryCount: number;
  /** Arms actually run, in report order, paired with their spec. */
  results: Array<{ spec: ArmSpec; result: ArmRunResult }>;
  verdict: Verdict;
  /** Paired bootstrap CIs + sign tests on the headline comparisons. */
  significance: PairedComparison[];
  /**
   * #1157 — the UNPAIRED bootstrap CI on the headline arm's vector nDCG@10, and
   * that arm's per-stratum slice. Both are REQUIRED rather than optional: a
   * results file whose headline number carries no interval is the defect #1157
   * was raised to fix, and an optional field is a defect a caller can reintroduce
   * by forgetting a property.
   */
  headline: {
    /** Which arm the interval and strata describe. */
    armId: string;
    ci: MeanWithCi;
    strata: StratumMetrics[];
  };
  /** ISO timestamp of the run. */
  ranAt: string;
}

const fmt = (n: number): string => n.toFixed(3);
const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
const pval = (p: number): string => (p < 0.001 ? "<0.001" : p.toFixed(3));

/**
 * The bm25 reference line is arm-independent BY CONSTRUCTION (the channel is
 * driven by an empty vector store), but it is rendered PER ARM anyway, and the
 * spread is stated. An earlier version of this harness printed a single number
 * and asserted the property in prose while the underlying channel was in fact
 * leaking vector hits — so the property is now shown rather than claimed, and a
 * regression would be visible in the table instead of hidden behind it.
 */
function bm25Section(results: RenderInput["results"]): string {
  if (results.length === 0) return "";
  const ndcgs = results.map((r) => r.result.channels.bm25.ndcgAtK[10] ?? 0);
  const spread = Math.max(...ndcgs) - Math.min(...ndcgs);
  const rows = results.map((r) => channelRow(r.spec, r.result.channels.bm25)).join("\n");

  return `## BM25-only reference line (no vector channel at all)

Driven by an EMPTY vector store, so no vector can reach this ranking by any path.
It is therefore identical across arms — and printed per arm so you can check that
rather than take it on trust. **Spread across arms: ${spread.toFixed(4)} nDCG@10.**

| Arm | Configuration | nDCG@10 | MRR | R@1 | R@5 | R@10 | hit@10 |
|---|---|---|---|---|---|---|---|
${rows}

A hybrid delta smaller than the vector delta means BM25 is masking the vector
channel — which is exactly why the vector channel is measured in isolation.`;
}

/** Paired bootstrap CI + exact sign test on each headline comparison. */
function significanceSection(significance: PairedComparison[]): string {
  if (significance.length === 0) return "";
  const rows = significance
    .map(
      (c) =>
        `| ${c.label} | ${c.armA} − ${c.armB} | ${c.n} | ${signed(c.meanDelta)} | ` +
        `[${signed(c.ciLow)}, ${signed(c.ciHigh)}] | ${c.wins}/${c.losses}/${c.ties} | ${pval(
          c.signTestP,
        )} |`,
    )
    .join("\n");
  const b = significance[0];

  return `## Paired significance (the mean deltas above, with an interval around them)

Paired by query (both arms are scored on the SAME requirements), ${b.resamples} bootstrap
resamples with a fixed seed, ${(b.confidence * 100).toFixed(0)}% percentile CI, plus a two-sided exact sign
test over the non-tied queries. These do NOT gate anything — the bar was pre-registered
on mean deltas and is not being moved after the fact. They are here so a reader can see
which of those deltas are distinguishable from zero on ${b.n} queries, which a mean alone
cannot tell them.

| Comparison | Arms | n | mean Δ nDCG@10 | 95% CI | W/L/T | sign test p |
|---|---|---|---|---|---|---|
${rows}`;
}

function channelRow(spec: ArmSpec, m: ChannelMetrics): string {
  return `| ${spec.id} | ${spec.label} | ${fmt(m.ndcgAtK[10] ?? 0)} | ${fmt(m.mrr)} | ${fmt(
    m.recallAtK[1] ?? 0,
  )} | ${fmt(m.recallAtK[5] ?? 0)} | ${fmt(m.recallAtK[10] ?? 0)} | ${fmt(m.hitRateAt10)} |`;
}

/** Render the full results markdown (table per channel + verdict + honesty note). */
export function renderReport(input: RenderInput): string {
  const { results, verdict, significance } = input;
  const header =
    "| Arm | Configuration | nDCG@10 | MRR | R@1 | R@5 | R@10 | hit@10 |\n" +
    "|---|---|---|---|---|---|---|---|";

  const vectorTable = [
    header,
    ...results.map((r) => channelRow(r.spec, r.result.channels.vector)),
  ].join("\n");
  const hybridTable = [
    header,
    ...results.map((r) => channelRow(r.spec, r.result.channels.hybrid)),
  ].join("\n");
  const checkRows = verdict.checks
    .map((c) => {
      const status = c.passed === null ? "n/a" : c.passed ? "PASS" : "FAIL";
      const value = c.value === null ? "—" : fmt(c.value);
      const bar = c.bar === null ? "—" : fmt(c.bar);
      return `| ${c.id} | ${c.kind} | ${value} | ${bar} | **${status}** | ${c.description} |`;
    })
    .join("\n");

  return `# Embedding retrieval eval — NL requirement → code symbol (issue #788)

- **Corpus**: \`${input.corpusId}\` — ${input.queryCount} hand-authored NL requirements over ${input.docCount} real METIS code symbols.
- **Headline metric**: vector-channel nDCG@10 (the vector channel is the only thing the #783 flip changes).
- **Run at**: ${input.ranAt}

## Vector channel (isolated — the channel under test)

${vectorTable}

## Hybrid channel (production \`HybridCodeSearch\`, BM25 + vector, RRF-fused)

${hybridTable}

${bm25Section(results)}

${renderIntervalSection({
  metricLabel: `\`${input.headline.armId}\` vector-channel nDCG@10`,
  stats: input.headline.ci,
})}

${renderStrataSection(input.headline.strata)}

${significanceSection(significance)}

## Verdict against the bar (bar fixed BEFORE the run)

| Check | Kind | Value | Bar | Result | What it means |
|---|---|---|---|---|---|
${checkRows}

### Outcome: **${verdict.outcome}**

${verdict.summary}

## Honesty notes

- The corpus is SMALL (${input.queryCount} queries, ${input.docCount} symbols) and HAND-BUILT. It licenses a directional
  conclusion about NL-requirement → code retrieval on METIS-shaped TypeScript. It does NOT license a
  claim about absolute retrieval quality, about other languages (SQL/SAS/Java), or about end-to-end
  analysis verdict accuracy.
- Ground truth is hand-authored by a human reading the code — not LLM-labelled, not mined from usage.
- The corpus and the bar were frozen before any arm was run.
- ${input.queryCount} queries cannot establish EQUIVALENCE between two arms. A comparison whose CI
  contains zero is UNDERPOWERED — it is not evidence that the arms are the same, only an absence of
  evidence that they differ. That distinction is load-bearing for the q8-vs-fp32 check: read its row
  in the significance table as "no evidence q8 degrades retrieval", NOT as "q8 and fp32 are equivalent".
`;
}

/** The machine-readable artifact the #783 PR can cite. */
export function toJsonArtifact(input: RenderInput): unknown {
  return {
    kind: "embed-retrieval-eval",
    corpus: input.corpusId,
    ranAt: input.ranAt,
    docCount: input.docCount,
    queryCount: input.queryCount,
    headlineMetric: input.verdict.headlineMetric,
    outcome: input.verdict.outcome,
    summary: input.verdict.summary,
    checks: input.verdict.checks,
    // #1157 — the interval and the strata ride the MACHINE-READABLE artifact too,
    // so a later sub-issue can diff them without re-parsing markdown.
    headline: {
      armId: input.headline.armId,
      metric: "vector.ndcgAt10",
      mean: round4(input.headline.ci.mean),
      ciLow: round4(input.headline.ci.ciLow),
      ciHigh: round4(input.headline.ci.ciHigh),
      halfWidth: round4(input.headline.ci.halfWidth),
      sd: round4(input.headline.ci.sd),
      n: input.headline.ci.n,
      confidence: input.headline.ci.confidence,
      resamples: input.headline.ci.resamples,
      strata: input.headline.strata.map((s) => ({
        key: s.key,
        value: s.value,
        queryCount: s.queryCount,
        ndcgAt10: round4(s.ndcgAt10),
        mrr: round4(s.mrr),
      })),
    },
    significance: input.significance.map((c) => ({
      label: c.label,
      armA: c.armA,
      armB: c.armB,
      metric: "vector.ndcgAt10",
      n: c.n,
      meanDelta: round4(c.meanDelta),
      ciLow: round4(c.ciLow),
      ciHigh: round4(c.ciHigh),
      confidence: c.confidence,
      resamples: c.resamples,
      wins: c.wins,
      losses: c.losses,
      ties: c.ties,
      signTestP: round4(c.signTestP),
    })),
    arms: input.results.map(({ spec, result }) => ({
      id: spec.id,
      role: spec.role,
      model: spec.model,
      pooling: spec.pooling ?? null,
      dtype: spec.dtype ?? null,
      dimension: spec.dimension,
      channels: {
        vector: roundChannel(result.channels.vector),
        hybrid: roundChannel(result.channels.hybrid),
        bm25: roundChannel(result.channels.bm25),
      },
      vectorQueries: result.vectorQueries.map((q) => ({
        queryId: q.queryId,
        firstRelevantRank: q.firstRelevantRank,
        ndcgAt10: round4(q.ndcgAtK[10] ?? 0),
        recallAt5: round4(q.recallAtK[5] ?? 0),
      })),
    })),
  };
}

function roundChannel(m: ChannelMetrics): unknown {
  return {
    queryCount: m.queryCount,
    ndcgAt1: round4(m.ndcgAtK[1] ?? 0),
    ndcgAt5: round4(m.ndcgAtK[5] ?? 0),
    ndcgAt10: round4(m.ndcgAtK[10] ?? 0),
    mrr: round4(m.mrr),
    recallAt1: round4(m.recallAtK[1] ?? 0),
    recallAt5: round4(m.recallAtK[5] ?? 0),
    recallAt10: round4(m.recallAtK[10] ?? 0),
    hitRateAt10: round4(m.hitRateAt10),
  };
}
