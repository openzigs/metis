/**
 * Embeddings backend registry tests (Epic #930 / issue #931).
 *
 * Covers the registry seam in isolation: registration, alias normalization,
 * key resolution precedence, loud failure on unknown keys, capability +
 * descriptor surfaces. The built-in backends are pulled in by importing
 * `embedder.js` (which registers them on load).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = ["AI_OFFLINE", "EMBED_BACKEND", "EMBEDDINGS_MODE", "EMBED_MODEL", "EMBED_DIM"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function loadRegistry() {
  // Importing the embedder registers all built-in + cloud backends.
  await import("../src/lib/rag/embedder.js");
  return import("../src/lib/rag/embedder-registry.js");
}

describe("embedder registry (#931)", () => {
  it("registers all built-in + cloud backend keys", async () => {
    const reg = await loadRegistry();
    const keys = reg.listBackendKeys();
    expect(keys).toEqual(
      expect.arrayContaining([
        "offline",
        "xenova",
        "embeddinggemma",
        "sidecar",
        "bedrock",
        "bedrock-sdk",
        "openai",
      ]),
    );
  });

  it("normalizes aliases to canonical keys", async () => {
    const reg = await loadRegistry();
    expect(reg.normalizeBackendKey("hash")).toBe("offline");
    expect(reg.normalizeBackendKey("local")).toBe("offline");
    expect(reg.normalizeBackendKey("remote")).toBe("sidecar");
    expect(reg.normalizeBackendKey("bedrock-gateway")).toBe("bedrock");
    expect(reg.normalizeBackendKey("gateway")).toBe("bedrock");
    expect(reg.normalizeBackendKey("azure-openai")).toBe("openai");
    expect(reg.normalizeBackendKey("azure")).toBe("openai");
    expect(reg.normalizeBackendKey("gemma")).toBe("embeddinggemma");
    expect(reg.normalizeBackendKey("  XENOVA  ")).toBe("xenova");
  });

  it("resolves explicit cfg.backend over everything else", async () => {
    process.env.AI_OFFLINE = "1";
    process.env.EMBED_BACKEND = "sidecar";
    const reg = await loadRegistry();
    expect(reg.resolveBackendKey({ backend: "openai" })).toBe("openai");
  });

  it("resolves AI_OFFLINE before EMBED_BACKEND", async () => {
    process.env.AI_OFFLINE = "1";
    process.env.EMBED_BACKEND = "bedrock";
    const reg = await loadRegistry();
    expect(reg.resolveBackendKey()).toBe("offline");
  });

  it("resolves EMBED_BACKEND (normalized) when no offline flag", async () => {
    process.env.EMBED_BACKEND = "bedrock-gateway";
    const reg = await loadRegistry();
    expect(reg.resolveBackendKey()).toBe("bedrock");
  });

  it("defaults to xenova when nothing is configured", async () => {
    const reg = await loadRegistry();
    expect(reg.resolveBackendKey()).toBe("xenova");
  });

  it("throws loudly with the registered key list on an unknown backend", async () => {
    const reg = await loadRegistry();
    expect(() => reg.createBackend({ backend: "does-not-exist" })).toThrowError(
      /Unknown embeddings backend "does-not-exist"/,
    );
    expect(() => reg.createBackend({ backend: "does-not-exist" })).toThrowError(/openai/);
  });

  it("exposes static descriptors without constructing a backend", async () => {
    const reg = await loadRegistry();
    const descriptors = reg.listBackendDescriptors();
    const offline = descriptors.find((d) => d.key === "offline");
    expect(offline).toMatchObject({
      key: "offline",
      requiresEgress: false,
      offlineCapable: true,
    });
    const bedrock = reg.getBackendDescriptor("bedrock");
    expect(bedrock).toMatchObject({ key: "bedrock", requiresEgress: true, offlineCapable: false });
  });

  it("reports live capabilities of a constructed backend", async () => {
    process.env.AI_OFFLINE = "1";
    const { Embedder } = await import("../src/lib/rag/embedder.js");
    const caps = new Embedder().capabilities();
    expect(caps).toEqual({
      key: "offline",
      model: "metis-offline-hash-v1",
      dimension: 384,
      requiresEgress: false,
    });
  });
});
