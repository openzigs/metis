/**
 * #785 — the "is my embedder real?" smoke check.
 *
 * Note the last block: it runs the check against the REAL hash stub (no mocks, no
 * network) and asserts the verdict is `hash-stub`. That is the single most
 * important test here — it proves the tool actually catches the failure epic #780
 * exists to eliminate, rather than merely reporting whatever the config claims.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EMBED_MODEL } from "@metis/shared";
import { Embedder, type EmbedderHealth } from "./embedder.js";
import {
  NO_LOCAL_WEIGHTS,
  SEMANTIC_MARGIN,
  SMOKE_PROBES,
  cosine,
  exitCodeFor,
  formatSmokeReport,
  isHashStub,
  loadsWeightsLocally,
  runEmbedSmoke,
} from "./embed-smoke.js";

const noCacheDir = async () => null;

function health(overrides: Partial<EmbedderHealth> = {}): EmbedderHealth {
  return {
    loaded: true,
    ok: true,
    status: "ok",
    backend: "xenova",
    model: "Alibaba-NLP/gte-modernbert-base",
    dimension: 768,
    fellBack: false,
    hashFallbackAllowed: false,
    error: null,
    ...overrides,
  };
}

/**
 * A stand-in embedder. `vectors` is what `embed()` returns for the three probes.
 */
function fakeEmbedder(h: EmbedderHealth, vectors?: number[][], embedError?: Error): () => Embedder {
  return () =>
    ({
      key: h.backend,
      model: h.model,
      dimension: h.dimension,
      health: async () => h,
      embed: async () => {
        if (embedError) throw embedError;
        return { vectors: vectors ?? [], model: h.model, dimension: h.dimension };
      },
    }) as unknown as Embedder;
}

/** A vector space where `related` is close to `anchor` and `unrelated` is not. */
const DISCRIMINATING: number[][] = [
  [1, 0, 0],
  [0.95, 0.31, 0],
  [0, 0, 1],
];

/** A "vector space" that separates nothing — the hash-stub signature. */
const NON_DISCRIMINATING: number[][] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

describe("cosine", () => {
  it("is 1 for identical directions and 0 for orthogonal ones", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 5])).toBeCloseTo(0);
  });

  it("is -1 for opposed vectors", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 for a zero vector rather than NaN", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("throws on a dimension mismatch instead of silently truncating", () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/i);
  });
});

describe("isHashStub", () => {
  it("recognises the offline backend and the stub's model id", () => {
    expect(isHashStub("offline", "anything")).toBe(true);
    expect(isHashStub("xenova", DEFAULT_EMBED_MODEL)).toBe(true);
    expect(isHashStub("XENOVA", DEFAULT_EMBED_MODEL.toUpperCase())).toBe(true);
  });

  it("does not flag a real backend + model", () => {
    expect(isHashStub("sidecar", "Alibaba-NLP/gte-modernbert-base")).toBe(false);
  });
});

describe("loadsWeightsLocally", () => {
  it("is true only for the in-process ONNX backends", () => {
    expect(loadsWeightsLocally("xenova")).toBe(true);
    expect(loadsWeightsLocally("embeddinggemma")).toBe(true);
  });

  it("is false for the sidecar, the stub and every cloud backend", () => {
    for (const key of ["sidecar", "offline", "bedrock", "bedrock-sdk", "openai"]) {
      expect(loadsWeightsLocally(key)).toBe(false);
    }
  });
});

describe("runEmbedSmoke — verdicts", () => {
  it("REAL: a loaded model whose vector space discriminates", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health(), DISCRIMINATING),
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.verdict).toBe("real");
    expect(report.semantic?.discriminates).toBe(true);
    expect(report.semantic!.margin).toBeGreaterThan(SEMANTIC_MARGIN);
    // Pooling must be reported from the per-model map, not guessed (#782).
    expect(report.pooling).toBe("cls");
    expect(report.poolingSource).toBe("model-map");
    expect(report.dtype).toBe("q8");
    expect(report.dimension).toBe(768);
    expect(exitCodeFor(report.verdict)).toBe(0);
  });

  it("HASH-STUB: the offline backend is the SELECTED one (no probe run)", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(
        health({ backend: "offline", model: DEFAULT_EMBED_MODEL, dimension: 384 }),
        DISCRIMINATING,
      ),
      env: { AI_OFFLINE: "1" } as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.verdict).toBe("hash-stub");
    // Deliberately NOT probed: a lucky margin must never read as evidence of semantics.
    expect(report.semantic).toBeNull();
    expect(report.reasons.join(" ")).toMatch(/NON-SEMANTIC/i);
    expect(exitCodeFor(report.verdict)).toBe(1);
  });

  it("HASH-STUB: a real backend FELL BACK to the stub", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(
        health({
          backend: "sidecar",
          model: DEFAULT_EMBED_MODEL,
          dimension: 384,
          status: "degraded",
          ok: false,
          fellBack: true,
          hashFallbackAllowed: true,
          error: "sidecar unreachable",
        }),
      ),
      env: { EMBED_ALLOW_HASH_FALLBACK: "1" } as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.verdict).toBe("hash-stub");
    expect(report.fellBack).toBe(true);
    expect(report.reasons.join(" ")).toMatch(/FELL BACK/);
    expect(report.reasons.join(" ")).toContain("sidecar unreachable");
  });

  it("ERROR: the backend failed to load (the #783 fail-loud path)", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(
        health({
          status: "error",
          ok: false,
          loaded: false,
          error: 'Embeddings backend "xenova" failed to load',
        }),
      ),
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.verdict).toBe("error");
    expect(report.semantic).toBeNull();
    expect(report.reasons.join(" ")).toContain("failed to load");
    expect(exitCodeFor(report.verdict)).toBe(1);
  });

  it("ERROR: the backend loaded but embedding threw", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health(), undefined, new Error("ECONNRESET")),
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.verdict).toBe("error");
    expect(report.reasons.join(" ")).toContain("ECONNRESET");
  });

  it("ERROR: the backend returned the wrong number of vectors", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health(), [[1, 0, 0]]),
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.verdict).toBe("error");
    expect(report.reasons.join(" ")).toMatch(/expected 3 vectors, got 1/);
  });

  it("SUSPECT: identity looks real but the vectors do not discriminate", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health(), NON_DISCRIMINATING),
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.verdict).toBe("suspect");
    expect(report.semantic?.discriminates).toBe(false);
    // The config reads correctly and the vectors do not — trust the vectors.
    expect(report.reasons.join(" ")).toMatch(/CHANCE LEVEL/);
    expect(exitCodeFor(report.verdict)).toBe(1);
  });

  it("embeds the three probe texts — and only those", async () => {
    const embed = vi.fn(async () => ({
      vectors: DISCRIMINATING,
      model: "m",
      dimension: 3,
    }));
    const embedder = () =>
      ({
        key: "xenova",
        model: "Alibaba-NLP/gte-modernbert-base",
        dimension: 768,
        health: async () => health(),
        embed,
      }) as unknown as Embedder;

    await runEmbedSmoke({
      getEmbedderFn: embedder,
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(embed).toHaveBeenCalledExactlyOnceWith([
      SMOKE_PROBES.anchor,
      SMOKE_PROBES.related,
      SMOKE_PROBES.unrelated,
    ]);
  });
});

describe("runEmbedSmoke — environment reporting", () => {
  it("FAILS LOUD on an HF_ENDPOINT carrying credentials, without echoing the secret", async () => {
    // #784 rejects a credentialed mirror at config-resolution time, because the
    // endpoint gets echoed into build logs and stdout. The smoke check inherits
    // that rather than papering over it — but the thrown message must not leak the
    // token either, since a developer will paste this straight into an issue.
    const run = runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health(), DISCRIMINATING),
      env: { HF_ENDPOINT: "https://user:sekrit@hf-mirror.corp.example" } as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    await expect(run).rejects.toThrow(/must not embed credentials/i);
    await expect(run).rejects.not.toThrow(/sekrit/);
  });

  it("FAILS LOUD on an invalid EMBED_DTYPE rather than defaulting", async () => {
    await expect(
      runEmbedSmoke({
        getEmbedderFn: fakeEmbedder(health(), DISCRIMINATING),
        env: { EMBED_DTYPE: "int4" } as NodeJS.ProcessEnv,
        cacheDirReader: noCacheDir,
        platform: "linux",
      }),
    ).rejects.toThrow(/Invalid EMBED_DTYPE/i);
  });

  it("reports a clean mirror and the offline flag", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health(), DISCRIMINATING),
      env: {
        HF_ENDPOINT: "https://hf-mirror.corp.example",
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_CACHE: "/data/hf-cache",
      } as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.offline).toBe(true);
    expect(report.mirror).toContain("hf-mirror.corp.example");
    expect(report.cachePath).toContain("hf-cache");
  });

  it("does NOT report a local cache (or a MAX_PATH warning) for the SIDECAR backend", async () => {
    // The sidecar's weights live in its container image. Reporting the server's
    // TRANSFORMERS_CACHE here — and MAX_PATH-warning about it — would send a Windows
    // dev chasing a directory that has no bearing on where their vectors come from.
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health({ backend: "sidecar" }), DISCRIMINATING),
      env: {
        TRANSFORMERS_CACHE: `C:\\Users\\dev\\${"deeply\\".repeat(30)}cache`,
      } as NodeJS.ProcessEnv,
      cacheDirReader: async () => "/node_modules/.cache",
      platform: "win32",
    });

    expect(report.weightsLocal).toBe(false);
    expect(report.cachePath).toBe(NO_LOCAL_WEIGHTS);
    expect(report.cacheHeadroom.atRisk).toBe(false);
    expect(formatSmokeReport(report)).not.toContain("WINDOWS MAX_PATH");
  });

  it("DOES report a local cache for the in-process xenova backend", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health({ backend: "xenova" }), DISCRIMINATING),
      env: { TRANSFORMERS_CACHE: "/data/hf-cache" } as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.weightsLocal).toBe(true);
    expect(report.cachePath).toContain("hf-cache");
  });

  it("flags a MAX_PATH-risky cache root on Windows", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health(), DISCRIMINATING),
      env: {
        TRANSFORMERS_CACHE: `C:\\Users\\dev\\source\\repos\\${"deeply\\".repeat(30)}cache`,
      } as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "win32",
    });

    expect(report.platform).toBe("win32");
    expect(report.cacheHeadroom.atRisk).toBe(true);
    expect(formatSmokeReport(report)).toContain("WINDOWS MAX_PATH");
  });
});

describe("formatSmokeReport", () => {
  it("leads with the verdict and includes the identity + probe numbers", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health(), DISCRIMINATING),
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });
    const text = formatSmokeReport(report);

    expect(text).toContain("VERDICT: REAL");
    expect(text).toContain("Alibaba-NLP/gte-modernbert-base");
    expect(text).toContain("pooling        cls");
    expect(text).toContain("dtype          q8");
    expect(text).toContain("discriminates              true");
  });

  it("says NOT semantic, loudly, for the hash stub", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(
        health({
          backend: "offline",
          model: DEFAULT_EMBED_MODEL,
          dimension: 384,
          hashFallbackAllowed: true,
        }),
      ),
      env: { AI_OFFLINE: "1" } as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });
    const text = formatSmokeReport(report);

    expect(text).toContain("VERDICT: HASH STUB — vectors are NOT semantic");
    expect(text).toContain("ALLOWED");
  });

  it("renders an error report without a semantic section", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: fakeEmbedder(health({ status: "error", ok: false, error: "boom" })),
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });
    const text = formatSmokeReport(report);

    expect(text).toContain("VERDICT: ERROR");
    expect(text).toContain("error          boom");
    expect(text).not.toContain("Semantic probe");
  });
});

/**
 * The check earns its keep here: a REAL, unmocked hash embedder must be caught.
 * No network, no model download — the stub is pure and in-process.
 */
describe("runEmbedSmoke — against the REAL hash stub (no mocks)", () => {
  it("verdict is hash-stub, and it is reported as non-semantic", async () => {
    const report = await runEmbedSmoke({
      getEmbedderFn: () => new Embedder({ backend: "offline" }),
      env: {} as NodeJS.ProcessEnv,
      cacheDirReader: noCacheDir,
      platform: "linux",
    });

    expect(report.verdict).toBe("hash-stub");
    expect(report.backend).toBe("offline");
    expect(report.model).toBe(DEFAULT_EMBED_MODEL);
    expect(report.dimension).toBe(384);
    expect(exitCodeFor(report.verdict)).toBe(1);
  });

  it("the stub's vector space genuinely does NOT discriminate — the premise of the probe", async () => {
    // Proven directly rather than assumed: embed the same three probes through the
    // real stub and show the paraphrase is not meaningfully closer than the
    // off-topic sentence. Deterministic (SHA-256 of fixed strings), so this is a
    // stable assertion, not a flaky one.
    const stub = new Embedder({ backend: "offline" });
    const { vectors } = await stub.embed([
      SMOKE_PROBES.anchor,
      SMOKE_PROBES.related,
      SMOKE_PROBES.unrelated,
    ]);

    const relatedSim = cosine(vectors[0], vectors[1]);
    const unrelatedSim = cosine(vectors[0], vectors[2]);
    expect(relatedSim - unrelatedSim).toBeLessThanOrEqual(SEMANTIC_MARGIN);
  });

  /**
   * SEMANTIC_MARGIN is a calibration, and a calibration that nothing checks is a
   * number someone will "tidy up" later. This pins BOTH sides of it.
   *
   * The first version of this check used 0.05 and the real stub cleared it at
   * 0.145 — i.e. the tool would have certified hash noise as "REAL". The stub's
   * margin is zero-mean noise with sd ≈ 0.0726 (measured over 50k triples), so a
   * 0.05 bar is exceeded ~25% of the time. Hence the bar, and hence this test.
   */
  it("SEMANTIC_MARGIN sits far above the stub's noise floor", async () => {
    const stub = new Embedder({ backend: "offline" });
    const margins: number[] = [];

    for (let i = 0; i < 400; i += 1) {
      const { vectors } = await stub.embed([
        `anchor requirement number ${i}`,
        `a paraphrase of requirement ${i}`,
        `an unrelated sentence ${i}`,
      ]);
      margins.push(cosine(vectors[0], vectors[1]) - cosine(vectors[0], vectors[2]));
    }

    const mean = margins.reduce((s, v) => s + v, 0) / margins.length;
    const sd = Math.sqrt(margins.reduce((s, v) => s + (v - mean) ** 2, 0) / margins.length);

    // Zero-mean noise: the stub has no semantics to express.
    expect(Math.abs(mean)).toBeLessThan(0.02);
    // The bar must clear the noise by a wide margin (>3 sd), or "discriminates"
    // is a coin-flip. sd is ~0.073, so this asserts SEMANTIC_MARGIN > ~0.22.
    expect(SEMANTIC_MARGIN).toBeGreaterThan(3 * sd);
    // No sampled stub margin should reach the bar.
    expect(Math.max(...margins)).toBeLessThan(SEMANTIC_MARGIN);
  });

  /**
   * The other side of the calibration: the bar must sit BELOW what a real model
   * scores, or every healthy deployment gets a false "suspect".
   *
   * 0.381 is the margin measured on these exact probes with the real
   * `Alibaba-NLP/gte-modernbert-base` (768d, cls, q8) — see SEMANTIC_MARGIN's docs.
   * We cannot download weights in a unit test, so this pins the recorded
   * measurement against the bar rather than re-deriving it.
   */
  it("SEMANTIC_MARGIN sits below the measured real-model margin", () => {
    const MEASURED_GTE_MODERNBERT_MARGIN = 0.381;
    expect(SEMANTIC_MARGIN).toBeLessThan(MEASURED_GTE_MODERNBERT_MARGIN);
    // Meaningful headroom on both sides, not a bar wedged against one of them.
    expect(MEASURED_GTE_MODERNBERT_MARGIN - SEMANTIC_MARGIN).toBeGreaterThan(0.1);
  });
});
