/**
 * Issue #786 — the server must respect the sidecar's 64-text `/embed` cap.
 *
 * The cap is not a free change: `knowledge-service.ts` ingests a document by
 * calling `embedder.embed(chunks.map(c => c.text))` with EVERY chunk of that
 * document in one call, and its reindex path batches at 128. Dropping the
 * sidecar's limit from 256 to 64 without doing anything else would 400 the
 * ingest of any document over 64 chunks — i.e. most of them.
 *
 * So `EmbeddingsClient.embed()` — the only module that knows the sidecar's HTTP
 * contract — splits oversized calls into ≤64-text posts and stitches the vectors
 * back together in order. These tests run against a real local HTTP server acting
 * as the sidecar, so the wire shape is genuinely exercised.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_EMBED_TEXTS_PER_REQUEST } from "../src/lib/rag/embed-model-config.js";

const ORIGINAL_TOKEN = process.env.EMBEDDINGS_TOKEN;

interface Probe {
  server: Server;
  url: string;
  /** The `texts` array of every /embed request the sidecar received, in order. */
  batches: string[][];
  close(): Promise<void>;
}

/**
 * A sidecar stub that ENFORCES the real cap: it 400s any request over 64 texts,
 * exactly as `server/embeddings-svc/src/app.ts` does. A test that only counted
 * requests would still pass if the client sent one 200-text post to a lenient
 * stub — this one would not.
 */
async function startSidecar(): Promise<Probe> {
  const batches: string[][] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { texts: string[] };
      if (parsed.texts.length > MAX_EMBED_TEXTS_PER_REQUEST) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request", details: "too many texts" }));
        return;
      }
      batches.push(parsed.texts);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          // Vector encodes its own text so mis-ordering is detectable.
          vectors: parsed.texts.map((t) => [Number(t.split("-")[1]), 0, 0]),
          model: "Alibaba-NLP/gte-modernbert-base",
          dimension: 3,
          pooling: "cls",
          dtype: "q8",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    batches,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let probe: Probe;

beforeEach(async () => {
  probe = await startSidecar();
  process.env.EMBEDDINGS_TOKEN = "test-token";
});

afterEach(async () => {
  await probe.close();
  if (ORIGINAL_TOKEN === undefined) delete process.env.EMBEDDINGS_TOKEN;
  else process.env.EMBEDDINGS_TOKEN = ORIGINAL_TOKEN;
});

async function client() {
  const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
  return new EmbeddingsClient({ baseUrl: probe.url, token: "test-token", maxAttempts: 1 });
}

const texts = (n: number) => Array.from({ length: n }, (_, i) => `text-${i}`);

describe("EmbeddingsClient batch cap (#786)", () => {
  it("sends a single request when the batch fits under the cap", async () => {
    const c = await client();
    const res = await c.embed(texts(64));
    expect(probe.batches).toHaveLength(1);
    expect(res.vectors).toHaveLength(64);
  });

  it("splits a 128-text reindex batch into two ≤64 requests", async () => {
    // knowledge-service.ts's reindex batchSize default is 128 — over the cap.
    const c = await client();
    const res = await c.embed(texts(128));
    expect(probe.batches.map((b) => b.length)).toEqual([64, 64]);
    expect(res.vectors).toHaveLength(128);
  });

  it("splits an unbounded ingest batch and returns one vector per text, IN ORDER", async () => {
    // knowledge-service.ts:354 hands over every chunk of a document at once.
    const c = await client();
    const res = await c.embed(texts(150));
    expect(probe.batches.map((b) => b.length)).toEqual([64, 64, 22]);
    expect(res.vectors).toHaveLength(150);
    // Each stub vector carries its own index — proves nothing was re-ordered.
    expect(res.vectors.map((v) => v[0])).toEqual(Array.from({ length: 150 }, (_, i) => i));
  });

  it("never sends a request the sidecar would reject", async () => {
    const c = await client();
    await c.embed(texts(300));
    expect(probe.batches.every((b) => b.length <= MAX_EMBED_TEXTS_PER_REQUEST)).toBe(true);
    // The stub 400s over the cap, so reaching here at all proves the point.
    expect(probe.batches).toHaveLength(5);
  });

  it("preserves the model/dimension/pooling metadata across the split", async () => {
    const c = await client();
    const res = await c.embed(texts(70));
    expect(res.model).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(res.dimension).toBe(3);
    expect(res.pooling).toBe("cls");
    expect(res.dtype).toBe("q8");
  });

  /**
   * The slices are separate posts to a ClusterIP Service, so a rolling update can
   * land them on two pods running DIFFERENT models. Concatenating those vectors
   * yields an array that is internally inhomogeneous but advertises the LAST
   * slice's model/dimension — silently written to the store as one vector space,
   * after which every distance against it is meaningless. Refuse instead.
   */
  it("refuses to mix vector spaces when the sidecar changes model mid-batch", async () => {
    await probe.close();

    let call = 0;
    const skewed = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const { texts: batch } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          texts: string[];
        };
        call += 1;
        // Slice 1: the old pod. Slice 2+: the new pod, mid-rollout.
        const old = call === 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            vectors: batch.map(() => (old ? [1, 2, 3] : [1, 2, 3, 4])),
            model: old ? "Xenova/all-MiniLM-L6-v2" : "Alibaba-NLP/gte-modernbert-base",
            dimension: old ? 3 : 4,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => skewed.listen(0, "127.0.0.1", resolve));
    const port = (skewed.address() as AddressInfo).port;

    const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
    const c = new EmbeddingsClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token",
      maxAttempts: 1,
    });

    await expect(c.embed(texts(130))).rejects.toThrow(/changed model\/dimension mid-batch/);
    await new Promise<void>((resolve) => skewed.close(() => resolve()));
    // It must fail rather than return 130 vectors of two different widths.
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("still short-circuits an empty batch without touching the network", async () => {
    const c = await client();
    const res = await c.embed([]);
    expect(probe.batches).toHaveLength(0);
    expect(res.vectors).toEqual([]);
  });

  it("issues the slices sequentially so one pod never holds N batches at once", async () => {
    // Parallel posts to a single sidecar pod would put every slice in the ONNX
    // arena simultaneously — recreating the very memory spike the cap prevents.
    // So: hold each response open briefly and record the peak concurrency the
    // sidecar actually observed. Sequential ⇒ it never exceeds 1.
    await probe.close();

    let inFlight = 0;
    let peakInFlight = 0;
    const slow = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const { texts: batch } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          texts: string[];
        };
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              vectors: batch.map(() => [1, 2, 3]),
              model: "m",
              dimension: 3,
            }),
          );
        }, 25);
      });
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const port = (slow.address() as AddressInfo).port;

    const { EmbeddingsClient } = await import("../src/lib/rag/embeddings-client.js");
    const c = new EmbeddingsClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token",
      maxAttempts: 1,
    });
    const res = await c.embed(texts(130)); // 3 slices
    await new Promise<void>((resolve) => slow.close(() => resolve()));

    expect(res.vectors).toHaveLength(130);
    expect(peakInFlight).toBe(1);
  });
});
