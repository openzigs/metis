import { describe, expect, it } from "vitest";
import { DEFAULT_EMBED_BATCH_SIZE, embedInBoundedBatches } from "./embed-batched.js";
import type { EmbeddingResult } from "./embedder-registry.js";

function embedder(
  overrides: Partial<{ identity: (call: number) => string | undefined; short: number }> = {},
) {
  const calls: string[][] = [];
  return {
    calls,
    embed: async (texts: string[]): Promise<EmbeddingResult> => {
      calls.push(texts);
      const call = calls.length;
      const count = overrides.short === call ? texts.length - 1 : texts.length;
      return {
        model: "m",
        dimension: 1,
        identity: overrides.identity ? overrides.identity(call) : "m|cls|q8",
        vectors: texts.slice(0, count).map((t) => [t.length]),
      };
    },
  };
}

describe("embedInBoundedBatches (#189)", () => {
  it("never sends more than the batch size, keeps order, and reports progress", async () => {
    const e = embedder();
    const texts = Array.from({ length: 70 }, (_, i) => "x".repeat(i + 1));
    const progress: Array<[number, number]> = [];
    const result = await embedInBoundedBatches(e, texts, {
      onProgress: (done, total) => {
        progress.push([done, total]);
      },
    });
    expect(e.calls.map((c) => c.length)).toEqual([32, 32, 6]);
    expect(DEFAULT_EMBED_BATCH_SIZE).toBe(32);
    expect(result.vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length));
    expect(result.identity).toBe("m|cls|q8");
    expect(progress).toEqual([
      [32, 70],
      [64, 70],
      [70, 70],
    ]);
  });

  it("honours an explicit batch size, flooring nonsense to 1", async () => {
    const e = embedder();
    await embedInBoundedBatches(e, ["a", "b", "c"], { batchSize: 0 });
    expect(e.calls).toEqual([["a"], ["b"], ["c"]]);
  });

  it("returns an empty result without calling the embedder", async () => {
    const e = embedder();
    await expect(embedInBoundedBatches(e, [])).resolves.toMatchObject({
      vectors: [],
      model: "empty",
    });
    expect(e.calls).toEqual([]);
  });

  it("refuses a batch whose vector count does not match", async () => {
    await expect(
      embedInBoundedBatches(embedder({ short: 2 }), ["a", "b", "c", "d"], { batchSize: 2 }),
    ).rejects.toThrow("embedder returned 1 vectors for a batch of 2 texts");
  });

  it("refuses to mix two embedding identities in one result", async () => {
    await expect(
      embedInBoundedBatches(
        embedder({ identity: (call) => (call === 1 ? "real" : "metis-offline-hash-v1") }),
        ["a", "b"],
        { batchSize: 1 },
      ),
    ).rejects.toThrow(/identity changed mid-document \(real → metis-offline-hash-v1\)/);
    // A backend with no identity is identified by its model.
    await expect(
      embedInBoundedBatches(embedder({ identity: () => undefined }), ["a", "b"], { batchSize: 1 }),
    ).resolves.toMatchObject({ model: "m" });
  });

  it("stops between batches once aborted", async () => {
    const controller = new AbortController();
    const e = embedder();
    await expect(
      embedInBoundedBatches(e, ["a", "b", "c"], {
        batchSize: 1,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
    expect(e.calls).toEqual([["a"]]);
  });
});
