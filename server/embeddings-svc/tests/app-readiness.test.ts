/**
 * Issue #786 — the HTTP surface of warm-at-boot readiness + the /embed batch cap.
 *
 * Two probe-shaped guarantees are asserted here, because the chart depends on
 * both and a regression in either is silent:
 *
 *   1. `/readyz` is 503 until the ONNX session is warm, and 503 FOREVER if it
 *      failed to load. That is what keeps a broken pod out of the Service's
 *      endpoints and stalls the rollout.
 *   2. `/healthz` is 200 throughout — including while the model is still loading
 *      AND after a permanent load failure. `livenessProbe` points here, so a 503
 *      would have kubelet kill a pod whose only problem is that it is honest.
 *
 * Issue #689 — every request here goes through `invoke()` (tests/helpers/invoke-app.ts),
 * never `supertest`. supertest calls `app.listen(0)`, which binds the WILDCARD (`:::P`),
 * then dials `127.0.0.1:P`. On macOS (SO_REUSEADDR, which Node sets) another process can
 * bind the more specific `127.0.0.1:P` on top of that listener, and the kernel routes the
 * dial to it. The mechanism was reproduced synthetically (a foreign 401 server bound that
 * way answered our `GET /readyz` with 401, which `/readyz` cannot return because it carries
 * no auth), so it is the inferred cause of the "401 instead of 503" flake; the process that
 * took the port in the wild was never identified, and the fix does not depend on which it
 * was. The 20 s timeout was the same dependency on loopback sockets
 * and ports while the monorepo fan-out contends for them (#1379). In process, there is
 * no port to steal and nothing to time out on. The `listen` spy below keeps it that way.
 */
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReadinessForTests, beginWarmup } from "../src/readiness.js";
import { send, type Reply } from "./helpers/invoke-app.js";
import { createListenGuard } from "./helpers/listen-guard.js";
import { MAX_EMBED_TEXT_CHARS, MAX_EMBED_TEXTS_PER_REQUEST } from "../src/model-config.js";

const TOKEN = "test-secret-token-12345";
const ORIGINAL_TOKEN = process.env.EMBEDDINGS_TOKEN;

vi.mock("../src/pipelines.js", () => ({
  async getEmbedPipeline(_model: string) {
    return async (texts: string[]) => ({
      data: new Float32Array(texts.flatMap((t) => [t.length, t.length + 1, t.length + 2])),
      dims: [texts.length, 3],
    });
  },
  async getRerankPipeline() {
    return async () => [];
  },
  __resetPipelinesForTests() {},
}));

// Issue #689 — no test in this file may open a TCP listener. See the header.
const listenGuard = createListenGuard("#689");

beforeEach(() => {
  process.env.EMBEDDINGS_TOKEN = TOKEN;
  __resetReadinessForTests();
  listenGuard.arm();
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

/** An unauthenticated GET — what kubelet's probes send. In process, no socket (#689). */
function get(app: Express, url: string): Promise<Reply> {
  return send(app, "GET", url);
}

/** An authenticated POST /embed. In process, no socket (#689). */
function embed(app: Express, json: unknown): Promise<Reply> {
  return send(app, "POST", "/embed", json, { authorization: `Bearer ${TOKEN}` });
}

describe("GET /readyz — warm-at-boot readiness (#786)", () => {
  it("503s while the model is still warming", async () => {
    const app = await loadApp();
    beginWarmup(() => new Promise(() => {})); // never resolves — still loading

    const res = await get(app, "/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("warming");
    expect(res.body.model).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(res.body.pooling).toBe("cls");
    expect(res.body.dtype).toBe("q8");
  });

  it("503s before warm-up has even been kicked off", async () => {
    const app = await loadApp();
    const res = await get(app, "/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("warming");
  });

  it("200s once the ONNX session is warm", async () => {
    const app = await loadApp();
    await beginWarmup(async () => ({}));

    const res = await get(app, "/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.durationMs).toBeTypeOf("number");
  });

  it("503s when the model could not be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await loadApp();
    await beginWarmup(async () => {
      throw new Error("Could not locate file: onnx/model_quantized.onnx");
    });

    const res = await get(app, "/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.error).toBeTypeOf("string");
  });

  // OWASP A01/A09. /readyz is unauthenticated by design (kubelet carries no
  // bearer token), so its body is readable by anything that can reach the pod
  // network — a strictly larger set than "kubelet". A raw transformers.js /
  // onnxruntime failure routinely names filesystem paths, cache dirs and the
  // resolved HF endpoint, so the wire gets a stable generic reason and the
  // detail goes to the logs, where the operator has to look anyway.
  it("does NOT leak the raw loader exception to an unauthenticated caller", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await loadApp();
    await beginWarmup(async () => {
      throw new Error("Could not locate file: /home/node/.cache/hf/onnx/model_quantized.onnx");
    });

    const res = await get(app, "/readyz"); // no Authorization header
    expect(res.status).toBe(503);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("/home/node/.cache");
    expect(body).not.toContain("model_quantized.onnx");
    expect(res.body.error).toBe("model failed to load — see the pod logs for the underlying error");
    // ...but the operator can still get at the real thing.
    expect(logged).toHaveBeenCalled();
  });

  it("needs no bearer token — kubelet does not carry one", async () => {
    const app = await loadApp();
    await beginWarmup(async () => ({}));
    const res = await get(app, "/readyz"); // no Authorization header
    expect(res.status).toBe(200);
  });
});

describe("GET /healthz — liveness stays 200 (#786)", () => {
  it("200s while the model is still warming", async () => {
    const app = await loadApp();
    beginWarmup(() => new Promise(() => {}));

    const res = await get(app, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
  });

  it("200s even after a PERMANENT load failure — liveness must not crash-loop the pod", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await loadApp();
    await beginWarmup(async () => {
      throw new Error("weights missing");
    });

    const res = await get(app, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
  });

  it("reports ready=true once warm", async () => {
    const app = await loadApp();
    await beginWarmup(async () => ({}));
    const res = await get(app, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
  });
});

describe("POST /embed — batch cap of 64 (#786)", () => {
  const texts = (n: number) => Array.from({ length: n }, (_, i) => `text ${i}`);

  it("caps the request at 64 texts", () => {
    expect(MAX_EMBED_TEXTS_PER_REQUEST).toBe(64);
  });

  it("accepts exactly 64 texts", async () => {
    const app = await loadApp();
    const res = await embed(app, { texts: texts(64) });
    expect(res.status).toBe(200);
    expect(res.body.vectors).toHaveLength(64);
  });

  it("rejects 65 texts with 400 and a message that says what to do", async () => {
    const app = await loadApp();
    const res = await embed(app, { texts: texts(65) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(JSON.stringify(res.body.details)).toContain("at most 64");
  });

  it("rejects the OLD 256 limit — the whole point of the cap", async () => {
    const app = await loadApp();
    const res = await embed(app, { texts: texts(256) });
    expect(res.status).toBe(400);
  });

  it("does not silently truncate an oversized batch", async () => {
    const app = await loadApp();
    const res = await embed(app, { texts: texts(100) });
    // A 200 with 64 vectors for 100 texts would mis-align every downstream chunk.
    expect(res.status).toBe(400);
    expect(res.body.vectors).toBeUndefined();
  });

  // The count cap alone is a bound on CARDINALITY, not on WORK: 64 × an
  // arbitrarily long string clears it. Bound each entry too (OWASP A05).
  it("rejects a single text longer than the per-entry cap", async () => {
    const app = await loadApp();
    const res = await embed(app, { texts: ["x".repeat(MAX_EMBED_TEXT_CHARS + 1)] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    expect(JSON.stringify(res.body.details)).toContain("text too long");
  });

  it("accepts a text at exactly the per-entry cap", async () => {
    const app = await loadApp();
    const res = await embed(app, { texts: ["x".repeat(MAX_EMBED_TEXT_CHARS)] });
    expect(res.status).toBe(200);
    expect(res.body.vectors).toHaveLength(1);
  });

  it("bounds a within-count batch of oversized texts — the memory bound is not count-only", async () => {
    const app = await loadApp();
    // 64 texts: legal by count, but each one far past the per-entry cap. Before
    // the per-string cap this was a 200 and ~6 MB of tokenizer work.
    const res = await embed(app, { texts: Array.from({ length: 64 }, () => "x".repeat(100_000)) });
    expect(res.status).toBe(400);
    expect(res.body.vectors).toBeUndefined();
  });
});
