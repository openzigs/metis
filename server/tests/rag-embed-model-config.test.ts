/**
 * Issue #782 — the server's copy of the pooling/dtype rules.
 *
 * The sidecar copy is tested in `server/embeddings-svc/tests/model-config.test.ts`
 * and a parity test proves the two files are byte-identical. This suite covers
 * the SERVER copy so the rules are exercised (and coverage-measured) inside the
 * server package too.
 */
import { describe, expect, it } from "vitest";
import {
  assertValidEmbedConfig,
  DEFAULT_DTYPE,
  DEFAULT_POOLING,
  declaredPoolingFromConfig,
  parsePoolingOverrides,
  poolingFromModelMap,
  resolveDtype,
  resolvePooling,
} from "../src/lib/rag/embed-model-config.js";
import { listBackendDescriptors } from "../src/lib/rag/embedder.js";

const EMPTY: Record<string, string | undefined> = {};

/**
 * The backends that load their weights through transformers.js, and therefore
 * the ones whose default model MUST match a pooling rule — a miss means the
 * model silently pools by the `mean` fallback, which is the exact silent-skew
 * failure this config exists to prevent.
 *
 * Derived from the live registry rather than hand-copied, so registering a new
 * local backend without a pooling rule fails this test instead of quietly
 * shipping. Double-gated:
 *  - `offlineCapable` excludes the cloud backends (openai/bedrock), which pool
 *    server-side and correctly have no local rule;
 *  - a `/` in the model id (an HF `owner/name` repo id) excludes the hash stub,
 *    whose `metis-offline-hash-v1` is not a transformer at all.
 * Every cloud default (`text-embedding-3-small`, `amazon.titan-embed-text-v2:0`)
 * is slash-free, so a future cloud backend cannot drift in here silently either.
 */
const TRANSFORMERS_BACKED = listBackendDescriptors().filter(
  (d) => d.offlineCapable && d.defaultModel.includes("/"),
);

describe("embed-model-config (server copy)", () => {
  it("ships mean + q8 as defaults (no behaviour change until #783/#788)", () => {
    expect(DEFAULT_POOLING).toBe("mean");
    expect(DEFAULT_DTYPE).toBe("q8");
    expect(resolveDtype(EMPTY)).toBe("q8");
    expect(resolvePooling("Xenova/bge-small-en-v1.5", undefined, EMPTY)).toEqual({
      pooling: "mean",
      source: "model-map",
    });
  });

  it.each([
    ["Alibaba-NLP/gte-modernbert-base", "cls"],
    ["ibm-granite/granite-embedding-english-r2", "cls"],
    ["Xenova/bge-small-en-v1.5", "mean"],
    ["jinaai/jina-embeddings-v2-base-code", "mean"],
    ["Xenova/all-MiniLM-L6-v2", "mean"],
  ])("maps %s → %s", (model, expected) => {
    expect(poolingFromModelMap(model)).toBe(expected);
  });

  it("applies request > env-map > model-map > env-default > fallback", () => {
    const env = { EMBED_POOLING_MAP: "acme/x=cls", EMBED_POOLING: "cls" };
    expect(resolvePooling("acme/x", "mean", env).source).toBe("request");
    expect(resolvePooling("acme/x", undefined, env).source).toBe("env-map");
    expect(resolvePooling("Xenova/bge-small-en-v1.5", undefined, env).source).toBe("model-map");
    expect(resolvePooling("acme/y", undefined, { EMBED_POOLING: "cls" }).source).toBe(
      "env-default",
    );
    expect(resolvePooling("acme/y", undefined, EMPTY).source).toBe("fallback");
  });

  it("fails loud on invalid config rather than silently mean-pooling", () => {
    expect(() => resolvePooling("acme/x", "max", EMPTY)).toThrow(/Invalid pooling/);
    expect(() => resolvePooling("acme/x", undefined, { EMBED_POOLING: "max" })).toThrow(
      /Invalid EMBED_POOLING/,
    );
    expect(() => parsePoolingOverrides("acme/x=max")).toThrow(/Invalid EMBED_POOLING_MAP entry/);
    expect(() => resolveDtype({ EMBED_DTYPE: "int4" })).toThrow(/Invalid EMBED_DTYPE/);
  });

  it("reads a declared pooling only when the config actually carries one", () => {
    expect(declaredPoolingFromConfig({ pooling_mode_cls_token: true })).toBe("cls");
    expect(declaredPoolingFromConfig({ pooling_mode_mean_tokens: true })).toBe("mean");
    expect(declaredPoolingFromConfig({ model_type: "modernbert" })).toBeNull();
    expect(declaredPoolingFromConfig(null)).toBeNull();
  });

  it("resolves fp32 from EMBED_DTYPE", () => {
    expect(resolveDtype({ EMBED_DTYPE: "fp32" })).toBe("fp32");
    expect(parsePoolingOverrides(undefined).size).toBe(0);
  });

  it("maps embeddinggemma from a RULE, not the fallback (it is a shipped backend)", () => {
    expect(poolingFromModelMap("onnx-community/embeddinggemma-300m-ONNX")).toBe("mean");
    expect(resolvePooling("onnx-community/embeddinggemma-300m-ONNX", undefined, EMPTY).source).toBe(
      "model-map",
    );
  });

  it("resolves EVERY registered transformers.js backend's default model from the map", () => {
    // Enumerated from the registry, NOT hand-copied: the sidecar twin can only
    // list model-id literals (it cannot import from the server workspace), so
    // this is the copy that actually catches drift. Register a local backend
    // whose model has no pooling rule and this fails here.
    expect(TRANSFORMERS_BACKED.length).toBeGreaterThan(0);
    for (const backend of TRANSFORMERS_BACKED) {
      expect(
        resolvePooling(backend.defaultModel, undefined, EMPTY).source,
        `backend "${backend.label}" (${backend.defaultModel}) has no pooling rule — it would ` +
          `silently pool by the "${DEFAULT_POOLING}" fallback; add a rule to embed-model-config.ts`,
      ).toBe("model-map");
    }
  });

  it("memoizes the EMBED_POOLING_MAP parse (resolvePooling runs per embed call)", () => {
    const raw = "acme/x=cls";
    expect(parsePoolingOverrides(raw)).toBe(parsePoolingOverrides(raw));
  });
});

describe("assertValidEmbedConfig (boot-time gate)", () => {
  it("passes for an empty and for a fully valid env", () => {
    expect(() => assertValidEmbedConfig(EMPTY)).not.toThrow();
    expect(() =>
      assertValidEmbedConfig({
        EMBED_POOLING_MAP: "acme/custom=cls",
        EMBED_POOLING: "mean",
        EMBED_DTYPE: "fp32",
      }),
    ).not.toThrow();
  });

  it.each([
    [{ EMBED_POOLING_MAP: "acme/model=clss" }, /Invalid EMBED_POOLING_MAP entry/],
    [{ EMBED_POOLING: "clss" }, /Invalid EMBED_POOLING/],
    [{ EMBED_DTYPE: "int4" }, /Invalid EMBED_DTYPE/],
  ])("throws on %o", (env, expected) => {
    expect(() => assertValidEmbedConfig(env)).toThrow(expected);
  });

  it("catches a bad EMBED_POOLING that resolvePooling alone would never reach", () => {
    // EMBED_POOLING is only consulted for a model NO rule matches, so a typo can
    // lie dormant behind every mapped model. Only the boot gate surfaces it.
    expect(() =>
      resolvePooling("Xenova/bge-small-en-v1.5", undefined, { EMBED_POOLING: "clss" }),
    ).not.toThrow();
    expect(() => assertValidEmbedConfig({ EMBED_POOLING: "clss" })).toThrow(
      /Invalid EMBED_POOLING/,
    );
  });
});
