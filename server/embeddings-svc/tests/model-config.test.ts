/**
 * Issue #782 — per-model pooling + dtype resolution.
 *
 * These are the rules that decide whether a CLS model gets CLS-pooled. A bug
 * here does not throw; it silently emits degraded vectors. So they are pinned
 * exhaustively, including the ZERO-CHANGE guarantee for today's default model.
 */
import { describe, expect, it } from "vitest";
import {
  assertValidEmbedConfig,
  DEFAULT_DTYPE,
  DEFAULT_POOLING,
  declaredPoolingFromConfig,
  isEmbedDtype,
  isEmbedPooling,
  modelKey,
  parsePoolingOverrides,
  poolingFromModelMap,
  resolveDtype,
  resolvePooling,
} from "../src/model-config.js";

const EMPTY: Record<string, string | undefined> = {};

describe("defaults (zero behaviour change)", () => {
  it("keeps mean pooling + q8 dtype as the shipped defaults", () => {
    expect(DEFAULT_POOLING).toBe("mean");
    // NOTE: #782's issue text says "fp32 remains the default", but #781 shipped
    // q8 and BOTH Dockerfiles bake q8. Defaulting to fp32 here would make every
    // air-gapped image request weights it never baked. #788 then SETTLED the
    // question in q8's favour (it scored higher: 0.402 vs 0.360 nDCG@10), and
    // #783 shipped on it — so this is now a decision, not a placeholder.
    expect(DEFAULT_DTYPE).toBe("q8");
  });

  it("resolves today's default model exactly as the pre-#782 hardcode did", () => {
    expect(resolvePooling("Xenova/bge-small-en-v1.5", undefined, EMPTY)).toEqual({
      pooling: "mean",
      source: "model-map",
    });
    expect(resolveDtype(EMPTY)).toBe("q8");
  });
});

describe("poolingFromModelMap", () => {
  it.each([
    ["Alibaba-NLP/gte-modernbert-base", "cls"],
    ["onnx-community/granite-embedding-small-english-r2-ONNX", "cls"],
    ["ibm-granite/granite-embedding-english-r2", "cls"],
    ["Xenova/bge-small-en-v1.5", "mean"],
    ["BAAI/bge-m3", "mean"],
    ["jinaai/jina-embeddings-v2-base-code", "mean"],
    ["Xenova/all-MiniLM-L6-v2", "mean"],
    // A SHIPPED backend, so it must resolve via an explicit RULE, not the
    // fallback — otherwise every load logs "no per-model rule matched", which
    // trains operators to ignore the warning that is supposed to matter.
    ["onnx-community/embeddinggemma-300m-ONNX", "mean"],
  ])("maps %s → %s", (model, expected) => {
    expect(poolingFromModelMap(model)).toBe(expected);
  });

  it("resolves every shipped backend model from the map, never the fallback", () => {
    for (const model of [
      "Xenova/bge-small-en-v1.5",
      "onnx-community/embeddinggemma-300m-ONNX",
      "Alibaba-NLP/gte-modernbert-base",
    ]) {
      expect(resolvePooling(model, undefined, EMPTY).source).toBe("model-map");
    }
  });

  it("returns null for a model no rule matches", () => {
    expect(poolingFromModelMap("acme/some-unknown-embedder")).toBeNull();
  });

  it("matches on the basename, case-insensitively, ignoring the owner", () => {
    expect(modelKey("  Alibaba-NLP/GTE-ModernBERT-Base  ")).toBe("gte-modernbert-base");
    expect(poolingFromModelMap("someone-else/GTE-ModernBERT-base")).toBe("cls");
    // An owner named "bge" must not make a CLS model mean-pool.
    expect(poolingFromModelMap("bge/gte-modernbert-base")).toBe("cls");
  });
});

describe("resolvePooling precedence", () => {
  const env = {
    EMBED_POOLING_MAP: "acme/custom=cls,Xenova/bge-small-en-v1.5=cls",
    EMBED_POOLING: "cls",
  };

  it("1. an explicit request field wins over everything", () => {
    expect(resolvePooling("Alibaba-NLP/gte-modernbert-base", "mean", env)).toEqual({
      pooling: "mean",
      source: "request",
    });
  });

  it("2. EMBED_POOLING_MAP overrides the built-in map", () => {
    expect(resolvePooling("Xenova/bge-small-en-v1.5", undefined, env)).toEqual({
      pooling: "cls",
      source: "env-map",
    });
  });

  it("3. the built-in map beats the EMBED_POOLING global default", () => {
    expect(resolvePooling("Xenova/bge-small-en-v1.5", undefined, { EMBED_POOLING: "cls" })).toEqual(
      { pooling: "mean", source: "model-map" },
    );
  });

  it("4. EMBED_POOLING applies to models the built-in map does not know", () => {
    expect(resolvePooling("acme/unknown", undefined, { EMBED_POOLING: "cls" })).toEqual({
      pooling: "cls",
      source: "env-default",
    });
  });

  it("5. falls back to mean when nothing matches", () => {
    expect(resolvePooling("acme/unknown", undefined, EMPTY)).toEqual({
      pooling: "mean",
      source: "fallback",
    });
  });

  it("rejects an invalid explicit pooling instead of silently meaning-pooling", () => {
    expect(() => resolvePooling("acme/x", "max", EMPTY)).toThrow(/Invalid pooling "max"/);
  });

  it("rejects an invalid EMBED_POOLING", () => {
    expect(() => resolvePooling("acme/x", undefined, { EMBED_POOLING: "last-token" })).toThrow(
      /Invalid EMBED_POOLING/,
    );
  });
});

describe("parsePoolingOverrides", () => {
  it("parses a comma-separated list and lower-cases the model key", () => {
    const map = parsePoolingOverrides("Alibaba-NLP/gte-modernbert-base=cls, acme/x =mean ,");
    expect(map.get("alibaba-nlp/gte-modernbert-base")).toBe("cls");
    expect(map.get("acme/x")).toBe("mean");
    expect(map.size).toBe(2);
  });

  it("returns an empty map for unset/blank input", () => {
    expect(parsePoolingOverrides(undefined).size).toBe(0);
    expect(parsePoolingOverrides("   ").size).toBe(0);
  });

  it.each(["acme/x=maxpool", "acme/x", "=cls"])("throws on the invalid entry %s", (raw) => {
    expect(() => parsePoolingOverrides(raw)).toThrow(/Invalid EMBED_POOLING_MAP entry/);
  });
});

describe("parsePoolingOverrides memoization", () => {
  it("returns the same parsed map for a repeated raw string (parsed once, not per request)", () => {
    const raw = "acme/x=cls,acme/y=mean";
    expect(parsePoolingOverrides(raw)).toBe(parsePoolingOverrides(raw));
  });

  it("re-parses when the raw string changes", () => {
    const a = parsePoolingOverrides("acme/x=cls");
    const b = parsePoolingOverrides("acme/x=mean");
    expect(a).not.toBe(b);
    expect(a.get("acme/x")).toBe("cls");
    expect(b.get("acme/x")).toBe("mean");
  });

  it("never memoizes an invalid value — it throws every time", () => {
    expect(() => parsePoolingOverrides("acme/x=clss")).toThrow(/Invalid EMBED_POOLING_MAP entry/);
    expect(() => parsePoolingOverrides("acme/x=clss")).toThrow(/Invalid EMBED_POOLING_MAP entry/);
  });
});

describe("assertValidEmbedConfig", () => {
  it("accepts an empty env and a fully valid env", () => {
    expect(() => assertValidEmbedConfig(EMPTY)).not.toThrow();
    expect(() =>
      assertValidEmbedConfig({
        EMBED_POOLING_MAP: "acme/custom=cls",
        EMBED_POOLING: "mean",
        EMBED_DTYPE: "fp32",
      }),
    ).not.toThrow();
  });

  it("throws on a malformed EMBED_POOLING_MAP", () => {
    expect(() => assertValidEmbedConfig({ EMBED_POOLING_MAP: "acme/model=clss" })).toThrow(
      /Invalid EMBED_POOLING_MAP entry/,
    );
  });

  it("throws on an invalid EMBED_DTYPE", () => {
    expect(() => assertValidEmbedConfig({ EMBED_DTYPE: "int4" })).toThrow(/Invalid EMBED_DTYPE/);
  });

  it("catches a typo'd EMBED_POOLING that resolvePooling alone would never reach", () => {
    // `resolvePooling` only consults EMBED_POOLING for a model NO rule matches,
    // so a bad global default lies dormant for every mapped model. Boot
    // validation is what surfaces it.
    expect(() =>
      resolvePooling("Xenova/bge-small-en-v1.5", undefined, { EMBED_POOLING: "clss" }),
    ).not.toThrow();
    expect(() => assertValidEmbedConfig({ EMBED_POOLING: "clss" })).toThrow(
      /Invalid EMBED_POOLING/,
    );
  });
});

describe("resolveDtype", () => {
  it("defaults to q8 and accepts fp32/q8 case-insensitively", () => {
    expect(resolveDtype(EMPTY)).toBe("q8");
    expect(resolveDtype({ EMBED_DTYPE: "fp32" })).toBe("fp32");
    expect(resolveDtype({ EMBED_DTYPE: " Q8 " })).toBe("q8");
    expect(resolveDtype({ EMBED_DTYPE: "" })).toBe("q8");
  });

  it("throws on an unsupported dtype rather than silently defaulting", () => {
    expect(() => resolveDtype({ EMBED_DTYPE: "int4" })).toThrow(/Invalid EMBED_DTYPE "int4"/);
  });
});

describe("type guards", () => {
  it("narrow pooling and dtype values", () => {
    expect(isEmbedPooling("cls")).toBe(true);
    expect(isEmbedPooling("MEAN")).toBe(false);
    expect(isEmbedDtype("fp32")).toBe(true);
    expect(isEmbedDtype("fp16")).toBe(false);
  });
});

describe("declaredPoolingFromConfig", () => {
  it("reads sentence-transformers pooling flags when a config carries them", () => {
    expect(declaredPoolingFromConfig({ pooling_mode_cls_token: true })).toBe("cls");
    expect(declaredPoolingFromConfig({ pooling_mode_mean_tokens: true })).toBe("mean");
  });

  it("returns null when the config says nothing about pooling (the common case)", () => {
    expect(declaredPoolingFromConfig({ model_type: "modernbert" })).toBeNull();
    expect(declaredPoolingFromConfig(undefined)).toBeNull();
    expect(declaredPoolingFromConfig("nonsense")).toBeNull();
  });
});

/**
 * Issue #784 — weights delivery. The sidecar's COPY of these rules is what the
 * bake stage of `Dockerfile.embeddings` actually executes (it imports the
 * compiled `dist/model-config.js`), so it is tested here on its own terms and
 * not only through the parity test.
 */
describe("resolveEmbedModel (#784)", () => {
  it("serves DEFAULT_SIDECAR_EMBED_MODEL when EMBED_MODEL is unset", async () => {
    const { resolveEmbedModel, DEFAULT_SIDECAR_EMBED_MODEL, AIR_GAP_EMBED_MODEL, resolvePooling } =
      await import("../src/model-config.js");
    expect(resolveEmbedModel({})).toBe(DEFAULT_SIDECAR_EMBED_MODEL);
    expect(resolveEmbedModel({ EMBED_MODEL: "  " })).toBe(DEFAULT_SIDECAR_EMBED_MODEL);
    // #783 moved this constant to gte-modernbert; the lockstep guard made the
    // Dockerfile ARG and the bake list follow it.
    expect(DEFAULT_SIDECAR_EMBED_MODEL).toBe(AIR_GAP_EMBED_MODEL);
    expect(DEFAULT_SIDECAR_EMBED_MODEL).toBe("Alibaba-NLP/gte-modernbert-base");
    // …and the sidecar CLS-pools it with no configuration. The model id alone is
    // not the #788 win: the same weights at `mean` scored level with the model
    // this replaced, and nothing downstream would have said so.
    expect(resolvePooling(DEFAULT_SIDECAR_EMBED_MODEL, undefined, {})).toEqual({
      pooling: "cls",
      source: "model-map",
    });
  });

  it("honours EMBED_MODEL — the SAME value the image bakes", async () => {
    const { resolveEmbedModel } = await import("../src/model-config.js");
    expect(resolveEmbedModel({ EMBED_MODEL: " acme/custom " })).toBe("acme/custom");
  });
});

describe("resolveBakeModels (#784)", () => {
  it("bakes the served default (gte-modernbert) AND the superseded bge-small", async () => {
    // #783: the served default IS gte-modernbert now. bge-small stays baked so an
    // offline image can still serve a corpus indexed before the flip (chunks are
    // queried BY MODEL ID) and so EMBED_MODEL can be rolled back without a rebuild.
    const {
      resolveBakeModels,
      AIR_GAP_EMBED_MODEL,
      BGE_SMALL_EMBED_MODEL,
      DEFAULT_SIDECAR_EMBED_MODEL,
    } = await import("../src/model-config.js");
    expect(DEFAULT_SIDECAR_EMBED_MODEL).toBe(AIR_GAP_EMBED_MODEL);
    expect(resolveBakeModels({})).toEqual([AIR_GAP_EMBED_MODEL, BGE_SMALL_EMBED_MODEL]);
  });

  it("always bakes the model the runtime will SERVE", async () => {
    const { resolveBakeModels } = await import("../src/model-config.js");
    // EMBED_MODEL moves both ends: it is what /embed defaults to AND what the
    // bake must include. Listing it explicitly is the supported way to trim.
    expect(
      resolveBakeModels({ EMBED_MODEL: "acme/custom", BAKE_EMBED_MODELS: "acme/custom" }),
    ).toEqual(["acme/custom"]);
  });

  it("FAILS THE BUILD when the list omits the model the runtime will serve", async () => {
    const { resolveBakeModels } = await import("../src/model-config.js");
    // The unbootable-image case. Silently prepending EMBED_MODEL (the pre-review
    // behaviour) made this "work" while also making a genuine trim impossible.
    expect(() =>
      resolveBakeModels({ EMBED_MODEL: "acme/custom", BAKE_EMBED_MODELS: "acme/other" }),
    ).toThrow(/does not include "acme\/custom"/);
    // The default EMBED_MODEL is implied, so an unqualified trim fails too.
    expect(() => resolveBakeModels({ BAKE_EMBED_MODELS: "acme/other" })).toThrow(
      /HF_HUB_OFFLINE=1/,
    );
  });

  it("dedupes case-insensitively rather than baking the same weights twice", async () => {
    const { resolveBakeModels } = await import("../src/model-config.js");
    expect(
      resolveBakeModels({
        EMBED_MODEL: "acme/Custom",
        BAKE_EMBED_MODELS: "acme/custom, acme/CUSTOM ,acme/other",
      }),
    ).toEqual(["acme/custom", "acme/other"]);
  });

  it("reads an empty ENV BAKE_EMBED_MODELS as 'unset', not as 'bake nothing'", async () => {
    const { resolveBakeModels, DEFAULT_BAKE_MODELS } = await import("../src/model-config.js");
    expect(resolveBakeModels({ BAKE_EMBED_MODELS: "" })).toEqual([...DEFAULT_BAKE_MODELS]);
  });
});

describe("resolveRemoteHost / isEmbedOffline (#784)", () => {
  it("normalises HF_ENDPOINT into a remoteHost with a trailing slash", async () => {
    const { resolveRemoteHost } = await import("../src/model-config.js");
    expect(resolveRemoteHost({ HF_ENDPOINT: "https://mirror.corp" })).toBe("https://mirror.corp/");
    expect(resolveRemoteHost({ HF_ENDPOINT: "https://mirror.corp/hf" })).toBe(
      "https://mirror.corp/hf/",
    );
    expect(resolveRemoteHost({})).toBeNull();
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "mirror.corp" })).toThrow(/Invalid HF_ENDPOINT/);
  });

  it("rejects plaintext http:// unless the risk is explicitly accepted (A08)", async () => {
    const { resolveRemoteHost } = await import("../src/model-config.js");
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "http://mirror.corp" })).toThrow(
      /Refusing plaintext HF_ENDPOINT/,
    );
    expect(
      resolveRemoteHost({ HF_ENDPOINT: "http://mirror.corp", HF_ENDPOINT_ALLOW_INSECURE: "1" }),
    ).toBe("http://mirror.corp/");
  });

  it("rejects embedded credentials, and never echoes them back", async () => {
    const { resolveRemoteHost } = await import("../src/model-config.js");
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "https://user:hunter2@mirror.corp" })).toThrow(
      /must not embed credentials/,
    );
    // The message that tells you not to put a token in the URL must not print it.
    try {
      resolveRemoteHost({ HF_ENDPOINT: "https://user:hunter2@mirror.corp" });
      expect.unreachable("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("hunter2");
    }
  });

  it("rejects a query string or fragment the path template cannot survive", async () => {
    const { resolveRemoteHost } = await import("../src/model-config.js");
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "https://mirror.corp/x?y=1" })).toThrow(
      /query string or fragment/,
    );
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "https://mirror.corp/#frag" })).toThrow(
      /query string or fragment/,
    );
  });

  it("rejects non-http(s) protocols", async () => {
    const { resolveRemoteHost } = await import("../src/model-config.js");
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "file:///etc/passwd" })).toThrow(/not supported/);
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "ftp://mirror.corp" })).toThrow(/not supported/);
  });

  it("treats all three offline flags as equivalent", async () => {
    const { isEmbedOffline } = await import("../src/model-config.js");
    expect(isEmbedOffline({ HF_HUB_OFFLINE: "1" })).toBe(true);
    expect(isEmbedOffline({ TRANSFORMERS_OFFLINE: "true" })).toBe(true);
    expect(isEmbedOffline({ EMBEDDINGS_OFFLINE: "on" })).toBe(true);
    expect(isEmbedOffline({})).toBe(false);
  });
});

describe("redactUrl (#784 F5)", () => {
  it("strips userinfo so a mirror URL is safe to log", async () => {
    const { redactUrl } = await import("../src/model-config.js");
    expect(redactUrl("https://user:hunter2@mirror.corp/hf/")).toBe(
      "https://mirror.corp/hf/ (credentials redacted)",
    );
    expect(redactUrl("https://mirror.corp/")).toBe("https://mirror.corp/");
  });

  it("still redacts when the value is not a parseable URL", async () => {
    const { redactUrl } = await import("../src/model-config.js");
    expect(redactUrl("//user:hunter2@mirror.corp")).not.toContain("hunter2");
  });
});
