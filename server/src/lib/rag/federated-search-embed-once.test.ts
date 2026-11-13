/**
 * #2279 — a federated call embeds each distinct query string once, not once per
 * project: the real KnowledgeService under FederatedSearchService, with an
 * embedder that counts its calls.
 */
import { describe, expect, it, vi } from "vitest";
import { KnowledgeService } from "./knowledge-service.js";
import { FederatedSearchService } from "./federated-search-service.js";
import type { Embedder } from "./embedder.js";
import type { VectorStore } from "./vector-store.js";
import { BM25Index } from "./bm25-index.js";

vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../auth/accessible-projects.js", () => ({
  getUserAccessibleProjects: async () => [
    { id: "pa", name: "Alpha" },
    { id: "pb", name: "Beta" },
    { id: "pc", name: "Gamma" },
  ],
}));
vi.mock("./acl.js", async (original) => ({
  ...(await original<typeof import("./acl.js")>()),
  resolveAclActor: async (userId: string) => ({ userId, role: "reader" }),
}));

function countingEmbedder(fail = false) {
  const embedded: string[] = [];
  const embedder = {
    model: "fake-model",
    dimension: 4,
    embed: async (texts: string[]) => {
      embedded.push(...texts);
      if (fail) throw new Error("embedder down");
      return { vectors: texts.map(() => [1, 0, 0, 1]), model: "fake-model", dimension: 4 };
    },
  } as unknown as Embedder;
  return { embedder, embedded };
}

function emptyStore(): VectorStore {
  return {
    search: vi.fn(async () => []),
    modelCoverage: vi.fn(async () => ({ totalChunks: 0, modelCounts: {} })),
    deleteByDocument: vi.fn(),
    dropTable: vi.fn(),
  } as unknown as VectorStore;
}

function service(embedder: Embedder) {
  const knowledgeService = new KnowledgeService({
    embedder,
    vectorStore: emptyStore(),
    bm25: new BM25Index(),
  });
  return new FederatedSearchService({ knowledgeService });
}

describe("FederatedSearchService embeds each query once per call (#2279)", () => {
  it("embeds the user's searches and the conversational one once each, across three projects", async () => {
    const { embedder, embedded } = countingEmbedder();
    const out = await service(embedder).searchAcrossProjects({
      userId: "u1",
      query: "and in the client?",
      moreQueries: ["second part?"],
      contextualQuery: "and in the client?\nHow is annual billing done?",
    });
    expect(out.projectsSearched).toEqual(["pa", "pb", "pc"]);
    expect([...embedded].sort()).toEqual(
      [
        "and in the client?",
        "and in the client?\nHow is annual billing done?",
        "second part?",
      ].sort(),
    );
  });

  it("does not share embeddings between calls", async () => {
    const { embedder, embedded } = countingEmbedder();
    const svc = service(embedder);
    await svc.searchAcrossProjects({ userId: "u1", query: "q" });
    await svc.searchAcrossProjects({ userId: "u1", query: "q" });
    expect(embedded).toEqual(["q", "q"]);
  });

  it("reports every project failed when the shared embedding fails", async () => {
    const { embedder } = countingEmbedder(true);
    const out = await service(embedder).searchAcrossProjects({ userId: "u1", query: "q" });
    expect(out.projectsSearched).toEqual([]);
    expect(out.failures.map((f) => f.reason)).toEqual(["error", "error", "error"]);
  });
});
