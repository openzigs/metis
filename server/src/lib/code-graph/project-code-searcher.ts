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
 * Cap on symbols loaded into the in-memory BM25 index per query.
 *
 * This bounds the LEXICAL index only. #797: vector hits that fall outside it are
 * hydrated by id (see {@link SymbolIndex.getSymbolsByIds}), so a semantic hit is
 * never lost to this window — which is what used to happen, silently, on any repo
 * with more than 5000 symbols (METIS has ~15k).
 */
const MAX_INDEXED_SYMBOLS = 5000;

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
 * lexical channel (window and all) rather than a hand-built stand-in.
 */
export const prismaSymbolIndex: SymbolIndex = {
  async getSymbols(projectId: string): Promise<SearchableSymbol[]> {
    const rows = await prisma.codeSymbol.findMany({
      where: { projectId },
      select: SYMBOL_SELECT,
      // Deterministic window: without an order the DB may return a different
      // arbitrary 5000 rows per query, so the BM25 cache key thrashes and the
      // lexical ranking is not reproducible.
      orderBy: { id: "asc" },
      take: MAX_INDEXED_SYMBOLS,
    });
    return rows.map(toSearchable);
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
