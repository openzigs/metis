/**
 * Epic #780 / Issue #788 — retrieval eval runner.
 *
 * Runs one ARM (= one embedding configuration: model × pooling × dtype) over the
 * corpus and scores THREE channels:
 *
 *   - `vector` — cosine ranking over the embedded symbol texts ONLY. This is the
 *     channel the epic is actually changing, and it is measured in isolation on
 *     purpose: in the fused hybrid ranking a strong BM25 signal can mask a
 *     catastrophic vector channel entirely (that is precisely how a hash
 *     embedder survived in production this long). If you only look at hybrid,
 *     you cannot see the thing you are deciding about.
 *   - `hybrid` — the REAL production {@link HybridCodeSearch} (BM25 + vector,
 *     RRF-fused with the production default weights), driven by this arm's
 *     vectors. This is what a user would actually experience.
 *   - `bm25` — the same production class driven by an EMPTY vector store, so no
 *     vector can reach the ranking by any path. It is the "what would we get with
 *     no vector channel at all" reference line, and it is what makes a hybrid
 *     delta interpretable.
 *
 *     This channel is arm-INDEPENDENT by construction, and the construction is
 *     load-bearing: an earlier version built it from the same populated vector
 *     store with `vectorWeight: 0`, which is NOT the same thing. `HybridCodeSearch`
 *     used to run the vector query regardless of weight and insert every hit into
 *     the fused map at a weighted score of zero — so vector-derived documents
 *     padded the tail of the "BM25-only" top-10 in vector rank order (BM25 scores
 *     only documents with a non-zero term match, typically far fewer than 10).
 *     The reference line silently tracked each arm's vector quality: it moved by
 *     0.060 nDCG@10 across the five arms — more than the 0.05 decision bar.
 *     `hybrid-search.ts` now skips the vector channel at `vectorWeight <= 0`, and
 *     this harness ALSO passes an empty store, so the property survives a future
 *     change to either side.
 *
 * The runner takes an injected {@link EmbedFn}, so the unit tests drive it with
 * synthetic embedders (no weights, no network) and the CLI drives it with the
 * real ONNX models through the production `Embedder`.
 */
import {
  HybridCodeSearch,
  DEFAULT_WEIGHTS,
  type SearchableSymbol,
  type SearchWeights,
  type SymbolIndex,
  type SymbolVectorStore,
  type VectorSearchHit,
} from "../../code-graph/hybrid-search.js";
import type { EmbedService } from "../../code-graph/symbol-embeddings.js";
import type { EmbedRetrievalCorpus } from "./corpus.js";
import {
  aggregate,
  cosine,
  rankByCosine,
  scoreQuery,
  type ChannelMetrics,
  type QueryScore,
} from "./metrics.js";

/** Embed a batch of texts into unit-comparable vectors. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Rank cut-off used when driving the production hybrid searcher. */
export const HYBRID_LIMIT = 10;

/** The three channels every arm reports. */
export interface ArmChannels {
  vector: ChannelMetrics;
  hybrid: ChannelMetrics;
  bm25: ChannelMetrics;
}

export interface ArmRunResult {
  armId: string;
  channels: ArmChannels;
  /** Per-query vector-channel detail (kept for the JSON artifact / debugging). */
  vectorQueries: QueryScore[];
  /** Corpus shape, echoed so a results file is self-describing. */
  docCount: number;
  queryCount: number;
}

/** Embed texts in batches so a 183-symbol corpus doesn't go through as one call. */
export async function embedBatched(
  texts: readonly string[],
  embed: EmbedFn,
  batchSize = 16,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await embed([...batch]);
    if (vectors.length !== batch.length) {
      throw new Error(`embed returned ${vectors.length} vectors for ${batch.length} texts`);
    }
    out.push(...vectors);
  }
  return out;
}

/** In-memory cosine vector store with the production {@link SymbolVectorStore} shape. */
export function createMemoryVectorStore(
  rows: ReadonlyArray<{ symbolId: string; filePath: string; vector: number[] }>,
): SymbolVectorStore {
  return {
    async search(_projectId: string, queryVector: number[], k: number): Promise<VectorSearchHit[]> {
      return rows
        .map((r) => ({
          metadata: {
            symbolId: r.symbolId,
            filePath: r.filePath,
            kind: "",
            name: "",
            qualifiedName: "",
            contentHash: "",
          },
          score: cosine(queryVector, r.vector),
        }))
        .sort((a, b) =>
          b.score === a.score
            ? a.metadata.symbolId < b.metadata.symbolId
              ? -1
              : 1
            : b.score - a.score,
        )
        .slice(0, k);
    },
  };
}

/**
 * A vector store with nothing in it — the bm25 reference channel's store.
 *
 * Weighting the vector channel to zero is NOT sufficient to remove it (see the
 * module docstring): the only way to guarantee no vector influence is to have no
 * vectors to find. This is the same idiom `project-code-searcher.ts` and the
 * codegraph eval fixture already use to force `HybridCodeSearch` onto its lexical
 * branch.
 */
export function createEmptyVectorStore(): SymbolVectorStore {
  return {
    async search(): Promise<VectorSearchHit[]> {
      return [];
    },
  };
}

/**
 * Epic #1156 / Issue #1157 — the WEIGHTS-FREE lexical baseline.
 *
 * Every other channel in this file needs an embedder, which means ~150 MB of ONNX
 * weights and HF egress. The BM25 reference channel needs neither: with
 * `vectorWeight: 0` the production `HybridCodeSearch` skips the vector branch
 * entirely, so the ranking is pure lexical and reproducible anywhere — in CI, on a
 * laptop, and on a machine with no route to huggingface.co.
 *
 * That makes it the one arm that can characterise a NEW corpus (its spread, and
 * therefore the width of the interval around any number measured on it) without
 * waiting on a download. It is also precisely the channel sub-issue #1159 changes.
 *
 * ## The tripwire has to COUNT, not throw
 *
 * A throwing embed service looks like a guard and is not one:
 * `HybridCodeSearch.search` wraps the whole vector branch in a `try/catch` that
 * logs "Vector search failed, falling back to BM25-only" and continues
 * (`hybrid-search.ts`). So a thrown error is swallowed, `vectorResults` stays `[]`,
 * every metric comes out identical, and the run resolves — the "lexical" arm would
 * have silently entered the vector branch and reported success.
 *
 * So the service throws *and* records that it was reached, and this function fails
 * on the COUNT after the loop. That detects the condition regardless of what the
 * production searcher does with the exception, which is the only way a tripwire on
 * the far side of a `catch` can mean anything.
 */
export const LEXICAL_ONLY_WEIGHTS: SearchWeights = { bm25Weight: 1, vectorWeight: 0 };

export async function runLexicalBaseline(
  corpus: EmbedRetrievalCorpus,
  /**
   * The weights to score at. A seam, not a knob: production has exactly one
   * lexical-only setting, and the tests use this to drive a POSITIVE CONTROL that
   * proves the embedder tripwire can actually fire.
   */
  weights: SearchWeights = LEXICAL_ONLY_WEIGHTS,
): Promise<QueryScore[]> {
  let embedCalls = 0;
  const refusingEmbedService: EmbedService = {
    async embed() {
      embedCalls += 1;
      throw new Error("the lexical baseline must reach no embedder");
    },
  };
  const search = new HybridCodeSearch(
    createEmptyVectorStore(),
    createSymbolIndex(corpus.searchable),
    refusingEmbedService,
  );

  const scores: QueryScore[] = [];
  for (const q of corpus.queries) {
    const hits = await search.search(q.requirement, corpus.projectId, {
      limit: HYBRID_LIMIT,
      weights,
    });
    scores.push(
      scoreQuery(
        q.id,
        hits.map((h) => h.symbolId),
        q.relevant,
      ),
    );
  }

  if (embedCalls > 0) {
    throw new Error(
      `runLexicalBaseline reached an embedder ${embedCalls} time(s) at ` +
        `bm25Weight=${weights.bm25Weight} vectorWeight=${weights.vectorWeight}. ` +
        `This arm exists to be reproducible with no model weights; a run that embeds ` +
        `anything is not the lexical channel, whatever score it printed.`,
    );
  }
  return scores;
}

function createSymbolIndex(symbols: readonly SearchableSymbol[]): SymbolIndex {
  return {
    async getSymbols(): Promise<SearchableSymbol[]> {
      return [...symbols];
    },
  };
}

function createEmbedService(embed: EmbedFn, model: string, dimension: number): EmbedService {
  return {
    async embed(texts: string[]) {
      const vectors = await embed(texts);
      return { vectors, model, dimension };
    },
  };
}

/**
 * Run every channel for one arm. `embed` is called once per doc batch and once
 * per query (the hybrid/bm25 channels reuse the SAME doc vectors — no re-embed).
 */
export async function runArm(
  armId: string,
  corpus: EmbedRetrievalCorpus,
  embed: EmbedFn,
): Promise<ArmRunResult> {
  const docVectors = await embedBatched(
    corpus.docs.map((d) => d.text),
    embed,
  );
  const queryVectors = await embedBatched(
    corpus.queries.map((q) => q.requirement),
    embed,
  );
  const dimension = docVectors[0]?.length ?? 0;

  // --- vector-only channel (the isolated channel this epic changes) ---
  const vectorDocs = corpus.docs.map((d, i) => ({ id: d.id, vector: docVectors[i] }));
  const vectorQueries: QueryScore[] = corpus.queries.map((q, i) =>
    scoreQuery(
      q.id,
      rankByCosine(queryVectors[i], vectorDocs).map((s) => s.id),
      q.relevant,
    ),
  );

  // --- hybrid + bm25 channels (production HybridCodeSearch) ---
  const store = createMemoryVectorStore(
    corpus.docs.map((d, i) => ({ symbolId: d.id, filePath: d.filePath, vector: docVectors[i] })),
  );
  const index = createSymbolIndex(corpus.searchable);
  const service = createEmbedService(embed, armId, dimension);
  const hybridSearch = new HybridCodeSearch(store, index, service);
  // The reference channel gets an EMPTY vector store — no vector can reach it.
  const bm25Search = new HybridCodeSearch(createEmptyVectorStore(), index, service);

  const hybridScores: QueryScore[] = [];
  const bm25Scores: QueryScore[] = [];
  for (const q of corpus.queries) {
    const hybridHits = await hybridSearch.search(q.requirement, corpus.projectId, {
      limit: HYBRID_LIMIT,
      weights: DEFAULT_WEIGHTS,
    });
    hybridScores.push(
      scoreQuery(
        q.id,
        hybridHits.map((h) => h.symbolId),
        q.relevant,
      ),
    );

    const bm25Hits = await bm25Search.search(q.requirement, corpus.projectId, {
      limit: HYBRID_LIMIT,
      weights: { bm25Weight: 1, vectorWeight: 0 },
    });
    bm25Scores.push(
      scoreQuery(
        q.id,
        bm25Hits.map((h) => h.symbolId),
        q.relevant,
      ),
    );
  }

  return {
    armId,
    channels: {
      vector: aggregate(vectorQueries),
      hybrid: aggregate(hybridScores),
      bm25: aggregate(bm25Scores),
    },
    vectorQueries,
    docCount: corpus.docs.length,
    queryCount: corpus.queries.length,
  };
}
