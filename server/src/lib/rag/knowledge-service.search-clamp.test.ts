/**
 * Backend search `k`-clamp tests (grounding recall raise).
 *
 * Per-section doc grounding now requests up to `DEFAULT_GROUNDING_K = 60` chunks
 * (`docs-gen/grounding/grounding-retrieval.ts`). `KnowledgeService.search`
 * re-clamps `k` to {@link MAX_SEARCH_K}; that ceiling MUST be ≥ 60 or the recall
 * raise is silently truncated back to the old 50. These tests pin that the
 * internal ceiling is 60 and that a 60-chunk request is honored end-to-end.
 *
 * We assert via the `poolSize` argument passed to `VectorStore.search`:
 * `poolSize = clamp(fusionPoolSize ?? max(k*4,20), k, 200)`, so with a tiny
 * explicit `fusionPoolSize` the LOWER clamp bound is exactly the effective `k`.
 * That isolates the clamp from the `max(k*4,20)` term (which saturates at 200 for
 * both 50 and 60 and so could not distinguish them).
 */
import { describe, expect, it, vi } from "vitest";
import { KnowledgeService, MAX_SEARCH_K } from "./knowledge-service.js";
import type { Embedder } from "./embedder.js";
import type { VectorStore } from "./vector-store.js";

// No prisma needed: dense mode + a tiny pool keeps search to one store call.
vi.mock("../prisma.js", () => ({ prisma: {} }));

function fakeEmbedder(model = "fake-model-v1"): Embedder {
  return {
    model,
    dimension: 4,
    embed: async (texts: string[]) => ({
      vectors: texts.map(() => [1, 0, 0, 1]),
      model,
      dimension: 4,
    }),
  } as unknown as Embedder;
}

/** A vector store that records the `poolSize` (limit) it was asked for. */
function recordingStore(): { store: VectorStore; calls: number[] } {
  const calls: number[] = [];
  const store = {
    search: vi.fn(async (_projectId: string, _vec: number[], limit: number) => {
      calls.push(limit);
      return [];
    }),
    modelCoverage: vi.fn(async () => ({ totalChunks: 0, modelCounts: {} })),
    deleteByDocument: vi.fn(),
    dropTable: vi.fn(),
  } as unknown as VectorStore;
  return { store, calls };
}

function makeService(store: VectorStore): KnowledgeService {
  return new KnowledgeService({ embedder: fakeEmbedder(), vectorStore: store });
}

describe("KnowledgeService.search k clamp (MAX_SEARCH_K)", () => {
  it("exposes an internal ceiling of 80 (>= DEFAULT_GROUNDING_K)", () => {
    expect(MAX_SEARCH_K).toBe(80);
  });

  it("honors a k of 80 (not silently truncated to the old 50/60)", async () => {
    const { store, calls } = recordingStore();
    const svc = makeService(store);
    // fusionPoolSize=1 → poolSize = clamp(1, k, 200) = effective k.
    await svc.search("p1", "query text", { k: 80, fusionPoolSize: 1, mode: "dense" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(80);
  });

  it("clamps a k above the ceiling down to MAX_SEARCH_K (80), not higher", async () => {
    const { store, calls } = recordingStore();
    const svc = makeService(store);
    await svc.search("p1", "query text", { k: 1000, fusionPoolSize: 1, mode: "dense" });
    expect(calls[0]).toBe(MAX_SEARCH_K);
  });

  it("still clamps a non-positive k up to the minimum of 1", async () => {
    const { store, calls } = recordingStore();
    const svc = makeService(store);
    await svc.search("p1", "query text", { k: 0, fusionPoolSize: 1, mode: "dense" });
    expect(calls[0]).toBe(1);
  });
});
