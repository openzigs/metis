/**
 * Issue #222 — in-process ONNX on two threads aborts the server.
 *
 * `onnxruntime-node` kills the whole process with a V8 `FATAL ERROR` (exit 134, not
 * catchable from JavaScript) once ONNX sessions are live on two threads. Since #189
 * the in-process embedder runs its model in a `worker_thread` by default, and the
 * `RAG_RERANK=1` cross-encoder loads its model on the MAIN thread — so the first
 * query embed after the first rerank takes the server down.
 *
 * The fix refuses that configuration at boot with an error naming the ways out,
 * rather than letting it boot, pass `/readyz`, and die on the first reranked search.
 * These tests drive the real `createApp()` boot path and the real reranker factory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  __resetRerankerSingleton,
  assertRerankOnnxSingleThread,
  createCrossEncoderReranker,
  getReranker,
} from "../src/lib/rag/reranker.js";
import { getBackendDescriptor, registerBackend } from "../src/lib/rag/embedder-registry.js";

/** The configuration from the issue: defaults, plus `RAG_RERANK=1`. */
function conflictingEnv(): void {
  vi.stubEnv("RAG_RERANK", "1");
  vi.stubEnv("AI_OFFLINE", "");
  vi.stubEnv("EMBEDDINGS_MODE", "in-process");
  vi.stubEnv("EMBED_BACKEND", "xenova");
  vi.stubEnv("EMBED_INPROCESS_RUNTIME", "worker");
}

beforeEach(() => {
  __resetRerankerSingleton();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetRerankerSingleton();
});

describe("assertRerankOnnxSingleThread (#222)", () => {
  it("refuses RAG_RERANK=1 with the in-process reranker and the worker embedder", () => {
    conflictingEnv();
    expect(() => assertRerankOnnxSingleThread()).toThrow(/RAG_RERANK/);
  });

  it("names every way out, so the operator does not have to guess", () => {
    conflictingEnv();
    let message = "";
    try {
      assertRerankOnnxSingleThread();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/EMBEDDINGS_MODE=sidecar/);
    expect(message).toMatch(/EMBED_INPROCESS_RUNTIME=inline/);
    expect(message).toMatch(/unset RAG_RERANK/);
  });

  it("refuses the EmbeddingGemma backend too — it is the same in-process worker ONNX", () => {
    conflictingEnv();
    vi.stubEnv("EMBED_BACKEND", "embeddinggemma");
    expect(() => assertRerankOnnxSingleThread()).toThrow(/RAG_RERANK/);
  });

  it("allows the default deployment (RAG_RERANK unset)", () => {
    conflictingEnv();
    vi.stubEnv("RAG_RERANK", "");
    expect(() => assertRerankOnnxSingleThread()).not.toThrow();
  });

  it("allows the inline runtime — embedder and reranker then share the main thread", () => {
    conflictingEnv();
    vi.stubEnv("EMBED_INPROCESS_RUNTIME", "inline");
    expect(() => assertRerankOnnxSingleThread()).not.toThrow();
  });

  it("allows the sidecar mode — the reranker then runs out of process", () => {
    conflictingEnv();
    vi.stubEnv("EMBEDDINGS_MODE", "sidecar");
    expect(() => assertRerankOnnxSingleThread()).not.toThrow();
  });

  it.each(["offline", "sidecar", "bedrock-sdk", "openai"])(
    "allows a non-ONNX embed backend (%s) — only the reranker holds an ONNX session",
    (backend) => {
      conflictingEnv();
      vi.stubEnv("EMBED_BACKEND", backend);
      expect(() => assertRerankOnnxSingleThread()).not.toThrow();
    },
  );
});

describe("createApp() refuses the combination at boot (#222)", () => {
  it("throws on RAG_RERANK=1 with the default worker embedder", () => {
    conflictingEnv();
    // The boot check's own wording — the reranker factory refuses too (below), and
    // the knowledge service constructs a reranker inside createApp(), so a looser
    // pattern would pass even with the boot check deleted.
    expect(() => createApp()).toThrow(/RAG_RERANK=1 is not supported in this configuration/);
  });

  it("still boots once the runtime is inline", () => {
    conflictingEnv();
    vi.stubEnv("EMBED_INPROCESS_RUNTIME", "inline");
    expect(() => createApp()).not.toThrow();
  });
});

describe("the reranker factories refuse too — scripts that never call createApp (#222)", () => {
  it("createCrossEncoderReranker throws instead of loading a main-thread ONNX session", () => {
    conflictingEnv();
    expect(() => createCrossEncoderReranker()).toThrow(/RAG_RERANK|EMBED_INPROCESS_RUNTIME/);
  });

  it("getReranker throws for the same configuration", () => {
    conflictingEnv();
    expect(() => getReranker()).toThrow(/EMBED_INPROCESS_RUNTIME/);
  });

  it("createCrossEncoderReranker is still available for a safe configuration", () => {
    conflictingEnv();
    vi.stubEnv("EMBED_INPROCESS_RUNTIME", "inline");
    expect(createCrossEncoderReranker().enabled).toBe(true);
  });
});

/**
 * PR #255 review — the eval harness builds its embedder from a per-arm backend
 * (`createArmEmbedFn` → `new Embedder({ backend: spec.backend })`), not from the
 * process environment. The factory judges the configuration the caller passes.
 */
describe("createCrossEncoderReranker judges the caller's embedder, not the env's (#222)", () => {
  it("refuses an in-process ONNX arm even when the env names an HTTP backend", () => {
    conflictingEnv();
    vi.stubEnv("EMBED_BACKEND", "openai");
    expect(() => createCrossEncoderReranker({ embed: { backend: "xenova" } })).toThrow(
      /EMBED_INPROCESS_RUNTIME/,
    );
  });

  it("allows the hash-floor arm under the default env, which would conflict on its own", () => {
    conflictingEnv();
    expect(createCrossEncoderReranker({ embed: { backend: "offline" } }).enabled).toBe(true);
  });

  it("honours the caller's runtime over the env's", () => {
    conflictingEnv();
    const inline = { backend: "xenova", inProcessRuntime: "inline" } as const;
    expect(createCrossEncoderReranker({ embed: inline }).enabled).toBe(true);
    vi.stubEnv("EMBED_INPROCESS_RUNTIME", "inline");
    expect(() =>
      createCrossEncoderReranker({ embed: { backend: "xenova", inProcessRuntime: "worker" } }),
    ).toThrow(/EMBED_INPROCESS_RUNTIME/);
  });
});

describe("the in-process ONNX backend list comes from the backend registry (#222)", () => {
  it("refuses a newly registered in-process ONNX backend without editing the reranker", () => {
    registerBackend(
      "test-onnx-222",
      () => {
        throw new Error("never constructed by the check");
      },
      {
        label: "test",
        description: "test",
        requiresEgress: false,
        defaultModel: "m",
        defaultDimension: 8,
        offlineCapable: true,
        inProcessOnnx: true,
      },
    );
    conflictingEnv();
    vi.stubEnv("EMBED_BACKEND", "test-onnx-222");
    expect(() => assertRerankOnnxSingleThread()).toThrow(/RAG_RERANK/);
  });

  it("the built-in in-process backends declare it", () => {
    expect(getBackendDescriptor("xenova")?.inProcessOnnx).toBe(true);
    expect(getBackendDescriptor("embeddinggemma")?.inProcessOnnx).toBe(true);
    expect(getBackendDescriptor("sidecar")?.inProcessOnnx).toBeFalsy();
  });
});
