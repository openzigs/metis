/**
 * Epic #1156 / Issue #1159 — the lexical A/B: does splitting snake_case, and does
 * widening the BM25 document, move retrieval on `embedretrieval-02-nl-to-code`?
 *
 * ## Two levers, measured SEPARATELY, on purpose
 *
 * #1156's rule is that retrieval changes are not additive and cannot be batched —
 * its precedent is #931 REGRESSING precision as an LLM seeder while #936 IMPROVED it
 * 0.40 → 0.75 as an LLM filter, same model, opposite outcome, decided entirely by
 * where it sat in the pipeline. So this module scores four arms, not two:
 *
 *   `baseline`  — production at `bb86b146`: the pre-#1159 tokenizer, name + qualifiedName.
 *   `tokenizer` — lever 1 alone: snake_case split (additive), same document text.
 *   `document`  — lever 2 alone: same tokenizer, document widened with retrievable fields.
 *   `combined`  — both.
 *
 * If both shipped together and the total came out flat, there would be no way to tell
 * whether one helped and one hurt.
 *
 * ## The decision rule is IMPORTED, not re-derived
 *
 * `interval-report.ts` (#1157) prints the rule into every artifact and
 * `rerank-sweep.ts` (#1158) implements it. {@link classifyDelta} and {@link testsAgree}
 * come from there unchanged: pre-register a minimum practically-important delta, report
 * the paired bootstrap CI **and** the exact sign test **and** the count of non-zero
 * per-query deltas, and classify SHIP / DIRECTION-ESTABLISHED-MAGNITUDE-NOT /
 * NOT-ESTABLISHED. On disagreement believe the sign test (`stats.ts` header).
 *
 * The "paired sd collapses because a surgical change leaves most queries at zero"
 * hypothesis is FALSIFIED (#1157 measured 0.269/0.343/0.342 against an absolute 0.337),
 * so the paired sd is measured and reported per comparison rather than assumed.
 *
 * ## Why two pre-registered bars and not one
 *
 * The lexical channel is what changed, so the effect must show in PURE BM25 — that is
 * #1159's primary target and it carries the issue's own bar,
 * {@link MIN_IMPORTANT_BM25_DELTA}. At `DEFAULT_WEIGHTS` (`0.05 / 0.95`) the lexical
 * channel carries 5% of the fused score, so a LARGE BM25 gain can legitimately show as
 * a SMALL fused gain; judging the fused channel against the BM25 bar would reject a
 * real improvement for arithmetic reasons. {@link MIN_IMPORTANT_FUSED_DELTA} is
 * therefore separate and smaller. Both are constants in this file, fixed before the
 * first arm ran, precisely so neither can be adjusted to whatever came out.
 *
 * ## The honest ceiling on the headline stratum
 *
 * #1157 disclosed, and #1158's review confirmed, that five of the 23 `naming: snake`
 * queries carry the target table's words verbatim over bare one-line header passages
 * ({@link SNAKE_UPPER_BOUND_QUERY_IDS}). A gain concentrated there is an UPPER BOUND,
 * not clean signal, so {@link summariseSnakeStratum} reports the stratum with and
 * without them and the caller prints both.
 *
 * Pure and injectable: the searcher is a seam, so everything here is unit tested with
 * no weights, no network and no store.
 */
import {
  HybridCodeSearch,
  tokenizeCodeRoots,
  buildSymbolDocumentText,
  DEFAULT_LEXICAL_CONFIG,
  type LexicalConfig,
  type SearchableSymbol,
  type SearchWeights,
  type SymbolIndex,
  type SymbolVectorStore,
} from "../../code-graph/hybrid-search.js";
import type { EmbedService } from "../../code-graph/symbol-embeddings.js";
import type { EmbedRetrievalCorpus } from "./corpus.js";
import { scoreQuery, type QueryScore } from "./metrics.js";
import { bootstrapMean, compareArms, type MeanWithCi, type PairedComparison } from "./stats.js";
import {
  classifyDelta,
  sampleSd,
  testsAgree,
  type RerankVerdict as DeltaVerdict,
} from "./rerank-sweep.js";
import {
  compareMissSets,
  exactNameProbes,
  type MissSetDelta,
  type SweepRow,
} from "./weight-sweep.js";

/** Rank depth every arm is scored at — the `@10` in nDCG@10. */
export const LEXICAL_K = 10;

/**
 * PRE-REGISTERED, pure-BM25 channel: #1159's own primary target, "+0.05 nDCG@10 from
 * the re-baselined 0.143". The lexical channel is the thing that changed, so this is
 * where the effect has to show, and this is the bar it has to clear.
 */
export const MIN_IMPORTANT_BM25_DELTA = 0.05;

/**
 * PRE-REGISTERED, fused channel at `DEFAULT_WEIGHTS`.
 *
 * Smaller than {@link MIN_IMPORTANT_BM25_DELTA} for an arithmetic reason, not a
 * convenient one: at `bm25Weight: 0.05` the lexical channel contributes 5% of the RRF
 * score, so the same change cannot move the fused number as far. `0.02` is the bottom
 * of the ±0.02–0.06 band #1156 says its sub-issues will produce; below it the epic
 * itself treats a move as noise.
 *
 * #1159's fused criterion is primarily NON-REGRESSION. Read a fused
 * `NOT-ESTABLISHED` with a positive point estimate as "no harm shown", not as failure.
 */
export const MIN_IMPORTANT_FUSED_DELTA = 0.02;

/**
 * The five `naming: snake` queries whose requirement text carries the target table's
 * words verbatim, over bare one-line header passages.
 *
 * Disclosed by #1157 and confirmed by #1158's review. They are NOT excluded from the
 * corpus — they are legitimate requirements — but a lexical gain concentrated in them
 * is close to tautological, so the stratum is reported both ways and the reader gets
 * to see the difference rather than being handed the flattering half.
 */
export const SNAKE_UPPER_BOUND_QUERY_IDS: readonly string[] = [
  "Q113",
  "Q114",
  "Q116",
  "Q117",
  "Q118",
];

/**
 * The tokenizer production shipped BEFORE #1159, frozen.
 *
 * A copy, deliberately: the baseline arm must not move when production moves, which is
 * exactly what would happen if this delegated to `tokenizeCode`. The copy is verified
 * against the eight-row table in #1159's finding (`lexical-ab.test.ts`), which is the
 * ground truth for what the function used to do, so it cannot silently be the wrong
 * baseline.
 */
export function legacyTokenizeCode(text: string): string[] {
  const expanded = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return expanded
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Lever 2's candidate document text — **MEASURED AND REJECTED**. Kept because a
 * negative result that cannot be reproduced is not a result (#1156: "a change that
 * does not move nDCG@10 is reverted and recorded").
 *
 * On `embedretrieval-02-nl-to-code` this arm came out WORSE than the shipped
 * `name + qualifiedName` document, on both counts that matter:
 *
 *   - pure BM25 nDCG@10 **0.056 → 0.053**, Δ −0.004, 95% CI [−0.012, +0.001],
 *     sign p = 1.000, 4/127 non-zero deltas → NOT-ESTABLISHED, pointing DOWN;
 *   - it lost **`testConnection`** from the exact-name #1 set (2/155 → 3/155), which
 *     is #1159's hard stop on its own.
 *
 * The likely mechanism, for whoever revisits this: `kind` and `language` are almost
 * constant across the index, so they carry near-zero IDF while still inflating every
 * document's length — and BM25's length normalisation then penalises the documents
 * that gained the least. `filePath` is worse than neutral for schema symbols, where
 * every table and column in the corpus shares one `schema.prisma` path. A useful
 * follow-up is not "add more fields" but "add a field with real per-symbol entropy",
 * which on this schema means the signature or the docstring — and those need columns
 * `CodeSymbol` does not have, which #1159 puts out of scope.
 *
 * The candidate is the shipped `name + qualifiedName`, widened with the fields a
 * production `CodeSymbol` row can ACTUALLY supply.
 *
 * `signature` and `docstring` are not among them — `CodeSymbol` has no such columns
 * (`server/prisma/schema.prisma`), so they are unreachable in production and adding
 * them would need a schema change and an ingest change, which #1159 puts out of scope.
 * `filePath`, `kind` and `language` need neither: the first two are already in
 * `SYMBOL_SELECT`, and `language` is an existing column.
 *
 * `filePath` is passed through the tokenizer's own separator handling rather than
 * pre-split, so `finops/budget-enforcer.ts` contributes `finops budget enforcer ts`
 * exactly as it would if it were part of any other field.
 */
export function enrichedDocumentText(sym: SearchableSymbol): string {
  const parts = [buildSymbolDocumentText(sym), sym.filePath, sym.kind];
  if (sym.language) parts.push(sym.language);
  return parts.join(" ");
}

/** One arm: a label, the lexical configuration it scores, and what it isolates. */
export interface LexicalArmSpec {
  id: string;
  label: string;
  config: LexicalConfig;
}

/**
 * The four arms, in the order the report prints them. `baseline` is production at
 * `bb86b146`; `combined` is what a naive "ship both" PR would have measured.
 */
export const LEXICAL_ARMS: readonly LexicalArmSpec[] = [
  {
    id: "baseline",
    label: "baseline (production at bb86b146)",
    config: { tokenizer: legacyTokenizeCode, buildDocumentText: buildSymbolDocumentText },
  },
  {
    id: "tokenizer",
    label: "lever 1 — snake_case split, additive",
    config: {
      tokenizer: DEFAULT_LEXICAL_CONFIG.tokenizer,
      buildDocumentText: buildSymbolDocumentText,
    },
  },
  {
    id: "document",
    label: "lever 2 — filePath + kind + language in the BM25 document",
    config: { tokenizer: legacyTokenizeCode, buildDocumentText: enrichedDocumentText },
  },
  {
    id: "combined",
    label: "both levers",
    config: {
      tokenizer: DEFAULT_LEXICAL_CONFIG.tokenizer,
      buildDocumentText: enrichedDocumentText,
    },
  },
];

/** Rank a query through one arm and return the ranked symbol ids. */
export type LexicalSearch = (query: string, limit: number) => Promise<string[]>;

/** Everything {@link createLexicalArmSearch} needs to build one arm's searcher. */
export interface LexicalSearchDeps {
  vectorStore: SymbolVectorStore;
  symbolIndex: SymbolIndex;
  embedService: EmbedService;
  projectId: string;
  weights: SearchWeights;
}

/**
 * One arm's searcher: the PRODUCTION {@link HybridCodeSearch}, with the arm's lexical
 * configuration as the only free variable.
 *
 * Every arm shares the same vector store, the same index and the same embed service,
 * so the vectors are byte-identical across arms and the only thing that can move a
 * number is the lexical channel. That is what makes a paired per-query delta here
 * attributable to the tokenizer (or the document text) rather than to a re-embed.
 */
export function createLexicalArmSearch(
  deps: LexicalSearchDeps,
  config: LexicalConfig,
): LexicalSearch {
  const search = new HybridCodeSearch(
    deps.vectorStore,
    deps.symbolIndex,
    deps.embedService,
    config,
  );
  return async (query, limit) => {
    const hits = await search.search(query, deps.projectId, { limit, weights: deps.weights });
    return hits.map((h) => h.symbolId);
  };
}

export interface LexicalArmResult {
  armId: string;
  label: string;
  ndcg10: number;
  ndcg10Ci: MeanWithCi;
  mrr: number;
  /** Per-query scores — the unit of every paired comparison below. */
  perQuery: QueryScore[];
  /** Fraction of exact-name lookups whose target came back RANKED #1. */
  exactNameTop1: number;
  exactNameCount: number;
  /** The exact-name lookups that did NOT come back #1 — named, never just counted. */
  exactNameMisses: string[];
}

/**
 * Score one arm: nDCG@10 with its absolute CI, MRR, and the exact-name regression
 * suite WITH its miss set.
 *
 * The exact-name probes are not optional here. #1159's hard stop is "any change to the
 * exact-name miss set is a regression, full stop, even if aggregate nDCG rises", and
 * that is uncheckable without them.
 */
export async function scoreLexicalArm(
  corpus: EmbedRetrievalCorpus,
  search: LexicalSearch,
  spec: Pick<LexicalArmSpec, "id" | "label">,
): Promise<LexicalArmResult> {
  const perQuery: QueryScore[] = [];
  for (const q of corpus.queries) {
    perQuery.push(scoreQuery(q.id, await search(q.requirement, LEXICAL_K), q.relevant));
  }

  const exactNameMisses: string[] = [];
  let top1 = 0;
  const probes = exactNameProbes(corpus);
  for (const probe of probes) {
    const ranked = await search(probe.query, LEXICAL_K);
    if (ranked[0] === probe.targetId) top1 += 1;
    else exactNameMisses.push(probe.query);
  }

  const ndcgs = perQuery.map((s) => s.ndcgAtK[LEXICAL_K] ?? 0);
  return {
    armId: spec.id,
    label: spec.label,
    ndcg10: ndcgs.reduce((a, b) => a + b, 0) / (ndcgs.length || 1),
    ndcg10Ci: bootstrapMean(ndcgs),
    mrr: perQuery.reduce((s, q) => s + q.reciprocalRank, 0) / (perQuery.length || 1),
    perQuery,
    exactNameTop1: probes.length === 0 ? 0 : top1 / probes.length,
    exactNameCount: probes.length,
    exactNameMisses,
  };
}

export interface LexicalComparison {
  armId: string;
  label: string;
  ndcgBaseline: number;
  ndcgArm: number;
  paired: PairedComparison;
  /** Per-query deltas that are not exactly zero — the bootstrap's effective sample. */
  nonZeroDeltas: number;
  /** Sample sd of the per-query deltas: the paired spread, MEASURED not projected. */
  pairedSd: number;
  /** The bar this comparison was judged against — carried so the artifact is self-describing. */
  minDelta: number;
  verdict: DeltaVerdict;
  /** False when the bootstrap CI and the exact sign test disagree — reported, never hidden. */
  testsAgree: boolean;
  missSet: MissSetDelta;
}

/** Per-query nDCG@10 keyed by query id — the unit of the paired comparison. */
function ndcgByQuery(arm: LexicalArmResult): ReadonlyMap<string, number> {
  return new Map(arm.perQuery.map((q) => [q.queryId, q.ndcgAtK[LEXICAL_K] ?? 0]));
}

/**
 * `compareMissSets` speaks {@link SweepRow}; an arm carries the same field under the
 * same name. Adapting rather than reimplementing keeps ONE definition of "the miss set
 * moved" in the repo (the same choice #1158 made).
 */
function asSweepRow(arm: LexicalArmResult): SweepRow {
  return { exactNameMisses: arm.exactNameMisses } as SweepRow;
}

/** Compare one arm against the baseline on one channel's per-query nDCG@10. */
export function compareLexicalArm(
  baseline: LexicalArmResult,
  arm: LexicalArmResult,
  minDelta: number,
): LexicalComparison {
  const paired = compareArms(
    `${arm.armId} vs baseline`,
    arm.armId,
    baseline.armId,
    ndcgByQuery(arm),
    ndcgByQuery(baseline),
  );

  const base = ndcgByQuery(baseline);
  const deltas: number[] = [];
  for (const [id, v] of ndcgByQuery(arm)) {
    const b = base.get(id);
    if (b !== undefined) deltas.push(v - b);
  }

  return {
    armId: arm.armId,
    label: arm.label,
    ndcgBaseline: baseline.ndcg10,
    ndcgArm: arm.ndcg10,
    paired,
    nonZeroDeltas: deltas.filter((d) => d !== 0).length,
    pairedSd: sampleSd(deltas),
    minDelta,
    verdict: classifyDelta(paired, minDelta),
    testsAgree: testsAgree(paired),
    missSet: compareMissSets(asSweepRow(baseline), asSweepRow(arm)),
  };
}

/**
 * Re-derive one arm's aggregates over the corpus MINUS a set of query ids.
 *
 * ## Why the harness needs this and a stratum table was not enough
 *
 * {@link summariseSnakeStratum} already reported the `naming: snake` slice with and
 * without {@link SNAKE_UPPER_BOUND_QUERY_IDS}. That is the right disclosure and it is
 * not the DECISION. The verdict — the aggregate Δ, the paired CI and the sign test that
 * {@link compareLexicalArm} feeds to `classifyDelta` — was computed only over the full
 * query set, and on `embedretrieval-02-nl-to-code` all five disclosed upper-bound
 * queries turned out to be among the nine movers. So the classification rested on the
 * flattered queries while the honest half of the disclosure sat in a different table
 * (PR #1177 review).
 *
 * Feeding BOTH arms through this function and re-running `compareLexicalArm` re-derives
 * the decision statistic on the clean subset, so the artifact can print both
 * classifications side by side instead of leaving the reader to infer one.
 *
 * ## What is recomputed and what deliberately is NOT
 *
 * `perQuery`, and everything derived from it (`ndcg10`, its CI, `mrr`), are recomputed
 * from the survivors — carrying the full-set aggregate onto a filtered arm would
 * reproduce the exact defect this exists to remove.
 *
 * The exact-name fields are carried through UNCHANGED, on purpose. The exact-name suite
 * is keyed by SYMBOL NAME and runs outside `corpus.queries` ({@link scoreLexicalArm}),
 * so excluding a corpus query cannot move it; recomputing or blanking it would invent a
 * number, and #1159's hard stop is read off that field.
 *
 * The default is the five disclosed queries rather than an open parameter, so this
 * cannot quietly become a general query filter that lets a later caller choose whichever
 * subset flatters an arm.
 */
export function excludeQueries(
  arm: LexicalArmResult,
  excludeIds: readonly string[] = SNAKE_UPPER_BOUND_QUERY_IDS,
): LexicalArmResult {
  const excluded = new Set(excludeIds);
  const perQuery = arm.perQuery.filter((q) => !excluded.has(q.queryId));
  const ndcgs = perQuery.map((s) => s.ndcgAtK[LEXICAL_K] ?? 0);
  return {
    ...arm,
    perQuery,
    ndcg10: ndcgs.reduce((a, b) => a + b, 0) / (ndcgs.length || 1),
    ndcg10Ci: bootstrapMean(ndcgs),
    mrr: perQuery.reduce((s, q) => s + q.reciprocalRank, 0) / (perQuery.length || 1),
  };
}

/** One arm's `naming: snake` slice, reported with and without the five upper-bound queries. */
export interface SnakeStratumSummary {
  armId: string;
  /** All 23 `naming: snake` queries. */
  allQueries: number;
  allNdcg10: number;
  /** The same stratum minus {@link SNAKE_UPPER_BOUND_QUERY_IDS}. */
  cleanQueries: number;
  cleanNdcg10: number;
  /** The five upper-bound queries on their own — the number to distrust. */
  upperBoundQueries: number;
  upperBoundNdcg10: number;
}

/**
 * Slice one arm's per-query scores by the `naming: snake` stratum, three ways.
 *
 * `snakeQueryIds` is passed in rather than re-derived: `deriveStrata` already owns that
 * definition (`corpus.ts`) and a second copy of it here would be a second thing to keep
 * in sync with the corpus.
 */
export function summariseSnakeStratum(
  arm: LexicalArmResult,
  snakeQueryIds: ReadonlySet<string>,
  upperBoundIds: readonly string[] = SNAKE_UPPER_BOUND_QUERY_IDS,
): SnakeStratumSummary {
  const upper = new Set(upperBoundIds);
  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const inStratum = arm.perQuery.filter((q) => snakeQueryIds.has(q.queryId));
  const ndcg = (qs: QueryScore[]): number[] => qs.map((q) => q.ndcgAtK[LEXICAL_K] ?? 0);
  const clean = inStratum.filter((q) => !upper.has(q.queryId));
  const flattered = inStratum.filter((q) => upper.has(q.queryId));

  return {
    armId: arm.armId,
    allQueries: inStratum.length,
    allNdcg10: mean(ndcg(inStratum)),
    cleanQueries: clean.length,
    cleanNdcg10: mean(ndcg(clean)),
    upperBoundQueries: flattered.length,
    upperBoundNdcg10: mean(ndcg(flattered)),
  };
}

/**
 * A corpus statistic #1159 rests on: how many indexed symbols carry an underscore in
 * their name, i.e. how much of the corpus the tokenizer change can reach at all.
 *
 * Reported because a lever that can only touch 3% of the index cannot produce a large
 * aggregate move however well it works, and saying so up front is cheaper than
 * explaining a small number afterwards.
 */
export function underscoreSymbolShare(corpus: EmbedRetrievalCorpus): {
  withUnderscore: number;
  total: number;
  share: number;
} {
  const total = corpus.searchable.length;
  const withUnderscore = corpus.searchable.filter((s) => s.name.includes("_")).length;
  return { withUnderscore, total, share: total === 0 ? 0 : withUnderscore / total };
}

/**
 * The BM25 document a symbol produces under each arm, for the artifact.
 *
 * This is the check that keeps the harness honest about lever 2: it prints what the
 * index actually saw, so a reader can confirm the enriched arm added the fields it
 * claims and — more importantly — that the BASELINE arm's document is `name +
 * qualifiedName` and nothing else, which is what production indexes.
 */
export function describeArmDocuments(
  sym: SearchableSymbol,
  arms: readonly LexicalArmSpec[] = LEXICAL_ARMS,
): Array<{ armId: string; documentText: string; terms: string[] }> {
  return arms.map((a) => {
    const documentText = a.config.buildDocumentText(sym);
    return { armId: a.id, documentText, terms: a.config.tokenizer(documentText) };
  });
}

const f3 = (n: number): string => n.toFixed(3);

/** The per-arm results table the PR and the issue comment quote. */
export function renderLexicalArms(
  baseline: LexicalArmResult,
  arms: readonly LexicalArmResult[],
  comparisons: readonly LexicalComparison[],
): string {
  const lines = [
    `| arm | nDCG@10 | 95% CI (absolute) | MRR | exact-name #1 | miss set vs baseline |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const arm of [baseline, ...arms]) {
    const cmp = comparisons.find((c) => c.armId === arm.armId);
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
      `| \`${arm.armId}\` — ${arm.label} | ${f3(arm.ndcg10)} | ` +
        `[${f3(arm.ndcg10Ci.ciLow)}, ${f3(arm.ndcg10Ci.ciHigh)}] | ${f3(arm.mrr)} | ` +
        `${(arm.exactNameTop1 * 100).toFixed(0)}% (${arm.exactNameCount}) | ${missCell} |`,
    );
  }
  return lines.join("\n");
}

/** The paired-decision table — the one #1156's revert rule is read off. */
export function renderLexicalDecision(comparisons: readonly LexicalComparison[]): string {
  const lines = [
    `| arm | Δ nDCG@10 | paired 95% CI | paired sd | non-zero Δ / n | wins/losses/ties | sign p | tests agree? | bar | verdict |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const c of comparisons) {
    lines.push(
      `| \`${c.armId}\` | ${c.paired.meanDelta >= 0 ? "+" : ""}${f3(c.paired.meanDelta)} | ` +
        `[${f3(c.paired.ciLow)}, ${f3(c.paired.ciHigh)}] | ${f3(c.pairedSd)} | ` +
        `${c.nonZeroDeltas}/${c.paired.n} | ` +
        `${c.paired.wins}/${c.paired.losses}/${c.paired.ties} | ${c.paired.signTestP.toFixed(3)} | ` +
        `${c.testsAgree ? "yes" : "**NO — sign test wins**"} | +${f3(c.minDelta)} | ` +
        `**${c.verdict}** |`,
    );
  }
  return lines.join("\n");
}

/** The snake stratum, with and without the five upper-bound queries. */
export function renderSnakeStratum(summaries: readonly SnakeStratumSummary[]): string {
  const lines = [
    `| arm | snake (all) | n | snake MINUS the 5 upper-bound | n | the 5 upper-bound alone | n |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const s of summaries) {
    lines.push(
      `| \`${s.armId}\` | ${f3(s.allNdcg10)} | ${s.allQueries} | ${f3(s.cleanNdcg10)} | ` +
        `${s.cleanQueries} | ${f3(s.upperBoundNdcg10)} | ${s.upperBoundQueries} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Assert the corpus's searchable view carries no field production cannot supply.
 *
 * #1159's second finding is that `SearchableSymbol.signature` and `.docstring` are
 * structurally unreachable in production, and its explicit warning is that the harness
 * can therefore FLATTER a document-enrichment result. This turns that warning into a
 * check: if a corpus ever starts populating those fields, every lever-2 number measured
 * on it is measuring something production cannot do, and the run must fail rather than
 * print a number nobody can act on.
 */
export function assertProductionReachableFields(corpus: EmbedRetrievalCorpus): void {
  const offenders = corpus.searchable
    .filter((s) => s.signature !== undefined || s.docstring !== undefined)
    .map((s) => s.symbolId);
  if (offenders.length > 0) {
    throw new Error(
      `the corpus populates SearchableSymbol.signature/.docstring on ${offenders.length} ` +
        `symbol(s) (e.g. ${offenders.slice(0, 3).join(", ")}). \`CodeSymbol\` has no such ` +
        `columns and \`SYMBOL_SELECT\` does not read them, so a BM25 document built from ` +
        `them is unreachable in production and any lever-2 delta measured here would be ` +
        `harness-only. Fix the corpus, do not relax this check.`,
    );
  }
}

/** Re-exported so the CLI's tokenizer sanity print uses the one definition. */
export { tokenizeCodeRoots };
