/**
 * Issue #792 — backends stamp the composite embedding IDENTITY (model + pooling +
 * dtype) onto their results.
 *
 *   - the in-process `xenova` backend derives it LOCALLY (it is the producer);
 *   - the `sidecar` backend derives it from the WIRE response the sidecar echoes,
 *     never from a server-side guess — so a server/sidecar env mismatch shows up
 *     as an identity change instead of being silently mislabelled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbedResponse } from "../src/lib/rag/embeddings-client.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.EMBED_DTYPE;
  delete process.env.EMBED_POOLING;
  delete process.env.EMBED_POOLING_MAP;
  delete process.env.HF_HUB_OFFLINE;
});

afterEach(() => {
  vi.unmock("@huggingface/transformers");
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

function mockRuntime() {
  const pipe = Object.assign(
    vi.fn(async () => ({ data: new Float32Array(768).fill(0.05), dims: [1, 768] })),
    { model: { config: {} } },
  );
  vi.doMock("@huggingface/transformers", () => ({ pipeline: vi.fn(async () => pipe), env: {} }));
}

const GTE = "Alibaba-NLP/gte-modernbert-base"; // built-in cls

describe("XenovaEmbedder identity (#792) — derived locally", () => {
  it("is the BARE model id at built-in pooling+dtype (grandfathers existing rows)", async () => {
    mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder(GTE, 768);
    expect(embedder.identity).toBe(GTE);
    expect(embedder.currentIdentity()).toBe(GTE);
    const res = await embedder.embed(["x"]);
    expect(res.identity).toBe(GTE);
  });

  it("gains a suffix when EMBED_POOLING_MAP flips the pooling", async () => {
    process.env.EMBED_POOLING_MAP = `${GTE}=mean`;
    mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder(GTE, 768);
    expect(embedder.pooling).toBe("mean");
    expect(embedder.identity).toBe(`${GTE}|mean|q8`);
    const res = await embedder.embed(["x"]);
    expect(res.identity).toBe(`${GTE}|mean|q8`);
  });

  it("gains a suffix when EMBED_DTYPE flips the dtype", async () => {
    process.env.EMBED_DTYPE = "fp32";
    mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder(GTE, 768);
    expect(embedder.identity).toBe(`${GTE}|cls|fp32`);
  });
});

/** Minimal sidecar client whose /embed echoes a configurable pooling+dtype. */
function fakeClient(echo: { pooling?: unknown; dtype?: unknown }) {
  const calls: number[] = [];
  const client = {
    async healthz() {
      return { status: "ok", tokenConfigured: true };
    },
    async embed(texts: string[], model?: string): Promise<EmbedResponse> {
      calls.push(texts.length);
      return {
        vectors: texts.map(() => [0.1, 0.2, 0.3]),
        model: model ?? GTE,
        dimension: 3,
        pooling: echo.pooling as EmbedResponse["pooling"],
        dtype: echo.dtype as EmbedResponse["dtype"],
      };
    },
  };
  return { client, calls };
}

describe("RemoteEmbedder identity (#792) — the WIRE value, not a guess", () => {
  it("persists the identity the SIDECAR echoed (default → bare)", async () => {
    process.env.EMBEDDINGS_TOKEN = "t";
    const { createBackend } = await import("../src/lib/rag/embedder-registry.js");
    await import("../src/lib/rag/embedder.js");
    const { client } = fakeClient({ pooling: "cls", dtype: "q8" });
    const backend = createBackend({
      backend: "sidecar",
      model: GTE,
      dimension: 3,
      client: client as never,
    });
    const res = await backend.embed(["q"]);
    expect(res.identity).toBe(GTE);
  });

  it("DETECTS a server/sidecar mismatch: sidecar echoes mean for a cls model", async () => {
    process.env.EMBEDDINGS_TOKEN = "t";
    const { createBackend } = await import("../src/lib/rag/embedder-registry.js");
    await import("../src/lib/rag/embedder.js");
    // Server would resolve cls for gte-modernbert; the sidecar reports it actually
    // mean-pooled. The identity must reflect the sidecar's truth.
    const { client } = fakeClient({ pooling: "mean", dtype: "q8" });
    const backend = createBackend({
      backend: "sidecar",
      model: GTE,
      dimension: 3,
      client: client as never,
    });
    const res = await backend.embed(["q"]);
    expect(res.identity).toBe(`${GTE}|mean|q8`);
  });

  it("DETECTS a sidecar dtype the server never sent (fp32 vs q8 default)", async () => {
    process.env.EMBEDDINGS_TOKEN = "t";
    const { createBackend } = await import("../src/lib/rag/embedder-registry.js");
    await import("../src/lib/rag/embedder.js");
    const { client } = fakeClient({ pooling: "cls", dtype: "fp32" });
    const backend = createBackend({
      backend: "sidecar",
      model: GTE,
      dimension: 3,
      client: client as never,
    });
    const res = await backend.embed(["q"]);
    expect(res.identity).toBe(`${GTE}|cls|fp32`);
  });

  it("currentIdentity() probes the sidecar once, then caches", async () => {
    process.env.EMBEDDINGS_TOKEN = "t";
    const { createBackend } = await import("../src/lib/rag/embedder-registry.js");
    await import("../src/lib/rag/embedder.js");
    const { client, calls } = fakeClient({ pooling: "mean", dtype: "fp32" });
    const backend = createBackend({
      backend: "sidecar",
      model: GTE,
      dimension: 3,
      client: client as never,
    });
    const backendWithIdentity = backend as typeof backend & {
      currentIdentity: () => Promise<string>;
    };
    expect(await backendWithIdentity.currentIdentity()).toBe(`${GTE}|mean|fp32`);
    // A real embed refreshes the cache; a second currentIdentity does NOT re-probe.
    await backend.embed(["q"]);
    expect(await backendWithIdentity.currentIdentity()).toBe(`${GTE}|mean|fp32`);
    // one probe + one embed = 2 calls; the trailing currentIdentity used the cache.
    expect(calls).toHaveLength(2);
  });

  it("falls back to the bare model id when the sidecar echoes nothing (pre-#782)", async () => {
    process.env.EMBEDDINGS_TOKEN = "t";
    const { createBackend } = await import("../src/lib/rag/embedder-registry.js");
    await import("../src/lib/rag/embedder.js");
    const { client } = fakeClient({ pooling: undefined, dtype: undefined });
    const backend = createBackend({
      backend: "sidecar",
      model: GTE,
      dimension: 3,
      client: client as never,
    });
    const res = await backend.embed(["q"]);
    expect(res.identity).toBe(GTE);
  });
});

describe("Embedder.currentIdentity() façade (#792)", () => {
  it("delegates to a backend that implements currentIdentity (xenova → composite on a flip)", async () => {
    process.env.EMBED_POOLING_MAP = `${GTE}=mean`;
    mockRuntime();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder({ backend: "xenova", model: GTE, dimension: 768 });
    expect(await embedder.currentIdentity()).toBe(`${GTE}|mean|q8`);
  });

  it("falls back to the bare model id for a backend without currentIdentity (offline stub)", async () => {
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder({ backend: "offline" });
    expect(await embedder.currentIdentity()).toBe(embedder.model);
  });
});
