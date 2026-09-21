/**
 * Issue #792 — the persisted embedding identity (model + pooling + dtype).
 *
 * These lock the "bare when default" rule that makes grandfathering the existing
 * index a mathematical identity rather than a data migration: a row is bare
 * exactly when its pooling+dtype are the model's built-in defaults, which is what
 * every pre-#792 row (and the shipped config) produced.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DTYPE, DEFAULT_POOLING } from "../src/lib/rag/embed-model-config.js";
import {
  builtinPooling,
  formatEmbeddingIdentity,
  identityFromWire,
} from "../src/lib/rag/embedding-identity.js";

const GTE = "Alibaba-NLP/gte-modernbert-base"; // built-in pooling: cls
const BGE = "Xenova/bge-small-en-v1.5"; // built-in pooling: mean

describe("builtinPooling", () => {
  it("uses the per-model map when a rule matches", () => {
    expect(builtinPooling(GTE)).toBe("cls");
    expect(builtinPooling(BGE)).toBe("mean");
  });

  it("falls back to DEFAULT_POOLING for an unmapped model", () => {
    expect(builtinPooling("acme/unknown-embedder")).toBe(DEFAULT_POOLING);
  });
});

describe("formatEmbeddingIdentity — bare when default", () => {
  it("is the BARE model id at the model's built-in pooling + default dtype", () => {
    // This is the invariant grandfathering rests on: default config → bare id ==
    // what every existing row already stores → no reindex, no retag.
    expect(formatEmbeddingIdentity(GTE, "cls", DEFAULT_DTYPE)).toBe(GTE);
    expect(formatEmbeddingIdentity(BGE, "mean", DEFAULT_DTYPE)).toBe(BGE);
  });

  it("suffixes when pooling diverges from the built-in default", () => {
    expect(formatEmbeddingIdentity(GTE, "mean", DEFAULT_DTYPE)).toBe(`${GTE}|mean|q8`);
    expect(formatEmbeddingIdentity(BGE, "cls", DEFAULT_DTYPE)).toBe(`${BGE}|cls|q8`);
  });

  it("suffixes when dtype diverges from the default", () => {
    expect(formatEmbeddingIdentity(GTE, "cls", "fp32")).toBe(`${GTE}|cls|fp32`);
  });

  it("suffixes when BOTH diverge", () => {
    expect(formatEmbeddingIdentity(GTE, "mean", "fp32")).toBe(`${GTE}|mean|fp32`);
  });

  it("is canonical — (cls, q8) for gte has exactly one spelling", () => {
    // No second representation to normalise: equality is plain string equality.
    const a = formatEmbeddingIdentity(GTE, builtinPooling(GTE), DEFAULT_DTYPE);
    const b = formatEmbeddingIdentity(GTE, "cls", "q8");
    expect(a).toBe(b);
    expect(a).toBe(GTE);
  });
});

describe("identityFromWire — the sidecar crux", () => {
  it("builds the identity from the ECHOED pooling + dtype, not a guess", () => {
    // Sidecar says it mean-pooled a cls model (server env disagrees): the persisted
    // identity must reflect what the SIDECAR did, so a mismatch is detectable.
    expect(identityFromWire(GTE, "mean", "q8")).toBe(`${GTE}|mean|q8`);
    // Sidecar echoes fp32 though the server default is q8 → detectable as fp32.
    expect(identityFromWire(GTE, "cls", "fp32")).toBe(`${GTE}|cls|fp32`);
  });

  it("returns the bare model id when the sidecar echoes neither field (pre-#782)", () => {
    expect(identityFromWire(GTE, undefined, undefined)).toBe(GTE);
    expect(identityFromWire(GTE, "cls", undefined)).toBe(GTE);
    expect(identityFromWire(GTE, "bogus", "q8")).toBe(GTE);
  });

  it("agrees with the local formatter for a default-config sidecar (bare)", () => {
    expect(identityFromWire(GTE, "cls", DEFAULT_DTYPE)).toBe(GTE);
    expect(identityFromWire(BGE, "mean", DEFAULT_DTYPE)).toBe(BGE);
  });
});
