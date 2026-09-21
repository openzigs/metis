/**
 * Issue #782 — PROOF, against real weights, that pooling is not cosmetic.
 *
 * A mocked runtime can only prove plumbing. The claim that motivates this whole
 * issue — "mean-pooling a CLS model returns a valid-looking but semantically
 * different vector" — is a property of the MODEL, so it has to be measured on
 * real weights.
 *
 * OPT-IN, reusing #781's existing gate (no new mechanism):
 *
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm --filter @metis/embeddings-svc test
 *
 * Measured locally on 2026-07-12 (@huggingface/transformers 3.8.1, dtype q8) —
 * cosine similarity between the CLS-pooled and mean-pooled vector for the same
 * input on the same model:
 *   - Xenova/bge-small-en-v1.5:        0.962
 *   - Alibaba-NLP/gte-modernbert-base: 0.856  ← the model this epic is adopting
 * Both are unit-norm and finite either way. That is the whole problem: nothing
 * about a wrong-pooled vector *looks* wrong, it just retrieves worse.
 */
import { describe, expect, it } from "vitest";
import { getEmbedPipeline } from "../src/pipelines.js";
import { resolvePooling } from "../src/model-config.js";

const DOWNLOAD_TESTS_ENABLED = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS === "1";
const TIMEOUT_MS = 15 * 60 * 1000;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(model: string, text: string, pooling: "cls" | "mean"): Promise<number[]> {
  const pipe = await getEmbedPipeline(model);
  const out = await pipe([text], { pooling, normalize: true });
  return Array.from(out.data);
}

describe.skipIf(!DOWNLOAD_TESTS_ENABLED)("pooling on real weights (network, opt-in)", () => {
  it(
    "cls and mean produce DIFFERENT vectors for the same input on the same model",
    async () => {
      const model = "Xenova/bge-small-en-v1.5";
      const text = "throttle repeated failed logins";

      const cls = await embed(model, text, "cls");
      const mean = await embed(model, text, "mean");

      expect(cls).toHaveLength(384);
      expect(mean).toHaveLength(384);
      // Both are unit-norm, finite, entirely plausible — which is precisely why a
      // wrong pooling is silent. They are NOT the same vector.
      expect(cls.every(Number.isFinite)).toBe(true);
      const sim = cosine(cls, mean);
      // eslint-disable-next-line no-console
      console.info(`[pooling] ${model} cosine(cls, mean) = ${sim.toFixed(3)}`);
      expect(sim).toBeLessThan(0.99);
      expect(cls).not.toEqual(mean);
    },
    TIMEOUT_MS,
  );

  it(
    "gte-modernbert (a CLS model) embeds under its mapped pooling, and mean differs",
    async () => {
      const model = "Alibaba-NLP/gte-modernbert-base";
      expect(resolvePooling(model, undefined, {}).pooling).toBe("cls");

      const text = "class RateLimiter { }";
      const cls = await embed(model, text, "cls");
      const mean = await embed(model, text, "mean");

      expect(cls).toHaveLength(768);
      const norm = Math.sqrt(cls.reduce((acc, x) => acc + x * x, 0));
      expect(norm).toBeCloseTo(1, 3);
      const sim = cosine(cls, mean);
      // eslint-disable-next-line no-console
      console.info(`[pooling] ${model} cosine(cls, mean) = ${sim.toFixed(3)}`);
      expect(sim).toBeLessThan(0.99);
    },
    TIMEOUT_MS,
  );
});
