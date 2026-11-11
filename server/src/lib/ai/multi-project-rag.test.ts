/**
 * #2238 — automatic retrieval for a chat scoped to several products: the prompt
 * block and the grounding of one turn, from a stubbed federated search.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  FederatedSearchOptions,
  FederatedSearchResult,
} from "../rag/federated-search-service.js";
import { buildMultiProjectRagContext, readChatSearchScope } from "./multi-project-rag.js";
import { parseScopeProjectIds, type ChatSearchScope } from "./chat-search-scope.js";

vi.mock("../config/config-service.js", () => ({
  getConfigService: () => ({
    getNumber: (key: string, d: number) =>
      key === "CHAT_MULTI_PROJECT_RELEVANCE_FLOOR_PCT" ? 60 : d,
  }),
}));

function hit(projectId: string, projectName: string, chunkId: string, text: string, score = 0.8) {
  return {
    chunkId,
    projectId,
    projectName,
    documentId: `doc-${chunkId}`,
    filename: `${chunkId}.md`,
    position: 0,
    text,
    score,
  };
}

function result(over: Partial<FederatedSearchResult> = {}): FederatedSearchResult {
  return {
    hits: [],
    projectsSearched: [],
    projectsFailed: [],
    totalHits: 0,
    projectsWithoutHits: [],
    failures: [],
    projectsRejected: 0,
    projectNames: {},
    ...over,
  };
}

const twoProducts: ChatSearchScope = { kind: "projects", projectIds: ["pa", "pb"] };

describe("readChatSearchScope (#2238)", () => {
  it("reads a multi-product scope from a session with no single project", () => {
    expect(
      readChatSearchScope({ projectId: null, scopeProjectIds: JSON.stringify(["pa", "pb"]) }),
    ).toEqual({ kind: "projects", projectIds: ["pa", "pb"] });
    expect(readChatSearchScope({ projectId: null, scopeWorkspaceId: "w1" })).toEqual({
      kind: "workspace",
      workspaceId: "w1",
    });
  });

  it("is null for a single-project session, an unscoped one, or a malformed scope", () => {
    expect(
      readChatSearchScope({ projectId: "pa", scopeProjectIds: JSON.stringify(["pa", "pb"]) }),
    ).toBeNull();
    expect(readChatSearchScope({ projectId: null })).toBeNull();
    expect(readChatSearchScope({ projectId: null, scopeProjectIds: '["pa"]' })).toBeNull();
    expect(readChatSearchScope({ projectId: null, scopeProjectIds: "{" })).toBeNull();
  });

  it("parses only a list of non-empty ids, de-duplicated", () => {
    expect(parseScopeProjectIds('["a","b","a"]')).toEqual(["a", "b"]);
    expect(parseScopeProjectIds('["a",1]')).toBeNull();
    expect(parseScopeProjectIds('{"a":1}')).toBeNull();
    expect(parseScopeProjectIds(null)).toBeNull();
  });
});

describe("buildMultiProjectRagContext (#2238)", () => {
  it("searches every project in the scope, for the caller, with the configured relevance floor", async () => {
    const search = vi.fn(async (_o: FederatedSearchOptions) => result());
    await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "how does rule X work?",
      deps: { search },
    });
    expect(search).toHaveBeenCalledWith({
      userId: "u1",
      projectIds: ["pa", "pb"],
      query: "how does rule X work?",
      k: 8,
      relevanceFloor: 0.6,
    });
  });

  it("labels each excerpt with its product, tells the model to attribute claims, and grounds per project", async () => {
    const capture = { contexts: [] as string[], sources: 0 };
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "what changes in A and B?",
      capture,
      deps: {
        search: async () =>
          result({
            hits: [
              hit("pa", "Alpha", "a1", "Alpha retries three times."),
              hit("pb", "Beta", "b1", "Beta never retries."),
              hit("pa", "Alpha", "a2", "Alpha logs every retry."),
            ],
            projectsSearched: ["pa", "pb"],
            projectNames: { pa: "Alpha", pb: "Beta" },
          }),
      },
    });

    expect(out.block).toContain("## Retrieved Knowledge (multi-product RAG)");
    expect(out.block).toContain('scoped to 2 products: "Alpha" and "Beta"');
    expect(out.block).toContain("attribute every claim to its product by name");
    expect(out.block).toContain("[1] [Alpha] a1.md#0");
    expect(out.block).toContain("[2] [Beta] b1.md#0");
    expect(out.block).toContain("Beta never retries.");
    expect(out.grounding).toEqual({
      status: "multi",
      projects: [
        { projectId: "pa", projectName: "Alpha", sources: 2 },
        { projectId: "pb", projectName: "Beta", sources: 1 },
      ],
    });
    expect(capture.sources).toBe(3);
    expect(capture.contexts).toHaveLength(3);
    expect(capture.contexts[1]).toContain("[Beta]");
  });

  it("names a project that timed out, in the block and on the grounding", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "projects", projectIds: ["pa", "pc"] },
      query: "q",
      deps: {
        search: async () =>
          result({
            hits: [hit("pa", "Alpha", "a1", "x")],
            projectsSearched: ["pa"],
            projectsFailed: ["pc"],
            failures: [{ projectId: "pc", projectName: "Gamma", reason: "timeout" }],
            projectNames: { pa: "Alpha", pc: "Gamma" },
          }),
      },
    });
    expect(out.block).toContain('Could not be searched this turn: "Gamma" (timed out)');
    expect(out.block).toContain("Name it in your answer");
    expect(out.block).toContain('scoped to 2 products: "Alpha" and "Gamma"');
    expect(out.grounding).toEqual({
      status: "multi",
      projects: [{ projectId: "pa", projectName: "Alpha", sources: 1 }],
      unsearched: [{ projectId: "pc", projectName: "Gamma", reason: "timeout" }],
    });
  });

  it("names a searched project that contributed nothing, and counts the ones the caller lost", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "projects", projectIds: ["pa", "pb", "gone"] },
      query: "q",
      deps: {
        search: async () =>
          result({
            hits: [hit("pa", "Alpha", "a1", "x")],
            projectsSearched: ["pa", "pb"],
            projectsWithoutHits: ["pb"],
            projectsRejected: 1,
            projectNames: { pa: "Alpha", pb: "Beta" },
          }),
      },
    });
    expect(out.block).toContain('Searched, but no excerpt from it is included above: "Beta"');
    expect(out.block).toContain("1 more project(s) in this chat's scope are no longer available");
    expect(out.block).not.toContain("gone");
    expect(out.grounding).toMatchObject({
      projects: [
        { projectId: "pa", sources: 1 },
        { projectId: "pb", sources: 0 },
      ],
      unavailable: 1,
    });
  });

  it("says no excerpt matched when every project was searched and none contributed", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      deps: {
        search: async () =>
          result({ projectsSearched: ["pa", "pb"], projectNames: { pa: "Alpha", pb: "Beta" } }),
      },
    });
    expect(out.block).toContain("No excerpt from their sources matched this question");
    expect(out.block).not.toContain("Searched, but no excerpt");
  });

  it("resolves a workspace scope to the projects of it the caller can open now", async () => {
    const workspaceProjects = vi.fn(async () => ["pa", "pb"]);
    const search = vi.fn(async () => result());
    await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "workspace", workspaceId: "w1" },
      query: "q",
      deps: { search, workspaceProjects, role: async () => "coordinator" },
    });
    expect(workspaceProjects).toHaveBeenCalledWith({ id: "u1", role: "coordinator" }, "w1");
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ["pa", "pb"] }));
  });

  it("fails closed and says so when the caller has left the workspace", async () => {
    const search = vi.fn(async () => result());
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "workspace", workspaceId: "w1" },
      query: "q",
      deps: {
        search,
        role: async () => "reader",
        workspaceProjects: async () => {
          throw new Error("Workspace not found");
        },
      },
    });
    expect(search).not.toHaveBeenCalled();
    expect(out.block).toContain("its workspace is no longer available to you");
    expect(out.grounding).toEqual({ status: "multi", projects: [] });
  });

  it("searches nothing for a workspace with no project the caller can open", async () => {
    const search = vi.fn(async () => result());
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "workspace", workspaceId: "w1" },
      query: "q",
      deps: { search, role: async () => "reader", workspaceProjects: async () => [] },
    });
    expect(search).not.toHaveBeenCalled();
    expect(out.block).toContain("none of its projects is available to you");
  });

  it("says nothing was searched when every project in the scope is now out of reach", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      deps: { search: async () => result({ projectsRejected: 2 }) },
    });
    expect(out.block).toContain("none of its projects is available to you");
    expect(out.grounding).toEqual({ status: "multi", projects: [], unavailable: 2 });
  });

  it("reports a failed search instead of answering as if grounded", async () => {
    const capture = { contexts: [] as string[], sources: 0 };
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      capture,
      deps: {
        search: async () => {
          throw new Error("role read failed");
        },
      },
    });
    expect(out.block).toContain("their sources could not be searched this turn");
    expect(out.grounding).toEqual({ status: "multi", projects: [] });
    expect(capture.sources).toBe(0);
  });

  it("retrieves nothing for an empty message, and searches with at most 2,048 characters", async () => {
    const search = vi.fn(async (_o: FederatedSearchOptions) => result());
    expect(
      await buildMultiProjectRagContext({
        userId: "u1",
        scope: twoProducts,
        query: "   ",
        deps: { search },
      }),
    ).toEqual({ block: "", grounding: { status: "multi", projects: [] } });
    expect(search).not.toHaveBeenCalled();
    await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "x".repeat(5000),
      deps: { search },
    });
    expect(search.mock.calls[0][0].query).toHaveLength(2048);
  });
});
