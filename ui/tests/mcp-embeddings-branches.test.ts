/**
 * Issue #121 extended — quick tests for mcp-api.ts and embeddings-api.ts
 * to cover the remaining uncovered branches (both at 0%).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
const mock = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mock.mockReset();
});

// ─── mcp-api branches ─────────────────────────────────────────────────────────

import { mcpApi, mcpPlatformApi } from "@/lib/mcp-api";

describe("mcpApi — uncovered branches", () => {
  it("list calls /mcp endpoint", async () => {
    mock.mockResolvedValueOnce({ items: [] });
    await mcpApi.list();
    expect(mock).toHaveBeenCalledWith("/mcp", expect.anything());
  });
});

describe("mcpPlatformApi — uncovered branches", () => {
  it("refreshFederation without source (no params)", async () => {
    mock.mockResolvedValueOnce({ results: [] });
    await mcpPlatformApi.refreshFederation();
    expect(mock).toHaveBeenCalledWith(
      "/mcp/federation/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refreshFederation with source (smithery branch)", async () => {
    mock.mockResolvedValueOnce({ results: [] });
    await mcpPlatformApi.refreshFederation("smithery");
    expect(mock).toHaveBeenCalledWith(
      "/mcp/federation/refresh",
      expect.objectContaining({ method: "POST", params: { source: "smithery" } }),
    );
  });
});

// ─── embeddings-api branches ─────────────────────────────────────────────────

import { embeddingsApi } from "@/lib/embeddings-api";

describe("embeddingsApi", () => {
  it("status calls correct endpoint", async () => {
    mock.mockResolvedValueOnce({ active: {}, backends: [] });
    await embeddingsApi.status();
    expect(mock).toHaveBeenCalledWith("/admin/embeddings");
  });

  it("coverage calls correct endpoint", async () => {
    mock.mockResolvedValueOnce({ totalChunks: 0 });
    await embeddingsApi.coverage("p1");
    expect(mock).toHaveBeenCalledWith(expect.stringContaining("p1/coverage"));
  });

  it("reindex without batchSize (default branch)", async () => {
    mock.mockResolvedValueOnce({ reindexed: 5 });
    await embeddingsApi.reindex("p1");
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("p1/reindex"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reindex with batchSize (explicit branch)", async () => {
    mock.mockResolvedValueOnce({ reindexed: 10 });
    await embeddingsApi.reindex("p1", { batchSize: 100 });
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("p1/reindex"),
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ batchSize: 100 }),
      }),
    );
  });
});
