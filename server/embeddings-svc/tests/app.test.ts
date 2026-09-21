/**
 * Auth + contract tests for the embeddings sidecar HTTP surface.
 *
 * We never actually load the heavy `@huggingface/transformers` runtime here —
 * the pipelines module is mocked so tests exercise routing, validation,
 * and auth without paying the model-download cost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const ORIGINAL_TOKEN = process.env.EMBEDDINGS_TOKEN;

vi.mock("../src/pipelines.js", () => {
  return {
    async getEmbedPipeline(_model: string) {
      return async (texts: string[]) => {
        // Deterministic stub: each text → vector [length, length+1, length+2]
        const flat: number[] = [];
        for (const t of texts) {
          flat.push(t.length, t.length + 1, t.length + 2);
        }
        return {
          data: new Float32Array(flat),
          dims: [texts.length, 3],
        };
      };
    },
    async getRerankPipeline(_model: string) {
      return async (pairs: { text: string; text_pair: string }[]) =>
        pairs.map((p, i) => ({ score: p.text_pair.length / 100 + i * 0.001 }));
    },
    __resetPipelinesForTests() {},
  };
});

beforeEach(() => {
  process.env.EMBEDDINGS_TOKEN = "test-secret-token-12345";
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.EMBEDDINGS_TOKEN;
  else process.env.EMBEDDINGS_TOKEN = ORIGINAL_TOKEN;
  vi.restoreAllMocks();
});

async function loadApp() {
  const { createApp } = await import("../src/app.js");
  return createApp();
}

describe("embeddings sidecar HTTP surface", () => {
  it("exposes /healthz without auth", async () => {
    const app = await loadApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.tokenConfigured).toBe(true);
  });

  it("rejects /embed without bearer token", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .send({ texts: ["hi"] });
    expect(res.status).toBe(401);
  });

  it("rejects /embed with wrong token", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set("Authorization", "Bearer not-the-right-token")
      .send({ texts: ["hi"] });
    expect(res.status).toBe(401);
  });

  it("returns 503 when EMBEDDINGS_TOKEN is unset (fail-closed)", async () => {
    delete process.env.EMBEDDINGS_TOKEN;
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set("Authorization", "Bearer anything")
      .send({ texts: ["hi"] });
    expect(res.status).toBe(503);
  });

  it("validates request body shape on /embed", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set("Authorization", "Bearer test-secret-token-12345")
      .send({ texts: [] });
    expect(res.status).toBe(400);
  });

  it("returns vectors with correct shape on /embed", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/embed")
      .set("Authorization", "Bearer test-secret-token-12345")
      .send({ texts: ["abc", "wxyz"] });
    expect(res.status).toBe(200);
    expect(res.body.vectors).toHaveLength(2);
    expect(res.body.vectors[0]).toEqual([3, 4, 5]);
    expect(res.body.vectors[1]).toEqual([4, 5, 6]);
    expect(res.body.dimension).toBe(3);
    expect(res.body.model).toBe("Alibaba-NLP/gte-modernbert-base");
  });

  it("validates request body shape on /rerank", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/rerank")
      .set("Authorization", "Bearer test-secret-token-12345")
      .send({ query: "", candidates: [] });
    expect(res.status).toBe(400);
  });

  it("returns scores on /rerank", async () => {
    const app = await loadApp();
    const res = await request(app)
      .post("/rerank")
      .set("Authorization", "Bearer test-secret-token-12345")
      .send({
        query: "what is metis",
        candidates: [
          { chunkId: "a", text: "metis is a project" },
          { chunkId: "b", text: "another candidate" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.scores).toHaveLength(2);
    expect(res.body.scores.every((s: number) => typeof s === "number")).toBe(true);
  });

  it("returns 404 for unknown routes", async () => {
    const app = await loadApp();
    const res = await request(app).get("/unknown");
    expect(res.status).toBe(404);
  });
});
