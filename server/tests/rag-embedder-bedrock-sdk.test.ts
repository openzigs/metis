/**
 * Direct AWS SDK Bedrock embeddings backend tests (Epic #930 / issue #933).
 *
 * The `@aws-sdk/client-bedrock-runtime` dependency is not installed, so we
 * never exercise the real SDK loader — every test injects an `invoke`
 * function. Covers Titan (per-input) and Cohere (batched) request/response
 * shapes plus throttling retry.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BedrockSdkEmbedder,
  type BedrockInvoke,
} from "../src/lib/rag/backends/bedrock-sdk-embedder.js";

describe("BedrockSdkEmbedder (#933)", () => {
  it("reports identity + egress", () => {
    const e = new BedrockSdkEmbedder({ invoke: vi.fn() });
    expect(e.key).toBe("bedrock-sdk");
    expect(e.requiresEgress).toBe(true);
    expect(e.model).toBe("amazon.titan-embed-text-v2:0");
  });

  it("embeds Titan inputs one request per text", async () => {
    const seen: string[] = [];
    const invoke: BedrockInvoke = vi.fn(async (modelId, body) => {
      expect(modelId).toBe("amazon.titan-embed-text-v2:0");
      const parsed = JSON.parse(body) as { inputText: string };
      seen.push(parsed.inputText);
      return { body: JSON.stringify({ embedding: [parsed.inputText.length, 0.5] }) };
    });
    const e = new BedrockSdkEmbedder({ invoke });
    const res = await e.embed(["ab", "cde"]);
    expect(seen).toEqual(["ab", "cde"]);
    expect(res.vectors).toEqual([
      [2, 0.5],
      [3, 0.5],
    ]);
    expect(res.dimension).toBe(2);
  });

  it("embeds Cohere inputs in a single batched request", async () => {
    const invoke: BedrockInvoke = vi.fn(async (modelId, body) => {
      expect(modelId).toBe("cohere.embed-english-v3");
      const parsed = JSON.parse(body) as { texts: string[]; input_type: string };
      expect(parsed.input_type).toBe("search_document");
      return { body: JSON.stringify({ embeddings: parsed.texts.map((_, i) => [i, i + 1]) }) };
    });
    const e = new BedrockSdkEmbedder({ model: "cohere.embed-english-v3", invoke });
    const res = await e.embed(["x", "y"]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(res.vectors).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("accepts a Uint8Array response body", async () => {
    const invoke: BedrockInvoke = vi.fn(async () => ({
      body: new TextEncoder().encode(JSON.stringify({ embedding: [9, 9] })),
    }));
    const e = new BedrockSdkEmbedder({ invoke });
    const res = await e.embed(["z"]);
    expect(res.vectors).toEqual([[9, 9]]);
  });

  it("retries on ThrottlingException then succeeds", async () => {
    let calls = 0;
    const invoke: BedrockInvoke = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        const err = new Error("rate exceeded");
        err.name = "ThrottlingException";
        throw err;
      }
      return { body: JSON.stringify({ embedding: [1] }) };
    });
    const e = new BedrockSdkEmbedder({ invoke, backoffMs: 0 });
    const res = await e.embed(["q"]);
    expect(calls).toBe(2);
    expect(res.vectors).toEqual([[1]]);
  });

  it("does not retry a non-throttling error", async () => {
    const invoke: BedrockInvoke = vi.fn(async () => {
      const err = new Error("bad model");
      err.name = "ValidationException";
      throw err;
    });
    const e = new BedrockSdkEmbedder({ invoke, backoffMs: 0 });
    await expect(e.embed(["q"])).rejects.toThrowError(/bad model/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("throws when the Titan response lacks an embedding", async () => {
    const invoke: BedrockInvoke = vi.fn(async () => ({ body: JSON.stringify({}) }));
    const e = new BedrockSdkEmbedder({ invoke });
    await expect(e.embed(["q"])).rejects.toThrowError(/missing 'embedding'/);
  });

  it("short-circuits empty input", async () => {
    const invoke = vi.fn();
    const e = new BedrockSdkEmbedder({ invoke });
    expect(await e.embed([])).toEqual({
      vectors: [],
      model: "amazon.titan-embed-text-v2:0",
      dimension: 1024,
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
