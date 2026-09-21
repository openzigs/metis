/**
 * Issue #536 — Unit tests for the federated search service.
 *
 * Tests: RRF fusion, ACL filtering, timeout handling, partial results, empty results.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FederatedSearchService,
  __resetFederatedSearchSingleton,
} from "./federated-search-service.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../auth/accessible-projects.js", () => ({
  getUserAccessibleProjects: vi.fn(),
}));

vi.mock("./knowledge-service.js", () => ({
  getKnowledgeService: vi.fn(() => ({
    search: vi.fn(),
  })),
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { getUserAccessibleProjects } from "../auth/accessible-projects.js";

const mockGetAccessible = vi.mocked(getUserAccessibleProjects);

// Helper to build a mock KnowledgeService
function buildMockKnowledgeService(impl: Record<string, unknown[]>) {
  return {
    search: vi.fn(async (projectId: string, _query: string, _opts: unknown) => {
      const hits = (impl[projectId] ?? []) as Array<{
        chunkId: string;
        documentId: string;
        filename: string;
        position: number;
        text: string;
        score: number;
        embeddingModel: string;
      }>;
      return { hits, mode: "hybrid" as const, reranked: false };
    }),
  };
}

function makeChunk(
  chunkId: string,
  opts: Partial<{
    documentId: string;
    filename: string;
    position: number;
    text: string;
    score: number;
  }> = {},
) {
  return {
    chunkId,
    documentId: opts.documentId ?? "doc-1",
    filename: opts.filename ?? "readme.md",
    position: opts.position ?? 0,
    text: opts.text ?? `Content of ${chunkId}`,
    score: opts.score ?? 0.9,
    embeddingModel: "text-embedding-3-small",
  };
}

describe("FederatedSearchService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetFederatedSearchSingleton();
  });

  describe("searchAcrossProjects", () => {
    it("returns empty results for empty query", async () => {
      const svc = new FederatedSearchService();
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "",
      });
      expect(result.hits).toHaveLength(0);
      expect(result.projectsSearched).toHaveLength(0);
    });

    it("searches all accessible projects when no projectIds specified", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "Project A" },
        { id: "proj-b", name: "Project B" },
        { id: "proj-c", name: "Project C" },
      ]);

      const mockKS = buildMockKnowledgeService({
        "proj-a": [makeChunk("chunk-a1", { score: 0.95 }), makeChunk("chunk-a2", { score: 0.8 })],
        "proj-b": [makeChunk("chunk-b1", { score: 0.9 })],
        "proj-c": [makeChunk("chunk-c1", { score: 0.85 })],
      });

      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "test query",
        k: 10,
      });

      expect(result.projectsSearched).toHaveLength(3);
      expect(result.projectsFailed).toHaveLength(0);
      expect(result.hits.length).toBeGreaterThan(0);
      // All hits have project provenance
      for (const hit of result.hits) {
        expect(hit.projectId).toBeTruthy();
        expect(hit.projectName).toBeTruthy();
      }
    });

    it("applies RRF fusion across 3 projects correctly", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
        { id: "proj-c", name: "C" },
      ]);

      // Each project has 2 results with decreasing scores
      const mockKS = buildMockKnowledgeService({
        "proj-a": [makeChunk("chunk-1", { score: 0.95 }), makeChunk("chunk-2", { score: 0.8 })],
        "proj-b": [makeChunk("chunk-3", { score: 0.9 }), makeChunk("chunk-1", { score: 0.7 })],
        "proj-c": [makeChunk("chunk-4", { score: 0.85 }), makeChunk("chunk-2", { score: 0.75 })],
      });

      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "test",
        k: 10,
      });

      // chunk-1 appears in proj-a (rank 1) and proj-b (rank 2)
      // RRF score = 1/(60+1) + 1/(60+2) = 1/61 + 1/62 ≈ 0.0325
      // chunk-2 appears in proj-a (rank 2) and proj-c (rank 2)
      // RRF score = 1/(60+2) + 1/(60+2) = 2/62 ≈ 0.0323
      // Both should rank higher than single-appearance chunks
      const chunk1 = result.hits.find((h) => h.chunkId === "chunk-1");
      const chunk3 = result.hits.find((h) => h.chunkId === "chunk-3");
      expect(chunk1).toBeDefined();
      expect(chunk3).toBeDefined();
      // chunk-1 (appears in 2 projects) should rank higher than chunk-3 (1 project)
      expect(chunk1!.score).toBeGreaterThan(chunk3!.score);
    });

    it("filters by ACL — only searches accessible projects", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);

      const mockKS = buildMockKnowledgeService({
        "proj-a": [makeChunk("chunk-a1")],
        "proj-b": [makeChunk("chunk-b1")],
      });

      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });

      // Request proj-a, proj-b, and proj-secret (not accessible)
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "test",
        projectIds: ["proj-a", "proj-b", "proj-secret"],
      });

      // Only proj-a and proj-b should be searched
      expect(result.projectsSearched).toEqual(expect.arrayContaining(["proj-a", "proj-b"]));
      expect(result.projectsSearched).not.toContain("proj-secret");
      // No hits from proj-secret
      expect(result.hits.every((h) => h.projectId !== "proj-secret")).toBe(true);
    });

    it("rejects all project IDs the user cannot access", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);

      const mockKS = buildMockKnowledgeService({});
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });

      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "test",
        projectIds: ["proj-secret", "proj-hidden"],
      });

      expect(result.hits).toHaveLength(0);
      expect(result.projectsSearched).toHaveLength(0);
    });

    it("handles timeout — one project times out, others return", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-fast", name: "Fast" },
        { id: "proj-slow", name: "Slow" },
      ]);

      const mockKS = {
        search: vi.fn(async (projectId: string) => {
          if (projectId === "proj-slow") {
            // Simulate a slow response that exceeds timeout
            await new Promise((resolve) => setTimeout(resolve, 200));
            return { hits: [makeChunk("slow-chunk")], mode: "hybrid", reranked: false };
          }
          return { hits: [makeChunk("fast-chunk")], mode: "hybrid", reranked: false };
        }),
      };

      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "test",
        timeoutMs: 50, // Very short timeout to trigger failure
      });

      expect(result.projectsSearched).toContain("proj-fast");
      expect(result.projectsFailed).toContain("proj-slow");
      expect(result.hits.some((h) => h.chunkId === "fast-chunk")).toBe(true);
    });

    it("returns partial results when some projects fail", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-ok", name: "OK" },
        { id: "proj-err", name: "Error" },
      ]);

      const mockKS = {
        search: vi.fn(async (projectId: string) => {
          if (projectId === "proj-err") {
            throw new Error("Database connection failed");
          }
          return {
            hits: [makeChunk("ok-chunk")],
            mode: "hybrid",
            reranked: false,
          };
        }),
      };

      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "test",
      });

      expect(result.projectsSearched).toContain("proj-ok");
      expect(result.projectsFailed).toContain("proj-err");
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].chunkId).toBe("ok-chunk");
    });

    it("returns empty results when no matches found", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);

      const mockKS = buildMockKnowledgeService({
        "proj-a": [],
        "proj-b": [],
      });

      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "nonexistent term",
      });

      expect(result.hits).toHaveLength(0);
      expect(result.projectsSearched).toHaveLength(2);
      expect(result.projectsFailed).toHaveLength(0);
      expect(result.totalHits).toBe(0);
    });

    it("respects k parameter to limit results", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);

      const manyChunks = Array.from({ length: 20 }, (_, i) =>
        makeChunk(`chunk-${i}`, { score: 1 - i * 0.01 }),
      );

      const mockKS = buildMockKnowledgeService({ "proj-a": manyChunks });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "test",
        k: 5,
      });

      expect(result.hits).toHaveLength(5);
    });

    it("returns empty for user with no accessible projects", async () => {
      mockGetAccessible.mockResolvedValue([]);

      const mockKS = buildMockKnowledgeService({});
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-lonely",
        query: "test",
      });

      expect(result.hits).toHaveLength(0);
      expect(result.projectsSearched).toHaveLength(0);
    });
  });
});
