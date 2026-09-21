/**
 * Coverage tests for the in-process `XenovaCrossEncoderReranker` path of
 * `rag/reranker.ts` (issue #145, rewritten for #1158).
 *
 * ## Why these tests changed shape
 *
 * They used to mock `pipeline("text-classification")` and assert that the reranker
 * sorted by the `score` field the pipeline returned. That passed, and the production
 * path it stood for scored nothing: `TextClassificationPipeline` forwards no
 * `text_pair`, so every candidate tokenized identically, and this checkpoint declares
 * one label so softmax returned exactly `1` for every pair. The mock was faithful to
 * a call the real library accepts and quietly ignores.
 *
 * So the mocks here are of `AutoTokenizer` + `AutoModelForSequenceClassification`, and
 * the first test asserts the thing the old suite could not: that the PASSAGE reaches
 * the model as `text_pair` alongside the query. That assertion is the regression guard
 * for the actual defect.
 *
 * The class is not exported, so it is exercised through `getReranker()` with
 * `RAG_RERANK=1` and `EMBEDDINGS_MODE=in-process`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_RAG = process.env.RAG_RERANK;
const ORIGINAL_MODE = process.env.EMBEDDINGS_MODE;
const ORIGINAL_OFFLINE = process.env.AI_OFFLINE;

interface TokenizeCall {
  texts: string[];
  opts: { text_pair: string[]; padding: boolean; truncation: boolean };
}

/**
 * Mock `@huggingface/transformers` with a classifier whose logit is a pure function
 * of the PASSAGE. If the passage never reaches the model — the #1158 defect — every
 * logit comes out identical and the ordering assertions below fail.
 */
function mockTransformers(
  logitFor: (passage: string) => number,
  opts: { tokenizeCalls?: TokenizeCall[]; rows?: (scores: number[]) => unknown } = {},
): void {
  vi.doMock("@huggingface/transformers", () => ({
    AutoTokenizer: {
      from_pretrained: vi.fn(async () => (texts: string[], o: TokenizeCall["opts"]) => {
        opts.tokenizeCalls?.push({ texts, opts: o });
        return { passages: o.text_pair };
      }),
    },
    AutoModelForSequenceClassification: {
      from_pretrained: vi.fn(async () => async (inputs: { passages: string[] }) => {
        const scores = inputs.passages.map(logitFor);
        return { logits: { tolist: () => opts.rows?.(scores) ?? scores.map((s) => [s]) } };
      }),
    },
    env: { allowRemoteModels: undefined },
  }));
}

beforeEach(() => {
  vi.resetModules();
  process.env.RAG_RERANK = "1";
  process.env.EMBEDDINGS_MODE = "in-process";
  delete process.env.AI_OFFLINE;
});

afterEach(() => {
  vi.doUnmock("@huggingface/transformers");
  vi.resetModules();
  if (ORIGINAL_RAG == null) delete process.env.RAG_RERANK;
  else process.env.RAG_RERANK = ORIGINAL_RAG;
  if (ORIGINAL_MODE == null) delete process.env.EMBEDDINGS_MODE;
  else process.env.EMBEDDINGS_MODE = ORIGINAL_MODE;
  if (ORIGINAL_OFFLINE == null) delete process.env.AI_OFFLINE;
  else process.env.AI_OFFLINE = ORIGINAL_OFFLINE;
});

describe("XenovaCrossEncoderReranker (in-process)", () => {
  it("tokenizes the query against each passage as text_pair, and sorts by the logit", async () => {
    const tokenizeCalls: TokenizeCall[] = [];
    mockTransformers((p) => p.length, { tokenizeCalls });
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    expect(r.enabled).toBe(true);

    const out = await r.rerank("query string", [
      { chunkId: "a", text: "x", score: 0 },
      { chunkId: "b", text: "longer-text", score: 0 },
      { chunkId: "c", text: "mid", score: 0 },
    ]);

    // THE regression guard for #1158: the query is repeated once per passage, and the
    // passages travel as `text_pair`. Without this the cross-encoder is a no-op.
    expect(tokenizeCalls).toHaveLength(1);
    expect(tokenizeCalls[0].texts).toEqual(["query string", "query string", "query string"]);
    expect(tokenizeCalls[0].opts.text_pair).toEqual(["x", "longer-text", "mid"]);
    expect(tokenizeCalls[0].opts.padding).toBe(true);
    expect(tokenizeCalls[0].opts.truncation).toBe(true);

    // length-based logit ⇒ "longer-text" (b) wins.
    expect(out.map((o) => o.chunkId)).toEqual(["b", "c", "a"]);
    expect(out[0].score).toBe("longer-text".length);
  });

  it("reuses the warm model across calls", async () => {
    const tokenizeCalls: TokenizeCall[] = [];
    mockTransformers((p) => p.length, { tokenizeCalls });
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    await r.rerank("query string", [{ chunkId: "a", text: "x", score: 0 }]);
    await r.rerank("query string", [{ chunkId: "a", text: "x", score: 0 }]);
    expect(tokenizeCalls).toHaveLength(2);
  });

  it("batches a pool larger than the batch size and keeps every candidate", async () => {
    const tokenizeCalls: TokenizeCall[] = [];
    mockTransformers((p) => Number(p.replace("p", "")), { tokenizeCalls });
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();

    const cands = Array.from({ length: 70 }, (_, i) => ({ chunkId: `c${i}`, text: `p${i}` }));
    const out = await r.rerank("query string", cands);

    // 70 candidates at a batch size of 32 → 32 + 32 + 6.
    expect(tokenizeCalls.map((c) => c.opts.text_pair.length)).toEqual([32, 32, 6]);
    expect(out).toHaveLength(70);
    expect(out[0].chunkId).toBe("c69");
    expect(out[69].chunkId).toBe("c0");
  });

  it("keeps the original order when the logits come back in an unexpected shape", async () => {
    // A shape mismatch must NOT be scored to zero — that would silently reorder the
    // pool. Falling through to the caller's ordering is the documented contract.
    mockTransformers((p) => p.length, { rows: () => "not-an-array" });
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    const cands = [
      { chunkId: "a", text: "x", score: 1 },
      { chunkId: "b", text: "yy", score: 2 },
    ];
    expect(await r.rerank("query string", cands)).toEqual(cands);
  });

  it("keeps the original order when a logit is not a finite number", async () => {
    mockTransformers(() => Number.NaN);
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    const cands = [
      { chunkId: "a", text: "x", score: 1 },
      { chunkId: "b", text: "yy", score: 2 },
    ];
    expect(await r.rerank("query string", cands)).toEqual(cands);
  });

  it("accepts a flat (non-nested) logit row", async () => {
    mockTransformers((p) => p.length, { rows: (scores) => scores });
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    const out = await r.rerank("query string", [
      { chunkId: "a", text: "x" },
      { chunkId: "b", text: "longer" },
    ]);
    expect(out.map((o) => o.chunkId)).toEqual(["b", "a"]);
  });

  it("falls back to original order when inference throws", async () => {
    vi.doMock("@huggingface/transformers", () => ({
      AutoTokenizer: { from_pretrained: vi.fn(async () => () => ({})) },
      AutoModelForSequenceClassification: {
        from_pretrained: vi.fn(async () => async () => {
          throw new Error("inference boom");
        }),
      },
      env: { allowRemoteModels: undefined },
    }));
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    const cands = [
      { chunkId: "a", text: "x", score: 1 },
      { chunkId: "b", text: "y", score: 2 },
    ];
    expect(await r.rerank("query string", cands)).toEqual(cands);
  });

  it("falls back when @huggingface/transformers fails to load", async () => {
    vi.doMock("@huggingface/transformers", () => {
      throw new Error("module load failed");
    });
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    const cands = [
      { chunkId: "a", text: "x", score: 1 },
      { chunkId: "b", text: "y", score: 2 },
    ];
    expect(await r.rerank("query string", cands)).toEqual(cands);
  });

  it("falls back when the model weights cannot be loaded", async () => {
    vi.doMock("@huggingface/transformers", () => ({
      AutoTokenizer: { from_pretrained: vi.fn(async () => () => ({})) },
      AutoModelForSequenceClassification: {
        from_pretrained: vi.fn(async () => {
          throw new Error("ENOENT: model_quantized.onnx");
        }),
      },
      env: { allowRemoteModels: undefined },
    }));
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    const cands = [{ chunkId: "a", text: "x", score: 1 }];
    expect(await r.rerank("query string", cands)).toEqual(cands);
  });

  it("short-circuits for queries shorter than minQueryLength", async () => {
    const tokenizeCalls: TokenizeCall[] = [];
    mockTransformers((p) => p.length, { tokenizeCalls });
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    const cands = [{ chunkId: "a", text: "x", score: 1 }];
    expect(await r.rerank("q", cands)).toEqual(cands);
    expect(tokenizeCalls).toHaveLength(0);
  });

  it("short-circuits for empty candidate lists without loading anything", async () => {
    const from_pretrained = vi.fn();
    vi.doMock("@huggingface/transformers", () => ({
      AutoTokenizer: { from_pretrained },
      AutoModelForSequenceClassification: { from_pretrained },
      env: { allowRemoteModels: undefined },
    }));
    const { getReranker, __resetRerankerSingleton } = await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    const r = getReranker();
    expect(await r.rerank("query string", [])).toEqual([]);
    expect(from_pretrained).not.toHaveBeenCalled();
  });
});

describe("firstLogitPerRow (#1158)", () => {
  it("reads the single logit off each row", async () => {
    const { firstLogitPerRow } = await import("../src/lib/rag/reranker.js");
    expect(firstLogitPerRow([[-11.3], [2.5]], 2)).toEqual([-11.3, 2.5]);
  });

  it("accepts an already-flat row", async () => {
    const { firstLogitPerRow } = await import("../src/lib/rag/reranker.js");
    expect(firstLogitPerRow([-11.3, 2.5], 2)).toEqual([-11.3, 2.5]);
  });

  it("rejects a row count that does not match the candidate count", async () => {
    const { firstLogitPerRow } = await import("../src/lib/rag/reranker.js");
    expect(firstLogitPerRow([[1]], 2)).toBeNull();
  });

  it("rejects non-numeric and non-finite values", async () => {
    const { firstLogitPerRow } = await import("../src/lib/rag/reranker.js");
    expect(firstLogitPerRow([["a"]], 1)).toBeNull();
    expect(firstLogitPerRow([[Number.POSITIVE_INFINITY]], 1)).toBeNull();
    expect(firstLogitPerRow("nope", 1)).toBeNull();
  });
});

describe("createCrossEncoderReranker (#1158)", () => {
  it("builds a real cross-encoder even when RAG_RERANK is unset", async () => {
    delete process.env.RAG_RERANK;
    mockTransformers((p) => p.length);
    const { createCrossEncoderReranker, getReranker, __resetRerankerSingleton } =
      await import("../src/lib/rag/reranker.js");
    __resetRerankerSingleton();
    // The flag still governs the SINGLETON production reads …
    expect(getReranker().enabled).toBe(false);
    // … while the explicit factory the eval harness uses does not consult it.
    const direct = createCrossEncoderReranker();
    expect(direct.enabled).toBe(true);
    const out = await direct.rerank("query string", [
      { chunkId: "a", text: "x" },
      { chunkId: "b", text: "longer" },
    ]);
    expect(out.map((o) => o.chunkId)).toEqual(["b", "a"]);
  });
});
