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

export const DEFAULT_WEIGHTS: SearchWeights = {
  bm25Weight: 0.4,
  vectorWeight: 0.6,
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
}

// ---- BM25 Implementation --------------------------------------------------

interface BM25Document {
  symbolId: string;
  text: string;
  termFreqs: Map<string, number>;
  length: number;
}

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
    const parts = [sym.name, sym.qualifiedName];
    if (sym.signature) parts.push(sym.signature);
    if (sym.docstring) parts.push(sym.docstring);
    return parts.join(" ");
  }

  private tokenize(text: string): string[] {
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
  private readonly bm25 = new BM25Index();
  private bm25CacheKey = "";

  constructor(
    private readonly vectorStore: SymbolVectorStore,
    private readonly symbolIndex: SymbolIndex,
    private readonly embedService: EmbedService,
  ) {}

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

    // Vector search
    let vectorResults: Array<{ id: string; score: number }> = [];
    try {
      const queryEmbedding = await this.embedService.embed([query]);
      if (queryEmbedding.vectors.length > 0) {
        const vectorHits = await this.vectorStore.search(
          projectId,
          queryEmbedding.vectors[0],
          limit * 2, // fetch more to allow for filtering
        );

        // Filter vector results to match our pre-filters
        vectorResults = vectorHits
          .filter((hit) => symbolMap.has(hit.metadata.symbolId))
          .map((hit) => ({ id: hit.metadata.symbolId, score: hit.score }));
      }
    } catch (err) {
      log.warn("Vector search failed, falling back to BM25-only", { error: String(err) });
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
