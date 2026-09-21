/**
 * Issue #807 — THE ACCEPTANCE TEST, against the real production weights.
 *
 * An embedding must be a function of `(model, text)`. Nothing else. #787/#792's
 * model-tagged reuse guard skips re-embedding a symbol whose `(contentHash, model)`
 * is unchanged, which is only sound if that function exists; a reindex is only
 * reproducible if it exists; and #797's acceptance target only ranks where the
 * corpus says it ranks if it exists.
 *
 * On `main` it does NOT exist. The shipped `q8` weights carry 88
 * `DynamicQuantizeLinear` nodes, each deriving a single PER-TENSOR activation scale
 * from the whole `[batch, seq, hidden]` tensor — so every text in a batch is
 * quantized against its batch-mates' dynamic range. This test fails on `main`
 * (cos(batch-1, batch-64) = 0.974) and passes with the forward-batch split.
 *
 * ## Run it
 *
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm --filter @metis/server exec \
 *     vitest run tests/rag-embedder-batch-invariance.test.ts
 *
 * Gated on the same flag #781/#788/#797 use, so CI's default job never pulls the
 * ONNX weights. (The gate is `describe.runIf`, NOT an `.integration.test.ts`
 * filename: the server's vitest config EXCLUDES that suffix outright, so such a
 * file would never run at all — not even when someone deliberately set the flag.) `AI_OFFLINE=1` in `tests/setup.ts` would resolve `getEmbedder()` to
 * the hash stub — a green run against that would prove nothing while looking real —
 * so the production `Embedder` is constructed from the production config instead,
 * exactly as `project-code-searcher.vector.test.ts` does.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBED_DIMENSION } from "@metis/shared";
import {
  DEFAULT_SIDECAR_EMBED_MODEL,
  resolveDtype,
  resolvePooling,
} from "../src/lib/rag/embed-model-config.js";

const DOWNLOAD_ENABLED = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS === "1";

/** The SHIPPED config, derived — never restated. See #803 review (L1). */
function realEmbedderConfig() {
  return {
    backend: "xenova" as const,
    model: DEFAULT_SIDECAR_EMBED_MODEL,
    dimension: DEFAULT_EMBED_DIMENSION,
    pooling: resolvePooling(DEFAULT_SIDECAR_EMBED_MODEL).pooling,
    dtype: resolveDtype(),
  };
}

/** The text whose vector must not move. Shaped like the symbol text ingest embeds. */
const TARGET =
  "export async function reserveIdempotencyKey(scope: string, key: string): Promise<boolean> { " +
  "const existing = await store.get(scope, key); if (existing) return false; " +
  "await store.put(scope, key, Date.now()); return true; }";

/**
 * Batch-mates of WILDLY differing lengths — the worst case for padding, which is
 * what the issue suspected. (It is not actually the mechanism — see the header of
 * `resolveForwardBatch` — but it is the strongest possible perturbation, so it is
 * what the acceptance test should carry.)
 */
function filler(i: number): string {
  const words = 3 + ((i * 37) % 120);
  return Array.from({ length: words }, (_, k) => `token${(i * 13 + k) % 97}`).join(" ");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

describe.runIf(DOWNLOAD_ENABLED)("#807 — embeddings are invariant to batch composition", () => {
  it("embeds a fixed text identically at batch 1, 8 and 64", async () => {
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const { AIR_GAP_EMBED_MODEL } = await import("../src/lib/rag/embed-model-config.js");
    const embedder = new Embedder(realEmbedderConfig());

    // If this is not the real model, every assertion below is meaningless.
    const probe = await embedder.embed(["warm"]);
    expect(probe.dimension).toBe(realEmbedderConfig().dimension);
    expect(embedder.model).toBe(AIR_GAP_EMBED_MODEL);

    const targetIn = async (size: number): Promise<number[]> => {
      const texts = [TARGET, ...Array.from({ length: size - 1 }, (_, i) => filler(i))];
      const { vectors } = await embedder.embed(texts);
      return vectors[0];
    };

    const v1 = await targetIn(1);
    const v8 = await targetIn(8);
    const v64 = await targetIn(64);

    const c8 = cosine(v1, v8);
    const c64 = cosine(v1, v64);
    const c8v64 = cosine(v8, v64);

    // eslint-disable-next-line no-console
    console.log(
      `\n[#807] ${embedder.model} (${probe.dimension}d, ${realEmbedderConfig().pooling}, ` +
        `${realEmbedderConfig().dtype})\n` +
        `[#807] cos(batch-1, batch-8)  = ${c8.toFixed(8)}\n` +
        `[#807] cos(batch-1, batch-64) = ${c64.toFixed(8)}\n` +
        `[#807] cos(batch-8, batch-64) = ${c8v64.toFixed(8)}`,
    );

    // Float tolerance, not quantization tolerance. On `main` these are ~0.974 —
    // three orders of magnitude outside this bound. Do NOT loosen it: the whole
    // point is that the vector is a function of the text, and 1e-6 is already
    // generous for `normalize: true` fp32 output.
    expect(1 - c8).toBeLessThan(1e-6);
    expect(1 - c64).toBeLessThan(1e-6);
    expect(1 - c8v64).toBeLessThan(1e-6);

    // Cosine alone can hide a uniform scaling; check the components directly.
    const maxDelta = Math.max(...v1.map((x, i) => Math.abs(x - v64[i])));
    expect(maxDelta).toBeLessThan(1e-4);
  }, 900_000);

  it("gives a symbol the same vector whatever ELSE ingest batched it with", async () => {
    // This is the reindex hazard, stated precisely — and it is NOT about ordering
    // within a batch. Reversing one fixed batch does NOT move the vectors (the SET
    // is unchanged, so the per-tensor min/max is unchanged); an "order" test would
    // pass on `main` and prove nothing. What actually changes under a re-ingest is
    // batch MEMBERSHIP: ingest walks N symbols in groups of
    // MAX_EMBED_TEXTS_PER_REQUEST, so a symbol that moves by one position lands in
    // a group with entirely different batch-mates — and on `main` that gives it a
    // different vector, from the same text and the same model.
    //
    // That is what breaks #787/#792's `(contentHash, model)` reuse guard: it skips
    // re-embedding on the premise that the vector could not have changed.
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder(realEmbedderConfig());

    const groupA = [TARGET, ...Array.from({ length: 7 }, (_, i) => filler(i))];
    const groupB = [TARGET, ...Array.from({ length: 7 }, (_, i) => filler(i + 40))];

    const { vectors: fromA } = await embedder.embed(groupA);
    const { vectors: fromB } = await embedder.embed(groupB);

    // Bit-identical, not merely close: same model, same text, same vector.
    expect(fromB[0]).toEqual(fromA[0]);
  }, 900_000);
});
