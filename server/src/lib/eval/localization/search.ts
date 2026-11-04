/**
 * #1753 — production's seeding search over a corpus's committed symbol rows,
 * with no database and no vector store.
 *
 * `defaultSeedChange` (impact-analysis-engine.ts) seeds with
 * `createDefaultCodeSearcher`: a `HybridCodeSearch` over the project's
 * `CodeSymbol` rows (lexical channel) and its symbol vectors (vector channel).
 * This builds the SAME `HybridCodeSearch` class over an in-memory index of the
 * rows (the fields production's `SYMBOL_SELECT` reads) and an in-memory vector
 * store of their embedding texts, one project per repository, so the ranking,
 * the fusion weights and the BM25 fallback are production's own.
 *
 * Vectors come from an {@link EmbedCache}: recorded vectors answer, and the
 * local model embeds only what is missing when one is given. Without a model a
 * missing text throws and is remembered, so a stale recording fails the run
 * rather than scoring a silent BM25 fallback as the hybrid ranking.
 */
import { createHash } from "node:crypto";
import {
  HybridCodeSearch,
  type SearchableSymbol,
  type SymbolIndex,
  type SymbolVectorStore,
} from "../../code-graph/hybrid-search.js";
import type { EmbedService } from "../../code-graph/symbol-embeddings.js";
import type {
  SeedSearcher,
  SeedSymbolLoader,
  SeedSymbolRow,
} from "../../impact-analysis/change-seeds.js";
import {
  recordedTextKey,
  toFloat16Bits,
  type RecordedVectors,
  type RecordedVectorsFile,
} from "../recorded-vectors.js";
import type { LocalizationSymbolRow } from "./corpus.js";

/** Texts embedded per call to the inner model. */
export const EMBED_BATCH = 32;

/**
 * Recorded vectors first; the inner model (when given) for the rest. Every
 * vector it holds, old and new, is written back by {@link toFiles}, so two
 * corpora sharing one symbol file share one recording.
 */
export class EmbedCache implements EmbedService {
  /** Texts asked for that neither the recording nor a model could answer. */
  readonly missing: string[] = [];
  /** Texts the inner model embedded this run. */
  embeddedCount = 0;
  private readonly vectors = new Map<string, number[]>();
  private model: string;
  private dimension: number;

  constructor(
    recording: RecordedVectors | null,
    private readonly inner: EmbedService | null,
    /** The command that records the missing vectors, named in the error. */
    readonly rerecord: string,
  ) {
    this.model = recording?.model ?? "";
    this.dimension = recording?.dimension ?? 0;
    for (const [k, v] of recording?.vectors ?? []) this.vectors.set(k, v);
  }

  get modelId(): string {
    return this.model;
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; model: string; dimension: number }> {
    const misses = [...new Set(texts.filter((t) => !this.vectors.has(recordedTextKey(t))))];
    if (misses.length > 0) {
      if (!this.inner) {
        this.missing.push(...misses);
        throw new Error(
          `${misses.length} text(s) have no recorded vector (first: "${misses[0]!.slice(0, 80)}"). ` +
            `Record them with: ${this.rerecord}`,
        );
      }
      for (let i = 0; i < misses.length; i += EMBED_BATCH) {
        const batch = misses.slice(i, i + EMBED_BATCH);
        const out = await this.inner.embed(batch);
        if (this.model && out.model !== this.model) {
          throw new Error(
            `the recording is ${this.model} but the model embedding now is ${out.model}; ` +
              "delete the recording to re-record it whole",
          );
        }
        this.model = out.model;
        this.dimension = out.dimension;
        batch.forEach((t, j) => this.vectors.set(recordedTextKey(t), out.vectors[j]!));
        this.embeddedCount += batch.length;
      }
    }
    return {
      vectors: texts.map((t) => this.vectors.get(recordedTextKey(t))!),
      model: this.model,
      dimension: this.dimension,
    };
  }

  /** Every vector held, as the two recorded-vector files, keys sorted. */
  toFiles(note: string): { file: RecordedVectorsFile; bytes: Buffer } {
    const keys = [...this.vectors.keys()].sort();
    const bytes = Buffer.alloc(keys.length * this.dimension * 2);
    keys.forEach((key, n) => {
      this.vectors.get(key)!.forEach((x, i) => {
        bytes.writeUInt16LE(toFloat16Bits(x), (n * this.dimension + i) * 2);
      });
    });
    return {
      file: { model: this.model, dimension: this.dimension, note, encoding: "float16-le", keys },
      bytes,
    };
  }
}

/** Throw when a run asked for a vector nobody could give it. */
export function assertNoMissingVectors(cache: EmbedCache): void {
  if (cache.missing.length === 0) return;
  throw new Error(
    `${cache.missing.length} text(s) had no vector, so the hybrid search fell back to BM25 for ` +
      `them (first: "${cache.missing[0]!.slice(0, 80)}"). Record them with: ${cache.rerecord}`,
  );
}

/** A row as production's `SYMBOL_SELECT` + `toSearchable` present it to the lexical channel. */
export function toSearchable(r: LocalizationSymbolRow): SearchableSymbol {
  return {
    symbolId: r.id,
    name: r.name,
    qualifiedName: r.qualifiedName,
    kind: r.kind,
    filePath: r.filePath,
    ...(r.signature ? { signature: r.signature } : {}),
    ...(r.docComment ? { docstring: r.docComment } : {}),
    ...(r.package ? { package: r.package } : {}),
  };
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** What the A0 seeding needs: the search, and the row lookups it hydrates hits with. */
export interface CorpusSearch {
  searcher: SeedSearcher;
  loadSymbols: SeedSymbolLoader;
  loadWriterIds: (symbolIds: string[], projectId: string) => Promise<Set<string>>;
  /** The model the vectors are from. */
  embeddingModel: string;
  /** A short digest of the rows searched, so a report names the exact corpus. */
  symbolsDigest: string;
}

/**
 * Build the corpus search. Every symbol with an embedding text is embedded once
 * (through `embed`), up front, as production's background embed job would have.
 * The project id of each search is the repository name.
 */
export async function buildCorpusSearch(
  rows: readonly LocalizationSymbolRow[],
  embed: EmbedCache,
): Promise<CorpusSearch> {
  const byRepo = new Map<string, LocalizationSymbolRow[]>();
  for (const r of rows) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo)!.push(r);
  }
  // Frozen and returned as the SAME array each time, like production's index:
  // HybridCodeSearch keys its shared BM25 index on the array's identity.
  const searchable = new Map(
    [...byRepo].map(([repo, rs]) => [repo, Object.freeze(rs.map(toSearchable))] as const),
  );
  const embeddable = rows.filter((r) => r.embeddingText);
  const { vectors } = await embed.embed(embeddable.map((r) => r.embeddingText!));
  const vectorRows = new Map<string, Array<{ row: LocalizationSymbolRow; vector: number[] }>>();
  embeddable.forEach((row, i) => {
    if (!vectorRows.has(row.repo)) vectorRows.set(row.repo, []);
    vectorRows.get(row.repo)!.push({ row, vector: vectors[i]! });
  });
  const store: SymbolVectorStore = {
    async search(projectId, queryVector, k) {
      return (vectorRows.get(projectId) ?? [])
        .map(({ row, vector }) => ({
          metadata: {
            symbolId: row.id,
            filePath: row.filePath,
            kind: row.kind,
            name: row.name,
            qualifiedName: row.qualifiedName,
            contentHash: "",
          },
          score: cosine(queryVector, vector),
        }))
        .sort((a, b) => b.score - a.score || a.metadata.symbolId.localeCompare(b.metadata.symbolId))
        .slice(0, k);
    },
  };
  const index: SymbolIndex = {
    async getSymbols(projectId) {
      return searchable.get(projectId) ?? [];
    },
  };
  const hybrid = new HybridCodeSearch(store, index, embed);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const loadSymbols: SeedSymbolLoader = async (ids, projectId) =>
    ids.flatMap((id): SeedSymbolRow[] => {
      const r = byId.get(id);
      if (!r || r.repo !== projectId) return [];
      return [
        {
          id: r.id,
          qualifiedName: r.qualifiedName,
          filePath: r.filePath,
          kind: r.kind,
          language: r.language,
          startLine: r.startLine,
          endLine: r.endLine,
          signature: r.signature ?? null,
        },
      ];
    });
  return {
    searcher: {
      async search(query, projectId, opts) {
        const hits = await hybrid.search(query, projectId, {
          limit: opts?.limit ?? 20,
          onRetrievalMode: opts?.onRetrievalMode,
        });
        return hits.map((h) => ({
          symbolId: h.symbolId,
          filePath: h.filePath,
          name: h.name,
          kind: h.kind,
          score: h.score,
        }));
      },
    },
    loadSymbols,
    loadWriterIds: async (ids, projectId) =>
      new Set(ids.filter((id) => byId.get(id)?.repo === projectId && byId.get(id)?.writesData)),
    embeddingModel: embed.modelId,
    symbolsDigest: createHash("sha256")
      .update(
        rows.map((r) => `${r.id}\u0000${r.qualifiedName}\u0000${r.embeddingText ?? ""}`).join("\n"),
      )
      .digest("hex")
      .slice(0, 12),
  };
}
