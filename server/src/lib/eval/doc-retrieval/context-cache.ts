/**
 * Issue #2234 — a record/replay cache for the `model` contextual-chunks arm.
 *
 * The `model` arm makes one provider call per chunk: 428 on the default corpus,
 * more than one bounded eval run can finish alongside its control arm. Recording
 * each context under a key of (document, chunk) lets a second run replay the
 * first's contexts and call the model only for what is missing, so the arm can be
 * completed across runs and re-scored without paying for it again.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import type { ChunkContextGenerator } from "../../rag/contextual-chunks.js";

/** The key a context is recorded under: the document and the chunk, hashed. */
export function contextCacheKey(document: string, chunk: string): string {
  return createHash("sha256").update(document).update("\u0000").update(chunk).digest("hex");
}

/** Read a recorded cache; a missing file is an empty cache. */
export async function readContextCache(file: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Wrap `inner` so a recorded context is replayed and only unrecorded chunks are
 * sent to it. A `null` (failed) context is not recorded, so a later run retries it.
 * `persist` runs after every document that produced new contexts.
 */
export function cachedChunkContextGenerator(
  inner: ChunkContextGenerator,
  cache: Record<string, string>,
  persist: (cache: Record<string, string>) => Promise<void> = async () => {},
): ChunkContextGenerator {
  return async (input) => {
    const keys = input.chunks.map((c) => contextCacheKey(input.document, c));
    const missing = keys.flatMap((k, i) => (k in cache ? [] : [i]));
    if (missing.length > 0) {
      const written = await inner({ ...input, chunks: missing.map((i) => input.chunks[i]) });
      let added = 0;
      missing.forEach((chunkIndex, j) => {
        const context = written[j];
        if (typeof context === "string") {
          cache[keys[chunkIndex]] = context;
          added += 1;
        }
      });
      if (added > 0) await persist(cache);
    }
    return keys.map((k) => cache[k] ?? null);
  };
}
