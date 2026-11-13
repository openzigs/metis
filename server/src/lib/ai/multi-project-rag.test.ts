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

describe("buildMultiProjectRagContext reads the conversation (#2279)", () => {
  const actor = { userId: "u1", role: "reader" } as never;
  const searched = (projectsSearched = ["pa", "pb"], hits: ReturnType<typeof hit>[] = []) =>
    result({ hits, projectsSearched, projectNames: { pa: "Alpha", pb: "Beta" } });
  const carriedChunk = (chunkId: string, documentId = `doc-${chunkId}`) => ({
    chunkId,
    documentId,
    filename: `${chunkId}.md`,
    position: 2,
    text: `Text of ${chunkId}.`,
    score: 0,
    embeddingModel: "stub",
    source: "upload" as const,
  });

  it("searches a follow-up with the turn before it, the user's own words first", async () => {
    const search = vi.fn(async (_o: FederatedSearchOptions) => result());
    await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      history: [
        { role: "user", content: "How is annual billing done?" },
        { role: "assistant", content: "Alpha bills annual plans up front." },
      ],
      query: "and in the client?",
      deps: { search },
    });
    expect(search).toHaveBeenCalledWith({
      userId: "u1",
      projectIds: ["pa", "pb"],
      query: "and in the client?",
      contextualQuery: "and in the client?\nHow is annual billing done?",
      k: 8,
      relevanceFloor: 0.6,
    });
  });

  it("searches each part of a multi-part question on its own too", async () => {
    const search = vi.fn(async (_o: FederatedSearchOptions) => result());
    await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "How does Alpha retry payments? And how does Beta refund them?",
      deps: { search },
    });
    expect(search.mock.calls[0]![0].moreQueries).toEqual([
      "How does Alpha retry payments?",
      "And how does Beta refund them?",
    ]);
    expect(search.mock.calls[0]![0].contextualQuery).toBeUndefined();
  });

  it("keeps the excerpts the previous answer cited, labelled with their product, for the caller", async () => {
    const loadChunks = vi.fn(async (projectId: string, ids: readonly string[], _actor: unknown) =>
      projectId === "pb" ? ids.filter((id) => id === "b9").map((id) => carriedChunk(id)) : [],
    );
    const aclActor = vi.fn(async () => actor);
    const capture = { contexts: [] as string[], sources: 0 };
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "and in the client?",
      carryForward: ["b9", "a1"],
      capture,
      deps: {
        search: async () => searched(["pa", "pb"], [hit("pa", "Alpha", "a1", "Alpha client.")]),
        loadChunks,
        aclActor,
      },
    });
    expect(aclActor).toHaveBeenCalledWith("u1");
    expect(loadChunks.mock.calls.map((c) => c[0]).sort()).toEqual(["pa", "pb"]);
    for (const c of loadChunks.mock.calls) expect(c[2]).toBe(actor);
    expect(out.block).toContain("[1] [Alpha] a1.md#0");
    expect(out.block).toContain("[2] [Beta] b9.md#2 (cited in your previous answer)\nText of b9.");
    expect(out.block).toContain('An excerpt marked "cited in your previous answer"');
    // The carried excerpt is one the model was shown: it counts for its product.
    expect(out.grounding).toEqual({
      status: "multi",
      projects: [
        { projectId: "pa", projectName: "Alpha", sources: 1 },
        { projectId: "pb", projectName: "Beta", sources: 1 },
      ],
    });
    expect(capture.sources).toBe(2);
    expect(capture).toMatchObject({
      excerpts: [
        { n: 1, chunkId: "a1", name: "a1.md", locator: "a1.md#0" },
        { n: 2, chunkId: "b9", name: "b9.md", locator: "b9.md#2", source: "upload" },
      ],
    });
  });

  it("does not repeat a cited excerpt this turn's search found again", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      carryForward: ["a1"],
      deps: {
        search: async () => searched(["pa", "pb"], [hit("pa", "Alpha", "a1", "Alpha client.")]),
        loadChunks: async (projectId) => (projectId === "pa" ? [carriedChunk("a1")] : []),
        aclActor: async () => actor,
      },
    });
    expect(out.block).not.toContain("cited in your previous answer");
    expect(out.block.match(/a1\.md/g)).toHaveLength(1);
  });

  it("reads carried excerpts only from projects the caller can still reach", async () => {
    const loadChunks = vi.fn(async (_projectId: string) => [carriedChunk("x")]);
    await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "projects", projectIds: ["pa", "gone"] },
      query: "q",
      carryForward: ["x"],
      deps: {
        search: async () =>
          result({ projectsSearched: ["pa"], projectsRejected: 1, projectNames: { pa: "Alpha" } }),
        loadChunks,
        aclActor: async () => actor,
      },
    });
    expect(loadChunks.mock.calls.map((c) => c[0])).toEqual(["pa"]);
  });

  it("carries nothing from a project whose search failed, so the block and counts agree", async () => {
    const loadChunks = vi.fn(async (projectId: string, ids: readonly string[]) =>
      ids
        .filter((id) => id.startsWith(projectId === "pa" ? "a" : "b"))
        .map((id) => carriedChunk(id)),
    );
    const capture = { contexts: [] as string[], sources: 0 };
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      carryForward: ["a7", "b9"],
      capture,
      deps: {
        // Beta is reachable (named) but its search timed out this turn.
        search: async () =>
          result({
            hits: [hit("pa", "Alpha", "a1", "Alpha client.")],
            projectsSearched: ["pa"],
            projectsFailed: ["pb"],
            failures: [{ projectId: "pb", projectName: "Beta", reason: "timeout" }],
            projectNames: { pa: "Alpha", pb: "Beta" },
          }),
        loadChunks,
        aclActor: async () => actor,
      },
    });
    expect(loadChunks.mock.calls.map((c) => c[0])).toEqual(["pa"]);
    expect(out.block).toContain("[2] [Alpha] a7.md#2 (cited in your previous answer)");
    expect(out.block).not.toContain("[Beta] b9.md");
    expect(out.block).toContain('Could not be searched this turn: "Beta" (timed out)');
    expect(out.grounding).toEqual({
      status: "multi",
      projects: [{ projectId: "pa", projectName: "Alpha", sources: 2 }],
      unsearched: [{ projectId: "pb", projectName: "Beta", reason: "timeout" }],
    });
    expect(capture.sources).toBe(2);
  });

  it("loses only the carry-over when the cited excerpts cannot be read", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      carryForward: ["b9"],
      deps: {
        search: async () => searched(["pa", "pb"], [hit("pa", "Alpha", "a1", "Alpha client.")]),
        loadChunks: async () => {
          throw new Error("db down");
        },
        aclActor: async () => actor,
      },
    });
    expect(out.block).toContain("[1] [Alpha] a1.md#0");
    expect(out.block).not.toContain("cited in your previous answer");
  });

  it("limits every search, and the carried excerpts, to the attached documents", async () => {
    const search = vi.fn(async (_o: FederatedSearchOptions) =>
      searched(["pa", "pb"], [hit("pa", "Alpha", "a1", "Alpha client.")]),
    );
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "Summarise these",
      documentIds: ["doc-a1", "doc-keep"],
      carryForward: ["b9", "b8"],
      deps: {
        search,
        loadChunks: async (projectId) =>
          projectId === "pb" ? [carriedChunk("b9"), carriedChunk("b8", "doc-keep")] : [],
        aclActor: async () => actor,
      },
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ documentIds: ["doc-a1", "doc-keep"], relevanceFloor: 0 }),
    );
    expect(out.block).toContain("The user attached documents to this question");
    expect(out.block).toContain("[2] [Beta] b8.md#2 (cited in your previous answer)");
    expect(out.block).not.toContain("b9.md");
  });

  it("says a product the attached documents do not cover has no excerpt for that reason", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "Summarise these",
      documentIds: ["doc-a1"],
      deps: { search: async () => searched(["pa", "pb"], [hit("pa", "Alpha", "a1", "Alpha.")]) },
    });
    expect(out.block).toContain(
      'Only the attached documents were searched, and none of them from "Beta" is included above',
    );
    expect(out.block).toContain("say that the attached documents do not cover it");
    expect(out.block).not.toContain("Searched, but no excerpt");
    expect(out.block).not.toContain("showed nothing relevant");
  });
});
