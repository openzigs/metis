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

// #2225 — the caller's role read is covered in tests/rag-acl-user-retrieval-2225.test.ts.
vi.mock("./acl.js", async (original) => ({
  ...(await original<typeof import("./acl.js")>()),
  resolveAclActor: async (userId: string) => ({ userId, role: "reader" }),
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

    // #717 — the repo path a project search set survives fusion, so the
    // global tool can name the file by it.
    it("carries a repo hit's path through cross-project fusion", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [
          {
            ...makeChunk("chunk-a1", { filename: "connector:repo:c1:src/internal/model/feed.go" }),
            path: "internal/model/feed.go",
          },
          makeChunk("chunk-a2"),
        ],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "Feed", k: 5 });
      const repo = result.hits.find((h) => h.chunkId === "chunk-a1");
      expect(repo?.path).toBe("internal/model/feed.go");
      expect(result.hits.find((h) => h.chunkId === "chunk-a2")).not.toHaveProperty("path");
    });

    // #2238 — fusion on relevance, not rank: under RRF an irrelevant project's
    // first hit scored exactly as high as the relevant project's first hit.
    it("leaves out a project whose best hit is far less relevant than the best project's", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
        { id: "proj-c", name: "C" },
      ]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [makeChunk("a1", { score: 0.82 }), makeChunk("a2", { score: 0.7 })],
        "proj-b": [makeChunk("b1", { score: 0.78 }), makeChunk("b2", { score: 0.6 })],
        // Ranked first in its own project, but barely related to the query.
        "proj-c": [makeChunk("c1", { score: 0.21 })],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q", k: 10 });

      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1", "b1", "a2", "b2"]);
      expect(result.projectsSearched).toEqual(["proj-a", "proj-b", "proj-c"]);
      expect(result.projectsWithoutHits).toEqual(["proj-c"]);
      expect(result.hits[0].score).toBeCloseTo(0.82);
    });

    it("shares k between the relevant projects, in the order asked for, each in its own order", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [
          makeChunk("a1", { score: 0.7 }),
          makeChunk("a2", { score: 0.69 }),
          makeChunk("a3", { score: 0.68 }),
        ],
        // B's own order stands: a keyword-only hit (score 0) ranked first stays first.
        "proj-b": [makeChunk("b1", { score: 0 }), makeChunk("b2", { score: 0.9 })],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q", k: 3 });

      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1", "b1", "a2"]);
      expect(result.totalHits).toBe(3);
    });

    it("keeps every project in when the floor is 0", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-c", name: "C" },
      ]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [makeChunk("a1", { score: 0.9 })],
        "proj-c": [makeChunk("c1", { score: 0.1 })],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        relevanceFloor: 0,
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1", "c1"]);
      expect(result.projectsWithoutHits).toEqual([]);
    });

    it("compares reranked projects on the cross-encoder's verdict", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = {
        search: vi.fn(async (projectId: string) => ({
          // Raw logits: a strong match in A, a clear non-match in B.
          hits:
            projectId === "proj-a"
              ? [makeChunk("a1", { score: 4 })]
              : [makeChunk("b1", { score: -6 })],
          mode: "hybrid" as const,
          reranked: true,
        })),
      };
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q" });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1"]);
      expect(result.hits[0].score).toBeCloseTo(1 / (1 + Math.exp(-4)));
    });

    it("keeps one copy of a chunk two rankings both return", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [makeChunk("same", { score: 0.8 })],
        "proj-b": [makeChunk("same", { score: 0.8 }), makeChunk("b2", { score: 0.7 })],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q" });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["same", "b2"]);
    });

    it("searches every project with the caller as the chunk-ACL actor (#2225)", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = buildMockKnowledgeService({});
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      await svc.searchAcrossProjects({ userId: "user-1", query: "q" });
      expect(mockKS.search).toHaveBeenCalledTimes(2);
      for (const call of mockKS.search.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ actor: { userId: "user-1", role: "reader" } }),
        );
      }
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
      // #2238 — counted, never named.
      expect(result.projectsRejected).toBe(2);
      expect(result.projectNames).toEqual({});
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
      // #2238 — the project is named, with why, so a reader can say so.
      expect(result.failures).toEqual([
        { projectId: "proj-slow", projectName: "Slow", reason: "timeout" },
      ]);
      expect(result.projectNames).toEqual({ "proj-fast": "Fast", "proj-slow": "Slow" });
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
      expect(result.failures).toEqual([
        { projectId: "proj-err", projectName: "Error", reason: "error" },
      ]);
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
