/**
 * Issue #782 — `/embed` pooling contract.
 *
 * The pre-#782 handler hardcoded `pooling: "mean"`, which silently degrades any
 * CLS model (gte-modernbert, Granite). These tests capture the options actually
 * handed to the runtime pipeline, so a reintroduced hardcode fails CI.
 *
 * The runtime itself is mocked — pooling MATH is proved against real weights in
 * `pooling.integration.test.ts` (download-gated).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

interface PipeCall {
  model: string;
  dtype: string | undefined;
  texts: string[];
  opts: { pooling: string; normalize: boolean };
}

const calls: PipeCall[] = [];

vi.mock("../src/pipelines.js", () => ({
  async getEmbedPipeline(model: string, dtype?: string) {
    return async (texts: string[], opts: { pooling: string; normalize: boolean }) => {
      calls.push({ model, dtype, texts, opts });
      return { data: new Float32Array([1, 2, 3]), dims: [texts.length, 3] };
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
  delete process.env.EMBED_POOLING;
  delete process.env.EMBED_POOLING_MAP;
  delete process.env.EMBED_DTYPE;
});

afterEach(() => {
  delete process.env.EMBEDDINGS_TOKEN;
  delete process.env.EMBED_POOLING;
  delete process.env.EMBED_POOLING_MAP;
  delete process.env.EMBED_DTYPE;
});

async function loadApp() {
  const { createApp } = await import("../src/app.js");
  return createApp();
}

describe("POST /embed pooling", () => {
  it("CLS-pools the default model with a default config (#783 — the measured arm)", async () => {
    // The whole #783 flip, seen from the sidecar's wire: an /embed call carrying
    // NOTHING but text must reach the pipeline as gte-modernbert + cls + q8. The
    // same call with `mean` would return a well-formed, unit-norm, USELESS vector
    // (#788 arm C: 0.254 nDCG@10 — level with the model this replaced) and no
    // status code, log line or metric anywhere would say so.
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set(AUTH)
      .send({ texts: ["hello"] });

    expect(res.status).toBe(200);
    expect(calls[0].model).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(calls[0].opts).toEqual({ pooling: "cls", normalize: true });
    expect(calls[0].dtype).toBe("q8");
    expect(res.body.pooling).toBe("cls");
    expect(res.body.dtype).toBe("q8");
  });

  it("CLS-pools a CLS model BY DEFAULT (regression guard against the old hardcode)", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set(AUTH)
      .send({ texts: ["throttle failed logins"], model: "Alibaba-NLP/gte-modernbert-base" });

    expect(res.status).toBe(200);
    expect(calls[0].opts.pooling).toBe("cls");
    expect(res.body.pooling).toBe("cls");
  });

  it("CLS-pools Granite by default too", async () => {
    const app = await loadApp();
    await request(app)
      .post("/embed")
      .set(AUTH)
      .send({ texts: ["x"], model: "onnx-community/granite-embedding-small-english-r2-ONNX" });

    expect(calls[0].opts.pooling).toBe("cls");
  });

  it("honours an explicit pooling field over the per-model map", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set(AUTH)
      .send({ texts: ["x"], model: "Alibaba-NLP/gte-modernbert-base", pooling: "mean" });

    expect(res.status).toBe(200);
    expect(calls[0].opts.pooling).toBe("mean");
  });

  it("honours EMBED_POOLING_MAP for a model the built-in map does not know", async () => {
    process.env.EMBED_POOLING_MAP = "acme/custom-embedder=cls";
    const app = await loadApp();
    await request(app)
      .post("/embed")
      .set(AUTH)
      .send({ texts: ["x"], model: "acme/custom-embedder" });

    expect(calls[0].opts.pooling).toBe("cls");
  });

  it("rejects an unknown pooling value with 400 (never silently mean-pools)", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set(AUTH)
      .send({ texts: ["x"], pooling: "max" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(calls).toHaveLength(0);
  });

  it("passes the configured EMBED_DTYPE through to the pipeline", async () => {
    process.env.EMBED_DTYPE = "fp32";
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set(AUTH)
      .send({ texts: ["x"] });

    expect(calls[0].dtype).toBe("fp32");
    expect(res.body.dtype).toBe("fp32");
  });
});

/**
 * Boot-time env validation.
 *
 * A bad EMBED_* value used to surface as a 500 on every embed call, from a pod
 * that had already passed /healthz and been handed traffic. It must instead kill
 * the process at construction: a crashloop is caught by the deploy, a
 * green-then-500ing pod is caught by a user.
 */
describe("createApp() env validation (crashloop, not per-request 500)", () => {
  it.each([
    ["EMBED_POOLING_MAP", "acme/model=clss", /Invalid EMBED_POOLING_MAP entry/],
    ["EMBED_POOLING", "clss", /Invalid EMBED_POOLING/],
    ["EMBED_DTYPE", "int4", /Invalid EMBED_DTYPE/],
  ])("refuses to construct the app when %s is malformed", async (key, value, expected) => {
    process.env[key] = value;
    await expect(loadApp()).rejects.toThrow(expected);
  });

  it("constructs normally with a valid EMBED_POOLING_MAP", async () => {
    process.env.EMBED_POOLING_MAP = "acme/custom-embedder=cls";
    await expect(loadApp()).resolves.toBeDefined();
  });

  it("still returns a 400 (not a crash) for a bad `pooling` FIELD on the request", async () => {
    // Boot validation must not swallow request-level validation: the pooling
    // field is untrusted input and stays a genuine 400.
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set(AUTH)
      .send({ texts: ["x"], pooling: "clss" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(calls).toHaveLength(0);
  });
});
