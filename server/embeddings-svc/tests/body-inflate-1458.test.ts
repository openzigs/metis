/**
 * #1458 — body-parser GHSA-27r3-jxmh-p828 in the embeddings sidecar: its global
 * `express.json()` runs AHEAD of the per-route token check, so a compressed body must be
 * refused (415) before any zlib stream exists, with or without a token. Plain JSON — what
 * the server's embeddings client sends — still works.
 *
 * In process through `invoke()`, never supertest (#692).
 */
import zlib from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoke, send } from "./helpers/invoke-app.js";
import { createListenGuard } from "./helpers/listen-guard.js";

const embedCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/pipelines.js", () => ({
  async getEmbedPipeline(_model: string) {
    return async (texts: string[]) => {
      embedCalls.count += 1;
      const flat: number[] = [];
      for (const t of texts) flat.push(t.length, t.length + 1, t.length + 2);
      return { data: new Float32Array(flat), dims: [texts.length, 3] };
    };
  },
  async getRerankPipeline(_model: string) {
    return async (pairs: { text: string; text_pair: string }[]) =>
      pairs.map((p) => ({ score: p.text_pair.length / 100 }));
  },
  __resetPipelinesForTests() {},
}));

const TOKEN = "test-secret-token-1458";
const ORIGINAL_TOKEN = process.env.EMBEDDINGS_TOKEN;
const listenGuard = createListenGuard("#692");

beforeEach(() => {
  listenGuard.arm();
  embedCalls.count = 0;
  process.env.EMBEDDINGS_TOKEN = TOKEN;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.EMBEDDINGS_TOKEN;
  else process.env.EMBEDDINGS_TOKEN = ORIGINAL_TOKEN;
  vi.restoreAllMocks();
  listenGuard.check();
});

async function loadApp() {
  const { createApp } = await import("../src/app.js");
  return createApp();
}

const BODY = Buffer.from(JSON.stringify({ texts: ["hi"] }));
const ENCODINGS: Array<[string, (b: Buffer) => Buffer]> = [
  ["gzip", (b) => zlib.gzipSync(b)],
  ["deflate", (b) => zlib.deflateSync(b)],
  ["br", (b) => zlib.brotliCompressSync(b)],
];

describe("embeddings-svc refuses compressed request bodies (#1458)", () => {
  for (const [encoding, compress] of ENCODINGS) {
    it(`refuses a ${encoding} /embed body with 415 and never inflates or embeds`, async () => {
      const inflaters = [
        vi.spyOn(zlib, "createGunzip"),
        vi.spyOn(zlib, "createInflate"),
        vi.spyOn(zlib, "createBrotliDecompress"),
      ];
      const app = await loadApp();
      const res = await invoke(app, {
        method: "POST",
        url: "/embed",
        raw: compress(BODY),
        headers: {
          "content-type": "application/json",
          "content-encoding": encoding,
          authorization: `Bearer ${TOKEN}`,
        },
      });
      expect(res.status).toBe(415);
      expect(embedCalls.count).toBe(0);
      for (const spy of inflaters) expect(spy).not.toHaveBeenCalled();
    });
  }

  it("refuses a gzip body with trailing bytes (the advisory's shape) before the token check", async () => {
    const app = await loadApp();
    const res = await invoke(app, {
      method: "POST",
      url: "/rerank",
      raw: Buffer.concat([zlib.gzipSync(BODY), Buffer.alloc(4096, 0x41)]),
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    // No token at all: the parser refuses first, so the vulnerable path is not
    // reachable pre-auth either.
    expect(res.status).toBe(415);
  });

  it("still embeds a plain JSON body, the shape the server's embeddings client sends", async () => {
    const app = await loadApp();
    const res = await send(
      app,
      "POST",
      "/embed",
      { texts: ["hi"] },
      {
        authorization: `Bearer ${TOKEN}`,
      },
    );
    expect(res.status).toBe(200);
    expect(embedCalls.count).toBe(1);
  });

  it("accepts an explicit identity encoding", async () => {
    const app = await loadApp();
    const res = await invoke(app, {
      method: "POST",
      url: "/embed",
      raw: BODY,
      headers: {
        "content-type": "application/json",
        "content-encoding": "identity",
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
  });
});
