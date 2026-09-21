/**
 * Tests for the HTTP client to the `metis-embeddings` sidecar (issue #145).
 *
 * We spin up a tiny local HTTP server with `node:http` to act as the
 * sidecar — this exercises the real undici request path without depending
 * on Docker or `@huggingface/transformers`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

const ORIGINAL_TOKEN = process.env.EMBEDDINGS_TOKEN;
const ORIGINAL_URL = process.env.EMBEDDINGS_URL;
const ORIGINAL_MODE = process.env.EMBEDDINGS_MODE;
const ORIGINAL_TIMEOUT = process.env.EMBEDDINGS_TIMEOUT_MS;
const ORIGINAL_MAX = process.env.EMBEDDINGS_MAX_ATTEMPTS;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_OFFLINE = process.env.AI_OFFLINE;

interface Handler {
  (
    path: string,
    body: string,
  ): { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

interface Probe {
  server: Server;
  url: string;
  calls: { path: string; auth: string | undefined; body: string }[];
  close(): Promise<void>;
}

async function startProbe(handler: Handler): Promise<Probe> {
  const calls: Probe["calls"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      try {
        const result = await handler(req.url ?? "", body);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

beforeEach(() => {
  process.env.EMBEDDINGS_TOKEN = "test-token";
  // The shared `tests/setup.ts` sets `AI_OFFLINE=1` globally. The sidecar
  // path tests in this file need that disabled so the Embedder doesn't
  // short-circuit to the hash backend.
  delete process.env.AI_OFFLINE;
  delete process.env.EMBEDDINGS_TIMEOUT_MS;
  delete process.env.EMBEDDINGS_MAX_ATTEMPTS;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.EMBEDDINGS_TOKEN;
  else process.env.EMBEDDINGS_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_URL === undefined) delete process.env.EMBEDDINGS_URL;
  else process.env.EMBEDDINGS_URL = ORIGINAL_URL;
  if (ORIGINAL_MODE === undefined) delete process.env.EMBEDDINGS_MODE;
  else process.env.EMBEDDINGS_MODE = ORIGINAL_MODE;
  if (ORIGINAL_TIMEOUT === undefined) delete process.env.EMBEDDINGS_TIMEOUT_MS;
  else process.env.EMBEDDINGS_TIMEOUT_MS = ORIGINAL_TIMEOUT;
  if (ORIGINAL_MAX === undefined) delete process.env.EMBEDDINGS_MAX_ATTEMPTS;
  else process.env.EMBEDDINGS_MAX_ATTEMPTS = ORIGINAL_MAX;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_VITEST === undefined) delete process.env.VITEST;
  else process.env.VITEST = ORIGINAL_VITEST;
  if (ORIGINAL_OFFLINE === undefined) delete process.env.AI_OFFLINE;
  else process.env.AI_OFFLINE = ORIGINAL_OFFLINE;
});

describe("EmbeddingsClient", () => {
  it("refuses to construct when EMBEDDINGS_TOKEN is missing", async () => {
    delete process.env.EMBEDDINGS_TOKEN;
    const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
    expect(() => new EmbeddingsClient()).toThrow(/EMBEDDINGS_TOKEN/);
  });

  it("returns empty result without HTTP traffic for an empty embed batch", async () => {
    const probe = await startProbe(() => ({
      status: 500,
      body: { error: "should not be called" },
    }));
    try {
      const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
      const client = new EmbeddingsClient({ baseUrl: probe.url });
      const res = await client.embed([]);
      expect(res.vectors).toHaveLength(0);
      expect(probe.calls).toHaveLength(0);
    } finally {
      await probe.close();
    }
  });

  it("returns empty result without HTTP traffic for an empty rerank batch", async () => {
    const probe = await startProbe(() => ({ status: 500, body: {} }));
    try {
      const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
      const client = new EmbeddingsClient({ baseUrl: probe.url });
      const res = await client.rerank("q", []);
      expect(res.scores).toHaveLength(0);
    } finally {
      await probe.close();
    }
  });

  it("posts to /embed with bearer auth and returns vectors", async () => {
    const probe = await startProbe(() => ({
      status: 200,
      body: { vectors: [[1, 2, 3]], model: "test-model", dimension: 3 },
    }));
    try {
      const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
      const client = new EmbeddingsClient({ baseUrl: probe.url });
      const res = await client.embed(["hi"]);
      expect(res.vectors).toEqual([[1, 2, 3]]);
      expect(res.dimension).toBe(3);
      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0]!.auth).toBe("Bearer test-token");
      expect(probe.calls[0]!.path).toBe("/embed");
    } finally {
      await probe.close();
    }
  });

  it("retries on 5xx and succeeds on the third attempt", async () => {
    let n = 0;
    const probe = await startProbe(() => {
      n += 1;
      if (n < 3) return { status: 503, body: { error: "warming up" } };
      return { status: 200, body: { vectors: [[0.1]], model: "m", dimension: 1 } };
    });
    try {
      const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
      const client = new EmbeddingsClient({ baseUrl: probe.url, maxAttempts: 3 });
      const res = await client.embed(["x"]);
      expect(res.vectors).toEqual([[0.1]]);
      expect(n).toBe(3);
    } finally {
      await probe.close();
    }
  });

  it("does not retry on 401 and surfaces the error", async () => {
    let n = 0;
    const probe = await startProbe(() => {
      n += 1;
      return { status: 401, body: { error: "unauthorized" } };
    });
    try {
      const { EmbeddingsClient, EmbeddingsClientError } =
        await import("../src/lib/rag/embeddings-client.js");
      const client = new EmbeddingsClient({ baseUrl: probe.url, maxAttempts: 3 });
      await expect(client.embed(["x"])).rejects.toBeInstanceOf(EmbeddingsClientError);
      expect(n).toBe(1);
    } finally {
      await probe.close();
    }
  });

  it("surfaces a 503 fail-closed sidecar with EmbeddingsClientError", async () => {
    const probe = await startProbe(() => ({ status: 503, body: { error: "no token" } }));
    try {
      const { EmbeddingsClient, EmbeddingsClientError } =
        await import("../src/lib/rag/embeddings-client.js");
      const client = new EmbeddingsClient({ baseUrl: probe.url, maxAttempts: 1 });
      await expect(client.embed(["x"])).rejects.toBeInstanceOf(EmbeddingsClientError);
    } finally {
      await probe.close();
    }
  });

  it("posts to /rerank and returns scores", async () => {
    const probe = await startProbe(() => ({
      status: 200,
      body: { scores: [0.9, 0.1], model: "rerank-test" },
    }));
    try {
      const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
      const client = new EmbeddingsClient({ baseUrl: probe.url });
      const res = await client.rerank("q", [
        { chunkId: "a", text: "alpha" },
        { chunkId: "b", text: "beta" },
      ]);
      expect(res.scores).toEqual([0.9, 0.1]);
      expect(probe.calls[0]!.path).toBe("/rerank");
    } finally {
      await probe.close();
    }
  });

  it("calls /healthz without auth errors and returns the body", async () => {
    const probe = await startProbe(() => ({
      status: 200,
      body: { status: "ok", tokenConfigured: true },
    }));
    try {
      const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
      const client = new EmbeddingsClient({ baseUrl: probe.url });
      const res = await client.healthz();
      expect(res.status).toBe("ok");
      expect(res.tokenConfigured).toBe(true);
    } finally {
      await probe.close();
    }
  });
});

describe("resolveEmbeddingsMode", () => {
  it("respects an explicit EMBEDDINGS_MODE", async () => {
    process.env.EMBEDDINGS_MODE = "sidecar";
    const { resolveEmbeddingsMode } = await import("../src/lib/rag/embeddings-client.js");
    expect(resolveEmbeddingsMode()).toBe("sidecar");
    process.env.EMBEDDINGS_MODE = "in-process";
    expect(resolveEmbeddingsMode()).toBe("in-process");
  });

  it("defaults to in-process when running under VITEST", async () => {
    delete process.env.EMBEDDINGS_MODE;
    process.env.VITEST = "true";
    process.env.NODE_ENV = "production";
    const { resolveEmbeddingsMode } = await import("../src/lib/rag/embeddings-client.js");
    expect(resolveEmbeddingsMode()).toBe("in-process");
  });

  it("defaults to in-process when AI_OFFLINE=1", async () => {
    delete process.env.EMBEDDINGS_MODE;
    delete process.env.VITEST;
    process.env.AI_OFFLINE = "1";
    process.env.NODE_ENV = "production";
    const { resolveEmbeddingsMode } = await import("../src/lib/rag/embeddings-client.js");
    expect(resolveEmbeddingsMode()).toBe("in-process");
  });

  it("defaults to sidecar in production when no offline flag is set", async () => {
    delete process.env.EMBEDDINGS_MODE;
    delete process.env.VITEST;
    delete process.env.AI_OFFLINE;
    process.env.NODE_ENV = "production";
    const { resolveEmbeddingsMode } = await import("../src/lib/rag/embeddings-client.js");
    expect(resolveEmbeddingsMode()).toBe("sidecar");
  });

  it("defaults to in-process for development", async () => {
    delete process.env.EMBEDDINGS_MODE;
    delete process.env.VITEST;
    delete process.env.AI_OFFLINE;
    process.env.NODE_ENV = "development";
    const { resolveEmbeddingsMode } = await import("../src/lib/rag/embeddings-client.js");
    expect(resolveEmbeddingsMode()).toBe("in-process");
  });
});

describe("Embedder + Reranker — sidecar wiring", () => {
  it("Embedder routes through the sidecar when backend=sidecar", async () => {
    const probe = await startProbe(() => ({
      status: 200,
      body: { vectors: [[0.5, 0.5, 0.5]], model: "Xenova/bge-small-en-v1.5", dimension: 3 },
    }));
    try {
      process.env.EMBEDDINGS_URL = probe.url;
      const { Embedder } = await import("../src/lib/rag/embedder.js");
      const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
      const embedder = new Embedder({
        backend: "sidecar",
        client: new EmbeddingsClient({ baseUrl: probe.url, maxAttempts: 1 }),
      });
      const res = await embedder.embed(["hello"]);
      expect(res.vectors).toEqual([[0.5, 0.5, 0.5]]);
      // First call hits /healthz (warm), second call hits /embed.
      expect(probe.calls.map((c) => c.path)).toContain("/embed");
    } finally {
      await probe.close();
    }
  });

  /** An Embedder pointed at a closed port — the "sidecar is down" shape. */
  async function unreachableSidecarEmbedder() {
    process.env.EMBEDDINGS_URL = "http://127.0.0.1:1"; // closed port
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
    return new Embedder({
      backend: "sidecar",
      client: new EmbeddingsClient({
        baseUrl: "http://127.0.0.1:1",
        maxAttempts: 1,
        timeoutMs: 1_000,
      }),
    });
  }

  it("Embedder FAILS LOUD when the sidecar is unreachable (#783)", async () => {
    // Until #783 this resolved with a hash vector. A sidecar that is down during a
    // rollout is a transient, recoverable event; quietly writing non-semantic
    // vectors into the corpus for its duration is not — nothing marks those rows,
    // and only a reindex removes them.
    delete process.env.EMBED_ALLOW_HASH_FALLBACK;
    const embedder = await unreachableSidecarEmbedder();
    await expect(embedder.embed(["hello"])).rejects.toThrow(/REFUSING to embed/);
    expect(embedder.fellBack).toBe(false);
  });

  it("Embedder falls back to hash when the sidecar is unreachable AND fallback is opted in", async () => {
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    try {
      const embedder = await unreachableSidecarEmbedder();
      const res = await embedder.embed(["hello"]);
      expect(res.model).toBe("metis-offline-hash-v1");
      expect(embedder.fellBack).toBe(true);
    } finally {
      delete process.env.EMBED_ALLOW_HASH_FALLBACK;
    }
  });

  it("RemoteReranker delegates to the sidecar and reorders by score", async () => {
    const probe = await startProbe(() => ({
      status: 200,
      body: { scores: [0.1, 0.9], model: "r" },
    }));
    try {
      process.env.EMBEDDINGS_URL = probe.url;
      process.env.RAG_RERANK = "1";
      process.env.EMBEDDINGS_MODE = "sidecar";
      const { __resetRerankerSingleton, getReranker } = await import("../src/lib/rag/reranker.js");
      __resetRerankerSingleton();
      const reranker = getReranker();
      expect(reranker.enabled).toBe(true);
      const out = await reranker.rerank("query string", [
        { chunkId: "a", text: "alpha" },
        { chunkId: "b", text: "beta" },
      ]);
      expect(out[0]!.chunkId).toBe("b");
      expect(out[0]!.score).toBe(0.9);
      expect(out[1]!.chunkId).toBe("a");
    } finally {
      await probe.close();
      delete process.env.RAG_RERANK;
    }
  });

  it("RemoteReranker falls back to original order on sidecar failure", async () => {
    process.env.EMBEDDINGS_URL = "http://127.0.0.1:1";
    process.env.RAG_RERANK = "1";
    process.env.EMBEDDINGS_MODE = "sidecar";
    const { __resetRerankerSingleton, getReranker } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const reranker = getReranker();
    const candidates = [
      { chunkId: "a", text: "alpha", score: 0.5 },
      { chunkId: "b", text: "beta", score: 0.4 },
    ];
    const out = await reranker.rerank("query string", candidates);
    expect(out.map((c) => c.chunkId)).toEqual(["a", "b"]);
    delete process.env.RAG_RERANK;
  });
});
