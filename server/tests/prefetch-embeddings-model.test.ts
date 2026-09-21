/**
 * Epic #930 / issue #941 — prefetch script backend-capability gating tests,
 * extended for the #784 offline-verify / mirror / cache-path behaviour.
 *
 * These tests exercise the gating + cache-path logic with a MOCK embedder so
 * the suite never touches HuggingFace or downloads anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UNPINNED_CACHE,
  readRuntimeCacheDir,
  isDownloadableBackend,
  isOfflineConfigured,
  prefetchEmbeddingsModel,
  resolveCachePath,
} from "../scripts/prefetch-embeddings-model.js";
import type { Embedder } from "../src/lib/rag/embedder.js";

function mockEmbedder(key: string, warm: () => Promise<void>): () => Embedder {
  return () =>
    ({
      key,
      model: `${key}-model`,
      dimension: 384,
      warm,
    }) as unknown as Embedder;
}

const noCacheDir = async () => null;

describe("isDownloadableBackend", () => {
  it("treats Xenova and EmbeddingGemma as downloadable", () => {
    expect(isDownloadableBackend("xenova")).toBe(true);
    expect(isDownloadableBackend("embeddinggemma")).toBe(true);
  });

  it("treats hash/offline, sidecar and cloud backends as non-downloadable", () => {
    for (const key of ["offline", "sidecar", "bedrock", "bedrock-sdk", "openai"]) {
      expect(isDownloadableBackend(key)).toBe(false);
    }
  });
});

describe("isOfflineConfigured", () => {
  it("detects every offline flag the runtime honours", () => {
    expect(isOfflineConfigured({ HF_HUB_OFFLINE: "1" })).toBe(true);
    expect(isOfflineConfigured({ HF_HUB_OFFLINE: "true" })).toBe(true);
    expect(isOfflineConfigured({ TRANSFORMERS_OFFLINE: "1" })).toBe(true);
    // #784 — the sidecar honoured EMBEDDINGS_OFFLINE and this path did not, so
    // the same variable meant "air-gapped" in one container and nothing in the
    // other. They now share one definition.
    expect(isOfflineConfigured({ EMBEDDINGS_OFFLINE: "1" })).toBe(true);
    expect(isOfflineConfigured({})).toBe(false);
  });
});

describe("resolveCachePath", () => {
  it("prefers TRANSFORMERS_CACHE — the only variable that pins the cache", () => {
    expect(resolveCachePath({ TRANSFORMERS_CACHE: "/models/cache" })).toBe("/models/cache");
  });

  it("otherwise reports the dir transformers.js actually resolved", () => {
    expect(resolveCachePath({}, "/app/node_modules/@huggingface/transformers/.cache")).toBe(
      "/app/node_modules/@huggingface/transformers/.cache",
    );
  });

  it("reports the cache as UNPINNED rather than inventing a plausible path", () => {
    // Pre-#784 this returned `~/.cache/huggingface/hub`, which transformers.js
    // v3 never writes to (it reads NO env vars and defaults to a dir inside
    // node_modules). An operator who mounted the reported path as their offline
    // cache volume would have mounted an empty directory.
    expect(resolveCachePath({}, null)).toBe(UNPINNED_CACHE);
    expect(resolveCachePath({}, null)).not.toMatch(/huggingface[\\/]hub$/);
  });
});

describe("prefetchEmbeddingsModel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("downloads (warms) when the backend is downloadable and online", async () => {
    const warm = vi.fn(async () => {});
    const outcome = await prefetchEmbeddingsModel(
      mockEmbedder("xenova", warm),
      () => {},
      { TRANSFORMERS_CACHE: "/models/cache" },
      noCacheDir,
    );
    expect(warm).toHaveBeenCalledTimes(1);
    expect(outcome.downloaded).toBe(true);
    expect(outcome.verified).toBe(false);
    expect(outcome.backendKey).toBe("xenova");
    expect(outcome.cachePath).toBe("/models/cache");
  });

  it("warns when nothing pinned the cache, because node_modules is not durable", async () => {
    const lines: string[] = [];
    await prefetchEmbeddingsModel(
      mockEmbedder("xenova", async () => {}),
      (m) => lines.push(m),
      {},
      noCacheDir,
    );
    expect(lines.join("\n")).toMatch(/TRANSFORMERS_CACHE is unset/);
  });

  it("is a no-op for a non-downloadable backend and never warms", async () => {
    const warm = vi.fn(async () => {});
    const outcome = await prefetchEmbeddingsModel(
      mockEmbedder("sidecar", warm),
      () => {},
      {},
      noCacheDir,
    );
    expect(warm).not.toHaveBeenCalled();
    expect(outcome.downloaded).toBe(false);
    expect(outcome.skippedReason).toMatch(/does not download/);
  });

  it("VERIFIES the cache when offline: warms from disk with no download", async () => {
    // The AC that matters: "a subsequent offline run loads the model". Pre-#784
    // this branch skipped warming entirely and exited 0 — so it reported success
    // for a cache that was empty, which is the one thing it needed to catch.
    const warm = vi.fn(async () => {});
    const outcome = await prefetchEmbeddingsModel(
      mockEmbedder("xenova", warm),
      () => {},
      { HF_HUB_OFFLINE: "1", TRANSFORMERS_CACHE: "/models/cache" },
      noCacheDir,
    );
    expect(warm).toHaveBeenCalledTimes(1);
    expect(outcome.downloaded).toBe(false);
    expect(outcome.verified).toBe(true);
    expect(outcome.cachePath).toBe("/models/cache");
  });

  it("fails loud when the offline cache cannot serve the model", async () => {
    const warm = vi.fn(async () => {
      throw new Error("Could not locate file: model_quantized.onnx");
    });
    await expect(
      prefetchEmbeddingsModel(
        mockEmbedder("xenova", warm),
        () => {},
        { HF_HUB_OFFLINE: "1", TRANSFORMERS_CACHE: "/models/cache" },
        noCacheDir,
      ),
    ).rejects.toThrow(/model_quantized\.onnx/);
  });

  it("uses the real transformers cache dir by default", async () => {
    // The default reader asks the module itself rather than guessing. It must
    // also survive the module being absent (it is a devDependency, and the
    // offline/hash backends never need it) by reporting "unpinned", not crashing.
    const dir = await readRuntimeCacheDir();
    expect(dir === null || typeof dir === "string").toBe(true);
    expect(resolveCachePath({}, dir)).toBeTypeOf("string");
  });

  it("writes to stdout when no logger is injected", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await prefetchEmbeddingsModel(
      mockEmbedder("offline", async () => {}),
      undefined,
      {},
      noCacheDir,
    );
    expect(write).toHaveBeenCalled();
  });

  it("reports the internal mirror it will download from", async () => {
    const lines: string[] = [];
    const outcome = await prefetchEmbeddingsModel(
      mockEmbedder("xenova", async () => {}),
      (m) => lines.push(m),
      { HF_ENDPOINT: "https://hf-mirror.corp.example", TRANSFORMERS_CACHE: "/c" },
      noCacheDir,
    );
    expect(outcome.mirror).toBe("https://hf-mirror.corp.example/");
    expect(lines[0]).toContain("mirror=https://hf-mirror.corp.example/");
  });
});
