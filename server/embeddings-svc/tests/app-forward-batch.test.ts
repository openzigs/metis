/**
 * Issue #807 — `/embed` runs a batch-INVARIANT forward pass.
 *
 * The sidecar is the path production actually uses (`EMBED_BACKEND=sidecar`), so the
 * fix has to hold HERE, not only in the in-process embedder. `q8`'s ONNX graph derives
 * one per-tensor activation scale from the whole `[batch, seq, hidden]` tensor, so any
 * two texts sharing a forward pass perturb each other's vectors — measured at
 * cos(batch-1, batch-64) = 0.974 on the shipped model, worth ~6 places of retrieval
 * rank. See `resolveForwardBatch` in `src/model-config.ts`.
 *
 * These tests capture the batches actually handed to the runtime pipeline, so a
 * regression that re-batches a quantized forward pass fails CI. The runtime is mocked;
 * the vector MATH is proved against real weights in the download-gated
 * `server/tests/rag-embedder-batch-invariance.test.ts`.
 *
 * NOTE what is deliberately NOT changed: the /embed REQUEST still carries up to
 * MAX_EMBED_TEXTS_PER_REQUEST (64) texts. This bounds the model call, not the HTTP
 * round-trip — ingest still makes ~235 posts for METIS's ~15k symbols, not ~15,000.
 *
 * ## Issue #1379 — why this file no longer opens a socket
 *
 * These are pure-logic assertions about which batches reach the model, but they used to
 * ride on `supertest`, which boots a listener on an ephemeral port and makes a real
 * loopback round-trip per request. That coupled a correctness invariant to a
 * machine-global, finite resource, and the monorepo fan-out runs this package beside
 * `server`'s ~1,100 files, whose own supertest suites churn that resource hard. The
 * observed failure was `(7 tests | 1 failed) 20076ms` against this package's
 * `testTimeout: 20_000` — a stalled round-trip, not a regression: the same file passes
 * in 158 ms alone. Measured here at 2–3 ms idle, 6,291 ms under CPU + loopback pressure,
 * and `connect EADDRNOTAVAIL` once the 16,384-port ephemeral range is saturated.
 *
 * `invoke()` hands the request straight to the same Express app in process. The router,
 * `express.json()`, the auth middleware, the Zod schema, the handler and Node's response
 * serializer are all still exercised — only the kernel is gone. This is NOT a raised
 * timeout and NOT a retry: there is nothing left to time out on. See
 * `tests/helpers/invoke-app.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./helpers/invoke-app.js";

const calls: string[][] = [];

vi.mock("../src/pipelines.js", () => ({
  async getEmbedPipeline() {
    return async (texts: string[]) => {
      calls.push([...texts]);
      // One row per text, 3 dims, content-derived so a reordering bug in the
      // concatenation surfaces as a wrong vector rather than a passing test.
      const data = new Float32Array(texts.length * 3);
      texts.forEach((t, row) => {
        for (let i = 0; i < 3; i += 1) data[row * 3 + i] = t.charCodeAt(0) + i;
      });
      return { data, dims: [texts.length, 3] };
    };
  },
  async getRerankPipeline() {
    return async () => [];
  },
  __resetPipelinesForTests() {},
}));

const AUTH = { Authorization: "Bearer test-secret-token-12345" };

beforeEach(() => {
  calls.length = 0;
  process.env.EMBEDDINGS_TOKEN = "test-secret-token-12345";
  delete process.env.EMBED_DTYPE;
  delete process.env.EMBED_FORWARD_BATCH;
});

afterEach(() => {
  delete process.env.EMBEDDINGS_TOKEN;
  delete process.env.EMBED_DTYPE;
  delete process.env.EMBED_FORWARD_BATCH;
});

async function embed(texts: string[]) {
  const { createApp } = await import("../src/app.js");
  return invoke(createApp(), {
    method: "POST",
    url: "/embed",
    headers: AUTH,
    json: { texts },
  });
}

/** The handler always answers `/embed` with a JSON object; narrow it once, here. */
function payload(res: { body: unknown }): {
  vectors: number[][];
  dimension: number;
  dtype: string;
} {
  return res.body as { vectors: number[][]; dimension: number; dtype: string };
}

describe("#807 — /embed forward-batch invariance", () => {
  it("splits a q8 request into ONE forward pass per text (the shipped default)", async () => {
    const res = await embed(["alpha", "bravo", "charlie"]);

    expect(res.status).toBe(200);
    // THE assertion: no two texts ever share a quantization scale.
    expect(calls).toEqual([["alpha"], ["bravo"], ["charlie"]]);
    expect(payload(res).vectors).toHaveLength(3);
    expect(payload(res).dtype).toBe("q8");
  });

  it("returns vectors in the REQUEST's order after splitting the passes", async () => {
    const res = await embed(["a", "b", "c"]);

    expect(res.status).toBe(200);
    expect(payload(res).vectors[0][0]).toBe("a".charCodeAt(0));
    expect(payload(res).vectors[1][0]).toBe("b".charCodeAt(0));
    expect(payload(res).vectors[2][0]).toBe("c".charCodeAt(0));
    expect(payload(res).dimension).toBe(3);
  });

  it("gives a text the same vector whatever else the caller batched with it", async () => {
    const alone = await embed(["target"]);
    const crowded = await embed(["some other text entirely", "target", "x"]);

    expect(payload(crowded).vectors[1]).toEqual(payload(alone).vectors[0]);
  });

  it("keeps ONE forward pass for the whole batch at fp32 — batching there is exact", async () => {
    process.env.EMBED_DTYPE = "fp32";

    const res = await embed(["alpha", "bravo", "charlie"]);

    expect(res.status).toBe(200);
    expect(calls).toEqual([["alpha", "bravo", "charlie"]]);
    expect(payload(res).dtype).toBe("fp32");
  });

  it("honours an explicit EMBED_FORWARD_BATCH on fp32 (a memory control)", async () => {
    process.env.EMBED_DTYPE = "fp32";
    process.env.EMBED_FORWARD_BATCH = "2";

    const res = await embed(["a", "b", "c"]);

    expect(res.status).toBe(200);
    expect(calls).toEqual([["a", "b"], ["c"]]);
  });

  it("REFUSES to let EMBED_FORWARD_BATCH re-batch a quantized forward pass", async () => {
    // The anti-footgun: raising the cap on q8 would silently restore #807's
    // batch-dependent vectors. The cap is lower-only, so this is ignored.
    process.env.EMBED_FORWARD_BATCH = "64";

    const res = await embed(["alpha", "bravo"]);

    expect(res.status).toBe(200);
    expect(calls).toEqual([["alpha"], ["bravo"]]);
  });

  it("refuses to boot on a malformed EMBED_FORWARD_BATCH rather than 500ing per request", async () => {
    process.env.EMBED_FORWARD_BATCH = "lots";
    const { createApp } = await import("../src/app.js");

    expect(() => createApp()).toThrow(/EMBED_FORWARD_BATCH/);
  });
});
