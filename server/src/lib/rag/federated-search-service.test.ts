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

vi.mock("../auth/accessible-projects.js", () => {
  const getUserAccessibleProjects = vi.fn();
  const getUserArchivedProjects = vi.fn(async () => []);
  return {
    getUserAccessibleProjects,
    getUserArchivedProjects,
    getUserProjectScope: vi.fn(async (userId: string) => ({
      accessible: await getUserAccessibleProjects(userId),
      archived: (ids: readonly string[]) => getUserArchivedProjects(userId, ids),
    })),
  };
});

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

import { getUserAccessibleProjects, getUserArchivedProjects } from "../auth/accessible-projects.js";

const mockGetAccessible = vi.mocked(getUserAccessibleProjects);
const mockGetArchived = vi.mocked(getUserArchivedProjects);

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
    mockGetArchived.mockResolvedValue([]);
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

    // #2264 — the projects that clear the floor share k by relevance: the next
    // slot goes to whichever project's next hit is most relevant.
    it("shares k between the relevant projects by relevance, each in its own order", async () => {
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

      expect(result.hits.map((h) => h.chunkId)).toEqual(["b1", "b2", "a1"]);
      expect(result.totalHits).toBe(3);
    });

    it("on the verdict scale, never moves a project's hit above one its project ranked higher", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      // Raw logits: A's ranking put a 0.6 verdict above a 0.95, so the 0.95 waits for it.
      const logits: Record<string, ReturnType<typeof makeChunk>[]> = {
        "proj-a": [makeChunk("a1", { score: 0.405 }), makeChunk("a2", { score: 2.944 })],
        "proj-b": [makeChunk("b1", { score: 1.386 }), makeChunk("b2", { score: 0 })],
      };
      const mockKS = {
        search: vi.fn(async (projectId: string) => ({
          hits: logits[projectId] ?? [],
          mode: "hybrid" as const,
          reranked: true,
        })),
      };
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        relevanceFloor: 0,
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["b1", "a1", "a2", "b2"]);
    });

    // The code review's case: with the reranker off a project's order is RRF
    // of its dense and keyword ranks, which the cosine need not follow. A
    // weak-cosine hit ranked first by its keywords capped every hit below it,
    // so the project with the best cosine of all lost every slot.
    it("on the cosine scale, shares the slots on each hit's own cosine, each project in its RRF order", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const hybrid = (id: string, rrf: number, cosine: number) => ({
        ...makeChunk(id, { score: rrf }),
        denseScore: cosine,
        matchedBy: ["dense", "lexical"],
      });
      const mockKS = buildMockKnowledgeService({
        "proj-a": [
          hybrid("a1", 0.033, 0.45),
          hybrid("a2", 0.032, 0.85),
          hybrid("a3", 0.031, 0.84),
          hybrid("a4", 0.03, 0.83),
        ],
        "proj-b": Array.from({ length: 8 }, (_, i) =>
          hybrid(`b${i + 1}`, 0.033 - i * 0.001, 0.8 - i * 0.01),
        ),
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q", k: 8 });

      // A's three cosines above B's best earn it three slots, which it fills
      // from the top of its own ranking: a1 first, as its fusion put it.
      expect(result.hits.map((h) => h.chunkId)).toEqual([
        "a1",
        "a2",
        "a3",
        "b1",
        "b2",
        "b3",
        "b4",
        "b5",
      ]);
      expect(result.projectsWithoutHits).toEqual([]);
      expect(result).not.toHaveProperty("projectsCapped");
    });

    it("breaks a tie between equally relevant hits for the more relevant project", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [makeChunk("a1", { score: 0.6 }), makeChunk("a2", { score: 0.5 })],
        "proj-b": [makeChunk("b1", { score: 0.9 }), makeChunk("b2", { score: 0.5 })],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        relevanceFloor: 0,
      });
      // a2 and b2 tie at 0.5 and depth 1: B, the more relevant project, goes first.
      expect(result.hits.map((h) => h.chunkId)).toEqual(["b1", "a1", "b2", "a2"]);
    });

    it("takes turns, in the order asked for, when share is 'turns'", async () => {
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
        "proj-b": [makeChunk("b1", { score: 0 }), makeChunk("b2", { score: 0.9 })],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        k: 3,
        share: "turns",
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1", "b1", "a2"]);
    });

    // #2336's sweep: distractors that clear the floor took one slot per round
    // from the products holding the answer. Under relevance they take the rest.
    it("gives the excerpts to the answer's product, not one per distractor that clears the floor", async () => {
      const distractors = Array.from({ length: 7 }, (_, i) => `proj-d${i}`);
      mockGetAccessible.mockResolvedValue([
        ...distractors.map((id) => ({ id, name: id })),
        { id: "proj-answer", name: "Answer" },
      ]);
      const mockKS = buildMockKnowledgeService({
        ...Object.fromEntries(
          distractors.map((id) => [
            id,
            [1, 2, 3].map((n) => makeChunk(`${id}-${n}`, { score: 0.63 - n * 0.01 })),
          ]),
        ),
        "proj-answer": [1, 2, 3, 4, 5, 6].map((n) =>
          makeChunk(`ans-${n}`, { score: 0.8 - n * 0.01 }),
        ),
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q", k: 8 });
      const ids = result.hits.map((h) => h.chunkId);
      // Every answer hit first, then the two closest distractor hits.
      expect(ids.slice(0, 6)).toEqual(["ans-1", "ans-2", "ans-3", "ans-4", "ans-5", "ans-6"]);
      expect(ids).toHaveLength(8);
      expect(ids.slice(6)).toEqual(["proj-d0-1", "proj-d1-1"]);
      // The other distractors cleared the floor, so they were cut by k, not irrelevant.
      expect(result.projectsCapped).toEqual(distractors.slice(2));
      expect(result.projectsWithoutHits).toEqual(distractors.slice(2));
    });

    it("lets a relevant project asked for after eight others into the excerpts", async () => {
      const early = Array.from({ length: 8 }, (_, i) => `proj-e${i}`);
      mockGetAccessible.mockResolvedValue([
        ...early.map((id) => ({ id, name: id })),
        { id: "proj-late", name: "Late" },
      ]);
      const mockKS = buildMockKnowledgeService({
        ...Object.fromEntries(early.map((id) => [id, [makeChunk(`${id}-1`, { score: 0.7 })]])),
        "proj-late": [makeChunk("late-1", { score: 0.9 })],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q", k: 8 });
      expect(result.hits[0]!.chunkId).toBe("late-1");
      expect(result.projectsCapped).toEqual(["proj-e7"]);
    });

    it("reports no capped project when every relevant one got a slot", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-c", name: "C" },
      ]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [makeChunk("a1", { score: 0.9 })],
        "proj-c": [makeChunk("c1", { score: 0.1 })],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q" });
      expect(result.projectsWithoutHits).toEqual(["proj-c"]);
      expect(result).not.toHaveProperty("projectsCapped");
    });

    // #2264 — the reranker fell back for one project: its scores are cosines
    // while the other's are cross-encoder verdicts, so both are compared on
    // the dense cosine.
    it("compares every project on the dense cosine when only some were reranked", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = {
        search: vi.fn(async (projectId: string) =>
          projectId === "proj-a"
            ? {
                // A logit of -1 is a verdict of 0.27, far below B's 0.7 cosine,
                // but A's dense match (0.72) is as close as B's.
                hits: [{ ...makeChunk("a1", { score: -1 }), denseScore: 0.72 }],
                mode: "hybrid" as const,
                reranked: true,
              }
            : {
                hits: [{ ...makeChunk("b1", { score: 0.7 }), denseScore: 0.7 }],
                mode: "hybrid" as const,
                reranked: false,
              },
        ),
      };
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({ userId: "user-1", query: "q" });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1", "b1"]);
      expect(result.projectsWithoutHits).toEqual([]);
      // The hit keeps the score a reader labels it with.
      expect(result.hits[0]!.score).toBeCloseTo(1 / (1 + Math.exp(1)));
    });

    it("compares on the dense cosine when one of a project's searches was not reranked", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = {
        search: vi.fn(async (projectId: string, query: string) => ({
          hits:
            projectId === "proj-a"
              ? [{ ...makeChunk(`a-${query}`, { score: 4 }), denseScore: 0.3 }]
              : [{ ...makeChunk(`b-${query}`, { score: 1 }), denseScore: 0.8 }],
          mode: "hybrid" as const,
          // A's second search fell back.
          reranked: !(projectId === "proj-a" && query === "second"),
        })),
      };
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "first",
        moreQueries: ["second"],
      });
      // On the verdicts A (0.98) would lead and B (0.73) clear the floor; on the
      // cosines A (0.3) is far below B (0.8) and is left out.
      expect(result.projectsWithoutHits).toEqual(["proj-a"]);
    });

    it("searches the most recently updated projects over maxProjects, and names the rest", async () => {
      // `getUserAccessibleProjects` returns the most recently updated first.
      mockGetAccessible.mockResolvedValue([
        { id: "proj-new", name: "New" },
        { id: "proj-mid", name: "Mid" },
        { id: "proj-old", name: "Old" },
      ]);
      const mockKS = buildMockKnowledgeService({
        "proj-new": [makeChunk("n1")],
        "proj-mid": [makeChunk("m1")],
        "proj-old": [makeChunk("o1")],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        projectIds: ["proj-old", "proj-mid", "proj-new"],
        maxProjects: 2,
      });
      expect(mockKS.search.mock.calls.map((c) => c[0])).toEqual(["proj-mid", "proj-new"]);
      expect(result.projectsSearched).toEqual(["proj-mid", "proj-new"]);
      expect(result.projectsOverLimit).toEqual(["proj-old"]);
      expect(result.projectNames).toEqual({
        "proj-old": "Old",
        "proj-mid": "Mid",
        "proj-new": "New",
      });
    });

    it("searches every project when the scope is within maxProjects", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = buildMockKnowledgeService({});
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        maxProjects: 2,
      });
      expect(mockKS.search).toHaveBeenCalledTimes(2);
      expect(result).not.toHaveProperty("projectsOverLimit");
    });

    it("names a reachable archived project as archived, not as rejected", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);
      mockGetArchived.mockResolvedValue([{ id: "proj-arch", name: "Old" }]);
      const mockKS = buildMockKnowledgeService({ "proj-a": [makeChunk("a1")] });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        projectIds: ["proj-a", "proj-arch", "proj-secret"],
      });
      // Asked only about the ids the caller cannot search.
      expect(mockGetArchived).toHaveBeenCalledWith("user-1", ["proj-arch", "proj-secret"]);
      expect(result.projectsArchived).toEqual(["proj-arch"]);
      expect(result.projectsRejected).toBe(1);
      expect(result.projectNames).toEqual({ "proj-a": "A", "proj-arch": "Old" });
      expect(mockKS.search.mock.calls.map((c) => c[0])).toEqual(["proj-a"]);
    });

    it("names the archived projects when every requested project is archived", async () => {
      mockGetAccessible.mockResolvedValue([]);
      mockGetArchived.mockResolvedValue([{ id: "proj-arch", name: "Old" }]);
      const mockKS = buildMockKnowledgeService({});
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        projectIds: ["proj-arch"],
      });
      expect(result.projectsArchived).toEqual(["proj-arch"]);
      expect(result.projectsRejected).toBe(0);
      expect(result.projectNames).toEqual({ "proj-arch": "Old" });
      expect(mockKS.search).not.toHaveBeenCalled();
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

  describe("a conversation-aware turn's searches (#2279)", () => {
    /** Each project's hits for each query, keyed by a word the query must contain. */
    function byQuery(impl: Record<string, Record<string, ReturnType<typeof makeChunk>[]>>) {
      return {
        search: vi.fn(async (projectId: string, query: string, _opts: unknown) => {
          const hits = Object.entries(impl[projectId] ?? {})
            .filter(([word]) => query.includes(word))
            .flatMap(([, h]) => h);
          return { hits, mode: "hybrid" as const, reranked: false };
        }),
      };
    }

    it("runs every search in every project, for the caller, limited to the attached documents", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = buildMockKnowledgeService({});
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      await svc.searchAcrossProjects({
        userId: "user-1",
        query: "and in the client?",
        moreQueries: ["second part?"],
        contextualQuery: "and in the client?\nHow is annual billing done?",
        documentIds: ["d1"],
      });
      const calls = mockKS.search.mock.calls.map((c) => [c[0], c[1]]);
      expect(calls).toEqual([
        ["proj-a", "and in the client?"],
        ["proj-a", "second part?"],
        ["proj-a", "and in the client?\nHow is annual billing done?"],
        ["proj-b", "and in the client?"],
        ["proj-b", "second part?"],
        ["proj-b", "and in the client?\nHow is annual billing done?"],
      ]);
      for (const call of mockKS.search.mock.calls) {
        expect(call[2]).toEqual({
          k: 20,
          actor: { userId: "user-1", role: "reader" },
          documentIds: ["d1"],
          embedCache: expect.any(Map),
        });
      }
      // One embedding cache for the whole call, shared by every project's searches.
      const caches = new Set(
        mockKS.search.mock.calls.map((c) => (c[2] as { embedCache: unknown }).embedCache),
      );
      expect(caches.size).toBe(1);
    });

    it("does not repeat a conversational search that is one of the user's own", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);
      const mockKS = buildMockKnowledgeService({});
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        moreQueries: ["q", " "],
        contextualQuery: " q ",
      });
      expect(mockKS.search.mock.calls.map((c) => c[1])).toEqual(["q"]);
    });

    it("a follow-up's conversational search brings in the product the earlier turn was about", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = byQuery({
        // Only the earlier question ("annual billing") finds A's excerpt.
        "proj-a": { annual: [makeChunk("a-annual", { score: 0.8 })] },
        // The latest words alone ("the client") match B, weakly.
        "proj-b": { client: [makeChunk("b-client", { score: 0.3 })] },
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const latestOnly = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "and in the client?",
      });
      expect(latestOnly.hits.map((h) => h.chunkId)).toEqual(["b-client"]);

      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "and in the client?",
        contextualQuery: "and in the client?\nHow is annual billing done?",
      });
      // A, the product the earlier turn was about, is brought in. B stays: it is
      // what the user's own words matched, and A's conversational-only 0.8 does
      // not raise the floor's bar above them.
      expect(result.hits.map((h) => h.chunkId)).toEqual(["a-annual", "b-client"]);
      expect(result.projectsWithoutHits).toEqual([]);
    });

    it("merges a project's searches as single-project chat does: the user's words first", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);
      const mockKS = byQuery({
        "proj-a": {
          // The conversational search ranks c1 first; the user's own ranks u1.
          annual: [makeChunk("c1", { score: 0.9 }), makeChunk("u1", { score: 0.7 })],
          client: [makeChunk("u1", { score: 0.7 })],
        },
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "the client",
        contextualQuery: "the client\nannual",
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["u1", "c1"]);
    });

    it("holds the hits only the conversational search found to a minority of k, across projects", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = byQuery({
        "proj-a": {
          annual: [makeChunk("ac1", { score: 0.8 }), makeChunk("ac2", { score: 0.8 })],
          client: [makeChunk("au1", { score: 0.7 })],
        },
        "proj-b": {
          annual: [makeChunk("bc1", { score: 0.8 }), makeChunk("bc2", { score: 0.8 })],
          client: [makeChunk("bu1", { score: 0.7 })],
        },
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "the client",
        contextualQuery: "the client\nannual",
        k: 5,
      });
      const ids = result.hits.map((h) => h.chunkId);
      // floor((5 - 1) / 2) = 2 conversational-only hits, whichever project holds them.
      expect(ids.filter((id) => id.includes("c")).length).toBe(2);
      expect(ids).toEqual(["au1", "bu1", "ac1", "bc1"]);
    });

    it("never drops a product the user's words matched for another product's conversational-only hits", async () => {
      // The adversarial panel's case: A's only hits come from the earlier topic,
      // B's from the user's own new words. Measured against A's 0.8, B (0.5)
      // fell under the 0.75 floor and 5 of the 8 slots went unused.
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = byQuery({
        "proj-a": { annual: [1, 2, 3, 4, 5].map((n) => makeChunk(`ac${n}`, { score: 0.8 })) },
        "proj-b": { client: [1, 2, 3, 4, 5].map((n) => makeChunk(`bu${n}`, { score: 0.5 })) },
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "and in the client?",
        contextualQuery: "and in the client?\nHow is annual billing done?",
        k: 8,
      });
      const ids = result.hits.map((h) => h.chunkId);
      // B is kept whole; A's conversational-only hits are still held to 3 of 8.
      expect(ids.filter((id) => id.startsWith("bu"))).toEqual(["bu1", "bu2", "bu3", "bu4", "bu5"]);
      expect(ids.filter((id) => id.startsWith("ac"))).toEqual(["ac1", "ac2", "ac3"]);
      expect(ids).toHaveLength(8);
      expect(result.projectsWithoutHits).toEqual([]);
    });

    it("measures the floor against the user's words: Alpha 0.7 stays beside Beta's conversational 1.0", async () => {
      // The code review's case: under the 0.75 floor, Beta's earlier-topic hit
      // at 1.0 set the bar at 0.75 and pushed out Alpha, the user's own match.
      mockGetAccessible.mockResolvedValue([
        { id: "proj-alpha", name: "Alpha" },
        { id: "proj-beta", name: "Beta" },
      ]);
      const mockKS = byQuery({
        "proj-alpha": { client: [makeChunk("alpha-u1", { score: 0.7 })] },
        "proj-beta": { annual: [makeChunk("beta-c1", { score: 1.0 })] },
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "and in the client?",
        contextualQuery: "and in the client?\nHow is annual billing done?",
        relevanceFloor: 0.75,
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["alpha-u1", "beta-c1"]);
      expect(result.projectsWithoutHits).toEqual([]);
    });

    // #2264 code review: C cleared the floor on the earlier topic alone, and the
    // conversational cap, not closer matches, left it out; k was not even full.
    it("does not report as capped a product only the conversational search found", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-c", name: "C" },
      ]);
      const mockKS = byQuery({
        "proj-a": {
          client: [makeChunk("au1", { score: 0.9 })],
          annual: [makeChunk("ac1", { score: 0.95 }), makeChunk("ac2", { score: 0.94 })],
        },
        "proj-c": { annual: [makeChunk("cc1", { score: 0.85 })] },
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "and in the client?",
        contextualQuery: "and in the client?\nHow is annual billing done?",
        k: 5,
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["au1", "ac1", "ac2"]);
      expect(result.projectsWithoutHits).toEqual(["proj-c"]);
      expect(result).not.toHaveProperty("projectsCapped");
    });

    it("still floors a product whose only hits are conversational, against the user's best", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = byQuery({
        "proj-a": { client: [makeChunk("au1", { score: 0.8 })] },
        // Earlier-topic only, and weak beside A's 0.8 from the user's words.
        "proj-b": { annual: [makeChunk("bc1", { score: 0.4 })] },
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "and in the client?",
        contextualQuery: "and in the client?\nHow is annual billing done?",
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["au1"]);
      expect(result.projectsWithoutHits).toEqual(["proj-b"]);
    });

    it("reports a project whose conversational search failed as not searched", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = {
        search: vi.fn(async (projectId: string, query: string) => {
          if (projectId === "proj-b" && query.includes("annual")) throw new Error("boom");
          return { hits: [makeChunk(`${projectId}-1`)], mode: "hybrid", reranked: false };
        }),
      };
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "the client",
        contextualQuery: "the client\nannual",
      });
      expect(result.projectsSearched).toEqual(["proj-a"]);
      expect(result.failures).toEqual([{ projectId: "proj-b", projectName: "B", reason: "error" }]);
      expect(result.hits.map((h) => h.chunkId)).toEqual(["proj-a-1"]);
    });
  });

  describe("chat's absolute relevance floor (#2294)", () => {
    const floorAt = (f: number) => vi.fn((_models: readonly string[]) => f);
    const scored = (id: string, score: number, extra: Record<string, unknown> = {}) => ({
      ...makeChunk(id, { score }),
      ...extra,
    });

    it("drops a weak hit before the merge, so the next one takes its slot", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [scored("a1", 0.8), scored("a2", 0.3), scored("a3", 0.7)],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const absoluteFloor = floorAt(0.55);
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        k: 2,
        absoluteFloor,
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1", "a3"]);
      // Of the two the merge would have returned, one fell below the floor.
      expect(result.belowFloor).toBe(1);
      // The floor is read for the embedders the hits were scored with.
      expect(absoluteFloor).toHaveBeenCalledWith([
        "text-embedding-3-small",
        "text-embedding-3-small",
        "text-embedding-3-small",
      ]);
    });

    it("leaves out a product whose every hit is below it, and compares the rest on what remains", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [scored("a1", 0.6)],
        // B's best is weak; without the floor it would set the relative bar.
        "proj-b": [scored("b1", 0.5)],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        absoluteFloor: floorAt(0.55),
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1"]);
      expect(result.projectsWithoutHits).toEqual(["proj-b"]);
      expect(result.belowFloor).toBe(1);
    });

    it("reads a reranked project's dense cosine, not the cross-encoder's verdict", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);
      const mockKS = {
        search: vi.fn(async () => ({
          hits: [
            scored("strong", 3, { denseScore: 0.7 }),
            // A confident cross-encoder, but a weak dense match.
            scored("weak", 4, { denseScore: 0.3 }),
          ],
          mode: "hybrid" as const,
          reranked: true,
        })),
      };
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        absoluteFloor: floorAt(0.55),
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["strong"]);
      expect(result.hits[0]!.denseScore).toBe(0.7);
    });

    it("compares the products on the relevance of the hits the floor kept", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const mockKS = {
        search: vi.fn(async (projectId: string) =>
          projectId === "proj-a"
            ? {
                // The cross-encoder's favourite is a weak dense match; what is
                // left of A is far less relevant than B, on the verdict both
                // projects were scored with (#2264: one scale).
                hits: [
                  scored("a-top", 6, { denseScore: 0.3 }),
                  scored("a-rest", -1, { denseScore: 0.7 }),
                ],
                mode: "hybrid" as const,
                reranked: true,
              }
            : {
                hits: [scored("b1", 0.6, { denseScore: 0.6 })],
                mode: "hybrid" as const,
                reranked: true,
              },
        ),
      };
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        absoluteFloor: floorAt(0.55),
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["b1"]);
      expect(result.projectsWithoutHits).toEqual(["proj-a"]);
    });

    it("keeps a keyword-only hit only when a dense hit of its own project cleared the floor", async () => {
      mockGetAccessible.mockResolvedValue([
        { id: "proj-a", name: "A" },
        { id: "proj-b", name: "B" },
      ]);
      const lexical = (id: string) => scored(id, 0, { matchedBy: ["lexical"] });
      const mockKS = buildMockKnowledgeService({
        "proj-a": [lexical("a-kw"), scored("a1", 0.7)],
        "proj-b": [lexical("b-kw")],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const kept = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        relevanceFloor: 0,
        absoluteFloor: floorAt(0.55),
      });
      // B has no dense hit of its own: A's strong hit does not vouch for B's keyword-only one.
      expect(kept.hits.map((h) => h.chunkId).sort()).toEqual(["a-kw", "a1"]);
      expect(kept.belowFloor).toBe(1);

      const weak = buildMockKnowledgeService({
        "proj-a": [lexical("a-kw"), scored("a1", 0.3)],
        "proj-b": [lexical("b-kw")],
      });
      const none = await new FederatedSearchService({
        knowledgeService: weak as never,
      }).searchAcrossProjects({
        userId: "user-1",
        query: "q",
        relevanceFloor: 0,
        absoluteFloor: floorAt(0.55),
      });
      expect(none.hits).toEqual([]);
      expect(none.belowFloor).toBe(3);
    });

    it("changes nothing when the floor is off for these embedders", async () => {
      mockGetAccessible.mockResolvedValue([{ id: "proj-a", name: "A" }]);
      const mockKS = buildMockKnowledgeService({
        "proj-a": [scored("a1", 0.8), scored("a2", 0.1)],
      });
      const svc = new FederatedSearchService({ knowledgeService: mockKS as never });
      const result = await svc.searchAcrossProjects({
        userId: "user-1",
        query: "q",
        absoluteFloor: floorAt(0),
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["a1", "a2"]);
      expect(result.belowFloor).toBe(0);
    });
  });
});
