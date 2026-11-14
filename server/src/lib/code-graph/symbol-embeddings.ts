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
   * Issue #1072 — the labelled context lines (`package: …`, `doc: …`) placed
   * between the header and everything else: `shippedContextLines` in
   * `symbol-context.ts`. Each is one line of neutralised repository text.
   */
  contextLines?: string;
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
  /**
   * #2346 — the stored vectors of `symbolIds` (ids whose symbol is gone), each
   * with the text it was embedded from and the file it was in. The pipeline
   * reuses one for a new symbol with the same content instead of embedding it
   * again ({@link renameStableKeys}). Optional: a store without it reuses
   * nothing, and every new symbol is embedded.
   */
  getStoredVectors?(projectId: string, symbolIds: string[]): Promise<StoredSymbolVector[]>;
}

/** #2346 — a vector already in the store, as {@link SymbolEmbeddingStore.getStoredVectors} reads it. */
export interface StoredSymbolVector {
  symbolId: string;
  vector: number[];
  /** The text the vector was embedded from. */
  text: string;
  /** The file the symbol was in when it was embedded. */
  filePath: string;
  embeddingModel: string;
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
  /**
   * #2346 — symbols given the stored vector of a symbol that is gone, with the
   * same content (a renamed or moved file, or an unchanged symbol of an edited
   * file), instead of being embedded again. Not counted in `embedded`.
   */
  reused: number;
  deleted: number;
  durationMs: number;
}

// ---- Formatting -----------------------------------------------------------

/** Max body lines to include in the embedding text. */
const MAX_BODY_LINES = 10;

/**
 * Format a symbol for embedding. The format is:
 * `{kind} {name} in {filePath}\n{contextLines}\n{signature}\n{docstring}\n{body_first_10_lines}`
 *
 * Ingest — the only production caller that formats rather than replays — passes
 * `contextLines` and `bodyLines` and neither `signature` nor `docstring`: the
 * first body lines already are the declaration, and the doc comment travels as
 * a `doc:` context line (#1072).
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

  if (symbol.contextLines) {
    parts.push(symbol.contextLines);
  }

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

// ---- Rename stability (#2346) ---------------------------------------------

/** The labelled context lines `contextLines` (symbol-context.ts) places after the header. */
const CONTEXT_LINE = /^(?:receiver|package|doc|tables|callers): /;

/** What a path in a key is replaced with: a NUL, which no formatted text holds. */
const PATH_MARK = "\u0000path";
const DIR_MARK = "\u0000dir";

/**
 * #2346 — the content keys of an embedding text, with the file it is in taken
 * out, so the same symbol in a renamed or moved file has the same keys.
 *
 * Ingest writes a symbol's text as `{kind} {name} in {filePath}`, its context
 * lines, then its body (`formatSymbolForEmbedding`). Only three parts depend on
 * where the file is: the header's path; a `module` symbol's name, which is the
 * file's name; and the `package:` line of a language with no package clause,
 * which is the file's directory name (`packageOfFile`). So:
 *
 *   - `exact`: the text with the header's path (and a module's file name)
 *     replaced. Equal for a rename within a directory, a move whose directory
 *     name is the same, a file whose package line is its declared package,
 *     and an unchanged symbol of an edited file;
 *   - `moved`: also with a `package:` line naming the directory replaced.
 *     Equal for a move to another directory.
 *
 * Everything else, the body above all, must be identical. A text whose header
 * does not end with ` in {filePath}` gets keys only its own exact text matches.
 */
export function renameStableKeys(text: string, filePath: string): { exact: string; moved: string } {
  const lines = text.split("\n");
  const suffix = ` in ${filePath}`;
  const header = lines[0] ?? "";
  const parts = filePath.split("/");
  if (filePath !== "" && header.endsWith(suffix)) {
    const head = header.slice(0, header.length - suffix.length);
    const named = head === `module ${parts[parts.length - 1]}` ? `module ${PATH_MARK}` : head;
    lines[0] = `${named} in ${PATH_MARK}`;
  }
  const exact = computeSymbolHash(lines.join("\n"));
  const dir = parts.length >= 2 ? parts[parts.length - 2] : null;
  for (let i = 1; dir && i < lines.length && CONTEXT_LINE.test(lines[i]!); i += 1) {
    if (lines[i] === `package: ${dir}`) {
      lines[i] = `package: ${DIR_MARK}`;
      break;
    }
  }
  return { exact, moved: computeSymbolHash(lines.join("\n")) };
}

/** Stored vectors read per {@link SymbolEmbeddingStore.getStoredVectors} call. */
const REUSE_READ_CHUNK = 500;

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

    // Ids with a stored vector and no current symbol: deleted at the end, and
    // first offered for reuse (#2346).
    const staleSymbolIds: string[] = [];
    for (const existingId of existingHashes.keys()) {
      if (!currentSymbolIds.has(existingId)) {
        staleSymbolIds.push(existingId);
      }
    }

    // #2346 — a symbol whose content is a gone symbol's takes that vector.
    // Ingest gives every symbol of a re-parsed file a new id, so a renamed or
    // moved file, and every unchanged symbol of an edited one, would otherwise
    // be embedded again from scratch.
    const reusedRows = await this.reuseStoredVectors(projectId, toEmbed, staleSymbolIds);
    progress.skipped += reusedRows;

    progress.phase = "embedding";
    onProgress?.(progress);

    log.info("Symbol embedding pipeline started", {
      projectId,
      total: symbols.length,
      toEmbed: toEmbed.length,
      skipped: progress.skipped,
      reused: reusedRows,
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

    // Step 5: Remove embeddings for symbols that no longer exist (a reused
    // vector now lives on under its new symbol's id, so this drops the copy).
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
      reused: reusedRows,
      deleted,
      durationMs,
    });

    return {
      totalSymbols: symbols.length,
      embedded: allRows.length,
      skipped: progress.skipped - reusedRows,
      reused: reusedRows,
      deleted,
      durationMs,
    };
  }

  /**
   * #2346 — give each symbol in `toEmbed` whose {@link renameStableKeys} match
   * a stale vector's that vector, written under the symbol's own id with its
   * current path and text, and take it out of `toEmbed`. The `exact` key is
   * tried before the `moved` one. Stale vectors are read in chunks, so memory
   * is bounded however many files moved. Returns how many were reused.
   *
   * The reused vector was embedded from the text at the old path, so its path
   * tokens are the old ones until the symbol's content changes or the next
   * model re-index embeds the stored (new) text.
   */
  private async reuseStoredVectors(
    projectId: string,
    toEmbed: Array<{ symbol: SymbolForEmbedding; formatted: string; hash: string }>,
    staleSymbolIds: readonly string[],
  ): Promise<number> {
    const read = this.store.getStoredVectors?.bind(this.store);
    if (!read || toEmbed.length === 0 || staleSymbolIds.length === 0) return 0;
    const pending = toEmbed.map((t) => ({
      ...t,
      keys: renameStableKeys(t.formatted, t.symbol.filePath),
    }));
    let reused = 0;
    for (let i = 0; i < staleSymbolIds.length && pending.length > 0; i += REUSE_READ_CHUNK) {
      const stored = await read(projectId, staleSymbolIds.slice(i, i + REUSE_READ_CHUNK));
      const byExact = new Map<string, StoredSymbolVector>();
      const byMoved = new Map<string, StoredSymbolVector>();
      for (const v of stored) {
        if (!v.text || v.vector.length === 0) continue;
        const k = renameStableKeys(v.text, v.filePath);
        if (!byExact.has(k.exact)) byExact.set(k.exact, v);
        if (!byMoved.has(k.moved)) byMoved.set(k.moved, v);
      }
      const rows: SymbolEmbeddingRow[] = [];
      for (let j = pending.length - 1; j >= 0; j -= 1) {
        const p = pending[j]!;
        const v = byExact.get(p.keys.exact) ?? byMoved.get(p.keys.moved);
        if (!v) continue;
        rows.push({
          id: `sym-embed-${p.symbol.symbolId}`,
          vector: v.vector,
          metadata: {
            symbolId: p.symbol.symbolId,
            filePath: p.symbol.filePath,
            kind: p.symbol.kind,
            name: p.symbol.name,
            qualifiedName: p.symbol.qualifiedName,
            contentHash: p.hash,
            text: p.formatted,
            embeddingModel: v.embeddingModel,
          },
        });
        pending.splice(j, 1);
      }
      if (rows.length > 0) {
        await this.store.upsert(projectId, rows);
        reused += rows.length;
      }
    }
    if (reused > 0) {
      const left = new Set(pending.map((p) => p.symbol.symbolId));
      for (let j = toEmbed.length - 1; j >= 0; j -= 1) {
        if (!left.has(toEmbed[j]!.symbol.symbolId)) toEmbed.splice(j, 1);
      }
    }
    return reused;
  }
}
