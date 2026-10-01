import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Prisma } from "@prisma/client";
import { KnowledgeService, type KnowledgeServiceDeps } from "./knowledge-service.js";
import type { EvidencePolicy } from "../docs-gen/evidence-policy.js";

vi.mock("../prisma.js", () => ({ prisma: { knowledgeChunk: { findMany: vi.fn() } } }));
import { prisma } from "../prisma.js";

const policy: EvidencePolicy = {
  projectId: "p1",
  generatedDocumentId: "self",
  actor: { userId: "alice", role: "coordinator" },
  aclSubjects: [{ kind: "user", value: "alice" }],
  repoConnectorId: "a",
  codeGraphId: "graph-a",
  sharedDocumentIds: ["reference"],
  allowWebResearch: false,
};
type FixtureRecord = {
  id: string;
  documentId: string;
  filename: string;
  acl: string;
  source?: string;
};
function fixture(extra: FixtureRecord[] = []) {
  // Extra records lead, so they fall inside the default top-k.
  const records: FixtureRecord[] = [
    ...extra,
    { id: "allowed", documentId: "allowed", filename: "connector:repo:a:src/same.ts", acl: "[]" },
    { id: "foreign", documentId: "foreign", filename: "connector:repo:b:src/same.ts", acl: "[]" },
    {
      id: "denied",
      documentId: "denied",
      filename: "connector:repo:a:src/same.ts",
      acl: '[{"kind":"user","value":"bob"}]',
    },
    {
      id: "generated",
      documentId: "gendoc-self",
      filename: "connector:repo:a:src/same.ts",
      acl: "[]",
    },
    { id: "reference", documentId: "reference", filename: "glossary.md", acl: "[]" },
  ];
  const rows = records.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    text: `LIVE-${r.id}`,
    metadata: "{}",
    chunkerIdentity: null,
    aclSubjects: "[]",
    document: {
      filename: r.filename,
      source: r.source ?? (r.filename.startsWith("connector:repo:") ? "repo" : "upload"),
      storagePath: "blob",
      aclSubjects: r.acl,
    },
    embeddingModel: "fake",
    position: 0,
  }));
  // The mocked client resolves a plain Promise, not Prisma's lazy PrismaPromise.
  const findMany = prisma.knowledgeChunk.findMany as unknown as Mock<
    (args?: Prisma.KnowledgeChunkFindManyArgs) => Promise<unknown>
  >;
  findMany.mockImplementation(async (args) => {
    const ids = (args?.where?.id as { in: string[] }).in;
    return rows.filter((r) => ids.includes(r.id));
  });
  const embed = vi.fn(async () => ({ vectors: [[1, 0]], model: "fake", dimension: 2 }));
  const search = vi.fn(async () =>
    records.map((r) => ({
      score: 0.9,
      row: {
        metadata: {
          chunkId: r.id,
          documentId: r.documentId,
          text: `STALE-${r.id}`,
          filename: "connector:repo:a:src/same.ts",
          position: 0,
          embeddingModel: "fake",
        },
      },
    })),
  );
  const rerank = vi.fn(
    async (_q: string, candidates: Array<{ chunkId: string; text: string; score: number }>) =>
      candidates,
  );
  const sparse = vi.fn(async () => records.map((r) => ({ chunkId: r.id, score: 1 })));
  const deps = {
    embedder: { model: "fake", dimension: 2, embed },
    vectorStore: {
      search,
      modelCoverage: vi.fn(async () => ({ totalChunks: 5, modelCounts: { fake: 5 } })),
    },
    reranker: { enabled: true, rerank },
    bm25: { search: sparse },
  } as unknown as KnowledgeServiceDeps;
  return { service: new KnowledgeService(deps), embed, search, rerank, rows };
}

beforeEach(() => vi.clearAllMocks());
describe("KnowledgeService primary evidence before reranking #1353", () => {
  it.each(["dense", "hybrid"] as const)(
    "filters %s candidate pool with SQL-authoritative ACLs and content before external reranking",
    async (mode) => {
      const { service, rerank } = fixture();
      const result = await service.search("p1", "query", {
        mode,
        actor: policy.actor,
        evidencePolicy: policy,
      });
      expect(result.hits.map((h) => h.chunkId)).toEqual(["allowed", "reference"]);
      expect(result.hits.map((h) => h.text)).toEqual(["LIVE-allowed", "LIVE-reference"]);
      expect(rerank).toHaveBeenCalledTimes(1);
      expect(rerank.mock.calls[0][1]).toEqual([
        { chunkId: "allowed", text: "LIVE-allowed", score: expect.any(Number) },
        { chunkId: "reference", text: "LIVE-reference", score: expect.any(Number) },
      ]);
      expect(result.hits[1].filename).toBe("glossary.md");
    },
  );

  // #547 — every hit carries its row's `documents.source`, read in SQL: the
  // vector store's copy of the filename (connector-shaped for every record
  // here) is not what a reader may classify on.
  it.each(["dense", "hybrid"] as const)(
    "%s hits carry the document row's source, not a filename-derived kind",
    async (mode) => {
      const { service } = fixture();
      const result = await service.search("p1", "query", { mode, evidencePolicy: policy });
      expect(result.hits.map((h) => [h.chunkId, h.source])).toEqual([
        ["allowed", "repo"],
        ["reference", "upload"],
      ]);
    },
  );

  // #547 — an upload stored under a repo-shaped name keeps its stored source:
  // a hit classified by filename prefix would read "repo" here.
  it.each(["dense", "hybrid"] as const)(
    "%s hit for an upload named like a repo file carries source upload",
    async (mode) => {
      const { service } = fixture([
        {
          id: "impostor",
          documentId: "impostor",
          filename: "connector:repo:a:src/x.ts",
          acl: "[]",
          source: "upload",
        },
      ]);
      const result = await service.search("p1", "query", { mode });
      const hit = result.hits.find((h) => h.chunkId === "impostor");
      expect(hit?.filename).toBe("connector:repo:a:src/same.ts");
      expect(hit?.source).toBe("upload");
    },
  );

  it("enforces the policy actor even when the generic search actor option is omitted", async () => {
    const { service } = fixture();
    const result = await service.search("p1", "query", { mode: "dense", evidencePolicy: policy });
    expect(result.hits.map((h) => h.chunkId)).toEqual(["allowed", "reference"]);
  });

  it("filters sparse-only candidates too", async () => {
    const { service, search, rerank } = fixture();
    search.mockResolvedValue([]);
    expect(
      (await service.search("p1", "query", { mode: "hybrid", evidencePolicy: policy })).hits.map(
        (h) => h.chunkId,
      ),
    ).toEqual(["allowed", "reference"]);
    expect(rerank.mock.calls[0][1].map((c) => c.text)).toEqual(["LIVE-allowed", "LIVE-reference"]);
  });

  it("no live authorized hits means no reranker call, not a dense fallback", async () => {
    const { service, rerank } = fixture();
    vi.mocked(prisma.knowledgeChunk.findMany).mockResolvedValue([]);
    expect(
      (await service.search("p1", "query", { mode: "dense", evidencePolicy: policy })).hits,
    ).toEqual([]);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("SQL failures cannot leak the unchecked pool to the reranker", async () => {
    const { service, rerank } = fixture();
    vi.mocked(prisma.knowledgeChunk.findMany).mockRejectedValue(new Error("SQL unavailable"));
    await expect(
      service.search("p1", "query", { mode: "dense", evidencePolicy: policy }),
    ).rejects.toThrow("SQL unavailable");
    expect(rerank).not.toHaveBeenCalled();
  });

  it("rejects cross-project policy before embedding, even for an empty query", async () => {
    const { service, embed, search, rerank } = fixture();
    await expect(service.search("foreign", "", { evidencePolicy: policy })).rejects.toThrow(
      "Generation authorization unavailable",
    );
    expect(embed).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(rerank).not.toHaveBeenCalled();
  });
});
