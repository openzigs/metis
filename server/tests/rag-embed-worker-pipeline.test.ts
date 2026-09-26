/**
 * Issue #189 — in-process embedding must never run on the main event loop.
 *
 * `fixtures/busy-transformers.mjs` stands in for transformers.js: its pipeline
 * blocks its thread per text, exactly as `onnxruntime-node`'s synchronous
 * `InferenceSession.run` does. The worker loads it by URL; the inline control loads
 * it through the module mock below — the same code on both sides of the boundary.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@huggingface/transformers", () => import("./fixtures/busy-transformers.mjs"));

import { BUSY_MS_PER_TEXT, LONG_ROW_MS } from "./fixtures/busy-transformers.mjs";
import { probeHealthzDuring } from "./helpers/healthz-prober.js";
import {
  createWorkerPipeline,
  resolveInProcessRuntime,
  resolveTransformersModuleUrl,
} from "../src/lib/rag/embed-worker-pipeline.js";
import {
  EMBED_WORKER_MAX_TEXTS_PER_CALL,
  Embedder,
  MAX_EMBED_SEQUENCE_TOKENS,
  XenovaEmbedder,
  capTokenizerSequenceLength,
  resolveXenovaEnvSettings,
} from "../src/lib/rag/embedder.js";

const FIXTURE_URL = new URL("./fixtures/busy-transformers.mjs", import.meta.url).href;
const ENV_KEYS = ["HF_HUB_OFFLINE", "TRANSFORMERS_CACHE", "HF_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = {};
const embedders: XenovaEmbedder[] = [];
const servers: Server[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(embedders.splice(0).map((embedder) => embedder.close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function busyEmbedder(
  runtime: "worker" | "inline",
  opts: { model?: string; dtype?: "q8" | "fp32" } = {},
): XenovaEmbedder {
  const embedder = new XenovaEmbedder(opts.model ?? "acme/busy-model", 4, {
    pooling: "cls",
    dtype: opts.dtype ?? "q8",
    runtime,
    workerModuleUrl: FIXTURE_URL,
  });
  embedders.push(embedder);
  return embedder;
}

async function healthServer(): Promise<string> {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 404).end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`;
}

async function worstHealthzLatency(url: string, work: () => Promise<unknown>): Promise<number> {
  const report = await probeHealthzDuring(url, work);
  expect(report.failures).toBe(0);
  expect(report.probes).toBeGreaterThan(1);
  return report.worst;
}

const texts = Array.from({ length: 40 }, (_, i) => `chunk number ${i}`);
/** A document with one over-long row: one blocking model call of LONG_ROW_MS. */
const documentTexts = [...texts.slice(0, 10), "__long__ row", ...texts.slice(10, 20)];

describe("#189 — /healthz stays responsive while a document is embedded", () => {
  it("the worker runtime answers /healthz within 1 s while the model blocks its thread", async () => {
    expect(LONG_ROW_MS + 20 * BUSY_MS_PER_TEXT).toBeGreaterThan(1000);
    const url = await healthServer();
    const embedder = busyEmbedder("worker");
    await embedder.warm();
    let vectors: number[][] = [];
    const worst = await worstHealthzLatency(url, async () => {
      vectors = (await embedder.embed(documentTexts)).vectors;
    });
    expect(vectors).toHaveLength(documentTexts.length);
    expect(worst).toBeLessThan(1000);
  });

  it("CONTROL: the same pipeline run inline blocks /healthz for the whole embed", async () => {
    const url = await healthServer();
    const embedder = busyEmbedder("inline");
    await embedder.warm();
    const worst = await worstHealthzLatency(url, () => embedder.embed(documentTexts));
    // If this ever passes quickly, the responsiveness test above proves nothing.
    expect(worst).toBeGreaterThan(1000);
  });
});

describe("XenovaEmbedder worker runtime", () => {
  it("returns the inline runtime's vectors, in order", async () => {
    const sample = ["alpha", "bravo", "charlie"];
    const inline = await busyEmbedder("inline").embed(sample);
    const worker = await busyEmbedder("worker").embed(sample);
    expect(worker.vectors).toEqual(inline.vectors);
    expect(worker).toMatchObject({ model: "acme/busy-model", dimension: 4 });
    expect(worker.identity).toBe(inline.identity);
  });

  it("caps the tokenizer at MAX_EMBED_SEQUENCE_TOKENS inside the worker", async () => {
    const [vector] = (await busyEmbedder("worker").embed(["x"])).vectors;
    // The fixture tokenizer ships 8,192; the worker must have lowered it.
    expect(vector[1]).toBe(MAX_EMBED_SEQUENCE_TOKENS);
  });

  it("applies the server's resolved transformers env in the worker's own instance", async () => {
    process.env.HF_HUB_OFFLINE = "1";
    const [vector] = (await busyEmbedder("worker").embed(["x"])).vectors;
    expect(vector[2]).toBe(1);
  });

  it("bounds every model call, including an fp32 batch the #807 policy leaves whole", async () => {
    const q8 = (await busyEmbedder("worker").embed(texts.slice(0, 5))).vectors;
    expect(q8.map((v) => v[3])).toEqual([1, 1, 1, 1, 1]);
    const fp32 = (await busyEmbedder("worker", { dtype: "fp32" }).embed(texts)).vectors;
    expect(Math.max(...fp32.map((v) => v[3]))).toBe(EMBED_WORKER_MAX_TEXTS_PER_CALL);
    const inlineFp32 = (await busyEmbedder("inline", { dtype: "fp32" }).embed(texts)).vectors;
    expect(inlineFp32[0][3]).toBe(texts.length);
  });

  it("surfaces a load failure through warm(), wrapped when offline", async () => {
    await expect(busyEmbedder("worker", { model: "acme/fail-load" }).warm()).rejects.toThrow(
      "cannot load acme/fail-load",
    );
    process.env.HF_HUB_OFFLINE = "1";
    await expect(busyEmbedder("worker", { model: "acme/fail-load-2" }).warm()).rejects.toThrow(
      /Offline embeddings model "acme\/fail-load-2" was not found.*cannot load/s,
    );
    await expect(busyEmbedder("worker", { model: "acme/fail-load-3" }).healthy()).resolves.toBe(
      false,
    );
  });

  it("surfaces a run failure and keeps serving afterwards", async () => {
    const embedder = busyEmbedder("worker");
    await expect(embedder.embed(["ok", "__explode__"])).rejects.toThrow("busy pipeline exploded");
    await expect(embedder.embed(["ok"])).resolves.toMatchObject({
      vectors: [[2, MAX_EMBED_SEQUENCE_TOKENS, 0, 1]],
    });
  });

  it("survives the worker thread dying mid-embed: the call rejects, the next one respawns", async () => {
    const embedder = busyEmbedder("worker");
    await expect(embedder.embed(["__crash__"])).rejects.toThrow(/embed worker exited \(code 3\)/);
    await expect(embedder.embed(["after"])).resolves.toMatchObject({
      vectors: [[5, MAX_EMBED_SEQUENCE_TOKENS, 0, 1]],
    });
  });

  it("rejects in-flight work when the worker is stopped, then loads a fresh one", async () => {
    const embedder = busyEmbedder("worker");
    await embedder.warm();
    const inflight = embedder.embed(texts);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await embedder.close();
    await expect(inflight).rejects.toThrow();
    await expect(embedder.embed(["again"])).resolves.toMatchObject({
      vectors: [[5, MAX_EMBED_SEQUENCE_TOKENS, 0, 1]],
    });
  });
});

describe("createWorkerPipeline", () => {
  it("restarts the worker on the next call after it dies", async () => {
    const pipeline = await createWorkerPipeline({
      model: "acme/busy-model",
      dtype: "q8",
      maxTokens: 512,
      transformersEnv: {},
      moduleUrl: FIXTURE_URL,
    });
    try {
      expect(pipeline.maxTokens).toBe(512);
      expect(pipeline.model.config).toEqual({ model_type: "busy", dtype: "q8" });
      const inflight = pipeline(["a", "b", "c"], { pooling: "cls", normalize: true });
      await pipeline.close();
      await expect(inflight).rejects.toThrow(/embed worker exited/);
      const next = await pipeline("abcd", { pooling: "cls", normalize: true });
      expect(Array.from(next.data)).toEqual([4, 512, 0, 1]);
      expect(next.dims).toEqual([1, 4]);
    } finally {
      await pipeline.close();
    }
  });

  it("resolves the installed transformers.js to an absolute file URL", () => {
    expect(resolveTransformersModuleUrl()).toMatch(/^file:.*@huggingface.*transformers/);
    // The ESM resolver wins when the runtime has one; otherwise the require build.
    expect(resolveTransformersModuleUrl(() => "file:///esm/transformers.mjs")).toBe(
      "file:///esm/transformers.mjs",
    );
    const fallback = resolveTransformersModuleUrl(() => {
      throw new Error("no resolver");
    });
    expect(fallback).toMatch(/^file:.*transformers.*\.cjs$/);
  });

  it("unwraps a CommonJS module's default export in the worker", async () => {
    const cjsShaped = `data:text/javascript,${encodeURIComponent(
      `import * as busy from ${JSON.stringify(FIXTURE_URL)}; export default { ...busy };`,
    )}`;
    const pipeline = await createWorkerPipeline({
      model: "acme/busy-model",
      dtype: "q8",
      maxTokens: 256,
      transformersEnv: {},
      moduleUrl: cjsShaped,
    });
    try {
      const out = await pipeline(["abc"], { pooling: "cls", normalize: true });
      expect(Array.from(out.data)).toEqual([3, 256, 0, 1]);
    } finally {
      await pipeline.close();
    }
  });
});

describe("runtime + settings resolution", () => {
  it("defaults to the worker and accepts only worker|inline", () => {
    expect(resolveInProcessRuntime({})).toBe("worker");
    expect(resolveInProcessRuntime({ EMBED_INPROCESS_RUNTIME: " Inline " })).toBe("inline");
    expect(resolveInProcessRuntime({ EMBED_INPROCESS_RUNTIME: "worker" })).toBe("worker");
    expect(() => resolveInProcessRuntime({ EMBED_INPROCESS_RUNTIME: "thread" })).toThrow(
      /Invalid EMBED_INPROCESS_RUNTIME "thread"/,
    );
  });

  it("the Embedder façade builds the in-process backends in the requested runtime", () => {
    const backendOf = (embedder: Embedder) =>
      (embedder as unknown as { backend: XenovaEmbedder }).backend;
    expect(backendOf(new Embedder({ backend: "xenova", inProcessRuntime: "worker" })).runtime).toBe(
      "worker",
    );
    expect(
      backendOf(new Embedder({ backend: "embeddinggemma", inProcessRuntime: "worker" })).runtime,
    ).toBe("worker");
    expect(backendOf(new Embedder({ backend: "xenova", inProcessRuntime: "inline" })).runtime).toBe(
      "inline",
    );
  });

  it("resolves the transformers env once for both runtimes", () => {
    expect(resolveXenovaEnvSettings()).toEqual({});
    process.env.TRANSFORMERS_CACHE = "/models";
    process.env.HF_ENDPOINT = "https://mirror.example.test";
    expect(resolveXenovaEnvSettings()).toMatchObject({
      cacheDir: "/models",
      remoteHost: expect.stringContaining("mirror.example.test"),
    });
    process.env.HF_HUB_OFFLINE = "1";
    expect(resolveXenovaEnvSettings()).toEqual({
      cacheDir: "/models",
      allowRemoteModels: false,
      allowLocalModels: true,
    });
  });

  it("capTokenizerSequenceLength lowers, never raises, the truncation length", () => {
    const full = { tokenizer: { model_max_length: 8192 } };
    expect(capTokenizerSequenceLength(full)).toBe(2048);
    expect(full.tokenizer.model_max_length).toBe(2048);
    expect(capTokenizerSequenceLength({ tokenizer: { model_max_length: 512 } })).toBe(512);
    expect(capTokenizerSequenceLength({ tokenizer: {} }, 1024)).toBe(1024);
    expect(capTokenizerSequenceLength({})).toBeNull();
  });
});
