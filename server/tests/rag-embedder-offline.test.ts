/**
 * Issue #936 — air-gapped in-process Xenova embeddings.
 *
 * Verifies `XenovaEmbedder` honors the offline bundle env vars:
 *   - `requiresEgress` reflects `HF_HUB_OFFLINE`
 *   - offline mode flips `@huggingface/transformers` env to local-only + cacheDir
 *   - a missing cache produces a clear, actionable error (no silent download)
 *   - a present cache loads a real-dimension vector with no fallback
 *
 * `@huggingface/transformers` is mocked so tests never pay the model-download cost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_OFFLINE = process.env.HF_HUB_OFFLINE;
const ORIGINAL_CACHE = process.env.TRANSFORMERS_CACHE;

beforeEach(() => {
  vi.resetModules();
  delete process.env.HF_HUB_OFFLINE;
  delete process.env.TRANSFORMERS_CACHE;
});

afterEach(() => {
  vi.unmock("@huggingface/transformers");
  if (ORIGINAL_OFFLINE == null) delete process.env.HF_HUB_OFFLINE;
  else process.env.HF_HUB_OFFLINE = ORIGINAL_OFFLINE;
  if (ORIGINAL_CACHE == null) delete process.env.TRANSFORMERS_CACHE;
  else process.env.TRANSFORMERS_CACHE = ORIGINAL_CACHE;
});

describe("XenovaEmbedder offline bundle (#936)", () => {
  it("requiresEgress is true online and false when HF_HUB_OFFLINE is set", async () => {
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const online = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    expect(online.requiresEgress).toBe(true);

    process.env.HF_HUB_OFFLINE = "1";
    const offline = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    expect(offline.requiresEgress).toBe(false);
  });

  it("loads from the local cache offline and flips the xenova env to local-only", async () => {
    process.env.HF_HUB_OFFLINE = "1";
    process.env.TRANSFORMERS_CACHE = "/var/cache/metis-models";
    const env: { allowRemoteModels?: boolean; allowLocalModels?: boolean; cacheDir?: string } = {};
    // Fake pipeline returns a single 384-dim normalized tensor.
    const pipe = vi.fn(async () => ({
      data: new Float32Array(384).fill(0.05),
      dims: [1, 384],
    }));
    const pipelineFactory = vi.fn(async () => pipe);
    vi.doMock("@huggingface/transformers", () => ({ pipeline: pipelineFactory, env }));

    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    const result = await embedder.embed(["hello world"]);

    expect(result.dimension).toBe(384);
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(384);
    // Offline env was applied to the xenova module.
    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
    expect(env.cacheDir).toBe("/var/cache/metis-models");
    // #781 — dtype q8 preserves transformers.js v2's quantized-by-default
    // behaviour; v3 would otherwise silently load fp32 weights on Node.
    expect(pipelineFactory).toHaveBeenCalledWith("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "q8",
    });
  });

  it("throws a clear actionable error when the offline cache is missing", async () => {
    process.env.HF_HUB_OFFLINE = "1";
    process.env.TRANSFORMERS_CACHE = "/nonexistent/cache";
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(async () => {
        throw new Error("ENOENT: model not found");
      }),
      env: {},
    }));

    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    await expect(embedder.embed(["x"])).rejects.toThrow(
      /was not found in the local cache.*TRANSFORMERS_CACHE=\/nonexistent\/cache/s,
    );
  });

  it("rethrows the underlying error online without the offline hint", async () => {
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(async () => {
        throw new Error("network unreachable");
      }),
      env: {},
    }));

    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    await expect(embedder.embed(["x"])).rejects.toThrow(/network unreachable/);
    await expect(embedder.embed(["x"])).rejects.not.toThrow(/local cache/);
  });

  it("fails with an actionable message when the runtime package cannot be imported", async () => {
    vi.doMock("@huggingface/transformers", () => {
      throw new Error("Cannot find module");
    });

    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    await expect(embedder.embed(["x"])).rejects.toThrow(
      /Failed to import "@huggingface\/transformers".*EMBED_BACKEND=offline/s,
    );
  });

  it("short-circuits an empty batch without loading the model", async () => {
    const pipelineFactory = vi.fn();
    vi.doMock("@huggingface/transformers", () => ({ pipeline: pipelineFactory, env: {} }));

    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    const result = await embedder.embed([]);

    expect(result).toEqual({ vectors: [], model: "Xenova/bge-small-en-v1.5", dimension: 384 });
    expect(pipelineFactory).not.toHaveBeenCalled();
  });

  it("healthy() reports true once the model loads and false when it cannot", async () => {
    const pipe = vi.fn(async () => ({ data: new Float32Array(384), dims: [1, 384] }));
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(async () => pipe),
      env: {},
    }));
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    await expect(new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384).healthy()).resolves.toBe(true);

    vi.resetModules();
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn(async () => {
        throw new Error("boom");
      }),
      env: {},
    }));
    const { XenovaEmbedder: Broken } = await import("../src/lib/rag/embedder.js");
    await expect(new Broken("Xenova/bge-small-en-v1.5", 384).healthy()).resolves.toBe(false);
  });
});
