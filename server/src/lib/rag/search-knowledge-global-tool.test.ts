/**
 * Issue #534 — Unit tests for search-knowledge-global tool.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSearchKnowledgeGlobalTool } from "./search-knowledge-global-tool.js";
import type { FederatedSearchService } from "./federated-search-service.js";

function mockService(
  result: Partial<Awaited<ReturnType<FederatedSearchService["searchAcrossProjects"]>>>,
): FederatedSearchService {
  return {
    searchAcrossProjects: vi.fn().mockResolvedValue({
      hits: [],
      projectsSearched: [],
      projectsFailed: [],
      totalHits: 0,
      ...result,
    }),
  } as unknown as FederatedSearchService;
}

describe("search-knowledge-global tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when userId is missing", async () => {
    const tool = buildSearchKnowledgeGlobalTool();
    const result = await tool.exec({ query: "test" }, {
      sessionId: "sess-1",
      userId: "",
      projectId: undefined,
    } as never);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("authentication required");
  });

  it("calls federated search with correct parameters", async () => {
    const svc = mockService({
      hits: [
        {
          chunkId: "c1",
          projectId: "p1",
          projectName: "Proj 1",
          documentId: "d1",
          filename: "readme.md",
          position: 0,
          text: "Hello world",
          score: 0.95,
        },
      ],
      projectsSearched: ["p1"],
      projectsFailed: [],
      totalHits: 1,
    });

    const tool = buildSearchKnowledgeGlobalTool({ service: svc });
    const result = await tool.exec({ query: "hello", projectIds: ["p1"], k: 5 }, {
      sessionId: "sess-1",
      userId: "user-1",
      projectId: undefined,
    } as never);

    expect(svc.searchAcrossProjects).toHaveBeenCalledWith({
      userId: "user-1",
      projectIds: ["p1"],
      query: "hello",
      k: 5,
    });
    expect(result.text).toContain("[Proj 1]");
    expect(result.text).toContain("readme.md#0");
    expect(result.text).toContain("Hello world");
  });

  it("reports no matches clearly", async () => {
    const svc = mockService({
      hits: [],
      projectsSearched: ["p1", "p2"],
      projectsFailed: [],
      totalHits: 0,
    });

    const tool = buildSearchKnowledgeGlobalTool({ service: svc });
    const result = await tool.exec({ query: "nonexistent" }, {
      sessionId: "sess-1",
      userId: "user-1",
      projectId: undefined,
    } as never);

    expect(result.text).toContain("no matches");
    expect(result.text).toContain("2 project(s)");
  });

  it("includes warning when projects fail", async () => {
    const svc = mockService({
      hits: [
        {
          chunkId: "c1",
          projectId: "p1",
          projectName: "Good",
          documentId: "d1",
          filename: "file.md",
          position: 1,
          text: "Content",
          score: 0.8,
        },
      ],
      projectsSearched: ["p1"],
      projectsFailed: ["p2"],
      totalHits: 1,
    });

    const tool = buildSearchKnowledgeGlobalTool({ service: svc });
    const result = await tool.exec({ query: "test" }, {
      sessionId: "sess-1",
      userId: "user-1",
      projectId: undefined,
    } as never);

    expect(result.text).toContain("1 project(s) timed out or failed");
  });
});
