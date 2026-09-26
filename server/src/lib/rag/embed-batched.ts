/**
 * Issue #189 — embed a large text set in bounded batches, never all at once.
 *
 * A generated document handed ALL of its chunks to one `embedder.embed` call; a
 * 611,592-character document is ~500 chunks, one request, no progress, no
 * cancellation point, and every vector held until the last one returns. This is
 * the shared bulk path: fixed-size batches, an abort check between them, progress
 * after each, and a guarantee that one result never mixes two embedding
 * identities (a backend that falls back mid-run would otherwise persist a document
 * whose vectors live in two spaces under one label).
 *
 * Repository-source ingest (#182) can adopt it unchanged.
 */
import type { EmbeddingResult } from "./embedder-registry.js";

/** Texts per `embed` call. Bounds the per-call payload and the progress granularity. */
export const DEFAULT_EMBED_BATCH_SIZE = 32;

export interface BoundedEmbedOptions {
  batchSize?: number;
  signal?: AbortSignal;
  /** Called after each batch with texts embedded so far and the total. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export async function embedInBoundedBatches(
  embedder: { embed(texts: string[]): Promise<EmbeddingResult> },
  texts: readonly string[],
  opts: BoundedEmbedOptions = {},
): Promise<EmbeddingResult> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_EMBED_BATCH_SIZE));
  const vectors: number[][] = [];
  let first: EmbeddingResult | null = null;
  for (let start = 0; start < texts.length; start += batchSize) {
    opts.signal?.throwIfAborted();
    const batch = texts.slice(start, start + batchSize);
    const result = await embedder.embed(batch);
    if (result.vectors.length !== batch.length) {
      throw new Error(
        `embedder returned ${result.vectors.length} vectors for a batch of ${batch.length} texts`,
      );
    }
    if (first && identityOf(result) !== identityOf(first)) {
      throw new Error(
        `embedding identity changed mid-document (${identityOf(first)} → ${identityOf(result)}); ` +
          "refusing to persist vectors from two embedding spaces under one label",
      );
    }
    first ??= result;
    vectors.push(...result.vectors);
    await opts.onProgress?.(vectors.length, texts.length);
  }
  if (!first) return { vectors: [], model: "empty", identity: "empty", dimension: 0 };
  return { ...first, vectors };
}

function identityOf(result: EmbeddingResult): string {
  return result.identity ?? result.model;
}
