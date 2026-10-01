/**
 * Auth + contract tests for the embeddings sidecar HTTP surface.
 *
 * We never actually load the heavy `@huggingface/transformers` runtime here —
 * the pipelines module is mocked so tests exercise routing, validation,
 * and auth without paying the model-download cost.
 *
 * Issue #692 — every request here goes through `invoke()` (tests/helpers/invoke-app.ts),
 * never `supertest`. supertest calls `app.listen(0)`, a WILDCARD bind, then dials
 * `127.0.0.1:<port>`; on macOS another process can bind the more specific
 * `127.0.0.1:<port>` and receive the request instead (the #689 flake mechanism). In
 * process there is no port to steal. The `listen` spy below keeps it that way.
 */
import { Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { invoke } from "./helpers/invoke-app.js";

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

// Issue #692 — no test in this file may open a TCP listener. See the header.
let listen: MockInstance<Server["listen"]>;

beforeEach(() => {
  listen = vi.spyOn(Server.prototype, "listen");
  process.env.EMBEDDINGS_TOKEN = "test-secret-token-12345";
});

afterEach(() => {
  // Capture, restore, THEN assert: a throwing assertion before the restore would
  // leave the spy (and its call count) in place and fail every later test too.
  const listenCalls = listen.mock.calls.length;
  listen.mockRestore();
  if (ORIGINAL_TOKEN === undefined) delete process.env.EMBEDDINGS_TOKEN;
  else process.env.EMBEDDINGS_TOKEN = ORIGINAL_TOKEN;
  vi.restoreAllMocks();
  expect(listenCalls, "a test bound a TCP port — use invoke(), not supertest (#692)").toBe(0);
});

async function loadApp() {
  const { createApp } = await import("../src/app.js");
  return createApp();
}

type App = Awaited<ReturnType<typeof loadApp>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are asserted field by field
type Reply = { status: number; body: Record<string, any> };

/** One request, in process — no socket, no port (#692). */
async function send(
  app: App,
  method: string,
  url: string,
  json?: unknown,
  headers?: Record<string, string>,
): Promise<Reply> {
  const res = await invoke(app, { method, url, json, headers });
  return { status: res.status, body: (res.body ?? {}) as Reply["body"] };
}

describe("embeddings sidecar HTTP surface", () => {
  it("exposes /healthz without auth", async () => {
    const app = await loadApp();
    const res = await send(app, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.tokenConfigured).toBe(true);
  });

  it("rejects /embed without bearer token", async () => {
    const app = await loadApp();
    const res = await send(app, "POST", "/embed", { texts: ["hi"] });
    expect(res.status).toBe(401);
  });

  it("rejects /embed with wrong token", async () => {
    const app = await loadApp();
    const res = await send(
      app,
      "POST",
      "/embed",
      { texts: ["hi"] },
      { authorization: "Bearer not-the-right-token" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when EMBEDDINGS_TOKEN is unset (fail-closed)", async () => {
    delete process.env.EMBEDDINGS_TOKEN;
    const app = await loadApp();
    const res = await send(
      app,
      "POST",
      "/embed",
      { texts: ["hi"] },
      { authorization: "Bearer anything" },
    );
    expect(res.status).toBe(503);
  });

  it("validates request body shape on /embed", async () => {
    const app = await loadApp();
    const res = await send(
      app,
      "POST",
      "/embed",
      { texts: [] },
      { authorization: "Bearer test-secret-token-12345" },
    );
    expect(res.status).toBe(400);
  });

  it("returns vectors with correct shape on /embed", async () => {
    const app = await loadApp();
    const res = await send(
      app,
      "POST",
      "/embed",
      { texts: ["abc", "wxyz"] },
      { authorization: "Bearer test-secret-token-12345" },
    );
    expect(res.status).toBe(200);
    expect(res.body.vectors).toHaveLength(2);
    expect(res.body.vectors[0]).toEqual([3, 4, 5]);
    expect(res.body.vectors[1]).toEqual([4, 5, 6]);
    expect(res.body.dimension).toBe(3);
    expect(res.body.model).toBe("Alibaba-NLP/gte-modernbert-base");
  });

  it("validates request body shape on /rerank", async () => {
    const app = await loadApp();
    const res = await send(
      app,
      "POST",
      "/rerank",
      { query: "", candidates: [] },
      { authorization: "Bearer test-secret-token-12345" },
    );
    expect(res.status).toBe(400);
  });

  it("returns scores on /rerank", async () => {
    const app = await loadApp();
    const res = await send(
      app,
      "POST",
      "/rerank",
      {
        query: "what is metis",
        candidates: [
          { chunkId: "a", text: "metis is a project" },
          { chunkId: "b", text: "another candidate" },
        ],
      },
      { authorization: "Bearer test-secret-token-12345" },
    );
    expect(res.status).toBe(200);
    expect(res.body.scores).toHaveLength(2);
    expect(res.body.scores.every((s: number) => typeof s === "number")).toBe(true);
  });

  it("returns 404 for unknown routes", async () => {
    const app = await loadApp();
    const res = await send(app, "GET", "/unknown");
    expect(res.status).toBe(404);
  });
});
