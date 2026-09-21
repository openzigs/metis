/**
 * EmbeddingGemma backend tests (Epic #930 / issue #939).
 *
 * Verifies the Matryoshka dimension selection + truncation. The `@xenova/
 * transformers` runtime is mocked so we can feed a deterministic 768-dim
 * tensor and assert the truncated + renormalized output without downloading a
 * real model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["EMBED_DIM", "EMBED_MODEL", "EMBED_BACKEND", "AI_OFFLINE"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Build a deterministic mock that returns a flat 768-dim tensor per input. */
function mockXenova(nativeDim: number) {
  vi.doMock("@huggingface/transformers", () => ({
    env: {},
    pipeline:
      async () =>
      // Return a tensor with `rows * nativeDim` floats; row i is all (i+1).
      async (texts: string | string[]) => {
        const arr = Array.isArray(texts) ? texts : [texts];
        const data = new Float32Array(arr.length * nativeDim);
        for (let i = 0; i < arr.length; i += 1) {
          for (let j = 0; j < nativeDim; j += 1) data[i * nativeDim + j] = i + 1;
        }
        return { data, dims: [arr.length, nativeDim] };
      },
  }));
}

describe("EmbeddingGemma backend (#939)", () => {
  it("resolveGemmaDimension validates the Matryoshka set", async () => {
    const { resolveGemmaDimension } = await import("../src/lib/rag/embedder.js");
    expect(resolveGemmaDimension()).toBe(768);
    expect(resolveGemmaDimension(256)).toBe(256);
    expect(() => resolveGemmaDimension(384)).toThrowError(/Supported Matryoshka/);
  });

  it("honors EMBED_DIM for dimension selection", async () => {
    process.env.EMBED_DIM = "512";
    const { resolveGemmaDimension } = await import("../src/lib/rag/embedder.js");
    expect(resolveGemmaDimension()).toBe(512);
  });

  it("constructs the embeddinggemma backend with the native default dim", async () => {
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const e = new Embedder({ backend: "embeddinggemma" });
    expect(e.key).toBe("embeddinggemma");
    expect(e.model).toBe("onnx-community/embeddinggemma-300m-ONNX");
    expect(e.dimension).toBe(768);
  });

  it("truncates + renormalizes to the configured Matryoshka dimension", async () => {
    mockXenova(768);
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const e = new Embedder({ backend: "embeddinggemma", dimension: 256 });
    expect(e.dimension).toBe(256);
    const res = await e.embed(["hello"]);
    expect(res.dimension).toBe(256);
    expect(res.vectors[0]).toHaveLength(256);
    // After L2 normalization of a constant vector, every element is 1/sqrt(256).
    const expected = 1 / Math.sqrt(256);
    expect(res.vectors[0][0]).toBeCloseTo(expected, 6);
    const norm = Math.sqrt(res.vectors[0].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("returns native-dim vectors when dimension equals the native size", async () => {
    mockXenova(768);
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const e = new Embedder({ backend: "embeddinggemma", dimension: 768 });
    const res = await e.embed(["a", "b"]);
    expect(res.vectors).toHaveLength(2);
    expect(res.vectors[0]).toHaveLength(768);
  });
});
