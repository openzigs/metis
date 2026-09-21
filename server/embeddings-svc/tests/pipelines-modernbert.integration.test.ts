/**
 * Issue #781 — PROOF that the new runtime loads the architectures that the old
 * one could not. This is the entire justification for the upgrade, so it is a
 * REAL load against REAL weights, not a mock.
 *
 * `@xenova/transformers` 2.17.2 registers neither the `modernbert` nor the
 * `gemma3` model type in its `src/models.js` mapping, so both models below are
 * unloadable on the old runtime — the epic's chosen embedder
 * (`Alibaba-NLP/gte-modernbert-base`, #780) and the already-shipped
 * `embeddinggemma` backend's default model alike. The latter means the
 * `embeddinggemma` backend was dead on arrival before this upgrade.
 *
 * OPT-IN: these download hundreds of MB from HuggingFace, so they are SKIPPED
 * by default and skipped in CI (which has no HF egress budget and no model
 * cache). Run them locally with:
 *
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm --filter @metis/embeddings-svc test
 *
 * Verified locally on 2026-07-12 against @huggingface/transformers 3.8.1:
 * gte-modernbert-base → dims [n, 768]; embeddinggemma-300m-ONNX → dims [n, 768].
 */
import { describe, expect, it } from "vitest";
import { getEmbedPipeline } from "../src/pipelines.js";

const DOWNLOAD_TESTS_ENABLED = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS === "1";

/** Cold model download + ONNX session init is slow on a laptop CPU. */
const TIMEOUT_MS = 15 * 60 * 1000;

describe.skipIf(!DOWNLOAD_TESTS_ENABLED)("real model loads (network, opt-in)", () => {
  it(
    "loads a ModernBERT embedder and returns 768-dim vectors (impossible on xenova v2)",
    async () => {
      const pipe = await getEmbedPipeline("Alibaba-NLP/gte-modernbert-base");

      // gte-modernbert is a CLS-pooling model. Pooling is hardcoded to "mean" in
      // app.ts today and becomes per-model configurable in #782 — here we assert
      // the RUNTIME can drive it, which is all #781 owns.
      const out = await pipe(["throttle repeated failed logins", "class RateLimiter {}"], {
        pooling: "cls",
        normalize: true,
      });

      expect(out.dims).toEqual([2, 768]);
      expect(out.data.length).toBe(2 * 768);
      // Real (not hash/degenerate) vectors: finite, non-zero, unit-normalised.
      const first = Array.from(out.data.slice(0, 768));
      expect(first.every((x) => Number.isFinite(x))).toBe(true);
      const norm = Math.sqrt(first.reduce((acc, x) => acc + x * x, 0));
      expect(norm).toBeCloseTo(1, 3);
    },
    TIMEOUT_MS,
  );

  it(
    "loads the embeddinggemma default model (gemma3 arch — also impossible on xenova v2)",
    async () => {
      const pipe = await getEmbedPipeline("onnx-community/embeddinggemma-300m-ONNX");
      const out = await pipe(["hello"], { pooling: "mean", normalize: true });

      // Native dim is 768; the server's embeddinggemma backend Matryoshka-truncates
      // from there (#939).
      expect(out.dims).toEqual([1, 768]);
    },
    TIMEOUT_MS,
  );
});
