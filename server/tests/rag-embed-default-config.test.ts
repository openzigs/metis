/**
 * Issue #783 — THE SHIPPED EMBEDDING CONFIGURATION.
 *
 * #788 measured ONE configuration and recommended shipping exactly it:
 *
 *     Alibaba-NLP/gte-modernbert-base · pooling `cls` · dtype `q8` · 768 dims
 *
 * Every part of that line is load-bearing, and the failure mode of getting one
 * part wrong is SILENCE, not an error:
 *
 *   - pooling: the same weights at `mean` scored 0.254 nDCG@10 — level with the
 *     bge-small it replaces (0.246), and IDENTICAL in the hybrid channel
 *     (0.287 vs 0.287). An "upgrade" that buys nothing, that produces perfectly
 *     well-formed unit vectors, and that no end-to-end metric would flag;
 *   - dtype: transformers resolves a different weights FILE per dtype, and both
 *     Dockerfiles bake q8. An `HF_HUB_OFFLINE=1` image that asks for fp32 hunts
 *     for weights that were never baked and cannot boot;
 *   - dims: 768 sizes the pgvector column and the Lance table schema.
 *
 * So this file asserts the shipped configuration directly, against the CONSTANTS
 * the runtime actually reads — not against string literals typed a second time.
 * If someone "simplifies" the per-model pooling map, THIS is the test that fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EMBED_DIMENSION, DEFAULT_XENOVA_EMBED_MODEL } from "@metis/shared";
import {
  DEFAULT_DTYPE,
  DEFAULT_SIDECAR_EMBED_MODEL,
  poolingFromModelMap,
  resolveDtype,
  resolvePooling,
} from "../src/lib/rag/embed-model-config.js";

const ENV_KEYS = [
  "EMBED_MODEL",
  "EMBED_BACKEND",
  "EMBED_DTYPE",
  "EMBED_POOLING",
  "EMBED_POOLING_MAP",
  "AI_OFFLINE",
] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the shipped default embedding configuration (#783 / #788)", () => {
  it("is gte-modernbert-base at 768 dims", () => {
    expect(DEFAULT_XENOVA_EMBED_MODEL).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(DEFAULT_EMBED_DIMENSION).toBe(768);
    // The server and the sidecar must serve the SAME model, or the server would
    // routinely ask an offline sidecar image for a model it never baked.
    expect(DEFAULT_SIDECAR_EMBED_MODEL).toBe(DEFAULT_XENOVA_EMBED_MODEL);
  });

  it("pools the default model with CLS — the arm #788 measured at 0.402", () => {
    // The wrong-pooling trap, asserted three ways so no single refactor can
    // quietly re-open it: the raw map, the full precedence chain, and (below) the
    // backend instance that actually calls the pipeline.
    expect(poolingFromModelMap(DEFAULT_XENOVA_EMBED_MODEL)).toBe("cls");
    expect(resolvePooling(DEFAULT_XENOVA_EMBED_MODEL, undefined, {})).toEqual({
      pooling: "cls",
      source: "model-map",
    });
    // Case/namespace robustness — HF ids get written every which way.
    expect(poolingFromModelMap("alibaba-nlp/GTE-ModernBERT-base")).toBe("cls");
    expect(poolingFromModelMap("gte-modernbert-base")).toBe("cls");
  });

  it("keeps the built-in CLS rule ABOVE an operator's global EMBED_POOLING default", () => {
    // A deployment that (reasonably) set EMBED_POOLING=mean back when the default
    // model was mean-pooled must NOT silently mean-pool gte-modernbert after an
    // upgrade. Precedence: built-in per-model map > EMBED_POOLING.
    expect(
      resolvePooling(DEFAULT_XENOVA_EMBED_MODEL, undefined, { EMBED_POOLING: "mean" }),
    ).toEqual({ pooling: "cls", source: "model-map" });
  });

  it("still lets an operator override pooling explicitly, per model", () => {
    // The escape hatch stays open (EMBED_POOLING_MAP outranks the built-in map) —
    // it is how a future model gets configured without a code change. It is also
    // the one remaining way to shoot yourself in the foot, which is why it is
    // explicit, per-model, and logged with its source at load.
    expect(
      resolvePooling(DEFAULT_XENOVA_EMBED_MODEL, undefined, {
        EMBED_POOLING_MAP: `${DEFAULT_XENOVA_EMBED_MODEL}=mean`,
      }),
    ).toEqual({ pooling: "mean", source: "env-map" });
  });

  it("requests q8 weights — the dtype #788 chose and both Dockerfiles bake", () => {
    expect(DEFAULT_DTYPE).toBe("q8");
    expect(resolveDtype({})).toBe("q8");
  });
});

describe("the default XenovaEmbedder instance", () => {
  it("resolves model + pooling + dtype + dimension to exactly the measured arm", async () => {
    // Construct the backend the way the REGISTRY does with no env set, and read
    // back what it will hand to the transformers pipeline. This is the assertion
    // that would fail if the pooling map stopped covering `gte-modernbert*`.
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder(DEFAULT_XENOVA_EMBED_MODEL, DEFAULT_EMBED_DIMENSION);
    expect(embedder.model).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(embedder.pooling).toBe("cls");
    expect(embedder.dtype).toBe("q8");
    expect(embedder.dimension).toBe(768);
  });

  it("passes `cls` to the pipeline call itself, not merely to a field", async () => {
    // The field could be right while the call site passed something else. Assert
    // the actual argument the feature-extraction pipeline receives.
    const pipe = vi.fn(async () => ({
      data: new Float32Array(768).fill(0.05),
      dims: [1, 768],
    }));
    const pipeline = vi.fn(async () => pipe);
    vi.doMock("@huggingface/transformers", () => ({ pipeline, env: {} }));

    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const { DEFAULT_XENOVA_EMBED_MODEL: model, DEFAULT_EMBED_DIMENSION: dim } =
      await import("@metis/shared");
    await new XenovaEmbedder(model, dim).embed(["hello"]);

    expect(pipeline).toHaveBeenCalledWith("feature-extraction", model, { dtype: "q8" });
    expect(pipe).toHaveBeenCalledWith(["hello"], { pooling: "cls", normalize: true });
  });
});

describe("the default backend resolved from an empty environment", () => {
  it("is xenova, at the measured model / pooling / dtype / dimension", async () => {
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    expect(embedder.key).toBe("xenova");
    expect(embedder.model).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(embedder.dimension).toBe(768);
    expect(embedder.capabilities()).toMatchObject({
      key: "xenova",
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
    });
  });

  it("sends the resolved CLS pooling to the sidecar on every call", async () => {
    // The sidecar has the same per-model map, but the server sends pooling
    // EXPLICITLY so that a server/sidecar version skew can never silently
    // mean-pool a CLS model. Assert the wire value, not the local field.
    const embed = vi.fn(async () => ({
      vectors: [new Array<number>(768).fill(0.01)],
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
    }));
    const client = { embed, healthz: vi.fn(async () => ({ status: "ok" })) };

    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder({
      backend: "sidecar",
      client: client as never,
    });
    await embedder.embed(["hello"]);

    expect(embed).toHaveBeenCalledWith(["hello"], "Alibaba-NLP/gte-modernbert-base", "cls");
  });
});
