/**
 * Issue #782 — per-model pooling + `EMBED_DTYPE` on the SERVER's embedding
 * backends (in-process `xenova`/`embeddinggemma` and the `sidecar` HTTP backend).
 *
 * The pre-#782 in-process backend hardcoded `pooling: "mean"`, which silently
 * degrades a CLS model (gte-modernbert, Granite). `@huggingface/transformers` is
 * mocked so we can assert exactly what the runtime is asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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

/** Mock runtime whose pipeline records the pooling/dtype it was asked for. */
function mockRuntime(config?: unknown) {
  const pipe = Object.assign(
    vi.fn(async () => ({ data: new Float32Array(384).fill(0.05), dims: [1, 384] })),
    { model: { config } },
  );
  const pipeline = vi.fn(async () => pipe);
  vi.doMock("@huggingface/transformers", () => ({ pipeline, env: {} }));
  return { pipeline, pipe };
}

describe("XenovaEmbedder pooling (#782)", () => {
  it("mean-pools today's default model at q8 — ZERO behaviour change vs #781", async () => {
    const { pipeline, pipe } = mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");

    const embedder = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    expect(embedder.pooling).toBe("mean");
    expect(embedder.dtype).toBe("q8");

    await embedder.embed(["hello"]);

    expect(pipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "q8",
    });
    expect(pipe).toHaveBeenCalledWith(["hello"], { pooling: "mean", normalize: true });
  });

  it("CLS-pools gte-modernbert BY DEFAULT (guards against reintroducing the hardcode)", async () => {
    const { pipe } = mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");

    const embedder = new XenovaEmbedder("Alibaba-NLP/gte-modernbert-base", 768);
    expect(embedder.pooling).toBe("cls");

    await embedder.embed(["throttle failed logins"]);

    expect(pipe).toHaveBeenCalledWith(["throttle failed logins"], {
      pooling: "cls",
      normalize: true,
    });
  });

  it("CLS-pools Granite by default", async () => {
    mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder(
      "onnx-community/granite-embedding-small-english-r2-ONNX",
      384,
    );
    expect(embedder.pooling).toBe("cls");
  });

  it("honours an explicit pooling option over the per-model map", async () => {
    const { pipe } = mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");

    const embedder = new XenovaEmbedder("Alibaba-NLP/gte-modernbert-base", 768, {
      pooling: "mean",
    });
    await embedder.embed(["x"]);

    expect(pipe).toHaveBeenCalledWith(["x"], { pooling: "mean", normalize: true });
  });

  it("honours EMBED_POOLING_MAP for an unmapped model", async () => {
    process.env.EMBED_POOLING_MAP = "acme/custom=cls";
    mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");

    expect(new XenovaEmbedder("acme/custom", 384).pooling).toBe("cls");
    expect(new XenovaEmbedder("acme/other", 384).pooling).toBe("mean");
  });

  it("passes EMBED_DTYPE=fp32 to the runtime", async () => {
    process.env.EMBED_DTYPE = "fp32";
    const { pipeline } = mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");

    const embedder = new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384);
    expect(embedder.dtype).toBe("fp32");
    await embedder.embed(["x"]);

    expect(pipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/bge-small-en-v1.5", {
      dtype: "fp32",
    });
  });

  it("throws on an invalid EMBED_DTYPE instead of loading unknown weights", async () => {
    process.env.EMBED_DTYPE = "int4";
    mockRuntime();
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");

    expect(() => new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384)).toThrow(
      /Invalid EMBED_DTYPE/,
    );
  });

  it("warns loudly when the model config declares a pooling we disagree with", async () => {
    // bge* maps to mean; this config claims CLS.
    mockRuntime({ pooling_mode_cls_token: true });
    const warn = vi.fn();
    vi.doMock("../src/lib/logger.js", () => {
      const stub = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
      return { createChildLogger: () => stub, logger: stub, redact: (x: unknown) => x };
    });
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");

    await new XenovaEmbedder("Xenova/bge-small-en-v1.5", 384).embed(["x"]);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("POOLING MISMATCH"),
      expect.objectContaining({ declared: "cls", resolved: "mean" }),
    );
    vi.doUnmock("../src/lib/logger.js");
  });

  it("routes the embeddinggemma backend through the same knobs", async () => {
    process.env.EMBED_DTYPE = "fp32";
    const { pipeline } = mockRuntime();
    const { createBackend } = await import("../src/lib/rag/embedder-registry.js");
    await import("../src/lib/rag/embedder.js");

    const backend = createBackend({ backend: "embeddinggemma", dimension: 768 });
    await backend.embed(["x"]);

    expect(pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "onnx-community/embeddinggemma-300m-ONNX",
      { dtype: "fp32" },
    );
  });
});

// ---------------------------------------------------------------------------
// Sidecar (HTTP) backend round-trip — the server must SEND the pooling.
// ---------------------------------------------------------------------------

interface Probe {
  server: Server;
  url: string;
  bodies: Record<string, unknown>[];
  close(): Promise<void>;
}

async function startSidecarProbe(): Promise<Probe> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/embed") {
        const body = JSON.parse(raw) as { texts: string[]; model?: string; pooling?: string };
        bodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            vectors: body.texts.map(() => [0.1, 0.2, 0.3]),
            model: body.model,
            dimension: 3,
            pooling: body.pooling,
            dtype: "q8",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tokenConfigured: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("sidecar backend sends pooling over the wire (#782)", () => {
  it("sends the per-model pooling — cls for gte-modernbert, mean for the default model", async () => {
    const probe = await startSidecarProbe();
    try {
      process.env.EMBEDDINGS_URL = probe.url;
      process.env.EMBEDDINGS_TOKEN = "test-token";
      const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
      const { createBackend } = await import("../src/lib/rag/embedder-registry.js");
      await import("../src/lib/rag/embedder.js");

      const client = new EmbeddingsClient({ baseUrl: probe.url, token: "test-token" });

      const cls = createBackend({
        backend: "sidecar",
        model: "Alibaba-NLP/gte-modernbert-base",
        dimension: 768,
        client,
      });
      const res = await cls.embed(["throttle failed logins"]);
      expect(res.vectors).toHaveLength(1);

      const mean = createBackend({
        backend: "sidecar",
        model: "Xenova/bge-small-en-v1.5",
        dimension: 384,
        client,
      });
      await mean.embed(["hello"]);

      expect(probe.bodies).toEqual([
        {
          texts: ["throttle failed logins"],
          model: "Alibaba-NLP/gte-modernbert-base",
          pooling: "cls",
        },
        { texts: ["hello"], model: "Xenova/bge-small-en-v1.5", pooling: "mean" },
      ]);
    } finally {
      await probe.close();
    }
  });
});
