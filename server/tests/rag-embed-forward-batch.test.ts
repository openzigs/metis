/**
 * Issue #807 — batch-invariant embeddings.
 *
 * ## What this suite is for
 *
 * The DEFECT is a property of the real ONNX graph and can only be *demonstrated*
 * against real weights — that proof lives in the gated
 * `rag-embedder-batch-invariance.integration.test.ts` (cos(batch-1, batch-64) =
 * 0.974 on `main`, 1.0 after this fix). CI must not download 143 MB of weights on
 * every push, so THIS suite proves the MECHANISM deterministically instead:
 *
 *   1. the policy itself (`resolveForwardBatch` / `forwardBatches`) — pure, and
 *   2. that `XenovaEmbedder` actually *routes its model calls through it*, which is
 *      the part a policy module cannot prove about its caller. #797's whole lesson
 *      was that a correct module wired to nothing is worth nothing, so the
 *      assertion below is on the calls the PIPELINE receives, not on the config.
 *
 * The two together mean a regression that re-batches a quantized forward pass fails
 * here, in the fast job, without any weights.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forwardBatches,
  QUANTIZED_FORWARD_BATCH,
  resolveForwardBatch,
  assertValidEmbedConfig,
} from "../src/lib/rag/embed-model-config.js";

describe("#807 forward-batch policy", () => {
  describe("resolveForwardBatch", () => {
    it("caps a quantized dtype at one text per forward pass", () => {
      // The whole fix in one line: a per-tensor quantization scale is only a
      // function of ONE text when the tensor holds only one text.
      expect(resolveForwardBatch("q8", {})).toBe(1);
      expect(QUANTIZED_FORWARD_BATCH).toBe(1);
    });

    it("leaves fp32 uncapped — batching there is provably exact", () => {
      // Measured: cos(batch-1, batch-64) = 1.00000000, max |Δ| = 8.9e-8. There is
      // no dynamic-quantization node in the fp32 graph, so paying 64× the forward
      // calls would buy nothing.
      expect(resolveForwardBatch("fp32", {})).toBeNull();
    });

    it("lets EMBED_FORWARD_BATCH LOWER the fp32 cap (a memory control)", () => {
      expect(resolveForwardBatch("fp32", { EMBED_FORWARD_BATCH: "8" })).toBe(8);
      expect(resolveForwardBatch("fp32", { EMBED_FORWARD_BATCH: "1" })).toBe(1);
    });

    it("REFUSES to let EMBED_FORWARD_BATCH raise a quantized cap", () => {
      // The anti-footgun. Honouring this would silently restore #807 — vectors that
      // depend on their batch-mates — in exchange for 1.87× throughput. It is not a
      // trade an operator should be able to make by typo, so the cap is lower-only.
      expect(resolveForwardBatch("q8", { EMBED_FORWARD_BATCH: "64" })).toBe(1);
      expect(resolveForwardBatch("q8", { EMBED_FORWARD_BATCH: "2" })).toBe(1);
    });

    it("throws on a non-positive or non-integer cap rather than defaulting", () => {
      for (const bad of ["0", "-1", "2.5", "sixty-four", "" + "abc"]) {
        expect(() => resolveForwardBatch("fp32", { EMBED_FORWARD_BATCH: bad })).toThrow(
          /EMBED_FORWARD_BATCH/,
        );
      }
    });

    it("ignores whitespace-only / unset values", () => {
      expect(resolveForwardBatch("q8", { EMBED_FORWARD_BATCH: "  " })).toBe(1);
      expect(resolveForwardBatch("q8", {})).toBe(1);
    });

    it("is validated at boot, not on the first embed call", () => {
      expect(() => assertValidEmbedConfig({ EMBED_FORWARD_BATCH: "nope" })).toThrow(
        /EMBED_FORWARD_BATCH/,
      );
      expect(() => assertValidEmbedConfig({ EMBED_FORWARD_BATCH: "4" })).not.toThrow();
    });
  });

  describe("forwardBatches", () => {
    const texts = ["a", "b", "c", "d", "e"];

    it("splits a quantized batch into single-text forward passes, in order", () => {
      expect(forwardBatches(texts, "q8", {})).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
    });

    it("hands fp32 the whole batch in one pass", () => {
      expect(forwardBatches(texts, "fp32", {})).toEqual([texts]);
    });

    it("chunks to an explicit cap, preserving order and the remainder", () => {
      expect(forwardBatches(texts, "fp32", { EMBED_FORWARD_BATCH: "2" })).toEqual([
        ["a", "b"],
        ["c", "d"],
        ["e"],
      ]);
    });

    it("returns no passes for no texts — the model is never called", () => {
      expect(forwardBatches([], "q8", {})).toEqual([]);
      expect(forwardBatches([], "fp32", {})).toEqual([]);
    });

    it("never loses or reorders a text, whatever the cap", () => {
      const many = Array.from({ length: 64 }, (_, i) => `t${i}`);
      for (const cap of ["1", "3", "7", "64", "100"]) {
        const flat = forwardBatches(many, "fp32", { EMBED_FORWARD_BATCH: cap }).flat();
        expect(flat).toEqual(many);
      }
    });
  });
});

// ---- The wiring: does XenovaEmbedder actually USE the policy? ---------------

/**
 * A fake transformers.js pipeline that RECORDS the batches the model is asked to
 * run. Vectors are content-derived, so a reordering bug in the concatenation shows
 * up as a wrong vector rather than as a passing test.
 */
const calls: string[][] = [];

const fakePipeline = vi.fn(async (texts: string[]) => {
  calls.push([...texts]);
  const dim = 4;
  const data = new Float32Array(texts.length * dim);
  texts.forEach((t, row) => {
    for (let i = 0; i < dim; i += 1) data[row * dim + i] = t.charCodeAt(0) + i;
  });
  return { data, dims: [texts.length, dim] };
});

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => fakePipeline),
  env: {},
}));

describe("#807 XenovaEmbedder routes the model call through the policy", () => {
  beforeEach(() => {
    calls.length = 0;
    fakePipeline.mockClear();
    delete process.env.EMBED_FORWARD_BATCH;
  });

  async function embedWith(dtype: "q8" | "fp32", texts: string[]) {
    const { XenovaEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = new XenovaEmbedder("acme/test-model", 4, { dtype, pooling: "cls" });
    return embedder.embed(texts);
  }

  it("issues ONE forward pass per text at q8 — no text ever shares a batch", async () => {
    const { vectors } = await embedWith("q8", ["alpha", "bravo", "charlie"]);

    // THE assertion. Three texts, three model calls, each holding exactly one text.
    expect(calls).toEqual([["alpha"], ["bravo"], ["charlie"]]);
    expect(vectors).toHaveLength(3);
  });

  it("keeps ONE forward pass for the whole batch at fp32", async () => {
    const { vectors } = await embedWith("fp32", ["alpha", "bravo", "charlie"]);

    expect(calls).toEqual([["alpha", "bravo", "charlie"]]);
    expect(vectors).toHaveLength(3);
  });

  it("returns vectors in the CALLER's order after splitting the passes", async () => {
    // The split is only safe if the concatenation is order-preserving; a fake that
    // encodes the text into the vector is what makes that checkable.
    const { vectors } = await embedWith("q8", ["a", "b", "c"]);
    expect(vectors[0][0]).toBe("a".charCodeAt(0));
    expect(vectors[1][0]).toBe("b".charCodeAt(0));
    expect(vectors[2][0]).toBe("c".charCodeAt(0));
  });

  it("produces the SAME vector for a text regardless of its batch-mates", async () => {
    // The invariant the real weights are checked against in the gated suite,
    // asserted here on the seam that guarantees it.
    const alone = await embedWith("q8", ["target"]);
    const crowded = await embedWith("q8", ["padding-padding-padding", "target", "x"]);
    expect(crowded.vectors[1]).toEqual(alone.vectors[0]);
  });

  it("never calls the model for an empty batch", async () => {
    const { vectors } = await embedWith("q8", []);
    expect(vectors).toEqual([]);
    expect(fakePipeline).not.toHaveBeenCalled();
  });
});
