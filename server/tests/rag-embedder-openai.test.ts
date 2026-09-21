/**
 * OpenAI / Azure OpenAI embeddings backend tests (Epic #930 / issue #934).
 *
 * Mocks the HTTP transport. Verifies the two URL/header shapes (vanilla OpenAI
 * vs Azure OpenAI) and basic parsing/error behavior.
 */
import { describe, expect, it, vi } from "vitest";
import { OpenAiEmbedder } from "../src/lib/rag/backends/openai-embedder.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAiEmbedder (#934)", () => {
  it("requires baseUrl + apiKey", () => {
    expect(() => new OpenAiEmbedder({ baseUrl: "", apiKey: "k" })).toThrowError(
      /EMBEDDINGS_OPENAI_BASE_URL/,
    );
    expect(() => new OpenAiEmbedder({ baseUrl: "http://o", apiKey: "" })).toThrowError(
      /EMBEDDINGS_OPENAI_API_KEY/,
    );
  });

  it("uses the OpenAI URL + bearer header when no api-version is set", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/embeddings");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-test");
      expect(headers["api-key"]).toBeUndefined();
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ model: "text-embedding-3-small", input: ["hi"] });
      return jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
    });
    const e = new OpenAiEmbedder({
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-test",
      fetchImpl,
    });
    expect(e.isAzure).toBe(false);
    const res = await e.embed(["hi"]);
    expect(res.vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(res.dimension).toBe(3);
  });

  it("uses the Azure deployment URL + api-key header when api-version is set", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://my.openai.azure.com/openai/deployments/text-embedding-3-large/embeddings?api-version=2024-02-01",
      );
      const headers = init.headers as Record<string, string>;
      expect(headers["api-key"]).toBe("azkey");
      expect(headers.Authorization).toBeUndefined();
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ input: ["hi"] });
      return jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] });
    });
    const e = new OpenAiEmbedder({
      baseUrl: "https://my.openai.azure.com",
      apiKey: "azkey",
      apiVersion: "2024-02-01",
      model: "text-embedding-3-large",
      fetchImpl,
    });
    expect(e.isAzure).toBe(true);
    const res = await e.embed(["hi"]);
    expect(res.vectors).toEqual([[1, 2]]);
  });

  it("defaults to 1536-dim text-embedding-3-small", () => {
    const e = new OpenAiEmbedder({ baseUrl: "http://o", apiKey: "k" });
    expect(e.model).toBe("text-embedding-3-small");
    expect(e.dimension).toBe(1536);
    expect(e.requiresEgress).toBe(true);
  });

  it("propagates upstream auth failures", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "nope" }, 401));
    const e = new OpenAiEmbedder({
      baseUrl: "http://o",
      apiKey: "bad",
      fetchImpl,
      backoffMs: 0,
    });
    await expect(e.embed(["x"])).rejects.toThrowError(/authentication failed/);
  });
});
