/**
 * Reranker tests (issue #131).
 *
 * Verifies the env gate, the no-op fallback, and the test injection seam.
 * The actual cross-encoder load is heavy + network-dependent and is exercised
 * only when `RAG_RERANK=1` in production / dev. Tests cover:
 *
 *   - `isRerankEnabled` honours `RAG_RERANK=1|true|yes|on`
 *   - `getReranker()` returns a no-op when the env is off
 *   - Injected stub reranker rescores candidates
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetRerankerSingleton,
  __setRerankerForTests,
  getReranker,
  isRerankEnabled,
  type Reranker,
} from "../src/lib/rag/reranker.js";

const ORIGINAL_ENV = process.env.RAG_RERANK;

beforeEach(() => {
  __resetRerankerSingleton();
  delete process.env.RAG_RERANK;
});

afterEach(() => {
  __resetRerankerSingleton();
  if (ORIGINAL_ENV == null) delete process.env.RAG_RERANK;
  else process.env.RAG_RERANK = ORIGINAL_ENV;
});

describe("isRerankEnabled", () => {
  it("is false when RAG_RERANK is unset", () => {
    delete process.env.RAG_RERANK;
    expect(isRerankEnabled()).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "YES", "on", "On"])("is true for %s", (val) => {
    process.env.RAG_RERANK = val;
    expect(isRerankEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", "anything-else"])("is false for %s", (val) => {
    process.env.RAG_RERANK = val;
    expect(isRerankEnabled()).toBe(false);
  });
});

describe("getReranker (no-op path)", () => {
  it("returns a disabled reranker when RAG_RERANK is unset", async () => {
    const r = getReranker();
    expect(r.enabled).toBe(false);
    const cands = [
      { chunkId: "a", text: "alpha", score: 0.1 },
      { chunkId: "b", text: "bravo", score: 0.9 },
    ];
    const out = await r.rerank("anything", cands);
    expect(out).toEqual(cands);
  });

  it("returns the same singleton on repeated calls until reset", () => {
    const a = getReranker();
    const b = getReranker();
    expect(a).toBe(b);
    __resetRerankerSingleton();
    const c = getReranker();
    expect(c).not.toBe(a);
  });
});

describe("__setRerankerForTests", () => {
  it("lets tests inject a stub reranker that flips the order", async () => {
    const stub: Reranker = {
      enabled: true,
      async rerank(_q, cands) {
        // Reverse the input order with deterministic scores so we can assert.
        return [...cands].reverse().map((c, i) => ({ ...c, score: cands.length - i }));
      },
    };
    __setRerankerForTests(stub);
    const r = getReranker();
    expect(r).toBe(stub);
    const out = await r.rerank("q", [
      { chunkId: "a", text: "x", score: 1 },
      { chunkId: "b", text: "y", score: 2 },
    ]);
    expect(out.map((o) => o.chunkId)).toEqual(["b", "a"]);
    expect(out[0].score).toBe(2);
  });
});
