/**
 * Issue #782 — `EMBED_DTYPE` plumbing + load-time pooling observability in the
 * sidecar's pipeline loader. The heavy runtime is mocked: we assert the CONTRACT
 * asked of it (which dtype, which cache key, what gets logged).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE = "@huggingface/transformers";

beforeEach(() => {
  vi.resetModules();
  delete process.env.EMBED_DTYPE;
});

afterEach(() => {
  vi.doUnmock(MODULE);
  vi.restoreAllMocks();
  delete process.env.EMBED_DTYPE;
});

function mockTransformers(config?: unknown) {
  const pipe = Object.assign(vi.fn(), { model: { config } });
  const pipeline = vi.fn(async () => pipe);
  vi.doMock(MODULE, () => ({ pipeline, env: {} }));
  return { pipeline, pipe };
}

describe("EMBED_DTYPE", () => {
  it("defaults to q8 — unchanged from #781", async () => {
    const { pipeline } = mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("Xenova/bge-small-en-v1.5");

    expect(pipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "q8",
    });
  });

  it("passes fp32 to the runtime when EMBED_DTYPE=fp32", async () => {
    process.env.EMBED_DTYPE = "fp32";
    const { pipeline } = mockTransformers();
    const { getEmbedPipeline, getRerankPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("Xenova/bge-small-en-v1.5");
    await getRerankPipeline("Xenova/ms-marco-MiniLM-L-6-v2");

    expect(pipeline).toHaveBeenNthCalledWith(1, "feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "fp32",
    });
    // The rerank model rides the same knob — the Dockerfile bakes both at the
    // same dtype, so they must request the same one.
    expect(pipeline).toHaveBeenNthCalledWith(
      2,
      "text-classification",
      "Xenova/ms-marco-MiniLM-L-6-v2",
      { dtype: "fp32" },
    );
  });

  it("an explicit dtype argument overrides the env", async () => {
    process.env.EMBED_DTYPE = "q8";
    const { pipeline } = mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("m", "fp32");

    expect(pipeline).toHaveBeenCalledWith("feature-extraction", "m", { dtype: "fp32" });
  });

  it("caches per model AND dtype (two dtypes are two different weight files)", async () => {
    const { pipeline } = mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    const a = await getEmbedPipeline("m", "q8");
    const b = await getEmbedPipeline("m", "q8");
    await getEmbedPipeline("m", "fp32");

    expect(a).toBe(b);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it("throws on an unsupported dtype instead of loading the wrong weights", async () => {
    process.env.EMBED_DTYPE = "int4";
    mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await expect(getEmbedPipeline("m")).rejects.toThrow(/Invalid EMBED_DTYPE/);
  });
});

describe("load-time pooling observability", () => {
  it("logs the resolved pooling + dtype for every model it loads", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("Alibaba-NLP/gte-modernbert-base");

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("model=Alibaba-NLP/gte-modernbert-base dtype=q8 pooling=cls"),
    );
  });

  it("flags a model no rule matched (it will fall back to mean)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mockTransformers();
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("acme/unknown-embedder");

    expect(info).toHaveBeenCalledWith(expect.stringContaining("no per-model rule matched"));
  });

  it("warns LOUDLY when the model config declares a pooling we disagree with", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    // A bge* model (mapped to mean) whose config declares CLS pooling.
    mockTransformers({ pooling_mode_cls_token: true });
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("Xenova/bge-small-en-v1.5");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("POOLING MISMATCH"));
  });

  it("does not warn when the declared pooling agrees (or is absent)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    mockTransformers({ pooling_mode_mean_tokens: true });
    const { getEmbedPipeline } = await import("../src/pipelines.js");

    await getEmbedPipeline("Xenova/bge-small-en-v1.5");
    await getEmbedPipeline("acme/no-config-pooling");

    expect(warn).not.toHaveBeenCalled();
  });
});
