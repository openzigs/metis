/**
 * Issue #784 — weights delivery: which models a build bakes, and where the
 * runtime is allowed to fetch them from.
 *
 * The stakes are asymmetric. Getting the bake list wrong does not slow a request
 * down, it produces a pod that CANNOT BOOT: under `HF_HUB_OFFLINE=1` the runtime
 * is forbidden from fetching, so a model that is not in the baked cache is a hard
 * load failure. Every case below is a way that could happen quietly.
 */
import { describe, expect, it } from "vitest";
import {
  AIR_GAP_EMBED_MODEL,
  BGE_SMALL_EMBED_MODEL,
  DEFAULT_BAKE_MODELS,
  DEFAULT_SIDECAR_EMBED_MODEL,
  assertValidEmbedConfig,
  isEmbedOffline,
  redactUrl,
  resolveBakeModels,
  resolveEmbedModel,
  resolveRemoteHost,
} from "../src/lib/rag/embed-model-config.js";

describe("resolveEmbedModel", () => {
  it("is the single source of truth for the model the sidecar SERVES", () => {
    // `app.ts` defaults /embed's `model` from this, and the bake list is derived
    // from it — so it is impossible to change what the image serves without
    // changing what it bakes. Before the #784 review these were three separate
    // string literals and the runner stage never even exported EMBED_MODEL.
    expect(resolveEmbedModel({})).toBe(DEFAULT_SIDECAR_EMBED_MODEL);
    expect(resolveEmbedModel({ EMBED_MODEL: "acme/custom" })).toBe("acme/custom");
    expect(resolveBakeModels({})).toContain(resolveEmbedModel({}));
  });
});

describe("resolveBakeModels", () => {
  it("bakes the served default (gte-modernbert) AND the superseded bge-small", () => {
    // #783 made gte-modernbert the served default. bge-small stays in the bake
    // list on purpose: chunks indexed before the flip are queried BY MODEL ID, so
    // an offline image without those weights could not serve a pre-flip corpus —
    // nor let an operator roll EMBED_MODEL back without rebuilding the image.
    expect(DEFAULT_SIDECAR_EMBED_MODEL).toBe(AIR_GAP_EMBED_MODEL);
    expect(resolveBakeModels({})).toEqual([AIR_GAP_EMBED_MODEL, BGE_SMALL_EMBED_MODEL]);
    expect(DEFAULT_BAKE_MODELS).toContain(AIR_GAP_EMBED_MODEL);
    expect(DEFAULT_BAKE_MODELS).toContain(BGE_SMALL_EMBED_MODEL);
  });

  it("honours an explicit comma-separated BAKE_EMBED_MODELS list", () => {
    expect(
      resolveBakeModels({
        EMBED_MODEL: "Alibaba-NLP/gte-modernbert-base",
        BAKE_EMBED_MODELS: " Alibaba-NLP/gte-modernbert-base , acme/other ",
      }),
    ).toEqual(["Alibaba-NLP/gte-modernbert-base", "acme/other"]);
  });

  it("treats an empty/whitespace BAKE_EMBED_MODELS as unset, not as an empty list", () => {
    // `ENV BAKE_EMBED_MODELS=` in the Dockerfile sets the EMPTY STRING, not
    // "undefined". If that were read as "bake nothing", the default build would
    // ship an image with no weights at all — and, being HF_HUB_OFFLINE=1, one
    // that dies on its first embed call.
    expect(resolveBakeModels({ BAKE_EMBED_MODELS: "" })).toEqual([...DEFAULT_BAKE_MODELS]);
    expect(resolveBakeModels({ BAKE_EMBED_MODELS: "   " })).toEqual([...DEFAULT_BAKE_MODELS]);
  });

  it("FAILS THE BUILD when the list omits the model the RUNTIME will serve", () => {
    // The unbootable-image case: an operator trims the bake list to save space
    // and forgets that EMBED_MODEL is what the sidecar actually loads. This used
    // to silently prepend the model — which meant the documented trim
    // (`--build-arg BAKE_EMBED_MODELS=<one model>`) never actually shrank the
    // image, while the reverse case still shipped an image that could not boot.
    // Now it is a build failure that names both ways out.
    expect(() =>
      resolveBakeModels({
        EMBED_MODEL: "acme/custom-embedder",
        BAKE_EMBED_MODELS: "Alibaba-NLP/gte-modernbert-base",
      }),
    ).toThrow(/does not include "acme\/custom-embedder"/);
  });

  it("lets a trim through when the runtime is pointed at a model that IS baked", () => {
    // The safe trim: move EMBED_MODEL and BAKE_EMBED_MODELS together, and the
    // image genuinely carries only gte-modernbert.
    expect(
      resolveBakeModels({
        EMBED_MODEL: AIR_GAP_EMBED_MODEL,
        BAKE_EMBED_MODELS: AIR_GAP_EMBED_MODEL,
      }),
    ).toEqual([AIR_GAP_EMBED_MODEL]);
  });

  it("does not bake the same model twice when EMBED_MODEL is already in the list", () => {
    const models = resolveBakeModels({ EMBED_MODEL: "alibaba-nlp/GTE-ModernBERT-base" });
    // Case-insensitive dedupe — HF ids are routinely written with varied casing,
    // and downloading the same weights twice would just inflate the image.
    expect(models.filter((m) => m.toLowerCase().includes("gte-modernbert"))).toHaveLength(1);
  });

  it("throws rather than baking nothing when the list resolves to empty", () => {
    expect(() => resolveBakeModels({ BAKE_EMBED_MODELS: " , , " })).toThrow(/empty model list/i);
  });
});

describe("resolveRemoteHost (HF_ENDPOINT mirror)", () => {
  it("is null when unset — downloads go to the public hub", () => {
    expect(resolveRemoteHost({})).toBeNull();
    expect(resolveRemoteHost({ HF_ENDPOINT: "" })).toBeNull();
  });

  it("normalises the trailing slash transformers.js's path template assumes", () => {
    // remoteHost is CONCATENATED with `{model}/resolve/{revision}/`; without the
    // slash the URL becomes ".../hf-mirror.corp.exampleAlibaba-NLP/...".
    expect(resolveRemoteHost({ HF_ENDPOINT: "https://hf-mirror.corp.example" })).toBe(
      "https://hf-mirror.corp.example/",
    );
    expect(resolveRemoteHost({ HF_ENDPOINT: "https://hf-mirror.corp.example/" })).toBe(
      "https://hf-mirror.corp.example/",
    );
  });

  it("throws on a non-http(s) value instead of silently using the public hub", () => {
    // Falling back would send an air-gapped/corp deploy at huggingface.co —
    // exactly the egress the mirror exists to avoid, and it would look like it
    // was configured.
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "hf-mirror.corp.example" })).toThrow(
      /Invalid HF_ENDPOINT/,
    );
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "file:///etc" })).toThrow(/Invalid HF_ENDPOINT/);
  });

  /**
   * OWASP A08 (software/data integrity). This value decides where an EXECUTABLE
   * ONNX graph is downloaded from, and transformers.js checks no hash, no
   * revision pin and no signature — so `http://` is a straight MITM-substitution
   * of the model, and userinfo in the URL is a token in the build log.
   */
  it("refuses plaintext http:// unless the risk is explicitly accepted", () => {
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "http://hf-mirror.corp.example" })).toThrow(
      /Refusing plaintext HF_ENDPOINT/,
    );
    expect(
      resolveRemoteHost({
        HF_ENDPOINT: "http://hf-mirror.corp.example",
        HF_ENDPOINT_ALLOW_INSECURE: "1",
      }),
    ).toBe("http://hf-mirror.corp.example/");
  });

  it("refuses an endpoint carrying credentials, and does not echo them", () => {
    expect(() =>
      resolveRemoteHost({ HF_ENDPOINT: "https://svc:s3cret@hf-mirror.corp.example" }),
    ).toThrow(/must not embed credentials/);
    try {
      resolveRemoteHost({ HF_ENDPOINT: "https://svc:s3cret@hf-mirror.corp.example" });
      expect.unreachable("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cret");
    }
  });

  it("refuses a query string the download path template would corrupt", () => {
    // remoteHost is CONCATENATED with `{model}/resolve/{revision}/`, so a query
    // string produces `…?x=1Alibaba-NLP/gte…` — a 404 that looks like a missing
    // model rather than a malformed mirror.
    expect(() => resolveRemoteHost({ HF_ENDPOINT: "https://hf-mirror.corp/x?y=1" })).toThrow(
      /query string or fragment/,
    );
  });

  it("redacts credentials from a mirror URL before it is logged (F5)", () => {
    expect(redactUrl("https://svc:s3cret@hf-mirror.corp/")).toBe(
      "https://hf-mirror.corp/ (credentials redacted)",
    );
    expect(redactUrl("https://hf-mirror.corp/")).toBe("https://hf-mirror.corp/");
  });

  it("is validated at boot, so a typo crashloops instead of 500ing per request", () => {
    expect(() => assertValidEmbedConfig({ HF_ENDPOINT: "not-a-url" })).toThrow(/HF_ENDPOINT/);
    expect(() =>
      assertValidEmbedConfig({ HF_ENDPOINT: "https://hf-mirror.corp.example" }),
    ).not.toThrow();
  });
});

describe("isEmbedOffline", () => {
  it("accepts every offline variable, so the sidecar and in-process paths agree", () => {
    for (const key of ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "EMBEDDINGS_OFFLINE"]) {
      expect(isEmbedOffline({ [key]: "1" }), key).toBe(true);
      expect(isEmbedOffline({ [key]: "true" }), key).toBe(true);
      expect(isEmbedOffline({ [key]: "YES" }), key).toBe(true);
    }
  });

  it("is false when unset or explicitly disabled", () => {
    expect(isEmbedOffline({})).toBe(false);
    expect(isEmbedOffline({ HF_HUB_OFFLINE: "0" })).toBe(false);
    expect(isEmbedOffline({ HF_HUB_OFFLINE: "false" })).toBe(false);
  });
});
