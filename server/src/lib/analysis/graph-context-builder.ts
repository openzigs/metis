/**
 * Epic #497 / Issue #500 — Graph-ranked context injection for chat queries.
 * Epic #507 / Issue #510 — Hybrid code search integration.
 *
 * Builds code context for the analysis agent by:
 * 1. Identifying relevant symbols via graph traversal
 * 2. Scoring by: (1 / (graphDistance + 1)) * edgeTypeWeight * queryRelevance
 * 3. Including a repo map preamble when budget allows
 * 4. Falling back to full file inclusion if no graph data exists
 * 5. (Hybrid mode) Combining graph-ranked results with embedding-retrieved results
 */
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import { CodeGraphQueryService } from "../code-graph/query-service.js";
import type { HybridSearchResult } from "../code-graph/hybrid-search.js";
import { RepoMapGenerator, estimateTokens } from "../code-graph/repo-map.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("graph-context-builder");

/**
 * Code retrieval mode — configurable via CODE_RETRIEVAL_MODE env var.
 * - "graph" — graph-ranked only (original behavior)
 * - "hybrid" — combine graph-ranked and embedding-retrieved results
 * - "embedding_only" — use only embedding-based search
 */
export type CodeRetrievalMode = "graph" | "hybrid" | "embedding_only";

export function resolveCodeRetrievalMode(): CodeRetrievalMode {
  const mode = process.env.CODE_RETRIEVAL_MODE?.trim().toLowerCase();
  if (mode === "hybrid" || mode === "embedding_only" || mode === "graph") return mode;
  return "graph"; // default
}

/** Token budget split for hybrid mode. */
export interface HybridBudgetSplit {
  /** Fraction of snippet budget for graph-ranked results. Default: 0.6 */
  graphFraction: number;
  /** Fraction of snippet budget for embedding-retrieved results. Default: 0.4 */
  embeddingFraction: number;
}

export const DEFAULT_HYBRID_BUDGET: HybridBudgetSplit = {
  graphFraction: 0.6,
  embeddingFraction: 0.4,
};

export interface GraphContextOptions {
  /** The user's query. */
  query: string;
  /** Project ID to look up code graph data. */
  projectId: string;
  /** Maximum tokens for the code context. */
  tokenBudget: number;
  /** Budget reserved for the repo map preamble. Default: 20% of tokenBudget. */
  repoMapBudget?: number;
  /** Override the code retrieval mode for this request. */
  retrievalMode?: CodeRetrievalMode;
  /** Budget split for hybrid mode. */
  hybridBudget?: HybridBudgetSplit;
}

export interface ContextSnippet {
  filePath: string;
  symbolName: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  content?: string;
}

export interface GraphContextResult {
  /** Formatted context string ready for the system prompt. */
  context: string;
  /** Repo map preamble (if included). */
  repoMap: string | null;
  /** Individual snippets that were included. */
  snippets: ContextSnippet[];
  /** Total estimated tokens used. */
  estimatedTokens: number;
  /** Whether the fallback (no graph data) was used. */
  usedFallback: boolean;
}

export interface GraphContextDataSource extends CodeGraphDataSource {
  /** Check if a project has code graph data. */
  hasCodeGraph(projectId: string): Promise<boolean>;
  /** Get the entry-point symbols for a project's code graph. */
  getProjectSymbols(
    projectId: string,
    limit: number,
  ): Promise<import("../code-graph/query-service.js").GraphSymbol[]>;
  /** Read file content for a symbol (for fallback mode). */
  readFileContent?(filePath: string): Promise<string | null>;
  /** Check if a project has symbol embeddings available. */
  hasSymbolEmbeddings?(projectId: string): Promise<boolean>;
}

/**
 * Provider interface for hybrid search. Allows the builder to call hybrid
 * search without directly depending on all its transitive dependencies.
 */
export interface HybridSearchProvider {
  search(
    query: string,
    projectId: string,
    opts?: { limit?: number },
  ): Promise<HybridSearchResult[]>;
}

/**
 * Compute query relevance score for a symbol based on name matching.
 */
export function computeQueryRelevance(symbolName: string, query: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryTerms.length === 0) return 0.5; // neutral when no query

  const nameLower = symbolName.toLowerCase();
  let matches = 0;

  for (const term of queryTerms) {
    if (nameLower.includes(term)) {
      matches++;
    }
  }

  // Score: 0.1 (no match) to 1.0 (all terms match)
  return matches > 0 ? Math.min(1.0, 0.3 + (matches / queryTerms.length) * 0.7) : 0.1;
}

/**
 * Compute final score for a symbol in context ranking.
 * score = (1 / (graphDistance + 1)) * edgeTypeWeight * queryRelevance
 */
export function computeContextScore(
  graphDistance: number,
  edgeTypeWeight: number,
  queryRelevance: number,
): number {
  return (1 / (graphDistance + 1)) * edgeTypeWeight * queryRelevance;
}

export class GraphContextBuilder {
  private readonly queryService: CodeGraphQueryService;
  private readonly repoMapGenerator: RepoMapGenerator;
  private readonly hybridSearch: HybridSearchProvider | null;

  constructor(
    private readonly dataSource: GraphContextDataSource,
    hybridSearch?: HybridSearchProvider,
  ) {
    this.queryService = new CodeGraphQueryService(dataSource);
    this.repoMapGenerator = new RepoMapGenerator(dataSource);
    this.hybridSearch = hybridSearch ?? null;
  }

  /**
   * Build code context for an agent query within the token budget.
   */
  async buildContext(opts: GraphContextOptions): Promise<GraphContextResult> {
    const { query, projectId, tokenBudget } = opts;
    const repoMapBudget = opts.repoMapBudget ?? Math.floor(tokenBudget * 0.2);
    const mode = opts.retrievalMode ?? resolveCodeRetrievalMode();
    const hybridBudget = opts.hybridBudget ?? DEFAULT_HYBRID_BUDGET;

    const hasGraph = await this.dataSource.hasCodeGraph(projectId);

    if (!hasGraph) {
      log.info("No code graph data, using fallback", { projectId });
      return this.buildFallbackContext(query, tokenBudget);
    }

    // Determine if hybrid search is available
    const hasEmbeddings = (await this.dataSource.hasSymbolEmbeddings?.(projectId)) ?? false;
    const useHybrid =
      this.hybridSearch !== null &&
      hasEmbeddings &&
      (mode === "hybrid" || mode === "embedding_only");

    // Embedding-only mode
    if (mode === "embedding_only" && useHybrid) {
      return this.buildEmbeddingOnlyContext(query, projectId, tokenBudget, repoMapBudget);
    }

    // Get project symbols to use as starting points for BFS
    const projectSymbols = await this.dataSource.getProjectSymbols(projectId, 100);
    if (projectSymbols.length === 0) {
      return this.buildFallbackContext(query, tokenBudget);
    }

    // Find symbols most relevant to the query as BFS starting points
    const startSymbols = this.findQueryRelevantSymbols(projectSymbols, query, 5);

    // BFS from each starting symbol
    const allScored: ContextSnippet[] = [];
    const seen = new Set<string>();

    for (const startSym of startSymbols) {
      const bfsResults = await this.queryService.bfsFromSymbol(
        startSym.id,
        3,
        tokenBudget * 50, // Token budget in "symbol slots"
      );

      for (const result of bfsResults) {
        if (seen.has(result.symbol.id)) continue;
        seen.add(result.symbol.id);

        const queryRelevance = computeQueryRelevance(result.symbol.qualifiedName, query);
        const score = computeContextScore(
          result.distance,
          result.score * (result.distance + 1),
          queryRelevance,
        );

        allScored.push({
          filePath: result.symbol.filePath,
          symbolName: result.symbol.qualifiedName,
          kind: result.symbol.kind,
          startLine: result.symbol.startLine,
          endLine: result.symbol.endLine,
          score,
        });
      }
    }

    // Also include the starting symbols themselves
    for (const sym of startSymbols) {
      if (!seen.has(sym.id)) {
        seen.add(sym.id);
        const queryRelevance = computeQueryRelevance(sym.qualifiedName, query);
        allScored.push({
          filePath: sym.filePath,
          symbolName: sym.qualifiedName,
          kind: sym.kind,
          startLine: sym.startLine,
          endLine: sym.endLine,
          score: queryRelevance * 2.0, // Boost for direct query matches
        });
      }
    }

    // Sort by score descending
    allScored.sort((a, b) => b.score - a.score);

    // Generate repo map preamble
    let repoMap: string | null = null;
    let repoMapTokens = 0;

    if (repoMapBudget > 0) {
      const focusFiles = [...new Set(allScored.slice(0, 5).map((s) => s.filePath))];
      const mapResult = await this.repoMapGenerator.generate({
        tokenBudget: repoMapBudget,
        focusFiles,
        query,
      });
      if (mapResult.fileCount > 0) {
        repoMap = mapResult.content;
        repoMapTokens = mapResult.estimatedTokens;
      }
    }

    // Fill remaining budget with snippets
    const remainingBudget = tokenBudget - repoMapTokens;
    const snippets: ContextSnippet[] = [];
    let snippetTokens = 0;

    if (useHybrid && mode === "hybrid") {
      // Hybrid mode: split budget between graph-ranked and embedding-retrieved
      const graphBudget = Math.floor(remainingBudget * hybridBudget.graphFraction);
      const embeddingBudget = Math.floor(remainingBudget * hybridBudget.embeddingFraction);

      // Graph-ranked snippets (60% by default)
      for (const snippet of allScored) {
        const snippetText = this.formatSnippet(snippet);
        const tokens = estimateTokens(snippetText);
        if (snippetTokens + tokens > graphBudget) break;
        snippets.push(snippet);
        snippetTokens += tokens;
      }

      // Embedding-retrieved snippets (40% by default)
      const embeddingSnippets = await this.getEmbeddingSnippets(query, projectId, 30);
      const seenSymbols = new Set(snippets.map((s) => s.symbolName));

      for (const embSnippet of embeddingSnippets) {
        // Deduplication: skip if already included from graph results
        if (seenSymbols.has(embSnippet.symbolName)) continue;

        const snippetText = this.formatSnippet(embSnippet);
        const tokens = estimateTokens(snippetText);
        if (snippetTokens + tokens > graphBudget + embeddingBudget) break;

        snippets.push(embSnippet);
        seenSymbols.add(embSnippet.symbolName);
        snippetTokens += tokens;
      }
    } else {
      // Graph-only mode
      for (const snippet of allScored) {
        const snippetText = this.formatSnippet(snippet);
        const tokens = estimateTokens(snippetText);
        if (snippetTokens + tokens > remainingBudget) break;
        snippets.push(snippet);
        snippetTokens += tokens;
      }
    }

    // Build final context string
    const contextParts: string[] = [];
    if (repoMap) {
      contextParts.push(repoMap);
    }
    if (snippets.length > 0) {
      contextParts.push("## Relevant Code\n");
      for (const snippet of snippets) {
        contextParts.push(this.formatSnippet(snippet));
      }
    }

    const context = contextParts.join("\n");

    log.info("Graph context built", {
      projectId,
      snippetCount: snippets.length,
      estimatedTokens: repoMapTokens + snippetTokens,
      usedFallback: false,
    });

    return {
      context,
      repoMap,
      snippets,
      estimatedTokens: repoMapTokens + snippetTokens,
      usedFallback: false,
    };
  }

  private findQueryRelevantSymbols(
    symbols: import("../code-graph/query-service.js").GraphSymbol[],
    query: string,
    limit: number,
  ): import("../code-graph/query-service.js").GraphSymbol[] {
    const scored = symbols.map((sym) => ({
      sym,
      relevance: computeQueryRelevance(sym.qualifiedName, query),
    }));

    scored.sort((a, b) => b.relevance - a.relevance);
    return scored.slice(0, limit).map((s) => s.sym);
  }

  private async buildFallbackContext(
    query: string,
    _tokenBudget: number,
  ): Promise<GraphContextResult> {
    // Fallback: return a basic context indicating no graph data
    const fallbackText = `[No code graph data available. Context selection based on query: "${query}"]\n`;

    return {
      context: fallbackText,
      repoMap: null,
      snippets: [],
      estimatedTokens: estimateTokens(fallbackText),
      usedFallback: true,
    };
  }

  private formatSnippet(snippet: ContextSnippet): string {
    return `### ${snippet.filePath}:${snippet.startLine}-${snippet.endLine} (${snippet.kind} ${snippet.symbolName})\n`;
  }

  /**
   * Build context using only embedding-based search (no graph traversal).
   */
  private async buildEmbeddingOnlyContext(
    query: string,
    projectId: string,
    tokenBudget: number,
    repoMapBudget: number,
  ): Promise<GraphContextResult> {
    const embeddingSnippets = await this.getEmbeddingSnippets(query, projectId, 50);

    if (embeddingSnippets.length === 0) {
      return this.buildFallbackContext(query, tokenBudget);
    }

    // Generate repo map
    let repoMap: string | null = null;
    let repoMapTokens = 0;

    if (repoMapBudget > 0) {
      const focusFiles = [...new Set(embeddingSnippets.slice(0, 5).map((s) => s.filePath))];
      const mapResult = await this.repoMapGenerator.generate({
        tokenBudget: repoMapBudget,
        focusFiles,
        query,
      });
      if (mapResult.fileCount > 0) {
        repoMap = mapResult.content;
        repoMapTokens = mapResult.estimatedTokens;
      }
    }

    const remainingBudget = tokenBudget - repoMapTokens;
    const snippets: ContextSnippet[] = [];
    let snippetTokens = 0;

    for (const snippet of embeddingSnippets) {
      const text = this.formatSnippet(snippet);
      const tokens = estimateTokens(text);
      if (snippetTokens + tokens > remainingBudget) break;
      snippets.push(snippet);
      snippetTokens += tokens;
    }

    const contextParts: string[] = [];
    if (repoMap) contextParts.push(repoMap);
    if (snippets.length > 0) {
      contextParts.push("## Relevant Code\n");
      for (const snippet of snippets) {
        contextParts.push(this.formatSnippet(snippet));
      }
    }

    const context = contextParts.join("\n");

    log.info("Embedding-only context built", {
      projectId,
      snippetCount: snippets.length,
      estimatedTokens: repoMapTokens + snippetTokens,
    });

    return {
      context,
      repoMap,
      snippets,
      estimatedTokens: repoMapTokens + snippetTokens,
      usedFallback: false,
    };
  }

  /**
   * Get snippets from hybrid/embedding search, converted to ContextSnippet format.
   */
  private async getEmbeddingSnippets(
    query: string,
    projectId: string,
    limit: number,
  ): Promise<ContextSnippet[]> {
    if (!this.hybridSearch) return [];

    try {
      const results = await this.hybridSearch.search(query, projectId, { limit });
      return results.map((r) => ({
        filePath: r.filePath,
        symbolName: r.name,
        kind: r.kind,
        startLine: 0,
        endLine: 0,
        score: r.score,
        content: r.snippet,
      }));
    } catch (err) {
      log.warn("Hybrid search failed, skipping embedding results", { error: String(err) });
      return [];
    }
  }
}

/**
 * Epic #647 / Issue #650 — Filter scored chunks by a configurable threshold.
 *
 * After retrieval and reranking, chunks below the threshold are excluded
 * from context injection. Logs the filter results for observability.
 *
 * @param chunks - Array of objects with at least `score` property
 * @param threshold - Minimum score to include (defaults to RAG_SCORE_THRESHOLD env var or 0.3)
 */
export function filterByScoreThreshold<T extends { score: number }>(
  chunks: T[],
  threshold?: number,
): T[] {
  const effectiveThreshold =
    threshold ?? (parseFloat(process.env.RAG_SCORE_THRESHOLD || "0.3") || 0.3);

  if (effectiveThreshold <= 0) return chunks;

  const included = chunks.filter((c) => c.score >= effectiveThreshold);

  log.debug("RAG score threshold filter applied", {
    retrieved: chunks.length,
    included: included.length,
    threshold: effectiveThreshold,
  });

  return included;
}
