/**
 * Epic #507 / Issue #509 — Hybrid code search combining BM25 and vector similarity.
 *
 * `HybridCodeSearch.search()` returns ranked symbols using both BM25 (keyword)
 * and vector similarity (semantic), fused via Reciprocal Rank Fusion (RRF).
 *
 * BM25 index is built from symbol names, signatures, and docstrings.
 * Vector search uses embeddings from issue #508.
 */
import { createChildLogger } from "../logger.js";
import type { EmbedService, SymbolEmbeddingMetadata } from "./symbol-embeddings.js";

const log = createChildLogger("hybrid-search");

// ---- Types ----------------------------------------------------------------

export interface SearchableSymbol {
  symbolId: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  /**
   * `ts | js | py | go | java | sql` — a real `CodeSymbol` column, unlike the two
   * fields below, so it is retrievable without a schema change.
   *
   * Production's `SYMBOL_SELECT` deliberately does NOT read it. #1159 measured
   * adding `filePath + kind + language` to the BM25 document and the arm came out
   * WORSE: pure-BM25 nDCG@10 0.056 → 0.053 (Δ −0.004, 95% CI [−0.012, +0.001],
   * sign p = 1.000) and it lost `testConnection` from the exact-name #1 set. The
   * field is populated only by the eval corpus, which keeps that negative result
   * reproducible. Do not wire it into `SYMBOL_SELECT` without re-measuring.
   */
  language?: string;
  /**
   * #1159: `CodeSymbol` has NO `signature` and NO `docstring` column, and
   * `SYMBOL_SELECT` (`project-code-searcher.ts`) does not read them. These two are
   * therefore reachable only from test fixtures — production BM25 documents are
   * `name + qualifiedName`. Adding the columns is a schema + ingest change and is
   * deliberately out of #1159's scope; do not read their presence here as evidence
   * that the lexical index sees a signature.
   */
  signature?: string;
  docstring?: string;
  snippet?: string;
}

export interface HybridSearchResult {
  symbolId: string;
  filePath: string;
  name: string;
  kind: string;
  score: number;
  snippet?: string;
}

export interface HybridSearchOptions {
  /** Maximum results to return. Default: 20. */
  limit?: number;
  /** File glob pattern filter. */
  fileGlob?: string;
  /** Filter by symbol kind. */
  symbolKind?: string;
  /** Weight configuration. */
  weights?: SearchWeights;
}

export interface SearchWeights {
  bm25Weight: number;
  vectorWeight: number;
}

/**
 * RRF fusion weights — RE-SWEPT in #807 to `0.05 / 0.95` (from #797/PR #803's
 * `0.15 / 0.85`, itself from `0.4 / 0.6`).
 *
 * ## Read this first: the previous numbers were measured on BROKEN VECTORS
 *
 * #803 chose `0.15 / 0.85` from a sweep of the wired path — a sound method run on an
 * unsound input. #807 found that the `q8` ONNX graph derives ONE per-tensor activation
 * scale per batch (88 `DynamicQuantizeLinear` nodes), so every symbol's vector was
 * perturbed by whatever else shared its ingest batch: cos(batch-1, batch-64) = 0.974.
 * The whole corpus #803 swept was quantization noise on top of the real embedding.
 *
 * Fixing that (see `resolveForwardBatch` in `embed-model-config.ts`) MOVES THE VECTOR
 * CHANNEL, which makes weights tuned against the old vectors stale by construction.
 * So the sweep was re-run on the corrected corpus. This is not a second bite at the
 * fusion cherry — the vector fix stands on its own (the flagship's VECTOR rank goes
 * 18 → 12 at every weighting, and realised vector nDCG@10 0.385 → 0.461). It is that
 * the constant below was derived from data this PR invalidated.
 *
 * ## The demotion RRF causes is still structural (unchanged reasoning)
 *
 * RRF scores a symbol found by BOTH channels `w_b/(k+r_b) + w_v/(k+r_v)` and a symbol
 * found by ONE channel only the single term. A lexically-plausible-but-wrong symbol
 * (`projectMonthEnd`, `projectCosts`, `startAlertEngine` — they share
 * "project"/"month"/"start" with the requirement's ORDINARY ENGLISH, not with its
 * meaning) collects both terms and outranks a correct vector-only hit. The higher
 * `bm25Weight` is, the more that noise is worth.
 *
 * ## The evidence (`pnpm eval:embed-retrieval --wired --sweep`, gte-modernbert-base,
 * ## 183-symbol / 30-requirement committed corpus, scored through the PRODUCTION
 * ## searcher, on #807's batch-invariant vectors)
 *
 *   bm25/vector   nDCG@10   MRR     exact-name #1   flagship NL rank   in top-15?
 *   1.00 / 0.00   0.143     0.141   100% (41)       absent             no   ← pre-#797
 *   0.40 / 0.60   0.430     0.401    85% (41)       27                 no   ← #803 incumbent
 *   0.20 / 0.80   0.431     0.401    85% (41)       16                 no
 *   0.15 / 0.85   0.437     0.401    85% (41)       16                 no   ← was CHOSEN
 *   0.10 / 0.90   0.457     0.423    85% (41)       16                 no
 *   0.05 / 0.95   0.474     0.444    85% (41)       14                 YES  ← CHOSEN
 *   0.00 / 1.00   0.461     0.424    83% (41)       12                 YES
 *
 * `0.05 / 0.95` is the nDCG-MAXIMAL row (0.474), not a point chosen to clear a limit —
 * it would be the pick on retrieval quality alone. It also carries NO BM25 regression:
 * the exact-name suite's miss SET is IDENTICAL to the incumbent's, name-for-name (the
 * same 6 of 41), not merely the same count. `0.00 / 1.00` scores WORSE and starts
 * losing exact-name lookups (`userCosts`), so BM25 is kept, not zeroed.
 *
 * ## The flagship case IS now closed — and note what closed it
 *
 * The previous revision of this comment said "at NO weighting does the flagship land
 * inside the tool's DEFAULT limit of 15; the best RRF can do is 18, because 18 is where
 * the VECTOR CHANNEL ITSELF ranks it". That algebra was right and remains right —
 * fusion cannot promote a symbol above its own best channel — but its INPUT was the
 * broken vector. Once the vector channel ranks the flagship 12th, the floor is 12, and
 * 15 is reachable. The fix was the embedding, exactly as #807 required; the sweep only
 * stopped fusion from throwing away the improvement.
 */
export const DEFAULT_WEIGHTS: SearchWeights = {
  bm25Weight: 0.05,
  vectorWeight: 0.95,
};

/** RRF constant k — controls how much rank position matters. */
const RRF_K = 60;

export interface VectorSearchHit {
  metadata: SymbolEmbeddingMetadata;
  score: number;
}

export interface SymbolVectorStore {
  search(projectId: string, queryVector: number[], k: number): Promise<VectorSearchHit[]>;
}

export interface SymbolIndex {
  getSymbols(projectId: string): Promise<SearchableSymbol[]>;
  /**
   * Issue #797 — hydrate specific symbols by id.
   *
   * {@link getSymbols} is WINDOWED in production (`take: MAX_INDEXED_SYMBOLS`),
   * because building an in-memory BM25 index over every symbol of a large repo on
   * every query is not viable. That window is a BM25 concern — but the fused
   * ranking used to drop any VECTOR hit that fell outside it, which on a ~15k
   * symbol repo silently discarded two thirds of correct semantic hits AFTER the
   * vector search had already paid for them. Implement this and a vector hit is
   * never lost to the lexical index's window.
   *
   * Optional: an index whose `getSymbols` is already complete (the eval harness,
   * unit fixtures) has nothing to hydrate.
   */
  getSymbolsByIds?(projectId: string, symbolIds: string[]): Promise<SearchableSymbol[]>;
}

// ---- BM25 Implementation --------------------------------------------------

interface BM25Document {
  symbolId: string;
  text: string;
  termFreqs: Map<string, number>;
  length: number;
}

/**
 * How a {@link BM25Index} turns a symbol into text and text into terms.
 *
 * Issue #1159 — this exists so the two halves cannot be varied independently.
 * The #943 contract (see {@link tokenizeCode}) is that index-side and query-side
 * tokenization are the SAME function; bundling the tokenizer into one object that
 * {@link BM25Index.build} and {@link BM25Index.score} both read makes that true by
 * construction rather than by convention.
 *
 * Production has exactly one setting ({@link DEFAULT_LEXICAL_CONFIG}). This is a
 * SEAM, not a knob: the #1159 A/B needs to score the pre-change lexical
 * configuration and the post-change one over the same corpus and the same vectors,
 * which is impossible if the configuration is hard-coded. Nothing in `server/src`
 * outside the eval passes a non-default config.
 */
export interface LexicalConfig {
  tokenizer: (text: string) => string[];
  buildDocumentText: (sym: SearchableSymbol) => string;
}

/**
 * The BM25 document text for one symbol.
 *
 * Issue #1159 — read the field list against `SYMBOL_SELECT` in
 * `project-code-searcher.ts` before assuming this indexes more than it does.
 * `CodeSymbol` has NO `signature` and NO `docstring` column, and the production
 * select reads `id, name, qualifiedName, kind, filePath`. So in production this
 * returns `name + " " + qualifiedName` and nothing else: the two optional fields
 * below are reachable only from test fixtures and are kept because
 * {@link SearchableSymbol} still declares them.
 *
 * Do not read the `if` guards as evidence that production BM25 sees a signature.
 * It does not, and #1159 measured what happens when the document is widened with
 * fields that ARE retrievable — see the results file that issue cites.
 */
export function buildSymbolDocumentText(sym: SearchableSymbol): string {
  const parts = [sym.name, sym.qualifiedName];
  if (sym.signature) parts.push(sym.signature);
  if (sym.docstring) parts.push(sym.docstring);
  return parts.join(" ");
}

/** Production's one lexical configuration. */
export const DEFAULT_LEXICAL_CONFIG: LexicalConfig = {
  tokenizer: tokenizeCode,
  buildDocumentText: buildSymbolDocumentText,
};

/**
 * Lightweight in-memory BM25 scorer for symbol search.
 * Builds an index from symbol names, signatures, and docstrings.
 */
export class BM25Index {
  private documents: BM25Document[] = [];
  private docFreqs: Map<string, number> = new Map();
  private avgDocLength = 0;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(private readonly lexical: LexicalConfig = DEFAULT_LEXICAL_CONFIG) {}

  /**
   * Build the index from a set of searchable symbols.
   */
  build(symbols: SearchableSymbol[]): void {
    this.documents = [];
    this.docFreqs = new Map();

    for (const sym of symbols) {
      const text = this.buildDocumentText(sym);
      const terms = this.tokenize(text);
      const termFreqs = new Map<string, number>();

      for (const term of terms) {
        termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1);
      }

      this.documents.push({
        symbolId: sym.symbolId,
        text,
        termFreqs,
        length: terms.length,
      });

      // Count unique terms per document for document frequency
      for (const term of new Set(terms)) {
        this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
      }
    }

    this.avgDocLength =
      this.documents.length > 0
        ? this.documents.reduce((sum, d) => sum + d.length, 0) / this.documents.length
        : 0;
  }

  /**
   * Score all documents against a query and return ranked symbol IDs with scores.
   */
  score(query: string): Array<{ symbolId: string; score: number }> {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0 || this.documents.length === 0) return [];

    const N = this.documents.length;
    const results: Array<{ symbolId: string; score: number }> = [];

    for (const doc of this.documents) {
      let docScore = 0;

      for (const term of queryTerms) {
        const tf = doc.termFreqs.get(term) ?? 0;
        if (tf === 0) continue;

        const df = this.docFreqs.get(term) ?? 0;
        // IDF with smoothing
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        // BM25 TF component
        const tfNorm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDocLength)));

        docScore += idf * tfNorm;
      }

      if (docScore > 0) {
        results.push({ symbolId: doc.symbolId, score: docScore });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private buildDocumentText(sym: SearchableSymbol): string {
    return this.lexical.buildDocumentText(sym);
  }

  private tokenize(text: string): string[] {
    return this.lexical.tokenizer(text);
  }
}

/**
 * Split identifier/prose text into BM25 terms: expand camelCase/PascalCase into
 * separate words, lowercase, drop non-`[a-z0-9_]`, discard single-character
 * tokens, and — since #1159 — ADDITIVELY split on `_`.
 *
 * Exported so query-side preprocessors (e.g. the requirement→code mapper's
 * stopword filter, #943) tokenize IDENTICALLY to the index — a query preprocessed
 * with a different tokenizer could keep/drop different terms than
 * {@link BM25Index} scores, silently desyncing the two. There are exactly two such
 * consumers, and both call THIS function:
 *
 *   - `BM25Index` itself, via {@link DEFAULT_LEXICAL_CONFIG};
 *   - `denoiseRequirementQuery` (`traceability/requirement-code-mapping.ts`), whose
 *     stopword set is applied to the tokens this returns.
 *
 * ## Why the underscore split, and why ADDITIVE (#1159)
 *
 * The pre-#1159 filter was `[^a-z0-9_]`, which deliberately preserved `_`, so
 * `order_status` stayed ONE opaque term and the query "order status" shared no term
 * with it at all — not a weak match, no match. That is disproportionately expensive
 * here because `CodeSymbol.kind` includes `table | column` and `language` includes
 * `sql` (`server/prisma/schema.prisma`): SQL tables and columns are first-class
 * indexed symbols and their names are overwhelmingly snake_case.
 *
 * The split is ADDITIVE — the joined original is emitted FIRST, then its parts —
 * because pure BM25 ranks an exact-name lookup #1 for every ground-truth symbol in
 * the eval corpus, and `order_status` is that lookup's highest-IDF term. Emitting
 * only `["order","status"]` would trade a measured 100% exact-name result for a
 * hoped-for recall gain. `hybrid-search.test.ts` asserts both halves.
 *
 * The single-character rule is unchanged on purpose (#1159 scope item 2): `id`
 * (length 2) survives the split of `project_id`, while `a_b` contributes only its
 * joined form. Admitting one-character tokens is a separate claim needing its own
 * measurement.
 *
 * ## What it measured (`pnpm eval:embed-retrieval --lexical-ab`, 127 queries / 794
 * ## symbols, `embedretrieval-02-nl-to-code`)
 *
 *   channel        baseline   after    Δ        paired 95% CI      sign p   verdict
 *   pure BM25      0.056      0.109    +0.053   [+0.020, +0.093]   0.004    direction only
 *   fused 0.05/95  0.276      0.282    +0.006   [+0.000, +0.015]   0.500    not established
 *
 * 9 wins, 0 losses, 118 ties on pure BM25 — one-directional. The `naming: snake`
 * stratum goes 0.000 → 0.294, and 0.000 → 0.146 with the five queries that carry
 * their target table's words verbatim removed, so the gain is not only the flattered
 * ones. Only 53 of 794 indexed names carry an underscore (6.7%), which is why an
 * effect that DOUBLES the lexical channel still moves the aggregate a few points.
 *
 * ## The headline is PARTLY carried by the five disclosed queries — quote both
 *
 * All five upper-bound queries (Q113/114/116/117/118 → `workspace_members`,
 * `workspace_invites`, `user_roles`, `role_permissions`, `audit_logs`) are among the
 * nine pure-BM25 movers, so the decision statistic is reported BOTH ways and the
 * harness now prints both tables (`--lexical-ab`, `excludeQueries` in `lexical-ab.ts`):
 *
 *   pure BM25      Δ         sign test          verdict
 *   all 127        +0.053    9/0, p = 0.004     DIRECTION-ESTABLISHED-MAGNITUDE-NOT
 *   minus the 5    +0.022    4/0, p = 0.125     NOT-ESTABLISHED
 *
 * `+0.022` is the figure a follow-up should inherit as its baseline, NOT `+0.053`.
 * On the clean subset the bootstrap lower bound rounds to +0.000 while the sign test
 * misses α = 0.05, so the two tests disagree and `stats.ts`'s rule — believe the sign
 * test — governs. The change still ships: 4 wins / 0 losses with zero measured losses
 * anywhere, and the un-flattered snake stratum rises from a literal 0.000 to 0.146.
 * The FUSED delta is unchanged by the exclusion (+0.006 either way, 2/0/120), because
 * the five score 0.000 on the fused channel in both arms — the fused number never
 * depended on them.
 *
 * ## The one measured cost, stated where it will be found
 *
 * On the FUSED channel the exact-name suite went 77% → 76% of 155: `extract_usage`
 * stopped ranking #1. It is NOT the joined form failing — `extract_usage` is still
 * BM25 rank 1, and by a wider margin than before (17.5 vs 9.5). It is RRF's
 * documented both-channels bonus (see {@link DEFAULT_WEIGHTS} above): pre-#1159 the
 * query `extract_usage` matched exactly ONE document, so BM25 uniquely lifted the
 * exact match; post-#1159 it matches 52, and `ExtractUsageRequest` — which the VECTOR
 * channel already ranked #1 (cos 0.690 vs 0.650) — now collects a second RRF term
 * worth 0.05/62 and edges ahead, 0.016380 vs 0.016142. The pure-BM25 miss set is
 * IDENTICAL before and after, which is the guard #1159 actually specified. Anything
 * that would recover it is a weights or fusion change, which #1156 rules out.
 *
 * The fused ledger is strictly −1 / +0: NOT ONE name is recovered. Every snake_case
 * table in the baseline fused miss set (`alert_channels`, `alert_events`,
 * `alert_rules`, `audit_logs`, `config_audit`, `cost_forecasts`, `role_permissions`,
 * `runtime_config`, `token_usages`, `user_roles`, `workspace_invites`,
 * `workspace_members`, `workspace_usage_daily`, `workspaces`) is still there
 * afterwards. Do not read "77% → 76%" as a net of offsetting moves; it is one loss
 * and no gains, and the +0.006 nDCG@10 does not cancel it — they are separate ledgers.
 */
export function tokenizeCode(text: string): string[] {
  const out: string[] = [];
  for (const term of tokenizeCodeRoots(text)) {
    out.push(term);
    if (!term.includes("_")) continue;
    for (const part of term.split("_")) {
      // Same length rule as the root stage; this also drops the empty strings that
      // leading, trailing and repeated underscores produce (`__init__`, `_leading`).
      if (part.length > 1) out.push(part);
    }
  }
  return out;
}

/**
 * {@link tokenizeCode}'s first stage: the same expansion, lowercasing, filtering
 * and single-character rule, WITHOUT the #1159 underscore split.
 *
 * **This is not a second tokenizer** — it is the one tokenizer's pre-split stage,
 * and `tokenizeCode` is defined in terms of it, so the two cannot drift. It exists
 * for exactly one job: rebuilding a QUERY STRING that something else will re-tokenize.
 *
 * The hazard it removes is real and silent. `tokenizeCode` is no longer idempotent
 * under join-and-retokenize — `tokenizeCode("order_status")` is
 * `["order_status","order","status"]`, and joining that back into
 * `"order_status order status"` re-derives the parts a SECOND time, doubling their
 * query-side term frequency and thereby their BM25 contribution. Any caller that
 * tokenizes a query, filters it, and joins the survivors back into a string (the
 * #943 requirement→code mapper, `denoiseRequirementQuery`) must filter over ROOTS so
 * that the re-tokenization produces each term exactly once.
 *
 * The property that makes this safe is asserted in `hybrid-search.test.ts`:
 * `tokenizeCode(tokenizeCodeRoots(t).join(" "))` equals `tokenizeCode(t)`.
 */
export function tokenizeCodeRoots(text: string): string[] {
  // Split camelCase/PascalCase before lowercasing
  const expanded = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return expanded
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// ---- Reciprocal Rank Fusion -----------------------------------------------

/**
 * Reciprocal Rank Fusion (RRF) combines multiple ranked lists into one.
 * score = sum(1 / (k + rank_i)) for each list where the item appears.
 */
export function reciprocalRankFusion(
  rankedLists: Array<Array<{ id: string; score: number }>>,
  k: number = RRF_K,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfScore = 1 / (k + rank + 1); // rank is 0-based, RRF uses 1-based
      scores.set(item.id, (scores.get(item.id) ?? 0) + rrfScore);
    }
  }

  const results = Array.from(scores.entries()).map(([id, score]) => ({ id, score }));
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---- Hybrid Search --------------------------------------------------------

export class HybridCodeSearch {
  private readonly bm25: BM25Index;
  private bm25CacheKey = "";

  constructor(
    private readonly vectorStore: SymbolVectorStore,
    private readonly symbolIndex: SymbolIndex,
    private readonly embedService: EmbedService,
    /**
     * Issue #1159 — a SEAM for the lexical A/B, not a production knob. Production
     * constructs this class in exactly one place (`createDefaultCodeSearcher`) and
     * passes nothing, so it gets {@link DEFAULT_LEXICAL_CONFIG}. The eval passes the
     * frozen pre-#1159 configuration to measure the change it made.
     */
    lexical: LexicalConfig = DEFAULT_LEXICAL_CONFIG,
  ) {
    this.bm25 = new BM25Index(lexical);
  }

  /**
   * Compute a cache key for the BM25 index based on symbol IDs and filters.
   * Rebuilds the index only when the underlying symbol set changes.
   */
  private computeBm25CacheKey(
    symbols: SearchableSymbol[],
    fileGlob?: string,
    symbolKind?: string,
  ): string {
    // Use sorted symbol IDs + filter params as the cache key
    const ids = symbols
      .map((s) => s.symbolId)
      .sort()
      .join(",");
    return `${ids}|${fileGlob ?? ""}|${symbolKind ?? ""}`;
  }

  /**
   * Issue #797 — pull vector-hit symbols the windowed lexical index did not
   * return, and add them to `symbolMap` if they satisfy the active pre-filters.
   * No-op when the index cannot hydrate (test fixtures, the eval harness) or
   * every hit is already present.
   */
  private async hydrateMissing(
    projectId: string,
    hitIds: string[],
    symbolMap: Map<string, SearchableSymbol>,
    fileGlob?: string,
    symbolKind?: string,
  ): Promise<void> {
    const hydrate = this.symbolIndex.getSymbolsByIds?.bind(this.symbolIndex);
    if (!hydrate) return;
    const missing = [...new Set(hitIds.filter((id) => !symbolMap.has(id)))];
    if (missing.length === 0) return;

    const extra = await hydrate(projectId, missing);
    for (const sym of extra) {
      if (fileGlob && !matchGlob(sym.filePath, fileGlob)) continue;
      if (symbolKind && sym.kind !== symbolKind) continue;
      // NOTE: deliberately NOT added to the BM25 index. These symbols were never
      // lexically scored, and injecting them would change the BM25 ranking as a
      // side effect of a vector hit.
      symbolMap.set(sym.symbolId, sym);
    }
    log.debug("hydrated vector hits outside the BM25 window", {
      projectId,
      missing: missing.length,
      hydrated: extra.length,
    });
  }

  /**
   * Search for symbols using hybrid BM25 + vector similarity with RRF fusion.
   */
  async search(
    query: string,
    projectId: string,
    opts: HybridSearchOptions = {},
  ): Promise<HybridSearchResult[]> {
    const { limit = 20, fileGlob, symbolKind, weights = DEFAULT_WEIGHTS } = opts;

    // Load symbols for BM25 index
    const allSymbols = await this.symbolIndex.getSymbols(projectId);
    if (allSymbols.length === 0) return [];

    // Apply pre-filters
    let filteredSymbols = allSymbols;
    if (fileGlob) {
      filteredSymbols = filteredSymbols.filter((s) => matchGlob(s.filePath, fileGlob));
    }
    if (symbolKind) {
      filteredSymbols = filteredSymbols.filter((s) => s.kind === symbolKind);
    }

    // Build symbol lookup map
    const symbolMap = new Map<string, SearchableSymbol>();
    for (const sym of filteredSymbols) {
      symbolMap.set(sym.symbolId, sym);
    }

    // BM25 scoring — rebuild index only when symbol set changes
    const cacheKey = this.computeBm25CacheKey(filteredSymbols, fileGlob, symbolKind);
    if (cacheKey !== this.bm25CacheKey) {
      this.bm25.build(filteredSymbols);
      this.bm25CacheKey = cacheKey;
      log.debug("BM25 index rebuilt", { projectId, symbolCount: filteredSymbols.length });
    }
    const bm25Results = this.bm25.score(query);

    // Vector search — SKIPPED ENTIRELY when the vector channel is weighted out.
    //
    // This is not merely an optimisation (though it does avoid a pointless embed
    // call + vector-store round-trip). The RRF loop below adds each vector hit
    // via `fusedScores.set(id, (get(id) ?? 0) + weight/(k+rank+1))`. At
    // `vectorWeight: 0` the added score is 0 — but `.set()` STILL INSERTS THE ID.
    // `BM25Index.score()` only returns documents with a non-zero term match
    // (often far fewer than `limit`), so those zero-scored vector hits would pad
    // the tail of the result list in vector-rank order. A caller that asks for a
    // purely lexical ranking would silently receive vector-derived results.
    // Cutting the channel off at the source makes `vectorWeight: 0` mean what it
    // says.
    let vectorResults: Array<{ id: string; score: number }> = [];
    if (weights.vectorWeight > 0) {
      try {
        const queryEmbedding = await this.embedService.embed([query]);
        if (queryEmbedding.vectors.length > 0) {
          const vectorHits = await this.vectorStore.search(
            projectId,
            queryEmbedding.vectors[0],
            limit * 2, // fetch more to allow for filtering
          );

          // Issue #797 — HYDRATE hits that fall outside the BM25 window.
          //
          // `symbolMap` is built from the (windowed) lexical index, and the filter
          // below drops anything missing from it. On a repo with more symbols than
          // the window holds, that quietly threw away correct vector hits — the
          // exact hits the semantic channel exists to find, discarded after the
          // embed + search had already been paid for. Fetching the missing ids by
          // primary key costs one indexed query and makes the window a property of
          // the lexical index alone.
          await this.hydrateMissing(
            projectId,
            vectorHits.map((h) => h.metadata.symbolId),
            symbolMap,
            fileGlob,
            symbolKind,
          );

          // Filter vector results to match our pre-filters. A hit still missing
          // from `symbolMap` here failed `fileGlob`/`symbolKind` (or no longer
          // exists) — those SHOULD be dropped.
          vectorResults = vectorHits
            .filter((hit) => symbolMap.has(hit.metadata.symbolId))
            .map((hit) => ({ id: hit.metadata.symbolId, score: hit.score }));
        }
      } catch (err) {
        log.warn("Vector search failed, falling back to BM25-only", { error: String(err) });
      }
    }

    // RRF fusion with weights
    const bm25Ranked = bm25Results.map((r) => ({ id: r.symbolId, score: r.score }));

    // Apply weights by scaling RRF contributions
    const fusedScores = new Map<string, number>();

    // BM25 contribution
    for (let rank = 0; rank < bm25Ranked.length; rank++) {
      const item = bm25Ranked[rank];
      const rrfScore = weights.bm25Weight / (RRF_K + rank + 1);
      fusedScores.set(item.id, (fusedScores.get(item.id) ?? 0) + rrfScore);
    }

    // Vector contribution
    for (let rank = 0; rank < vectorResults.length; rank++) {
      const item = vectorResults[rank];
      const rrfScore = weights.vectorWeight / (RRF_K + rank + 1);
      fusedScores.set(item.id, (fusedScores.get(item.id) ?? 0) + rrfScore);
    }

    // Sort by fused score
    const ranked = Array.from(fusedScores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Build results
    const results: HybridSearchResult[] = [];
    for (const { id, score } of ranked) {
      const sym = symbolMap.get(id);
      if (!sym) continue;

      results.push({
        symbolId: sym.symbolId,
        filePath: sym.filePath,
        name: sym.name,
        kind: sym.kind,
        score,
        snippet: sym.snippet ?? sym.signature,
      });
    }

    log.info("Hybrid search completed", {
      projectId,
      query: query.slice(0, 50),
      bm25Count: bm25Results.length,
      vectorCount: vectorResults.length,
      fusedCount: results.length,
    });

    return results;
  }
}

// ---- Utility --------------------------------------------------------------

/**
 * Simple glob matching for file paths. Supports `*` and `**` patterns.
 */
export function matchGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§DOUBLE§")
    .replace(/\*/g, "[^/]*")
    .replace(/§DOUBLE§/g, ".*");

  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `escaped` has all regex metacharacters escaped first and only `*`/`**` expanded into bounded classes; the anchored pattern cannot inject or backtrack catastrophically.
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(filePath);
}
