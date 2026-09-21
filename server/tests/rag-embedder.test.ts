/**
 * Embedder tests (Phase 5 / issue #41).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Embedder, __resetEmbedderSingleton, getEmbedder } from "../src/lib/rag/embedder.js";

beforeEach(() => {
  __resetEmbedderSingleton();
});

describe("Embedder", () => {
  it("first call after construction succeeds offline (no network)", async () => {
    const embedder = new Embedder();
    const result = await embedder.embed(["hello world"]);
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(384);
    expect(result.dimension).toBe(384);
    expect(typeof result.model).toBe("string");
  });

  it("default dimension is 384", () => {
    const embedder = new Embedder();
    expect(embedder.dimension).toBe(384);
  });

  it("returns one vector per input in input order, all unit-shaped", async () => {
    const embedder = new Embedder();
    const result = await embedder.embed(["alpha", "beta", "gamma"]);
    expect(result.vectors).toHaveLength(3);
    for (const v of result.vectors) {
      expect(v).toHaveLength(384);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeGreaterThan(0.99);
      expect(norm).toBeLessThan(1.01);
    }
  });

  it("is deterministic — same input → same vector", async () => {
    const embedder = new Embedder();
    const a = await embedder.embed(["consistent"]);
    const b = await embedder.embed(["consistent"]);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
  });

  it("returns an empty result for an empty input array (no warm)", async () => {
    const embedder = new Embedder();
    const result = await embedder.embed([]);
    expect(result.vectors).toEqual([]);
    expect(result.dimension).toBe(384);
  });

  it("rejects non-array input loudly", async () => {
    const embedder = new Embedder();
    // @ts-expect-error - intentional misuse
    await expect(embedder.embed("not-an-array")).rejects.toThrow(TypeError);
  });

  it("concurrent calls don't double-load the model", async () => {
    const embedder = new Embedder();
    const loadSpy = vi.spyOn(embedder as unknown as { load: () => Promise<void> }, "load");
    await Promise.all([
      embedder.embed(["a"]),
      embedder.embed(["b"]),
      embedder.embed(["c"]),
      embedder.embed(["d"]),
    ]);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("warm() is a no-op after first load", async () => {
    const embedder = new Embedder();
    await embedder.warm();
    const loadSpy = vi.spyOn(embedder as unknown as { load: () => Promise<void> }, "load");
    await embedder.warm();
    await embedder.warm();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("getEmbedder() returns a singleton across calls", () => {
    const a = getEmbedder();
    const b = getEmbedder();
    expect(a).toBe(b);
  });

  it("__resetEmbedderSingleton clears the singleton", () => {
    const a = getEmbedder();
    __resetEmbedderSingleton();
    const b = getEmbedder();
    expect(a).not.toBe(b);
  });
});
