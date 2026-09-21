/**
 * Embedder backend selection + the HASH FALLBACK (Phase 5 / issue #41 R-D1,
 * rewritten for issue #783).
 *
 * The behaviour under test changed sign in #783. It used to be: "when the real
 * backend cannot load, quietly swap in the hash stub and keep serving." That is
 * why retrieval in this deployment was noise for months — hash vectors are
 * unit-norm, finite, plausible numbers that no health check, no metric and no
 * type system objects to. The only trace was one `warn` line at boot.
 *
 * Now the fallback must be ASKED for. A backend that fails to load throws, and
 * the failure is recorded so `/readyz` and the admin panel can show it. These
 * tests pin BOTH directions: the loud failure, and the opt-in escape hatch —
 * including the detail that an opted-in fallback still reports itself as
 * NOT healthy, because it is not producing meaningful vectors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Env this suite mutates — snapshotted once, restored after every test. */
const MANAGED_ENV = [
  "AI_OFFLINE",
  "EMBED_ALLOW_HASH_FALLBACK",
  "EMBED_MODEL",
  "EMBED_BACKEND",
  "EMBEDDINGS_OPENAI_BASE_URL",
  "EMBEDDINGS_OPENAI_API_KEY",
  "BEDROCK_GATEWAY_URL",
  "BEDROCK_GATEWAY_API_KEY",
] as const;
const ORIGINAL_ENV = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));

/** Make `@huggingface/transformers` unloadable — the 401 / air-gap-miss shape. */
function breakTransformers(): void {
  vi.doMock("@huggingface/transformers", () => {
    throw new Error("simulated xenova load failure");
  });
}

/**
 * Stub the global transport with a 401 — a rotated/expired credential, which is
 * how a *working* cloud embeddings deployment actually starts failing. It has to
 * be a transport-level rejection, not a missing key: a missing key throws in the
 * backend CONSTRUCTOR, which never reaches `Embedder.load()` and so never
 * exercises the fallback branch at all (see the comment on the openai test).
 */
function unauthorizedFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetModules();
  for (const key of MANAGED_ENV) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of MANAGED_ENV) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Embedder backend selection", () => {
  it("uses the hash backend when AI_OFFLINE=1 (no @xenova load attempt)", async () => {
    process.env.AI_OFFLINE = "1";
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    const result = await embedder.embed(["hello"]);
    expect(result.model).toBe("metis-offline-hash-v1");
    expect(result.dimension).toBe(384);
    expect(embedder.fellBack).toBe(false);
  });

  it("forwards the configured model to the hash backend", async () => {
    process.env.AI_OFFLINE = "1";
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder({ backend: "offline", model: "custom-stub-v2" });
    expect(embedder.model).toBe("custom-stub-v2");
    const result = await embedder.embed(["x"]);
    expect(result.model).toBe("custom-stub-v2");
  });

  it("routes EMBED_MODEL=metis-offline-hash-v1 to the offline backend, not xenova", async () => {
    // The shipped-.env bug (#783): the hash stub's id was handed to the xenova
    // backend, which asked HuggingFace for a repo called `metis-offline-hash-v1`,
    // got a 401, and fell through to... the hash stub. Via the network. Silently.
    process.env.EMBED_MODEL = "metis-offline-hash-v1";
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    expect(embedder.key).toBe("offline");
    expect(embedder.dimension).toBe(384);
    // No transformers import is even attempted, so a broken/absent runtime is moot.
    const result = await embedder.embed(["hello"]);
    expect(result.model).toBe("metis-offline-hash-v1");
    expect(embedder.fellBack).toBe(false);
  });

  it("still fails loud on EMBED_BACKEND=xenova + EMBED_MODEL=metis-offline-hash-v1", async () => {
    // A contradiction, and the honest answer to a contradiction is an error —
    // NOT a backend silently chosen on the operator's behalf.
    process.env.EMBED_BACKEND = "xenova";
    process.env.EMBED_MODEL = "metis-offline-hash-v1";
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    expect(embedder.key).toBe("xenova");
    await expect(embedder.embed(["hello"])).rejects.toThrow(/failed to load/i);
  });
});

describe("hash fallback is opt-in (#783)", () => {
  it("FAILS LOUD when the xenova backend cannot load and the fallback is not enabled", async () => {
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();

    await expect(embedder.embed(["hello"])).rejects.toThrow(
      /REFUSING to embed[\s\S]*EMBED_ALLOW_HASH_FALLBACK=1/,
    );
    // The critical negative: NOTHING was embedded. A silent fallback would have
    // resolved this call with a hash vector and written it to the index.
    expect(embedder.fellBack).toBe(false);
    expect(embedder.lastError).toMatch(/Failed to import "@huggingface\/transformers"/);
  });

  it("keeps failing loud on every subsequent call, not just the first", async () => {
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    await expect(embedder.embed(["a"])).rejects.toThrow(/REFUSING to embed/);
    await expect(embedder.embed(["b"])).rejects.toThrow(/REFUSING to embed/);
    await expect(embedder.warm()).rejects.toThrow(/REFUSING to embed/);
  });

  it("reports status=error (and never ok) from health() when the backend cannot load", async () => {
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    const health = await embedder.health();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("error");
    expect(health.backend).toBe("xenova");
    expect(health.fellBack).toBe(false);
    expect(health.hashFallbackAllowed).toBe(false);
    expect(health.error).toMatch(/Failed to import "@huggingface\/transformers"/);
  });

  it("falls back to hash ONLY with EMBED_ALLOW_HASH_FALLBACK=1", async () => {
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    const result = await embedder.embed(["hello"]);
    expect(result.model).toBe("metis-offline-hash-v1");
    expect(embedder.fellBack).toBe(true);
  });

  it("an opted-in fallback emits hash-WIDTH vectors, never the real model's width", async () => {
    // The subtle corruption this guards: the fallback used to inherit the FAILED
    // backend's dimension, so after the #783 flip it would have written 768-dim
    // hash vectors tagged `metis-offline-hash-v1` — one model id spanning two
    // incompatible vector spaces, with nothing persisted to tell them apart.
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    const result = await embedder.embed(["hello"]);
    expect(result.dimension).toBe(384);
    expect(result.vectors[0]).toHaveLength(384);
    expect(embedder.dimension).toBe(384);
  });

  it("an active fallback reports DEGRADED and not-ok — no green tick over hash vectors", async () => {
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    await embedder.embed(["hello"]);

    const health = await embedder.health();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("degraded");
    expect(health.fellBack).toBe(true);
    expect(health.hashFallbackAllowed).toBe(true);
    // The panel must show the model ACTUALLY loaded, not the one configured.
    expect(health.backend).toBe("offline");
    expect(health.model).toBe("metis-offline-hash-v1");
    expect(health.dimension).toBe(384);
    expect(health.error).toMatch(/Failed to import "@huggingface\/transformers"/);
  });

  it("AI_OFFLINE=1 permits a fallback for an explicitly-configured backend", async () => {
    // AI_OFFLINE normally pins the `offline` backend outright, so this only bites
    // when a caller passes cfg.backend. Historical behaviour, kept deliberately.
    process.env.AI_OFFLINE = "1";
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder({ backend: "xenova" });
    const result = await embedder.embed(["hello"]);
    expect(result.model).toBe("metis-offline-hash-v1");
    expect(embedder.fellBack).toBe(true);
  });

  it("cloud (openai): a 401 at WARM time still fails loud WITH the fallback flag set", async () => {
    // EMBED_ALLOW_HASH_FALLBACK relaxes the LOCAL backends; it must never turn a
    // cloud deployment into a hash-vector generator.
    //
    // This test earns its keep by driving the failure from `warm()`, not from the
    // constructor. Its first draft simply deleted the API key — but then
    // `new OpenAiEmbedder` throws inside createBackend() and `Embedder.load()` is
    // never entered, so the fallback branch under test never runs and
    // `rejects.toThrow()` is satisfied by a construction error. The backend must
    // CONSTRUCT (plausible key) and then be rejected on the wire.
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    process.env.EMBEDDINGS_OPENAI_BASE_URL = "https://api.example.invalid/v1";
    process.env.EMBEDDINGS_OPENAI_API_KEY = "sk-rotated-yesterday";
    const fetchMock = unauthorizedFetch();

    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder({ backend: "openai" });
    expect(embedder.key).toBe("openai"); // constructed — we are past createBackend()

    await expect(embedder.embed(["hello"])).rejects.toThrow(/authentication failed \(401\)/);
    expect(fetchMock).toHaveBeenCalled(); // the failure came from the WIRE, i.e. from load()

    // The assertions with teeth. Without them, the throw above is satisfied by any
    // error at all — including the loud one raised *after* a hash swap would have
    // been refused. `key` tracks the LIVE backend, so it flips to "offline" the
    // moment a fallback happens.
    expect(embedder.fellBack).toBe(false);
    expect(embedder.key).toBe("openai");
    expect(embedder.dimension).not.toBe(384);
  });

  it("cloud (bedrock): a 401 at WARM time still fails loud WITH the fallback flag set", async () => {
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    process.env.BEDROCK_GATEWAY_URL = "https://bedrock.example.invalid";
    process.env.BEDROCK_GATEWAY_API_KEY = "expired-key";
    const fetchMock = unauthorizedFetch();

    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder({ backend: "bedrock" });

    await expect(embedder.embed(["hello"])).rejects.toThrow(/authentication failed \(401\)/);
    expect(fetchMock).toHaveBeenCalled();
    expect(embedder.fellBack).toBe(false);
    expect(embedder.key).toBe("bedrock");
  });

  it("a cloud failure reports ERROR — never a DEGRADED hash fallback — even with the flag on", async () => {
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    process.env.EMBEDDINGS_OPENAI_BASE_URL = "https://api.example.invalid/v1";
    process.env.EMBEDDINGS_OPENAI_API_KEY = "sk-rotated-yesterday";
    unauthorizedFetch();

    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const health = await new Embedder({ backend: "openai" }).health();

    expect(health.status).toBe("error");
    expect(health.ok).toBe(false);
    expect(health.fellBack).toBe(false);
    expect(health.backend).toBe("openai");
    expect(health.model).not.toBe("metis-offline-hash-v1");
    // The flag IS on, and the cloud backend still refused to degrade.
    expect(health.hashFallbackAllowed).toBe(true);
  });
});

describe("snapshot() — what /readyz reads (#783)", () => {
  it("is I/O-FREE: it never warms the backend, so a readiness probe cannot trigger a model load", async () => {
    // The reason snapshot() exists. `health()` warms — that is right for an admin
    // asking "is it working", and catastrophic for a kubelet probe, which would
    // start a 150 MB download (or hang on a wedged sidecar's 60s socket timeout)
    // on a readiness check.
    const pipeline = vi.fn();
    vi.doMock("@huggingface/transformers", () => ({ pipeline, env: {} }));
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();

    const state = embedder.snapshot();
    expect(pipeline).not.toHaveBeenCalled();
    expect(state.loaded).toBe(false);
    expect(state.status).toBe("ok"); // nothing known to be wrong — and it says "not warmed" downstream
    expect(state.backend).toBe("xenova");
    expect(state.model).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(state.dimension).toBe(768);
  });

  it("reports ERROR after a failed load — the state /readyz turns into a 503", async () => {
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    await expect(embedder.embed(["x"])).rejects.toThrow();

    const state = embedder.snapshot();
    expect(state.status).toBe("error");
    expect(state.ok).toBe(false);
    expect(state.fellBack).toBe(false);
    expect(state.error).toMatch(/Failed to import/);
  });

  it("reports DEGRADED while an opted-in hash fallback is serving", async () => {
    process.env.EMBED_ALLOW_HASH_FALLBACK = "1";
    breakTransformers();
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    await embedder.embed(["x"]);

    const state = embedder.snapshot();
    expect(state.status).toBe("degraded");
    expect(state.ok).toBe(false);
    expect(state.fellBack).toBe(true);
    expect(state.loaded).toBe(true);
    expect(state.model).toBe("metis-offline-hash-v1");
    expect(state.dimension).toBe(384);
  });

  it("reports OK once a real backend is loaded", async () => {
    process.env.AI_OFFLINE = "1"; // the stub, SELECTED — not fallen back to
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder();
    await embedder.embed(["x"]);

    const state = embedder.snapshot();
    expect(state).toMatchObject({
      ok: true,
      status: "ok",
      loaded: true,
      fellBack: false,
      backend: "offline",
      error: null,
    });
  });
});

describe("health() — the admin probe (#783)", () => {
  it("is ok for a loaded, healthy backend", async () => {
    process.env.AI_OFFLINE = "1";
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const health = await new Embedder().health();
    expect(health).toMatchObject({ ok: true, status: "ok", fellBack: false, error: null });
  });

  it("reports ERROR when the backend warms but then reports itself unhealthy", async () => {
    // A sidecar that answered /healthz at warm and stopped answering since. It has
    // NOT fallen back — it is simply unusable, and must not read as healthy.
    let calls = 0;
    const client = {
      healthz: vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new Error("sidecar went away");
        return { status: "ok" };
      }),
      embed: vi.fn(),
    };
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new Embedder({ backend: "sidecar", client: client as never });
    await embedder.warm();

    const health = await embedder.health();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("error");
    expect(health.fellBack).toBe(false);
    // The sidecar backend swallows the upstream error inside healthy(); the point
    // is that "unhealthy" reaches the panel as an ERROR, not as a green tick.
    expect(health.error).toMatch(/backend reported unhealthy/);
    expect(client.healthz).toHaveBeenCalledTimes(2);
  });

  it("reports — rather than crashes on — a backend whose healthy() throws", async () => {
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const { registerBackend } = await import("../src/lib/rag/embedder-registry.js");
    registerBackend(
      "test-throwing-health",
      () => ({
        key: "test-throwing-health",
        model: "m",
        dimension: 3,
        requiresEgress: false,
        warm: async () => {},
        embed: async () => ({ vectors: [], model: "m", dimension: 3 }),
        healthy: async () => {
          throw new Error("probe blew up");
        },
      }),
      {
        label: "t",
        description: "t",
        requiresEgress: false,
        defaultModel: "m",
        defaultDimension: 3,
        offlineCapable: true,
      },
    );

    const health = await new Embedder({ backend: "test-throwing-health" }).health();
    expect(health.ok).toBe(false);
    expect(health.status).toBe("error");
    expect(health.error).toMatch(/probe blew up/);
  });
});

describe("isHashFallbackAllowed", () => {
  it("accepts the usual truthy spellings and nothing else", async () => {
    const { isHashFallbackAllowed } = await import("../src/lib/rag/embedder.js");
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(isHashFallbackAllowed({ EMBED_ALLOW_HASH_FALLBACK: value })).toBe(true);
    }
    for (const value of ["0", "false", "no", "", "  "]) {
      expect(isHashFallbackAllowed({ EMBED_ALLOW_HASH_FALLBACK: value })).toBe(false);
    }
    expect(isHashFallbackAllowed({})).toBe(false);
    expect(isHashFallbackAllowed({ AI_OFFLINE: "1" })).toBe(true);
  });
});
