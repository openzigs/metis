/**
 * Epic #497 / Issue #498 — Code graph query service with BFS traversal APIs.
 *
 * Provides graph traversal operations over the persisted code graph:
 * - `bfsFromSymbol()` — BFS with token-budget awareness and relevance scoring
 * - `getRelatedFiles()` — files connected by import/call edges
 * - `getDependencyChain()` — upstream and downstream dependencies
 *
 * Results are scored by relevance: edge distance + edge type weight.
 */

export type EdgeKind = "calls" | "imports" | "defines" | "references";

export interface GraphSymbol {
  id: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
}

export interface GraphEdge {
  id: string;
  fromSymbolId: string;
  toSymbolId: string;
  kind: EdgeKind;
}

export interface ScoredSymbol {
  symbol: GraphSymbol;
  score: number;
  distance: number;
}

export interface RelatedFile {
  filePath: string;
  score: number;
  symbolCount: number;
}

export interface DependencyChain {
  upstream: GraphSymbol[];
  downstream: GraphSymbol[];
}

/** Edge type weights for relevance scoring. */
export const EDGE_TYPE_WEIGHTS: Record<EdgeKind, number> = {
  calls: 1.0,
  imports: 0.8,
  defines: 0.6,
  references: 0.4,
};

/** Approximate tokens per symbol entry in context output. */
const TOKENS_PER_SYMBOL = 50;

export interface CodeGraphDataSource {
  getSymbol(symbolId: string): Promise<GraphSymbol | null>;
  getEdgesFrom(symbolId: string): Promise<GraphEdge[]>;
  getEdgesTo(symbolId: string): Promise<GraphEdge[]>;
  getSymbolsByFile(filePath: string): Promise<GraphSymbol[]>;
  getSymbolsByIds(ids: string[]): Promise<GraphSymbol[]>;
  /**
   * Batched variants (#849/#872 perf): fetch outgoing/incoming edges for MANY
   * source nodes in one query. Optional — a source that omits them falls back to
   * per-node `getEdgesFrom`/`getEdgesTo`. The blast-radius BFS uses these to
   * replace its per-frontier-node N+1 with one query per depth level.
   */
  getEdgesFromMany?(symbolIds: string[]): Promise<GraphEdge[]>;
  getEdgesToMany?(symbolIds: string[]): Promise<GraphEdge[]>;
}

/**
 * A {@link CodeGraphDataSource} decorator that memoizes each per-node lookup for
 * the wrapped source's lifetime. The blast-radius BFS
 * ({@link "../impact-analysis/impact-analysis-engine"}) issues one
 * `getEdgesFrom`/`getSymbol` query PER visited node; when many requirements are
 * crossed against the SAME project graph in one pass (the gap-report
 * schema-impact producer #847 crosses every requirement), their depth-limited
 * neighborhoods overlap heavily and the raw Prisma source re-queries the same
 * nodes over and over — with the synchronous SQLite dev driver that serialized
 * into ~8s and stalled the event loop. Caching collapses the overlap to one
 * query per distinct node for the whole pass. Safe: a code graph is immutable
 * within one producer pass, and each instance is pass-scoped (never global).
 * Cached promises also dedupe concurrent in-flight lookups.
 */
export class CachingCodeGraphDataSource implements CodeGraphDataSource {
  private readonly symbolC = new Map<string, Promise<GraphSymbol | null>>();
  private readonly edgesFromC = new Map<string, Promise<GraphEdge[]>>();
  private readonly edgesToC = new Map<string, Promise<GraphEdge[]>>();
  private readonly byFileC = new Map<string, Promise<GraphSymbol[]>>();

  constructor(private readonly inner: CodeGraphDataSource) {}

  private memo<K, V>(cache: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> {
    let p = cache.get(key);
    if (!p) {
      p = load();
      cache.set(key, p);
    }
    return p;
  }

  getSymbol(symbolId: string): Promise<GraphSymbol | null> {
    return this.memo(this.symbolC, symbolId, () => this.inner.getSymbol(symbolId));
  }
  getEdgesFrom(symbolId: string): Promise<GraphEdge[]> {
    return this.memo(this.edgesFromC, symbolId, () => this.inner.getEdgesFrom(symbolId));
  }
  getEdgesTo(symbolId: string): Promise<GraphEdge[]> {
    return this.memo(this.edgesToC, symbolId, () => this.inner.getEdgesTo(symbolId));
  }
  getSymbolsByFile(filePath: string): Promise<GraphSymbol[]> {
    return this.memo(this.byFileC, filePath, () => this.inner.getSymbolsByFile(filePath));
  }

  /** Batched incoming edges: serve cached nodes, one query for the rest, then cache per node. */
  getEdgesToMany(symbolIds: string[]): Promise<GraphEdge[]> {
    return this.memoMany(this.edgesToC, symbolIds, (missing) =>
      this.inner.getEdgesToMany
        ? this.inner.getEdgesToMany(missing)
        : Promise.all(missing.map((id) => this.inner.getEdgesTo(id))).then((r) => r.flat()),
    );
  }

  getEdgesFromMany(symbolIds: string[]): Promise<GraphEdge[]> {
    return this.memoMany(this.edgesFromC, symbolIds, (missing) =>
      this.inner.getEdgesFromMany
        ? this.inner.getEdgesFromMany(missing)
        : Promise.all(missing.map((id) => this.inner.getEdgesFrom(id))).then((r) => r.flat()),
    );
  }

  /**
   * Batched edge fetch with a per-node cache. Serves already-cached nodes from
   * the cache, fetches the rest in ONE call, groups by the given `keyOf` node,
   * and primes the per-node cache so later per-node or batched calls reuse it.
   */
  private async memoMany(
    cache: Map<string, Promise<GraphEdge[]>>,
    ids: string[],
    fetchMissing: (missing: string[]) => Promise<GraphEdge[]>,
    keyOf: (e: GraphEdge) => string | null = (e) =>
      cache === this.edgesToC ? e.toSymbolId : e.fromSymbolId,
  ): Promise<GraphEdge[]> {
    const uniq = [...new Set(ids)];
    const missing = uniq.filter((id) => !cache.has(id));
    if (missing.length > 0) {
      const fetched = fetchMissing(missing);
      for (const id of missing) {
        cache.set(
          id,
          fetched.then((edges) => edges.filter((e) => keyOf(e) === id)),
        );
      }
    }
    const grouped = await Promise.all(uniq.map((id) => cache.get(id) as Promise<GraphEdge[]>));
    return grouped.flat();
  }

  /** Batch fetch, serving already-cached ids from {@link getSymbol} and caching the rest. */
  async getSymbolsByIds(ids: string[]): Promise<GraphSymbol[]> {
    const missing = ids.filter((id) => !this.symbolC.has(id));
    if (missing.length > 0) {
      const fetched = this.inner.getSymbolsByIds(missing);
      // Prime the per-id cache so later getSymbol()/getSymbolsByIds() reuse it.
      for (const id of missing) {
        this.symbolC.set(
          id,
          fetched.then((rows) => rows.find((r) => r.id === id) ?? null),
        );
      }
    }
    const out = await Promise.all(ids.map((id) => this.getSymbol(id)));
    return out.filter((s): s is GraphSymbol => s !== null);
  }
}

export class CodeGraphQueryService {
  constructor(private readonly dataSource: CodeGraphDataSource) {}

  /**
   * BFS from a starting symbol, returning ranked related symbols within
   * a token budget.
   */
  async bfsFromSymbol(
    symbolId: string,
    maxDepth: number,
    tokenBudget: number,
  ): Promise<ScoredSymbol[]> {
    const maxSymbols = Math.floor(tokenBudget / TOKENS_PER_SYMBOL);
    if (maxSymbols <= 0) return [];

    const visited = new Set<string>();
    const results: ScoredSymbol[] = [];

    // BFS queue: [symbolId, depth]
    const queue: Array<[string, number]> = [[symbolId, 0]];
    visited.add(symbolId);

    while (queue.length > 0 && results.length < maxSymbols) {
      const [currentId, depth] = queue.shift()!;

      if (depth > maxDepth) break;

      // Get edges from current symbol
      const [edgesFrom, edgesTo] = await Promise.all([
        this.dataSource.getEdgesFrom(currentId),
        this.dataSource.getEdgesTo(currentId),
      ]);

      const neighbors: Array<{ neighborId: string; edgeKind: EdgeKind }> = [];

      for (const edge of edgesFrom) {
        if (edge.toSymbolId && !visited.has(edge.toSymbolId)) {
          neighbors.push({ neighborId: edge.toSymbolId, edgeKind: edge.kind });
        }
      }
      for (const edge of edgesTo) {
        if (edge.fromSymbolId && !visited.has(edge.fromSymbolId)) {
          neighbors.push({ neighborId: edge.fromSymbolId, edgeKind: edge.kind });
        }
      }

      // Resolve neighbor symbols in batch
      const neighborIds = neighbors.map((n) => n.neighborId).filter((id) => !visited.has(id));
      const uniqueIds = [...new Set(neighborIds)];

      if (uniqueIds.length === 0) continue;

      const symbols = await this.dataSource.getSymbolsByIds(uniqueIds);
      const symbolMap = new Map(symbols.map((s) => [s.id, s]));

      for (const { neighborId, edgeKind } of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const symbol = symbolMap.get(neighborId);
        if (!symbol) continue;

        const neighborDepth = depth + 1;
        const score = this.computeScore(neighborDepth, edgeKind);

        results.push({ symbol, score, distance: neighborDepth });

        if (results.length >= maxSymbols) break;

        if (neighborDepth < maxDepth) {
          queue.push([neighborId, neighborDepth]);
        }
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Returns files connected to the given file via import/call edges,
   * ranked by connection strength.
   */
  async getRelatedFiles(filePath: string, maxResults: number): Promise<RelatedFile[]> {
    const symbols = await this.dataSource.getSymbolsByFile(filePath);
    if (symbols.length === 0) return [];

    const fileScores = new Map<string, { score: number; symbolCount: number }>();

    for (const symbol of symbols) {
      const [edgesFrom, edgesTo] = await Promise.all([
        this.dataSource.getEdgesFrom(symbol.id),
        this.dataSource.getEdgesTo(symbol.id),
      ]);

      const allEdges = [...edgesFrom, ...edgesTo];
      const neighborIds = allEdges
        .map((e) => (e.fromSymbolId === symbol.id ? e.toSymbolId : e.fromSymbolId))
        .filter(Boolean);

      if (neighborIds.length === 0) continue;

      const neighbors = await this.dataSource.getSymbolsByIds([...new Set(neighborIds)]);

      for (const neighbor of neighbors) {
        if (neighbor.filePath === filePath) continue;

        const entry = fileScores.get(neighbor.filePath) ?? { score: 0, symbolCount: 0 };
        const edge = allEdges.find(
          (e) => e.toSymbolId === neighbor.id || e.fromSymbolId === neighbor.id,
        );
        const edgeWeight = edge ? EDGE_TYPE_WEIGHTS[edge.kind] : 0.5;
        entry.score += edgeWeight;
        entry.symbolCount += 1;
        fileScores.set(neighbor.filePath, entry);
      }
    }

    const results: RelatedFile[] = [...fileScores.entries()]
      .map(([fp, { score, symbolCount }]) => ({ filePath: fp, score, symbolCount }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);

    return results;
  }

  /**
   * Returns upstream (callers/importers) and downstream (callees/imports) dependencies.
   */
  async getDependencyChain(symbolId: string): Promise<DependencyChain> {
    const upstream = await this.traverseDirection(symbolId, "upstream", 5);
    const downstream = await this.traverseDirection(symbolId, "downstream", 5);
    return { upstream, downstream };
  }

  private async traverseDirection(
    symbolId: string,
    direction: "upstream" | "downstream",
    maxDepth: number,
  ): Promise<GraphSymbol[]> {
    const visited = new Set<string>([symbolId]);
    const result: GraphSymbol[] = [];
    const queue: Array<[string, number]> = [[symbolId, 0]];

    while (queue.length > 0) {
      const [currentId, depth] = queue.shift()!;
      if (depth >= maxDepth) continue;

      const edges =
        direction === "upstream"
          ? await this.dataSource.getEdgesTo(currentId)
          : await this.dataSource.getEdgesFrom(currentId);

      const neighborIds = edges
        .map((e) => (direction === "upstream" ? e.fromSymbolId : e.toSymbolId))
        .filter((id) => id && !visited.has(id));

      const uniqueIds = [...new Set(neighborIds)];
      if (uniqueIds.length === 0) continue;

      const symbols = await this.dataSource.getSymbolsByIds(uniqueIds);

      for (const sym of symbols) {
        if (visited.has(sym.id)) continue;
        visited.add(sym.id);
        result.push(sym);
        queue.push([sym.id, depth + 1]);
      }
    }

    return result;
  }

  private computeScore(distance: number, edgeKind: EdgeKind): number {
    return (1 / (distance + 1)) * EDGE_TYPE_WEIGHTS[edgeKind];
  }
}
