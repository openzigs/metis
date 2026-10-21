/**
 * Issue #1097 — recorded embeddings for the requirement→code evals.
 *
 * Since #1097 `mapRequirementToCode` ranks with the hybrid search by default, so
 * the evals that replay it (`eval:reqmap`, `eval:impact-recall`) need symbol and
 * query vectors. Computing them needs the embedding model's weights (hundreds of
 * MB), which CI does not download. So the vectors are computed ONCE on a
 * developer machine with the local model and committed next to the fixture,
 * keyed by the SHA-256 of the exact text embedded:
 *
 *   pnpm eval:reqmap --record-vectors            # needs the local model
 *   pnpm eval:impact-recall --no-filter --searcher hybrid --record-vectors
 *
 * A replay embeds nothing. {@link RecordedEmbedService} answers from the file and
 * THROWS on a text it has no vector for: a fixture or query change then fails
 * loudly, naming the command that re-records, rather than scoring a silent
 * BM25 fallback as if it were the hybrid ranking.
 *
 * No network and no paid model at any point: recording uses the in-process
 * `gte-modernbert-base` weights from `TRANSFORMERS_CACHE`.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  HybridCodeSearch,
  type SearchableSymbol,
  type SymbolIndex,
  type SymbolVectorStore,
} from "../code-graph/hybrid-search.js";
import type { EmbedService } from "../code-graph/symbol-embeddings.js";
import { HybridCodeSymbolSearcher } from "../traceability/requirement-code-searcher.js";
import type {
  Bm25SearcherOptions,
  MemoizingBm25CodeSymbolSearcher,
} from "../traceability/requirement-code-mapping.js";

/**
 * The committed recording is two files. `<name>.json` (this shape) holds the
 * model, the dimension and the text hashes in order; `<name>.bin` holds the
 * vectors in that order, each component in IEEE half precision,
 * little-endian. Half precision keeps a cosine within about 1e-4 of the full
 * one and the vectors a quarter the size of decimal JSON (the JPetStore corpus:
 * 0.15 MB instead of 0.75 MB). The vectors are a `.bin` file, not text, so the
 * repository's text gates do not read them: base64 text of random bytes
 * happens to spell short words.
 */
export interface RecordedVectorsFile {
  model: string;
  dimension: number;
  note: string;
  encoding: "float16-le";
  /** The SHA-256 of each embedded text, in the order of the vectors in the `.bin` file. */
  keys: string[];
}

/** A recording, decoded. */
export interface RecordedVectors {
  model: string;
  dimension: number;
  vectors: ReadonlyMap<string, number[]>;
}

/** The key a text's vector is stored under. */
export function recordedTextKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** The IEEE half-precision bits of `value`, rounded to nearest even. */
export function toFloat16Bits(value: number): number {
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow → Inf
  if (e <= 0) {
    if (e < -10) return sign; // underflow → ±0
    const m = mant | 0x800000;
    const shift = 14 - e;
    const half = m >>> shift;
    const rest = m & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    return sign | (half + (rest > mid || (rest === mid && half & 1) ? 1 : 0));
  }
  const half = (e << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  return sign | (half + (rest > 0x1000 || (rest === 0x1000 && half & 1) ? 1 : 0));
}

/** The number the half-precision `bits` encode. */
export function fromFloat16Bits(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const mant = bits & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** The `.bin` file that goes with a recording's `.json` file. */
export function recordedVectorsBinFile(jsonFile: string): string {
  return jsonFile.replace(/\.json$/, "") + ".bin";
}

/** Decode a recording: its index and its vector bytes. */
export function decodeRecordedVectors(file: RecordedVectorsFile, bytes: Buffer): RecordedVectors {
  if (file.encoding !== "float16-le") {
    throw new Error(`unknown recorded-vector encoding: ${String(file.encoding)}`);
  }
  const width = file.dimension * 2;
  if (bytes.length !== file.keys.length * width) {
    throw new Error(
      `recorded vectors: ${bytes.length} bytes for ${file.keys.length} vectors of ${file.dimension}`,
    );
  }
  const vectors = new Map<string, number[]>();
  file.keys.forEach((key, n) => {
    const v: number[] = [];
    for (let i = 0; i < file.dimension; i++) {
      v.push(fromFloat16Bits(bytes.readUInt16LE(n * width + i * 2)));
    }
    vectors.set(key, v);
  });
  return { model: file.model, dimension: file.dimension, vectors };
}

/** Read and decode a recording (`.json` + `.bin`), or `null` when there is none. */
export async function loadRecordedVectors(jsonFile: string): Promise<RecordedVectors | null> {
  let raw: string;
  try {
    raw = await fs.readFile(jsonFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const bytes = await fs.readFile(recordedVectorsBinFile(jsonFile));
  return decodeRecordedVectors(JSON.parse(raw) as RecordedVectorsFile, bytes);
}

/** Write a recording's two files. */
export async function writeRecordedVectors(
  jsonFile: string,
  recording: { file: RecordedVectorsFile; bytes: Buffer },
): Promise<void> {
  await fs.writeFile(jsonFile, `${JSON.stringify(recording.file, null, 2)}\n`, "utf8");
  await fs.writeFile(recordedVectorsBinFile(jsonFile), recording.bytes);
}

/**
 * An {@link EmbedService} that answers from a recording and refuses anything
 * else. The refusal alone is not enough: HybridCodeSearch catches an embed
 * failure and answers with BM25, which would score a stale recording as if it
 * were the hybrid ranking. So every refused text is also kept in
 * {@link missing}, and the eval fails on it ({@link assertFullyRecorded}).
 */
export class RecordedEmbedService implements EmbedService {
  /** The texts asked for that the recording has no vector for. */
  readonly missing: string[] = [];

  constructor(
    private readonly recording: RecordedVectors,
    /** The command that re-records, named in the error. */
    readonly rerecord: string,
  ) {}

  async embed(texts: string[]): Promise<{ vectors: number[][]; model: string; dimension: number }> {
    const vectors = texts.map((text) => {
      const v = this.recording.vectors.get(recordedTextKey(text));
      if (!v) {
        this.missing.push(text);
        throw new Error(
          `no recorded vector for "${text.slice(0, 80)}"; the fixture or a query changed. ` +
            `Re-record with: ${this.rerecord}`,
        );
      }
      return v;
    });
    return { vectors, model: this.recording.model, dimension: this.recording.dimension };
  }
}

/** Throw when a replay asked for a text the recording does not hold. */
export function assertFullyRecorded(embed: EmbedService): void {
  if (!(embed instanceof RecordedEmbedService) || embed.missing.length === 0) return;
  throw new Error(
    `${embed.missing.length} text(s) have no recorded vector, so the hybrid arm fell back to ` +
      `BM25 for them (first: "${embed.missing[0]!.slice(0, 80)}"). Re-record with: ${embed.rerecord}`,
  );
}

/** An {@link EmbedService} that records every text another one embeds. */
export class RecordingEmbedService implements EmbedService {
  private readonly vectors = new Map<string, number[]>();
  private model = "";
  private dimension = 0;

  constructor(private readonly inner: EmbedService) {}

  async embed(texts: string[]): Promise<{ vectors: number[][]; model: string; dimension: number }> {
    const result = await this.inner.embed(texts);
    this.model = result.model;
    this.dimension = result.dimension;
    texts.forEach((text, i) => {
      const v = result.vectors[i];
      if (v) this.vectors.set(recordedTextKey(text), v);
    });
    return result;
  }

  /** The recording as its two committed files ({@link RecordedVectorsFile}), keys sorted. */
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

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** A symbol of an eval corpus, with the text production would embed for it. */
export interface EmbeddableSymbol extends SearchableSymbol {
  embeddingText: string;
}

/**
 * An in-memory {@link SymbolVectorStore} over `symbols`, each embedded once with
 * `embed` (the recorded service in a replay). Exact cosine, like the local store.
 */
export async function buildInMemorySymbolVectorStore(
  symbols: readonly EmbeddableSymbol[],
  embed: EmbedService,
): Promise<SymbolVectorStore> {
  const { vectors } = await embed.embed(symbols.map((s) => s.embeddingText));
  const rows = symbols.map((s, i) => ({ symbol: s, vector: vectors[i] }));
  return {
    async search(_projectId, queryVector, k) {
      return rows
        .map((r) => ({
          metadata: {
            symbolId: r.symbol.symbolId,
            filePath: r.symbol.filePath,
            kind: r.symbol.kind,
            name: r.symbol.name,
            qualifiedName: r.symbol.qualifiedName,
            contentHash: "",
          },
          score: cosine(queryVector, r.vector),
        }))
        .sort((a, b) => b.score - a.score || a.metadata.symbolId.localeCompare(b.metadata.symbolId))
        .slice(0, k);
    },
  };
}

/**
 * The production {@link HybridCodeSymbolSearcher} over an eval corpus: the real
 * HybridCodeSearch (weights, fusion, fallback) on an in-memory index and vector
 * store, turning hits into candidates with the fixture's BM25 searcher.
 */
export async function buildEvalHybridSearcher(opts: {
  symbols: readonly EmbeddableSymbol[];
  bm25: MemoizingBm25CodeSymbolSearcher;
  embed: EmbedService;
  model: string;
  /** Options hybrid hits are ranked under; default the fallback's (`bm25`'s). */
  hybridOptions?: Bm25SearcherOptions;
}): Promise<HybridCodeSymbolSearcher> {
  const vectorStore = await buildInMemorySymbolVectorStore(opts.symbols, opts.embed);
  const searchable: SearchableSymbol[] = opts.symbols.map(
    ({ embeddingText: _text, ...symbol }) => symbol,
  );
  const index: SymbolIndex = {
    async getSymbols() {
      return searchable;
    },
  };
  return new HybridCodeSymbolSearcher({
    bm25: opts.bm25,
    hybrid: new HybridCodeSearch(vectorStore, index, opts.embed),
    semanticModel: () => opts.model,
    ...(opts.hybridOptions ? { hybridOptions: opts.hybridOptions } : {}),
  });
}
