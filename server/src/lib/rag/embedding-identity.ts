/**
 * Persisted embedding IDENTITY — model + pooling + dtype (issue #792).
 *
 * ## The bug this closes
 *
 * A stored vector is a function of THREE things, not one: the model, the
 * POOLING that turned its token matrix into a vector (cos(cls, mean) = 0.856 on
 * gte-modernbert — a completely different vector), and the DTYPE of the weights
 * (q8 vs fp32 differ). Chunk reuse, coverage, and #787's shadow-reindex all keyed
 * on the model id ALONE (`KnowledgeChunk.embeddingModel`). So an operator who
 * flipped `EMBED_POOLING_MAP` / `EMBED_POOLING` / `EMBED_DTYPE` on a live
 * deployment changed the vectors the embedder produces while the reuse guard saw
 * the same model id — silently mixing cls- and mean-pooled (or q8 and fp32)
 * vectors in one index. Plausible, unit-norm, semantically degraded; no signal;
 * hybrid retrieval collapses toward BM25-only. This module makes the pooling and
 * dtype part of the identity the guard compares, so a flip INVALIDATES reuse and
 * drives the existing reindex flow for free.
 *
 * ## Representation — a composite string in the existing `embeddingModel` field
 *
 * The identity rides the ONE string that already flows end-to-end (the Prisma
 * `KnowledgeChunk.embeddingModel` column AND the vector-store row metadata), so
 * no new column, no vector-store schema change, no Prisma migration. The chosen
 * form is:
 *
 *   - `model`                       when pooling+dtype are the model's BUILT-IN
 *                                   defaults (the shipped resolution);
 *   - `model|pooling|dtype`         otherwise.
 *
 * The "bare when default" rule is what makes grandfathering a mathematical
 * identity instead of a data migration. Every row written before #792 carries a
 * bare model id, and every one of them was produced by the built-in resolution
 * (there was no persisted pooling to diverge from). The active embedder at its
 * DEFAULT config produces the SAME bare identity, so those rows match exactly —
 * no spurious reindex, no retag, no backfill. The moment an operator flips a
 * knob, the resolved pooling/dtype leave the built-in defaults, the identity
 * gains its `|pooling|dtype` suffix, and it stops matching the bare corpus — a
 * mismatch the existing coverage/reindex path already knows how to act on.
 *
 * A row's identity is therefore CANONICAL by construction: (cls, q8) for
 * gte-modernbert has exactly one spelling (bare), never two. Comparison is plain
 * string equality — no parsing, no normalisation table.
 */
import {
  DEFAULT_DTYPE,
  DEFAULT_POOLING,
  poolingFromModelMap,
  type EmbedDtype,
  type EmbedPooling,
  isEmbedDtype,
  isEmbedPooling,
} from "./embed-model-config.js";

/**
 * The pooling a model resolves to with NO operator override — its built-in map
 * entry, else the `mean` fallback. This is the baseline the identity is bare
 * against: a resolved pooling equal to this one produced the same vectors as the
 * pre-#792 default, so it needs no suffix.
 */
export function builtinPooling(model: string): EmbedPooling {
  return poolingFromModelMap(model) ?? DEFAULT_POOLING;
}

/**
 * The persisted embedding identity for `(model, pooling, dtype)`.
 *
 * Bare `model` when the pooling+dtype are the built-in defaults (back-compatible
 * with every pre-#792 row and the shipped config); `model|pooling|dtype`
 * otherwise. See the module header for why "bare when default" grandfathers the
 * existing index without a migration.
 */
export function formatEmbeddingIdentity(
  model: string,
  pooling: EmbedPooling,
  dtype: EmbedDtype,
): string {
  if (pooling === builtinPooling(model) && dtype === DEFAULT_DTYPE) {
    return model;
  }
  return `${model}|${pooling}|${dtype}`;
}

/**
 * Build an identity from a sidecar `/embed` WIRE response (issue #792 crux).
 *
 * For the `sidecar` backend the pooling+dtype that ACTUALLY produced a vector are
 * resolved in the SIDECAR process from the SIDECAR's env, which can differ from
 * the server's. The server must persist what the sidecar REPORTS, never a locally
 * re-derived guess — stamping a server-side guess onto a sidecar-produced vector
 * is the exact silent disagreement this issue exists to kill, now with a guard
 * vouching for it.
 *
 * So the identity is built from the echoed `pooling`/`dtype`. A pre-#782 sidecar
 * that echoes NEITHER falls back to the bare model id: it predates configurable
 * pooling, so bare (built-in defaults) is the only honest reading, and it keeps
 * this wire-compatible. A server/sidecar env mismatch is then DETECTABLE rather
 * than mislabelled — the persisted identity carries the sidecar's real values, so
 * a divergence surfaces as an identity (and therefore coverage/reindex) change.
 */
export function identityFromWire(model: string, pooling: unknown, dtype: unknown): string {
  if (isEmbedPooling(pooling) && isEmbedDtype(dtype)) {
    return formatEmbeddingIdentity(model, pooling, dtype);
  }
  // A sidecar that does not echo both fields (pre-#782): the only honest reading
  // is the bare model id — do NOT substitute the server's own resolved values.
  return model;
}
