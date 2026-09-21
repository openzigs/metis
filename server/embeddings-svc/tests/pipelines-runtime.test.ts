/**
 * Issue #781 — `@huggingface/transformers` (transformers.js v3) runtime wiring.
 *
 * The heavy runtime is mocked: these assert the CONTRACT the sidecar asks of it
 * (module name, dtype, per-model caching, env shim), not the ONNX inference.
 * The real-weights proof lives in `pipelines-modernbert.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE = "@huggingface/transformers";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock(MODULE);
  delete process.env.EMBEDDINGS_OFFLINE;
  delete process.env.EMBEDDINGS_CACHE_DIR;
});

/** Install a fake transformers module and return its spies. */
function mockTransformers() {
  const pipe = vi.fn();
  const pipeline = vi.fn(async () => pipe);
  const env: Record<string, unknown> = {};
  vi.doMock(MODULE, () => ({ pipeline, env }));
  return { pipeline, pipe, env };
}

describe("getEmbedPipeline", () => {
  it("loads the feature-extraction pipeline with the q8 dtype", async () => {
    const { pipeline } = mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("Xenova/bge-small-en-v1.5");

    // transformers.js v2 loaded quantized weights by default; v3 defaults to
    // fp32 on Node. Pinning q8 keeps the pre-upgrade footprint.
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "q8",
    });
  });

  it("constructs each model once and reuses it across calls", async () => {
    const { pipeline } = mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    const a = await getEmbedPipeline("model-a");
    const b = await getEmbedPipeline("model-a");
    await getEmbedPipeline("model-b");

    expect(a).toBe(b);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });
});

describe("getRerankPipeline", () => {
  it("loads the text-classification pipeline with the q8 dtype", async () => {
    const { pipeline } = mockTransformers();
    const { getRerankPipeline } = await import("../src/pipelines.js");

    await getRerankPipeline("Xenova/ms-marco-MiniLM-L-6-v2");

    expect(pipeline).toHaveBeenCalledWith("text-classification", "Xenova/ms-marco-MiniLM-L-6-v2", {
      dtype: "q8",
    });
  });

  it("caches the rerank pipeline per model", async () => {
    const { pipeline } = mockTransformers();
    const { getRerankPipeline } = await import("../src/pipelines.js");

    await getRerankPipeline("rr");
    await getRerankPipeline("rr");

    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});

describe("runtime env shim", () => {
  it("applies the offline env to the loaded module (air-gapped guarantee, #935)", async () => {
    process.env.EMBEDDINGS_OFFLINE = "1";
    process.env.EMBEDDINGS_CACHE_DIR = "/var/cache/metis-embeddings";
    const { env } = mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("Xenova/bge-small-en-v1.5");

    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
    expect(env.cacheDir).toBe("/var/cache/metis-embeddings");
  });

  it("allows remote models when no offline flag is set", async () => {
    const { env } = mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("Xenova/bge-small-en-v1.5");

    expect(env.allowRemoteModels).toBe(true);
  });

  it("imports the module exactly once across embed + rerank", async () => {
    const { pipeline } = mockTransformers();
    const { getEmbedPipeline, getRerankPipeline, __resetPipelinesForTests } =
      await import("../src/pipelines.js");

    await getEmbedPipeline("e");
    await getRerankPipeline("r");

    expect(pipeline).toHaveBeenCalledTimes(2);

    // The test seam drops the cached module + pipelines.
    __resetPipelinesForTests();
    await getEmbedPipeline("e");
    expect(pipeline).toHaveBeenCalledTimes(3);
  });
});
