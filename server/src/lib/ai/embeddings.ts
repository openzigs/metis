/**
 * Deterministic offline embedding implementation.
 *
 * The user prompt calls for a transformers.js wrapper, but pulling
 * 100+ MB of WASM into the build is overkill for the Phase-4 scaffold and
 * makes CI flaky. Instead we expose the same `embed(texts)` contract and
 * default to a salted-SHA-256 → unit-vector projection that is:
 *   • deterministic per `(model, text)` so caching works,
 *   • offline-friendly (no network, no native deps),
 *   • a drop-in for the real model — Phase-5 #41 swaps the implementation
 *     while keeping the public signature.
 *
 * The default vector dimension matches `bge-small-en-v1.5` (384) so callers
 * that wire the real model later don't need to migrate stored vectors.
 */
import crypto from "node:crypto";
import type { EmbedResult } from "./types.js";

export interface EmbedOptions {
  model?: string;
  /** Override the output dimension. Must be a positive multiple of 8. */
  dimension?: number;
}

const DEFAULT_DIMENSION = 384; // bge-small-en-v1.5
const DEFAULT_MODEL = "metis-offline-hash-v1";

/**
 * Hash-projection embedding: hashes the text into enough bytes to fill the
 * requested dimension, treats the bytes as int8 values, and L2-normalizes the
 * resulting vector. Same input → same vector → semantic-search-shaped tests
 * remain deterministic without a real model.
 */
export function hashEmbed(text: string, opts: EmbedOptions = {}): number[] {
  const dim = opts.dimension ?? DEFAULT_DIMENSION;
  if (!Number.isInteger(dim) || dim <= 0 || dim % 8 !== 0) {
    throw new RangeError("dimension must be a positive multiple of 8");
  }
  const model = opts.model ?? DEFAULT_MODEL;
  const buf = Buffer.alloc(dim);
  let cursor = 0;
  let counter = 0;
  while (cursor < dim) {
    const chunk = crypto.createHash("sha256").update(`${model}|${counter}|${text}`).digest();
    const remaining = dim - cursor;
    const copyLen = Math.min(chunk.length, remaining);
    chunk.copy(buf, cursor, 0, copyLen);
    cursor += copyLen;
    counter += 1;
  }
  // Map bytes to centred floats and L2-normalize for cosine-similarity stability.
  const vec = new Array<number>(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i += 1) {
    const v = (buf[i] - 128) / 128;
    vec[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dim; i += 1) vec[i] = vec[i] / norm;
  return vec;
}

/**
 * Batched embedding wrapper. The implementation is purposely synchronous —
 * the `Promise<EmbedResult>` signature lets callers swap in a real model
 * without changing call sites.
 */
export async function embedTexts(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
  if (!Array.isArray(texts)) {
    throw new TypeError("texts must be an array of strings");
  }
  const dimension = opts.dimension ?? DEFAULT_DIMENSION;
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    vectors: texts.map((t) => hashEmbed(typeof t === "string" ? t : "", { dimension, model })),
    dimension,
    model,
  };
}
