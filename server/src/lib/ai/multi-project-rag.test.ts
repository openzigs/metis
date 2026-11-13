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
import { readRelevanceFloor } from "./relevance-floor.js";

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
      // #2264 — the most relevant products' hits take the excerpts, and the
      // fan-out is bounded (`CHAT_MULTI_PROJECT_MAX_PROJECTS`, default 20).
      share: "relevance",
      maxProjects: 20,
      // #2294 — chat's absolute floor, read for the hits' embedders.
      absoluteFloor: readRelevanceFloor,
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
      // #2294 — each file the excerpts came from, named as the model saw it.
      sourcesUsed: [
        { name: "[Alpha] a1.md", excerpts: 1, relevance: 0.8 },
        { name: "[Beta] b1.md", excerpts: 1, relevance: 0.8 },
        { name: "[Alpha] a2.md", excerpts: 1, relevance: 0.8 },
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
      sourcesUsed: [{ name: "[Alpha] a1.md", excerpts: 1, relevance: 0.8 }],
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
    expect(out.grounding).toMatchObject({ reason: "nothing-found" });
    expect(out.grounding).not.toHaveProperty("belowFloor");
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
    // #2294 — and the label says why, as a single-project one does.
    expect(out.grounding).toEqual({ status: "multi", projects: [], reason: "retrieval-failed" });
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
      share: "relevance",
      maxProjects: 20,
      absoluteFloor: readRelevanceFloor,
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
      // A carried excerpt has no relevance of this turn's.
      sourcesUsed: [
        { name: "[Alpha] a1.md", excerpts: 1, relevance: 0.8 },
        { name: "[Beta] b9.md", excerpts: 1 },
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
      sourcesUsed: [
        { name: "[Alpha] a1.md", excerpts: 1, relevance: 0.8 },
        { name: "[Alpha] a7.md", excerpts: 1 },
      ],
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
      // #2264 — every product holding an attached document gets its turn.
      expect.objectContaining({
        documentIds: ["doc-a1", "doc-keep"],
        relevanceFloor: 0,
        share: "turns",
      }),
    );
    expect(out.block).toContain("The user attached documents to this question");
    expect(out.block).toContain("[2] [Beta] b8.md#2 (cited in your previous answer)");
    expect(out.block).not.toContain("b9.md");
    // #2294 — the user chose the source: no absolute floor either.
    expect(search.mock.calls[0]![0].absoluteFloor).toBeUndefined();
    // #2264 — nor the per-turn project cap: a product holding an attachment is searched.
    expect(search.mock.calls[0]![0].maxProjects).toBeUndefined();
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

describe("buildMultiProjectRagContext — relevance floor (#2294)", () => {
  const actor = { userId: "u1", role: "reader" } as never;

  it("passes an injected absolute floor to the search", async () => {
    const absoluteFloor = () => 0.5;
    const search = vi.fn(async (_o: FederatedSearchOptions) => result());
    await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      deps: { search, absoluteFloor },
    });
    expect(search.mock.calls[0]![0].absoluteFloor).toBe(absoluteFloor);
  });

  it("says the sources don't support an answer when the floor set every match aside", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "What is the capital of France?",
      deps: {
        search: async () =>
          result({
            projectsSearched: ["pa", "pb"],
            projectsWithoutHits: ["pa", "pb"],
            projectNames: { pa: "Alpha", pb: "Beta" },
            belowFloor: 5,
          }),
      },
    });
    expect(out.block).toContain(
      "Their knowledge bases were searched for this question and nothing in them was relevant enough to use: the 5 closest matches were too weak",
    );
    expect(out.block).toContain("say that their sources don't show this");
    expect(out.block).not.toContain("No excerpt from their sources matched");
    expect(out.grounding).toEqual({
      status: "multi",
      projects: [
        { projectId: "pa", projectName: "Alpha", sources: 0 },
        { projectId: "pb", projectName: "Beta", sources: 0 },
      ],
      reason: "insufficient-evidence",
      belowFloor: 5,
    });
  });

  it("names one weak match in the singular", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      deps: {
        search: async () =>
          result({ projectsSearched: ["pa"], projectNames: { pa: "Alpha" }, belowFloor: 1 }),
      },
    });
    expect(out.block).toContain("the 1 closest match was too weak");
  });

  it("says why nothing was supplied when every product's search failed", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      deps: {
        search: async () =>
          result({
            failures: [
              { projectId: "pa", projectName: "Alpha", reason: "error" },
              { projectId: "pb", projectName: "Beta", reason: "timeout" },
            ],
            projectNames: { pa: "Alpha", pb: "Beta" },
          }),
      },
    });
    expect(out.grounding).toMatchObject({ reason: "retrieval-failed" });
  });

  it("grounds a turn on carried excerpts when the floor set every fresh match aside, and says so", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "and monthly?",
      carryForward: ["b9"],
      deps: {
        search: async () =>
          result({
            projectsSearched: ["pa", "pb"],
            projectNames: { pa: "Alpha", pb: "Beta" },
            belowFloor: 3,
          }),
        loadChunks: async (projectId) =>
          projectId === "pb"
            ? [
                {
                  chunkId: "b9",
                  documentId: "doc-b9",
                  filename: "b9.md",
                  position: 0,
                  text: "Beta bills monthly.",
                  score: 0,
                  embeddingModel: "stub",
                  source: "upload" as const,
                },
              ]
            : [],
        aclActor: async () => actor,
      },
    });
    expect(out.block).toContain(
      "This question's own search found nothing relevant enough to use: the 3 closest matches were too weak.",
    );
    expect(out.block).toContain("[1] [Beta] b9.md#0 (cited in your previous answer)");
    expect(out.grounding).toEqual({
      status: "multi",
      projects: [
        { projectId: "pa", projectName: "Alpha", sources: 0 },
        { projectId: "pb", projectName: "Beta", sources: 1 },
      ],
      sourcesUsed: [{ name: "[Beta] b9.md", excerpts: 1 }],
    });
  });

  it("labels a source with its dense cosine, not a reranker's verdict", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      deps: {
        search: async () =>
          result({
            hits: [{ ...hit("pa", "Alpha", "a1", "x", 0.98), denseScore: 0.62 }],
            projectsSearched: ["pa"],
            projectNames: { pa: "Alpha" },
          }),
      },
    });
    expect(out.grounding).toMatchObject({
      sourcesUsed: [{ name: "[Alpha] a1.md", excerpts: 1, relevance: 0.62 }],
    });
  });
});

describe("buildMultiProjectRagContext — ranking past the excerpt limit (#2264)", () => {
  it("passes an injected per-turn project limit to the search", async () => {
    const search = vi.fn(async (_o: FederatedSearchOptions) => result());
    await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      deps: { search, maxProjects: 3 },
    });
    expect(search.mock.calls[0]![0].maxProjects).toBe(3);
  });

  it("says a relevant product left out by the excerpt limit was cut, not that it matched nothing", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "projects", projectIds: ["pa", "pb", "pc"] },
      query: "q",
      deps: {
        search: async () =>
          result({
            hits: [hit("pa", "Alpha", "a1", "x")],
            projectsSearched: ["pa", "pb", "pc"],
            projectsWithoutHits: ["pb", "pc"],
            projectsCapped: ["pb"],
            projectNames: { pa: "Alpha", pb: "Beta", pc: "Gamma" },
          }),
      },
    });
    expect(out.block).toContain(
      'Searched and relevant, but left out because the 8 excerpts went to closer matches: "Beta"',
    );
    expect(out.block).toContain("say that its sources may hold more than is shown here");
    expect(out.block).toContain('Searched, but no excerpt from it is included above: "Gamma"');
    expect(out.block).not.toContain('included above: "Beta"');
  });

  it("names the products a scope over the limit did not search, the first ten and a count", async () => {
    const over = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "workspace", workspaceId: "w1" },
      query: "q",
      deps: {
        role: async () => "reader",
        workspaceProjects: async () => ["pa", ...over],
        search: async () =>
          result({
            hits: [hit("pa", "Alpha", "a1", "x")],
            projectsSearched: ["pa"],
            projectsOverLimit: over,
            projectNames: {
              pa: "Alpha",
              ...Object.fromEntries(over.map((id) => [id, `Name ${id}`])),
            },
          }),
      },
    });
    expect(out.block).toContain("holds more products than one turn searches, so 12 were not");
    expect(out.block).toContain('"Name p0", "Name p1"');
    expect(out.block).toContain('"Name p9" and 2 more');
    expect(out.block).not.toContain("Name p10");
    expect(out.block).toContain("suggest narrowing the chat's scope");
  });

  it("names a chosen archived product as archived, not as out of reach", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "projects", projectIds: ["pa", "old"] },
      query: "q",
      deps: {
        search: async () =>
          result({
            hits: [hit("pa", "Alpha", "a1", "x")],
            projectsSearched: ["pa"],
            projectsArchived: ["old"],
            projectNames: { pa: "Alpha", old: "Legacy" },
          }),
      },
    });
    expect(out.block).toContain('Archived, so not searched: "Legacy"');
    expect(out.block).not.toContain("no longer available");
  });

  it("says nothing of a workspace's archived projects, which are not in its live scope", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "workspace", workspaceId: "w1" },
      query: "q",
      deps: {
        role: async () => "reader",
        workspaceProjects: async () => ["pa", "old"],
        search: async () =>
          result({
            hits: [hit("pa", "Alpha", "a1", "x")],
            projectsSearched: ["pa"],
            projectsArchived: ["old"],
            projectNames: { pa: "Alpha", old: "Legacy" },
          }),
      },
    });
    expect(out.block).not.toContain("Legacy");
    expect(out.block).not.toContain("no longer available");
  });

  it("says the projects are archived when every one in the scope is", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: twoProducts,
      query: "q",
      deps: {
        search: async () =>
          result({ projectsArchived: ["pa", "pb"], projectNames: { pa: "Alpha", pb: "Beta" } }),
      },
    });
    expect(out.block).toContain('but its projects are archived ("Alpha" and "Beta")');
    expect(out.block).not.toContain("available to you");
  });

  it("still names the chosen archived products when others are out of reach", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "projects", projectIds: ["pa", "gone"] },
      query: "q",
      deps: {
        search: async () =>
          result({ projectsArchived: ["pa"], projectsRejected: 1, projectNames: { pa: "Alpha" } }),
      },
    });
    expect(out.block).toContain(
      'but its projects are archived ("Alpha") or no longer available to you',
    );
  });

  it("does not name a workspace's archived projects when nothing was searched", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "workspace", workspaceId: "w1" },
      query: "q",
      deps: {
        role: async () => "reader",
        workspaceProjects: async () => ["old"],
        search: async () => result({ projectsArchived: ["old"], projectNames: { old: "Legacy" } }),
      },
    });
    expect(out.block).toContain("but its projects are archived.");
    expect(out.block).not.toContain("Legacy");
  });

  it("gives two products of the same name distinct labels", async () => {
    const out = await buildMultiProjectRagContext({
      userId: "u1",
      scope: { kind: "projects", projectIds: ["proj-aaaaaa", "proj-bbbbbb"] },
      query: "q",
      deps: {
        search: async () =>
          result({
            hits: [
              hit("proj-aaaaaa", "Billing", "a1", "One."),
              hit("proj-bbbbbb", "Billing", "b1", "Two."),
            ],
            projectsSearched: ["proj-aaaaaa", "proj-bbbbbb"],
            projectNames: { "proj-aaaaaa": "Billing", "proj-bbbbbb": "Billing" },
          }),
      },
    });
    expect(out.block).toContain("[1] [Billing (aaaaaa)] a1.md#0");
    expect(out.block).toContain("[2] [Billing (bbbbbb)] b1.md#0");
    expect(out.block).toContain('"Billing (aaaaaa)" and "Billing (bbbbbb)"');
    expect(out.grounding).toMatchObject({
      projects: [
        { projectId: "proj-aaaaaa", projectName: "Billing (aaaaaa)" },
        { projectId: "proj-bbbbbb", projectName: "Billing (bbbbbb)" },
      ],
    });
  });
});
