/**
 * Production wiring for the fused code-graph retrieval seam (Epic #712 / #714),
 * with the vector half finally connected (Epic #780 / #797).
 *
 * `buildFusedCodeBlock` (`../rag/fused-code-context.ts`) takes an injectable
 * {@link FusedCodeSearcher} + {@link SymbolLineLookup}. This module builds the
 * real ones from Prisma and the existing {@link HybridCodeSearch} (index #3):
 *
 *   - The searcher reuses `HybridCodeSearch` over a Prisma-backed
 *     {@link SymbolIndex} (the BM25 half) and the real symbol-embedding vector
 *     store (the semantic half — see `symbol-embedding-service.ts`). Until #797
 *     this file passed a NO-OP vector store and an EMPTY embed service, which
 *     forced the hybrid searcher onto its BM25-only branch: `search_code_symbols`
 *     was keyword matching over symbol names, and #780's embedder upgrade could
 *     not reach code retrieval at all because code retrieval used no embedder.
 *   - The line lookup reads authoritative `startLine`/`endLine`/`filePath`
 *     straight from the `CodeSymbol` rows, so the rendered locators (and the
 *     #715 citations that reuse them) come from the code graph, not the search
 *     result's denormalised copy.
 *
 * A project with no built code graph yields zero symbols → the searcher returns
 * `[]` → `buildFusedCodeBlock` is a clean no-op (no error). A project whose
 * symbols are not embedded yet (an ingest ran, the background embed job has not
 * finished) has no vectors tagged with the active model, so the vector channel
 * simply contributes nothing and BM25 keeps serving — degraded, never broken.
 */
import { prisma } from "../prisma.js";
import { getEmbedder } from "../rag/embedder.js";
import type {
  FusedCodeSearcher,
  RawCodeSymbolHit,
  SymbolLineLookup,
} from "../rag/fused-code-context.js";
import {
  HybridCodeSearch,
  type SearchableSymbol,
  type SymbolIndex,
  type SymbolVectorStore,
} from "./hybrid-search.js";
import { createSymbolVectorStore } from "./symbol-embedding-service.js";
import type { EmbedService } from "./symbol-embeddings.js";

/**
 * #372 — projects whose full lexical symbol set is held in memory (LRU). Each entry
 * also keeps its BM25 indexes alive through `HybridCodeSearch`'s weak cache; the
 * unfiltered one was measured at ~27 MB of retained heap for a 24k-symbol project,
 * so four bound the worst case near 110 MB. That figure counts one index per
 * project: each distinct `fileGlob`/`symbolKind` pair adds another (up to 8 per
 * array), but no production caller passes a filter today.
 */
const MAX_CACHED_PROJECTS = 4;

interface CachedSymbols {
  fingerprint: string;
  symbols: readonly SearchableSymbol[];
}

/** Insertion order is recency order: the first key is the least recently used. */
const symbolCache = new Map<string, CachedSymbols>();

/** Test seam: drop every cached project symbol set. */
export function __resetSymbolIndexCache(): void {
  symbolCache.clear();
}

const SYMBOL_SELECT = {
  id: true,
  name: true,
  qualifiedName: true,
  kind: true,
  filePath: true,
} as const;

interface SymbolRow {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
}

function toSearchable(r: SymbolRow): SearchableSymbol {
  return {
    symbolId: r.id,
    name: r.name,
    qualifiedName: r.qualifiedName,
    kind: r.kind,
    filePath: r.filePath,
  };
}

/**
 * Prisma-backed symbol index feeding the BM25 keyword scorer.
 *
 * Exported so the #797 tests and the `--wired` eval can drive the PRODUCTION
 * lexical channel rather than a hand-built stand-in.
 *
 * #372: `getSymbols` returns EVERY symbol in the project. It used to take the
 * first 5,000 by id, which on a 17k-symbol project left two thirds of the symbols
 * (all of `ui/src`, chosen by cuid order) lexically unsearchable, so an exact
 * name query could miss its own symbol.
 *
 * Loading and tokenizing every symbol on every query is what the cap was avoiding,
 * so the full set is cached per project (see {@link symbolCache}) and returned as
 * the SAME array while the project's symbols are unchanged; `HybridCodeSearch`
 * keys its shared BM25 index on that identity, so the index is built once per
 * change rather than once per query. A DB-side candidate filter was rejected:
 * BM25's IDF and average document length need the whole corpus, so ranking a
 * prefiltered subset would silently change the scores the fusion weights
 * (`DEFAULT_WEIGHTS`) were tuned against.
 */
export const prismaSymbolIndex: SymbolIndex = {
  async getSymbols(projectId: string): Promise<SearchableSymbol[]> {
    // Every symbol write is a create or a delete (`ingest.ts`, `schema-graph.ts`
    // — no update), so a create moves `max(createdAt)` and a pure delete moves the
    // count: together they change whenever the project's symbol set does.
    const agg = await prisma.codeSymbol.aggregate({
      where: { projectId },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const fingerprint = `${agg._count._all}|${agg._max.createdAt?.getTime() ?? ""}`;
    const cached = symbolCache.get(projectId);
    if (cached?.fingerprint === fingerprint) {
      // Refresh recency for the LRU.
      symbolCache.delete(projectId);
      symbolCache.set(projectId, cached);
      return cached.symbols as SearchableSymbol[];
    }

    const rows = await prisma.codeSymbol.findMany({
      where: { projectId },
      select: SYMBOL_SELECT,
      // Stable order keeps BM25 tie-breaks reproducible across queries.
      orderBy: { id: "asc" },
    });
    // Frozen: every caller shares this array, and the shared BM25 cache is keyed on
    // its identity, so a caller that sorted or pushed into it would corrupt both.
    const symbols = Object.freeze(rows.map(toSearchable));
    symbolCache.delete(projectId);
    if (symbolCache.size >= MAX_CACHED_PROJECTS) {
      symbolCache.delete(symbolCache.keys().next().value as string);
    }
    symbolCache.set(projectId, { fingerprint, symbols });
    return symbols as SearchableSymbol[];
  },

  async getSymbolsByIds(projectId: string, symbolIds: string[]): Promise<SearchableSymbol[]> {
    if (symbolIds.length === 0) return [];
    const rows = await prisma.codeSymbol.findMany({
      where: { projectId, id: { in: symbolIds } },
      select: SYMBOL_SELECT,
    });
    return rows.map(toSearchable);
  },
};

export interface CodeSearcherDeps {
  vectorStore?: SymbolVectorStore;
  embedService?: EmbedService;
  symbolIndex?: SymbolIndex;
}

/** Build the default production {@link FusedCodeSearcher}. */
export function createDefaultCodeSearcher(deps: CodeSearcherDeps = {}): FusedCodeSearcher {
  const hybrid = new HybridCodeSearch(
    deps.vectorStore ?? createSymbolVectorStore(),
    deps.symbolIndex ?? prismaSymbolIndex,
    // `Embedder` already satisfies `EmbedService`. Reusing the SINGLETON is what
    // guarantees the query is embedded by the same model, pooling and dtype the
    // symbols were indexed with (#792) — a second Embedder built here would be a
    // train/serve skew waiting to happen.
    deps.embedService ?? getEmbedder(),
  );
  return {
    async search(query, projectId, opts): Promise<RawCodeSymbolHit[]> {
      const results = await hybrid.search(query, projectId, { limit: opts?.limit ?? 20 });
      return results.map((r) => ({
        symbolId: r.symbolId,
        filePath: r.filePath,
        name: r.name,
        kind: r.kind,
        score: r.score,
        snippet: r.snippet,
      }));
    },
  };
}

/** Build the default production {@link SymbolLineLookup} (reads `CodeSymbol`). */
export function createDefaultSymbolLineLookup(): SymbolLineLookup {
  return {
    async resolve(symbolIds, projectId) {
      const map = new Map<string, { filePath: string; startLine: number; endLine: number }>();
      if (symbolIds.length === 0) return map;
      const rows = await prisma.codeSymbol.findMany({
        where: { id: { in: symbolIds }, projectId },
        select: { id: true, filePath: true, startLine: true, endLine: true },
      });
      for (const r of rows) {
        map.set(r.id, { filePath: r.filePath, startLine: r.startLine, endLine: r.endLine });
      }
      return map;
    },
  };
}
