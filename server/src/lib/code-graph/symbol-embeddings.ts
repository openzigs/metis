/**
 * Epic #507 / Issue #508 — Symbol-level embedding pipeline with incremental hashing.
 *
 * Triggered during code-graph ingest (after symbol extraction). Computes an
 * embedding for each symbol using the existing embedding service, using a
 * SHA-256 content hash as a cache key to enable incremental updates.
 *
 * Embeddings are stored in the vector store with metadata that identifies
 * the source symbol, enabling hybrid search (issue #509).
 */
import { createHash } from "node:crypto";
import { createChildLogger } from "../logger.js";
import { MAX_EMBED_TEXT_CHARS, MAX_EMBED_TEXTS_PER_REQUEST } from "../rag/embed-model-config.js";
import type { EmbeddingResult } from "../rag/embedder.js";

const log = createChildLogger("symbol-embeddings");

// ---- Types ----------------------------------------------------------------

export type SymbolKind = "function" | "class" | "interface" | "type" | "module" | "method";

export interface SymbolForEmbedding {
  symbolId: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  filePath: string;
  signature?: string;
  docstring?: string;
  bodyLines?: string[];
  /**
   * Issue #797 — the ALREADY-FORMATTED index text, when the caller has it.
   *
   * Ingest formats a symbol while the source file is still in memory and
   * persists the result to `CodeSymbolEmbedding.text`. Everything downstream —
   * the background embed job, and the #787 re-index after a model flip — runs
   * long after that file is gone, and `CodeSymbol` stores no signature,
   * docstring or body to rebuild it from. So those callers replay the persisted
   * text verbatim rather than re-deriving a DIFFERENT one; see
   * {@link formatSymbolForEmbedding}.
   */
  text?: string;
}

export interface SymbolEmbeddingMetadata {
  symbolId: string;
  filePath: string;
  kind: string;
  name: string;
  qualifiedName: string;
  contentHash: string;
  /** Issue #797 — the embedded text, so the store can persist it durably. */
  text?: string;
  /** Issue #797 — the model that produced the vector (the search-time filter). */
  embeddingModel?: string;
}

export interface SymbolEmbeddingRow {
  id: string;
  vector: number[];
  metadata: SymbolEmbeddingMetadata;
}

export interface SymbolEmbeddingStore {
  getExistingHashes(projectId: string): Promise<Map<string, string>>;
  upsert(projectId: string, rows: SymbolEmbeddingRow[]): Promise<void>;
  deleteBySymbolIds(projectId: string, symbolIds: string[]): Promise<number>;
}

export interface EmbedService {
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export interface PipelineProgress {
  total: number;
  completed: number;
  skipped: number;
  phase: "hashing" | "embedding" | "storing" | "done";
}

export type ProgressCallback = (progress: PipelineProgress) => void;

export interface PipelineOptions {
  projectId: string;
  symbols: SymbolForEmbedding[];
  batchSize?: number;
  onProgress?: ProgressCallback;
}

export interface PipelineResult {
  totalSymbols: number;
  embedded: number;
  skipped: number;
  deleted: number;
  durationMs: number;
}

// ---- Formatting -----------------------------------------------------------

/** Max body lines to include in the embedding text. */
const MAX_BODY_LINES = 10;

/**
 * Format a symbol for embedding. The format is:
 * `{kind} {name} in {filePath}\n{signature}\n{docstring}\n{body_first_10_lines}`
 *
 * A pre-formatted {@link SymbolForEmbedding.text} short-circuits this: it is
 * returned verbatim (subject to the same {@link MAX_TEXT_CHARS} cap below).
 * That is the ONLY way the re-index path can reproduce the text a symbol was
 * originally embedded from (issue #797) — the source file is long gone and
 * the DB keeps no body.
 */
export function formatSymbolForEmbedding(symbol: SymbolForEmbedding): string {
  if (symbol.text !== undefined) return truncateForEmbedding(symbol.text);

  const parts: string[] = [];
  parts.push(`${symbol.kind} ${symbol.name} in ${symbol.filePath}`);

  if (symbol.signature) {
    parts.push(symbol.signature);
  }

  if (symbol.docstring) {
    parts.push(symbol.docstring);
  }

  if (symbol.bodyLines && symbol.bodyLines.length > 0) {
    const bodyPreview = symbol.bodyLines.slice(0, MAX_BODY_LINES).join("\n");
    parts.push(bodyPreview);
  }

  return truncateForEmbedding(parts.join("\n"));
}

/**
 * `MAX_BODY_LINES` bounds body preview by LINE COUNT, which does nothing for a
 * source file with pathologically long lines (minified/generated code, a huge
 * embedded string/SQL/XML literal): a single one of those "10 lines" can carry
 * hundreds of KB. Real-world repro (2026-09-03, a JSP/Java monorepo of only 374
 * files): 46k symbols averaged 166 KB of embed text each (max ~1 MB), 7.66 GB
 * total — `embedProjectSymbols`/`getExistingHashes` load every row's `text` in
 * one `findMany`, so that alone crashed the dev server with a heap OOM twice.
 *
 * Cap at the embeddings sidecar's OWN per-entry limit (`MAX_EMBED_TEXT_CHARS`,
 * issue #786): the sidecar already rejects (400, no silent truncation) any text
 * over this length, so persisting something longer was never going to embed
 * anyway. Truncating here bounds both storage and the in-memory embed batch.
 */
const MAX_TEXT_CHARS = MAX_EMBED_TEXT_CHARS;

function truncateForEmbedding(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

/**
 * Compute the SHA-256 hash of the formatted symbol content. Used as a cache
 * key to enable incremental embedding — if the hash hasn't changed, the
 * symbol doesn't need to be re-embedded.
 */
export function computeSymbolHash(formattedContent: string): string {
  return createHash("sha256").update(formattedContent).digest("hex");
}

// ---- Pipeline -------------------------------------------------------------

/**
 * Default batch size for embedding API calls.
 *
 * Issue #797 — pinned to {@link MAX_EMBED_TEXTS_PER_REQUEST} (64), the hard cap
 * the embeddings sidecar enforces per POST (#786). At the old value of 100 the
 * embeddings client silently re-split every batch into 64 + 36, so a "batch"
 * here mapped onto two sidecar round-trips of uneven size and the progress
 * counter told you nothing about the request cadence. One batch = one post.
 */
const DEFAULT_BATCH_SIZE = MAX_EMBED_TEXTS_PER_REQUEST;

export class SymbolEmbeddingPipeline {
  constructor(
    private readonly store: SymbolEmbeddingStore,
    private readonly embedService: EmbedService,
  ) {}

  /**
   * Run the embedding pipeline for a set of symbols. Incrementally embeds
   * only symbols whose content has changed (based on SHA-256 hash).
   */
  async run(options: PipelineOptions): Promise<PipelineResult> {
    const start = Date.now();
    const { projectId, symbols, batchSize = DEFAULT_BATCH_SIZE, onProgress } = options;

    const progress: PipelineProgress = {
      total: symbols.length,
      completed: 0,
      skipped: 0,
      phase: "hashing",
    };

    // Step 1: Get existing hashes for incremental skip
    const existingHashes = await this.store.getExistingHashes(projectId);

    // Step 2: Format symbols and compute hashes, determine which need embedding
    const toEmbed: Array<{ symbol: SymbolForEmbedding; formatted: string; hash: string }> = [];
    const currentSymbolIds = new Set<string>();

    for (const symbol of symbols) {
      currentSymbolIds.add(symbol.symbolId);
      const formatted = formatSymbolForEmbedding(symbol);
      const hash = computeSymbolHash(formatted);

      if (existingHashes.get(symbol.symbolId) === hash) {
        progress.skipped++;
      } else {
        toEmbed.push({ symbol, formatted, hash });
      }
    }

    progress.phase = "embedding";
    onProgress?.(progress);

    log.info("Symbol embedding pipeline started", {
      projectId,
      total: symbols.length,
      toEmbed: toEmbed.length,
      skipped: progress.skipped,
    });

    // Step 3: Batch embed
    const allRows: SymbolEmbeddingRow[] = [];

    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const texts = batch.map((b) => b.formatted);

      const result = await this.embedService.embed(texts);

      const batchRows: SymbolEmbeddingRow[] = [];
      for (let j = 0; j < batch.length; j++) {
        const { symbol, hash, formatted } = batch[j];
        const vector = result.vectors[j];
        if (!vector) continue;

        batchRows.push({
          id: `sym-embed-${symbol.symbolId}`,
          vector,
          metadata: {
            symbolId: symbol.symbolId,
            filePath: symbol.filePath,
            kind: symbol.kind,
            name: symbol.name,
            qualifiedName: symbol.qualifiedName,
            contentHash: hash,
            text: formatted,
            embeddingModel: result.model,
          },
        });
      }

      // Issue #797 — PERSIST PER BATCH, not once at the end.
      //
      // A cold build of METIS is ~15k symbols ≈ 235 sidecar posts ≈ tens of
      // minutes. Holding every vector in memory until the last batch lands means
      // a pod eviction at 95% throws away all of it. Writing each batch as it
      // completes makes the store itself the resume checkpoint: a restarted run
      // sees the already-written hashes and skips them.
      if (batchRows.length > 0) {
        await this.store.upsert(projectId, batchRows);
        allRows.push(...batchRows);
      }

      progress.completed += batch.length;
      onProgress?.(progress);
    }

    progress.phase = "storing";
    onProgress?.(progress);

    // Step 5: Remove embeddings for symbols that no longer exist
    const staleSymbolIds: string[] = [];
    for (const existingId of existingHashes.keys()) {
      if (!currentSymbolIds.has(existingId)) {
        staleSymbolIds.push(existingId);
      }
    }

    let deleted = 0;
    if (staleSymbolIds.length > 0) {
      deleted = await this.store.deleteBySymbolIds(projectId, staleSymbolIds);
    }

    progress.phase = "done";
    onProgress?.(progress);

    const durationMs = Date.now() - start;
    log.info("Symbol embedding pipeline completed", {
      projectId,
      embedded: allRows.length,
      skipped: progress.skipped,
      deleted,
      durationMs,
    });

    return {
      totalSymbols: symbols.length,
      embedded: allRows.length,
      skipped: progress.skipped,
      deleted,
      durationMs,
    };
  }
}
