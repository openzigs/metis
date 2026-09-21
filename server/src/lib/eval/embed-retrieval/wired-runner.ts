/**
 * Epic #780 / Issue #797 — the REALISED retrieval eval.
 *
 * ## Why this file exists
 *
 * #788 measured NL-requirement → code retrieval at 0.402 nDCG@10 (vs 0.246 for the
 * incumbent) and that number was used to justify the #783 model flip. But #788's
 * {@link import("./runner.js").runArm} builds its OWN in-memory vector store and
 * its OWN symbol index. Production did not: `project-code-searcher.ts` passed a
 * NO-OP vector store, so `search_code_symbols` never embedded anything at all.
 *
 * #788 therefore measured the POTENTIAL of the embedder, not the REALISED benefit
 * of the feature. This runner measures the realised one: it drives the same corpus
 * and the same metrics through the PRODUCTION components that #797 wires up —
 *
 *   - {@link SymbolEmbeddingPipeline} (batching, content-hash skip, stale prune),
 *   - {@link createSymbolEmbeddingStore} (the real store adapter, model-tagging
 *     every row and mapping it onto the vector store's fixed column set),
 *   - a real {@link VectorStore} (the local JSON backend — same interface, same
 *     `search`/`upsert`/`listChunkRefs` contract as pgvector and Lance),
 *   - {@link createSymbolVectorStore} (the read path, INCLUDING the mandatory
 *     model-tag filter that a mixed-generation store depends on),
 *   - {@link createDefaultCodeSearcher} — the PRODUCTION SEAM ITSELF. Not a
 *     hand-built `HybridCodeSearch`: the same factory `search_code_symbols`,
 *     `fused-code-chunks` and `spec-kit/rag-context` call, so the eval inherits
 *     production's weights, its result mapping and its limit handling by
 *     construction rather than by imitation (PR #803 review, M3).
 *
 * ## What it still stands in for — stated precisely, because the last version of
 * ## this header overstated it
 *
 *   1. **Postgres.** The durable metadata rides the {@link SymbolMetadataRepo} seam
 *      with an in-memory implementation. That is a database, not a ranking component.
 *   2. **The symbol index.** `createDefaultCodeSearcher` is given a corpus-backed
 *      {@link SymbolIndex} instead of the Prisma-backed `prismaSymbolIndex`, because
 *      the latter needs a live `CodeSymbol` table. It implements the SAME contract,
 *      `getSymbolsByIds` included — but it is not windowed, so the eval does not
 *      exercise the `MAX_INDEXED_SYMBOLS` window or the hydration path #797 fixed.
 *      At 183 symbols the window is moot (production's is 5000), so this cannot move
 *      the numbers on THIS corpus — but it is a stand-in, and any residual between
 *      the potential and realised columns must not be explained away as if it were not.
 *
 * Report BOTH columns. A realised score materially below 0.402 is a finding about
 * this feature, not a bug in the harness.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HybridCodeSearch,
  type SearchableSymbol,
  type SearchWeights,
  type SymbolIndex,
  type SymbolVectorStore,
} from "../../code-graph/hybrid-search.js";
import { createDefaultCodeSearcher } from "../../code-graph/project-code-searcher.js";
import {
  createSymbolVectorStore,
  embedProjectSymbols,
  symbolVectorsId,
  type SymbolMetadataRepo,
  type SymbolMetadataRow,
} from "../../code-graph/symbol-embedding-service.js";
import { computeSymbolHash, type EmbedService } from "../../code-graph/symbol-embeddings.js";
import type { FusedCodeSearcher } from "../../rag/fused-code-context.js";
import { LocalVectorStore } from "../../rag/vector-store.js";
import type { EmbedRetrievalCorpus } from "./corpus.js";
import { aggregate, scoreQuery, type ChannelMetrics, type QueryScore } from "./metrics.js";
import { HYBRID_LIMIT, type EmbedFn } from "./runner.js";
import {
  runWeightSweep,
  WEIGHT_GRID,
  type SweepReport,
  type WeightedSearch,
} from "./weight-sweep.js";

export interface WiredRunResult {
  armId: string;
  /** The production hybrid channel, driven end-to-end through the wired store. */
  hybrid: ChannelMetrics;
  /** The vector channel in isolation, read back out of the SAME wired store. */
  vector: ChannelMetrics;
  /** Symbols the pipeline actually embedded (a resumed run would embed fewer). */
  embedded: number;
  docCount: number;
  queryCount: number;
  /** Per-query HYBRID scores — the production channel, and the one #1157 intervals. */
  perQuery: QueryScore[];
}

/**
 * An in-memory {@link SymbolMetadataRepo} seeded from the committed corpus, standing
 * in for the `CodeSymbolEmbedding` rows that `ingestCodeGraph` writes. Every field
 * is exactly what ingest would persist: the production `formatSymbolForEmbedding`
 * text, its SHA-256, and `embeddingModel: ""` (PENDING).
 */
export function createCorpusMetadataRepo(corpus: EmbedRetrievalCorpus): SymbolMetadataRepo {
  const byPath = new Map(corpus.symbols.map((s) => [s.id, s]));
  const rows: SymbolMetadataRow[] = corpus.docs.map((d) => {
    const sym = byPath.get(d.id);
    return {
      symbolId: d.id,
      text: d.text,
      contentHash: computeSymbolHash(d.text),
      embeddingModel: "",
      name: d.name,
      qualifiedName: sym?.qualifiedName ?? d.name,
      kind: d.kind,
      filePath: d.filePath,
    };
  });
  return {
    async list(): Promise<SymbolMetadataRow[]> {
      return rows.map((r) => ({ ...r }));
    },
    async listHashes() {
      return rows.map((r) => ({
        symbolId: r.symbolId,
        contentHash: r.contentHash,
        embeddingModel: r.embeddingModel,
      }));
    },
    async tag(_projectId, tagged): Promise<void> {
      for (const t of tagged) {
        const row = rows.find((r) => r.symbolId === t.symbolId);
        if (!row) continue;
        row.contentHash = t.contentHash;
        row.embeddingModel = t.embeddingModel;
      }
    },
  };
}

/**
 * The corpus as a {@link SymbolIndex} — the stand-in for `prismaSymbolIndex` (see
 * point 2 of this file's header). Implements `getSymbolsByIds` so the hydration
 * CONTRACT is honoured, but it is not windowed, so the window itself is untested here.
 */
export function corpusSymbolIndex(searchable: readonly SearchableSymbol[]): SymbolIndex {
  return {
    async getSymbols(): Promise<SearchableSymbol[]> {
      return [...searchable];
    },
    async getSymbolsByIds(_projectId, ids): Promise<SearchableSymbol[]> {
      return searchable.filter((s) => ids.includes(s.symbolId));
    },
  };
}

/** Everything a caller needs once the corpus has been embedded through production. */
export interface WiredCorpus {
  /** The production searcher, from the production factory, at DEFAULT_WEIGHTS. */
  searcher: FusedCodeSearcher;
  /** The production vector store (model-tag filter and all), for channel isolation. */
  vectorStore: SymbolVectorStore;
  embedService: EmbedService;
  /**
   * The same production `HybridCodeSearch` the factory builds, over the same store,
   * index and embedder — with the WEIGHTS as the free variable. `createDefaultCodeSearcher`
   * takes no weights (it is production, and production has exactly one setting), so a
   * sweep has to reach one layer in. Everything else is identical to `searcher`.
   */
  weightedSearch: WeightedSearch;
  /** Symbols the pipeline actually embedded. */
  embedded: number;
}

/**
 * Embed the corpus through the PRODUCTION write path, then hand `fn` the production
 * read path over it. Cleans up the temp store afterwards, whatever `fn` does.
 *
 * `embed` is the arm's embed function (the production `Embedder` under the hood);
 * `model` is the id its vectors are tagged with — which the read path then filters
 * on, exactly as production does.
 */
export async function withWiredCorpus<T>(
  corpus: EmbedRetrievalCorpus,
  embed: EmbedFn,
  model: string,
  fn: (wired: WiredCorpus) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eval797-"));
  try {
    const store = new LocalVectorStore({ root });
    const embedService: EmbedService = {
      async embed(texts: string[]) {
        const vectors = await embed(texts);
        return { vectors, model, dimension: vectors[0]?.length ?? 0 };
      },
    };
    const repo = createCorpusMetadataRepo(corpus);
    const deps = { store, embedService, repo, model: (): string => model };

    // WRITE through the production pipeline + store adapter.
    const result = await embedProjectSymbols(corpus.projectId, deps);

    // The detachment tripwire, asserted on an OBSERVABLE rather than on a discarded
    // constructor call: if a refactor ever stops routing this eval through the real
    // write path, the production namespace comes back empty (or carrying another
    // model's tag) and the run fails LOUDLY instead of quietly scoring a harness
    // again — which is the #797 defect itself.
    const written = await store.listChunkRefs(symbolVectorsId(corpus.projectId));
    if (written.length === 0 || written.some((r) => r.embeddingModel !== model)) {
      throw new Error(
        `wired eval wrote ${written.length} vectors to ${symbolVectorsId(corpus.projectId)} ` +
          `tagged for "${model}" — the production write path is not being exercised`,
      );
    }

    // READ through the production vector store and the PRODUCTION SEARCHER FACTORY.
    // `createDefaultCodeSearcher` is what `search_code_symbols` calls, so the weights,
    // the result mapping and the limit handling are production's, not a
    // re-implementation of them.
    const vectorStore = createSymbolVectorStore(deps);
    const symbolIndex = corpusSymbolIndex(corpus.searchable);
    const searcher = createDefaultCodeSearcher({ vectorStore, symbolIndex, embedService });
    const hybrid = new HybridCodeSearch(vectorStore, symbolIndex, embedService);

    return await fn({
      searcher,
      vectorStore,
      embedService,
      embedded: result.embedded,
      weightedSearch: async (query, weights, limit) => {
        const hits = await hybrid.search(query, corpus.projectId, { limit, weights });
        return hits.map((h) => h.symbolId);
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Run one arm through the WIRED production path and score it. */
export async function runWiredArm(
  armId: string,
  corpus: EmbedRetrievalCorpus,
  embed: EmbedFn,
  model: string,
): Promise<WiredRunResult> {
  return withWiredCorpus(corpus, embed, model, async (wired) => {
    const hybridScores: QueryScore[] = [];
    const vectorScores: QueryScore[] = [];
    for (const q of corpus.queries) {
      const hits = await wired.searcher.search(q.requirement, corpus.projectId, {
        limit: HYBRID_LIMIT,
      });
      hybridScores.push(
        scoreQuery(
          q.id,
          hits.map((h) => h.symbolId),
          q.relevant,
        ),
      );

      // The vector channel ALONE, read back out of the same wired store — so the
      // hybrid delta is attributable rather than a black box.
      const { vectors } = await wired.embedService.embed([q.requirement]);
      const vHits = await wired.vectorStore.search(corpus.projectId, vectors[0], HYBRID_LIMIT);
      vectorScores.push(
        scoreQuery(
          q.id,
          vHits.map((h) => h.metadata.symbolId),
          q.relevant,
        ),
      );
    }

    return {
      armId,
      hybrid: aggregate(hybridScores),
      vector: aggregate(vectorScores),
      embedded: wired.embedded,
      docCount: corpus.docs.length,
      queryCount: corpus.queries.length,
      perQuery: hybridScores,
    };
  });
}

/**
 * PR #803 review (B1) — sweep the fusion weights over the WIRED production path.
 *
 * One embed pass, N rankings: the vectors do not depend on the weights, so re-embedding
 * per setting would only burn 11× the ONNX time to reproduce the same store.
 */
export async function runWiredSweep(
  corpus: EmbedRetrievalCorpus,
  embed: EmbedFn,
  model: string,
  grid: readonly SearchWeights[] = WEIGHT_GRID,
): Promise<SweepReport> {
  return withWiredCorpus(corpus, embed, model, (wired) =>
    runWeightSweep(corpus, wired.weightedSearch, grid),
  );
}
