/**
 * Issue #2234 — a record/replay cache for the `model` contextual-chunks arm.
 *
 * The `model` arm makes one provider call per chunk: 428 on the default corpus,
 * more than one bounded eval run can finish alongside its control arm. Recording
 * each context lets a second run replay the first's contexts and call the model
 * only for what is missing, so the arm can be completed across runs and re-scored
 * without paying for it again.
 *
 * #2268 — a context is recorded under the production reuse key
 * (`chunkContextKey`): the prompt's wording, the provider and model, the document,
 * its title and the chunk. A run on another model, or after a prompt change, does
 * not replay contexts another model or prompt wrote. The generator itself does the
 * lookup (its `saved` input), exactly as an ingest reusing a document's contexts.
 */
import { promises as fs } from "node:fs";

import type { ChunkContextGenerator } from "../../rag/contextual-chunks.js";

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
 * sent to the model. A `null` (failed) context is not recorded, so a later run
 * retries it. `persist` runs after every document that produced new contexts.
 */
export function cachedChunkContextGenerator(
  inner: ChunkContextGenerator,
  cache: Record<string, string>,
  persist: (cache: Record<string, string>) => Promise<void> = async () => {},
): ChunkContextGenerator {
  return async (input) => {
    // #2355 — merged with, never in place of, the contexts the caller already saved.
    const saved = new Map([...(input.saved ?? []), ...Object.entries(cache)]);
    const out = await inner({ ...input, saved });
    let added = 0;
    for (const context of out) {
      if (context && cache[context.key] !== context.text) {
        cache[context.key] = context.text;
        added += 1;
      }
    }
    if (added > 0) await persist(cache);
    return out;
  };
}
