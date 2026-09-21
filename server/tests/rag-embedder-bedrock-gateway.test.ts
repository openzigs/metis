/**
 * Bedrock Access Gateway embeddings backend tests (Epic #930 / issue #932).
 *
 * The gateway speaks the OpenAI `/embeddings` contract, so we mock the HTTP
 * transport (`fetchImpl`) rather than hitting a real endpoint. Covers happy
 * path, index ordering, retry on 5xx, and loud failure on 401.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BedrockGatewayEmbedder,
  parseOpenAiEmbeddings,
} from "../src/lib/rag/backends/bedrock-gateway-embedder.js";
import { EmbedBackendHttpError } from "../src/lib/rag/backends/http.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("BedrockGatewayEmbedder (#932)", () => {
  it("requires baseUrl and apiKey", () => {
    expect(() => new BedrockGatewayEmbedder({ baseUrl: "", apiKey: "k" })).toThrowError(
      /BEDROCK_GATEWAY_URL/,
    );
    expect(() => new BedrockGatewayEmbedder({ baseUrl: "http://gw", apiKey: "" })).toThrowError(
      /BEDROCK_GATEWAY_API_KEY/,
    );
  });

  it("reports its identity + egress requirement", () => {
    const e = new BedrockGatewayEmbedder({ baseUrl: "http://gw/", apiKey: "k" });
    expect(e.key).toBe("bedrock");
    expect(e.model).toBe("amazon.titan-embed-text-v2:0");
    expect(e.dimension).toBe(1024);
    expect(e.requiresEgress).toBe(true);
  });

  it("POSTs OpenAI-shaped body with bearer auth and parses embeddings", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://gw/embeddings");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
      const parsed = JSON.parse(init.body as string);
      expect(parsed).toEqual({ model: "amazon.titan-embed-text-v2:0", input: ["a", "b"] });
      return jsonResponse({
        model: "amazon.titan-embed-text-v2:0",
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      });
    });
    const e = new BedrockGatewayEmbedder({ baseUrl: "http://gw/", apiKey: "secret", fetchImpl });
    const res = await e.embed(["a", "b"]);
    // Re-ordered by index.
    expect(res.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(res.model).toBe("amazon.titan-embed-text-v2:0");
    expect(res.dimension).toBe(2);
  });

  it("short-circuits empty input without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const e = new BedrockGatewayEmbedder({ baseUrl: "http://gw", apiKey: "k", fetchImpl });
    const res = await e.embed([]);
    expect(res.vectors).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 2) return jsonResponse({ error: "boom" }, 503);
      return jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] });
    });
    const e = new BedrockGatewayEmbedder({
      baseUrl: "http://gw",
      apiKey: "k",
      fetchImpl,
      backoffMs: 0,
    });
    const res = await e.embed(["x"]);
    expect(calls).toBe(2);
    expect(res.vectors[0]).toEqual([1, 2, 3]);
  });

  it("fails loud on 401 (no retry)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    const e = new BedrockGatewayEmbedder({
      baseUrl: "http://gw",
      apiKey: "bad",
      fetchImpl,
      backoffMs: 0,
    });
    await expect(e.embed(["x"])).rejects.toBeInstanceOf(EmbedBackendHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("healthy() returns false when the upstream errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "down" }, 500));
    const e = new BedrockGatewayEmbedder({
      baseUrl: "http://gw",
      apiKey: "k",
      fetchImpl,
      maxAttempts: 1,
      backoffMs: 0,
    });
    expect(await e.healthy()).toBe(false);
  });
});

describe("parseOpenAiEmbeddings", () => {
  it("throws when no data is returned", () => {
    expect(() => parseOpenAiEmbeddings({ data: [] }, 1, "bedrock")).toThrowError(/no embeddings/);
  });

  it("throws when the row count mismatches", () => {
    expect(() =>
      parseOpenAiEmbeddings({ data: [{ index: 0, embedding: [1] }] }, 2, "bedrock"),
    ).toThrowError(/expected 2 embeddings/);
  });

  it("throws when a row is missing its vector", () => {
    expect(() => parseOpenAiEmbeddings({ data: [{ index: 0 }] }, 1, "bedrock")).toThrowError(
      /missing embedding/,
    );
  });
});
