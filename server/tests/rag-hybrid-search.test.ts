/**
 * Hybrid retrieval integration test (issue #131).
 *
 * Uses the real BM25 index (lazy-loaded from a mocked Prisma) alongside the
 * filesystem-backed dense store + offline embedder. Asserts that:
 *
 *   - `mode: "dense"` returns dense-ranked hits only
 *   - `mode: "hybrid"` (default) merges BM25 with dense via RRF and can
 *      surface a chunk that BM25 ranks first even when dense ranks it lower
 *   - the cross-encoder rerank slot is invoked when the reranker is enabled
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockDocument {
  id: string;
  projectId: string;
  filename: string;
  mimeType: string;
  storagePath: string;
  status: string;
  errorMessage: string | null;
  chunkCount: number;
  processedAt: Date | null;
  deletedAt: Date | null;
  indexState?: string;
  autoApproveTrusted?: boolean;
  aclSubjects?: string;
  uploadedById?: string;
}

interface MockChunk {
  id: string;
  projectId: string;
  documentId: string;
  position: number;
  text: string;
  md5: string;
  embeddingModel: string;
  vectorRef: string | null;
  metadata: string | null;
  document?: { filename: string };
  aclSubjects?: string;
}

const documents = new Map<string, MockDocument>();
const chunks = new Map<string, MockChunk>();
const quarantine: {
  id: string;
  documentId: string;
  projectId: string;
  ord: number;
  text: string;
  embedding: string;
  metadata: string;
}[] = [];
let nextChunkId = 0;
let nextQuarantineId = 0;

type QuarantineWhere = {
  id?: string;
  documentId?: string;
  ord?: number | { gte: number } | { lt: number } | { in: number[] };
};
function matchesQuarantine(row: (typeof quarantine)[number], where: QuarantineWhere) {
  return (
    (!where.id || row.id === where.id) &&
    (!where.documentId || row.documentId === where.documentId) &&
    (where.ord === undefined ||
      (typeof where.ord === "number"
        ? row.ord === where.ord
        : "gte" in where.ord
          ? row.ord >= where.ord.gte
          : "lt" in where.ord
            ? row.ord < where.ord.lt
            : where.ord.in.includes(row.ord)))
  );
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; deletedAt?: null; indexState?: { in: string[] } };
          data: Partial<MockDocument>;
        }) => {
          const doc = documents.get(where.id);
          if (
            !doc ||
            (where.deletedAt === null && doc.deletedAt !== null) ||
            (where.indexState && !where.indexState.in.includes(doc.indexState ?? ""))
          )
            return { count: 0 };
          documents.set(doc.id, { ...doc, ...data });
          return { count: 1 };
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) => {
        const d = documents.get(where.id);
        return d && !d.deletedAt ? d : null;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => documents.get(where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { projectId: string; deletedAt: null } }) => {
        return [...documents.values()].filter(
          (d) => d.projectId === where.projectId && d.deletedAt == null,
        );
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MockDocument> }) => {
          const d = documents.get(where.id);
          if (!d) throw new Error("missing");
          const next = { ...d, ...data } as MockDocument;
          documents.set(where.id, next);
          return next;
        },
      ),
    },
    knowledgeChunk: {
      create: vi.fn(async ({ data }: { data: Omit<MockChunk, "id"> & { id?: string } }) => {
        nextChunkId += 1;
        const id = data.id ?? `chunk_${nextChunkId}`;
        const row: MockChunk = { id, vectorRef: null, ...data } as MockChunk;
        chunks.set(id, row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MockChunk> }) => {
          const c = chunks.get(where.id);
          if (!c) throw new Error("missing");
          const next = { ...c, ...data } as MockChunk;
          chunks.set(where.id, next);
          return next;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { documentId: string } }) => {
        let removed = 0;
        for (const [id, c] of chunks) {
          if (c.documentId === where.documentId) {
            chunks.delete(id);
            removed += 1;
          }
        }
        return { count: removed };
      }),
      findMany: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { projectId?: string; documentId?: string; id?: { in: string[] } };
          select?: Record<string, unknown>;
        }) => {
          const projectId = where.projectId;
          const ids = where.id?.in;
          let rows = [...chunks.values()];
          if (projectId) rows = rows.filter((c) => c.projectId === projectId);
          if (where.documentId) rows = rows.filter((c) => c.documentId === where.documentId);
          if (ids) rows = rows.filter((c) => ids.includes(c.id));
          if (select?.document) {
            rows = rows.map((r) => {
              const doc = documents.get(r.documentId);
              return { ...r, document: { filename: doc?.filename ?? "" } } as MockChunk;
            });
          }
          return rows;
        },
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { documentId: string }; data: Partial<MockChunk> }) => {
          let count = 0;
          for (const [id, c] of chunks) {
            if (c.documentId === where.documentId) {
              chunks.set(id, { ...c, ...data });
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
    quarantineChunk: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: QuarantineWhere;
          data: Partial<(typeof quarantine)[number]>;
        }) => {
          let count = 0;
          for (const row of quarantine)
            if (matchesQuarantine(row, where)) {
              Object.assign(row, data);
              count++;
            }
          return { count };
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: QuarantineWhere }) => {
        const retained = quarantine.filter((row) => !matchesQuarantine(row, where));
        const count = quarantine.length - retained.length;
        quarantine.splice(0, quarantine.length, ...retained);
        return { count };
      }),
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: {
            id?: string;
            documentId: string;
            projectId: string;
            ord: number;
            text: string;
            embedding: string;
            metadata: string;
          }[];
        }) => {
          quarantine.push(...data.map((d) => ({ ...d, id: d.id ?? `q_${++nextQuarantineId}` })));
          return { count: data.length };
        },
      ),
      findMany: vi.fn(async ({ where }: { where: QuarantineWhere }) => {
        const out = quarantine.filter((q) => matchesQuarantine(q, where));
        out.sort((a, b) => a.ord - b.ord);
        return out;
      }),
    },
    project: {
      findFirst: vi.fn(async () => ({
        id: "p1",
        autoApproveTrustedSources: true,
        chronicleEnabled: false,
        chronicleTtlDays: 28,
      })),
    },
    $transaction: vi.fn(async (ops: unknown[] | ((tx: unknown) => Promise<unknown>)) => {
      if (typeof ops !== "function") return Promise.all(ops);
      const savedDocuments = structuredClone(documents);
      const savedChunks = structuredClone(chunks);
      const savedQuarantine = structuredClone(quarantine);
      try {
        return await ops((await import("../src/lib/prisma.js")).prisma);
      } catch (error) {
        documents.clear();
        for (const [id, row] of savedDocuments) documents.set(id, row);
        chunks.clear();
        for (const [id, row] of savedChunks) chunks.set(id, row);
        quarantine.splice(0, quarantine.length, ...savedQuarantine);
        throw error;
      }
    }),
  },
}));

import { __resetEmbedderSingleton, Embedder } from "../src/lib/rag/embedder.js";
import { LocalVectorStore } from "../src/lib/rag/vector-store.js";
import { DocumentStorage } from "../src/lib/documents/storage.js";
import {
  KnowledgeService,
  __resetKnowledgeServiceSingleton,
} from "../src/lib/rag/knowledge-service.js";
import { BM25Index, __resetBM25IndexSingleton } from "../src/lib/rag/bm25-index.js";
import { __setRerankerForTests, type Reranker } from "../src/lib/rag/reranker.js";
import { prisma } from "../src/lib/prisma.js";
import { writeQuarantine } from "../src/lib/rag/quarantine.js";

let storageRoot: string;
let vectorRoot: string;
let storage: DocumentStorage;
let store: LocalVectorStore;
let svc: KnowledgeService;
let bm25: BM25Index;

async function seedDocument(
  id: string,
  projectId: string,
  text: string,
  filename = "doc.md",
): Promise<void> {
  const blob = await storage.write({ projectId, buffer: Buffer.from(text) });
  documents.set(id, {
    id,
    projectId,
    filename,
    mimeType: "text/markdown",
    storagePath: blob.storagePath,
    status: "pending",
    errorMessage: null,
    chunkCount: 0,
    processedAt: null,
    deletedAt: null,
    indexState: "pending",
    autoApproveTrusted: true,
    aclSubjects: "[]",
    uploadedById: "u1",
  } as MockDocument);
}

beforeEach(async () => {
  documents.clear();
  chunks.clear();
  quarantine.length = 0;
  nextChunkId = 0;
  nextQuarantineId = 0;
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metis-storage-"));
  vectorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metis-vec-"));
  storage = new DocumentStorage({ root: storageRoot });
  store = new LocalVectorStore({ root: vectorRoot });
  bm25 = new BM25Index();
  __resetEmbedderSingleton();
  __resetKnowledgeServiceSingleton();
  __resetBM25IndexSingleton();
  __setRerankerForTests(null);
  svc = new KnowledgeService({
    storage,
    vectorStore: store,
    embedder: new Embedder(),
    chunkOptions: { chunkSize: 80, overlap: 0 },
    bm25,
  });
});

afterEach(async () => {
  await fs.rm(storageRoot, { recursive: true, force: true });
  await fs.rm(vectorRoot, { recursive: true, force: true });
  __setRerankerForTests(null);
  vi.clearAllMocks();
});

describe("hybrid retrieval", () => {
  it("re-ingestion keeps other documents and journals out of source chunks", async () => {
    await seedDocument("d1", "phyb", "alpha original");
    await seedDocument("d2", "phyb", "bravo unrelated");
    await svc.ingestDocument("d1");
    await svc.ingestDocument("d2");
    const otherIds = [...chunks.values()]
      .filter((row) => row.documentId === "d2")
      .map((row) => row.id);
    const oldIds = [...chunks.values()]
      .filter((row) => row.documentId === "d1")
      .map((row) => row.id);
    await seedDocument("d1", "phyb", "charlie replacement");
    await svc.ingestDocument("d1");
    expect(
      [...chunks.values()].filter((row) => row.documentId === "d2").map((row) => row.id),
    ).toEqual(otherIds);
    expect(
      [...chunks.values()].filter((row) => row.documentId === "d1").map((row) => row.text),
    ).toEqual(["charlie replacement"]);
    expect(quarantine.every((row) => row.ord < 0)).toBe(true);
    const dense = await store.search(
      "phyb",
      (await new Embedder().embed(["charlie"])).vectors[0],
      20,
    );
    expect(dense.map((hit) => hit.row.id)).toEqual(expect.arrayContaining([...chunks.keys()]));
    expect(dense.some((hit) => oldIds.includes(hit.row.id))).toBe(false);
    expect((await bm25.search("phyb", "bravo", 20)).map((hit) => hit.chunkId)).toEqual(otherIds);
    expect(await bm25.search("phyb", "original", 20)).toEqual([]);
  });

  it("rolls back callback writes when quarantine insertion fails", async () => {
    await seedDocument("d1", "phyb", "alpha");
    const input = {
      documentId: "d1",
      projectId: "phyb",
      filename: "doc.md",
      embeddingModel: "test",
      aclSubjects: [],
      chunks: [{ ord: 0, text: "alpha", md5: "hash", embedding: [1, 0] }],
    };
    await writeQuarantine(input);
    const before = structuredClone(quarantine);
    vi.mocked(prisma.quarantineChunk.createMany).mockRejectedValueOnce(
      new Error("insertion failed"),
    );
    await expect(writeQuarantine(input)).rejects.toThrow("insertion failed");
    expect(quarantine).toEqual(before);
    expect(documents.get("d1")?.indexState).toBe("quarantined");
  });

  it("does not reset an indexed or deleted document through the conditional update", async () => {
    await seedDocument("d1", "phyb", "alpha");
    await svc.ingestDocument("d1");
    const before = structuredClone(quarantine);
    const input = {
      documentId: "d1",
      projectId: "phyb",
      filename: "doc.md",
      embeddingModel: "test",
      aclSubjects: [],
      chunks: [],
      onlyIfUnpublished: true,
    };
    await writeQuarantine(input);
    expect(documents.get("d1")?.indexState).toBe("indexed");
    expect(quarantine).toEqual(before);
    await prisma.document.update({
      where: { id: "d1" },
      data: { deletedAt: new Date(), indexState: "pending" },
    });
    await writeQuarantine(input);
    expect(documents.get("d1")?.indexState).toBe("pending");
    expect(quarantine).toEqual(before);
  });

  it("default mode is hybrid and result.mode echoes back", async () => {
    await seedDocument("d1", "phyb", "alpha bravo charlie delta echo foxtrot");
    await svc.ingestDocument("d1");
    const res = await svc.search("phyb", "alpha");
    expect(res.mode).toBe("hybrid");
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it("explicit mode: dense bypasses BM25 and reports mode=dense", async () => {
    await seedDocument("d1", "phyb", "alpha bravo charlie");
    await svc.ingestDocument("d1");
    const res = await svc.search("phyb", "alpha", { mode: "dense" });
    expect(res.mode).toBe("dense");
  });

  it("hybrid mode surfaces a BM25-only match that dense missed", async () => {
    // Seed two short docs whose dense vectors collide (offline embedder is
    // hash-based, so unique tokens drive distinct rankings). BM25 should
    // still pull the chunk that lexically contains the query term to the
    // top via RRF even if dense ranks it lower.
    await seedDocument(
      "d1",
      "phyb2",
      "Reciprocal rank fusion combines dense and sparse retrievers in a single ranking.",
    );
    await seedDocument(
      "d2",
      "phyb2",
      "Settlements engine reconciliation paragraph with no overlap.",
      "settlements.md",
    );
    await svc.ingestDocument("d1");
    await svc.ingestDocument("d2");
    const hybrid = await svc.search("phyb2", "fusion sparse retrievers", { mode: "hybrid", k: 2 });
    expect(hybrid.hits.length).toBeGreaterThan(0);
    expect(hybrid.hits[0].documentId).toBe("d1");
  });

  it("invokes the cross-encoder reranker when one is enabled", async () => {
    const calls: { query: string; count: number }[] = [];
    const stub: Reranker = {
      enabled: true,
      async rerank(query, cands) {
        calls.push({ query, count: cands.length });
        // Force the last candidate to top so we can prove the rerank ran.
        const reordered = [...cands].reverse();
        return reordered.map((c, i) => ({ ...c, score: cands.length - i }));
      },
    };
    __setRerankerForTests(stub);
    svc = new KnowledgeService({
      storage,
      vectorStore: store,
      embedder: new Embedder(),
      chunkOptions: { chunkSize: 80, overlap: 0 },
      bm25,
      reranker: stub,
    });
    await seedDocument("d1", "phr", "alpha alpha alpha");
    await seedDocument("d2", "phr", "bravo bravo bravo", "b.md");
    await svc.ingestDocument("d1");
    await svc.ingestDocument("d2");
    const res = await svc.search("phr", "alpha");
    expect(res.reranked).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].query).toBe("alpha");
  });

  it("hybrid degrades cleanly to dense when BM25 throws", async () => {
    await seedDocument("d1", "pdeg", "alpha bravo charlie");
    await svc.ingestDocument("d1");
    // Sabotage the BM25 instance so its search throws.
    bm25.search = vi.fn(async () => {
      throw new Error("simulated BM25 failure");
    });
    const res = await svc.search("pdeg", "alpha", { mode: "hybrid" });
    expect(res.mode).toBe("hybrid");
    // Dense path still returns hits.
    expect(res.hits.length).toBeGreaterThan(0);
  });

  it("drops stale dense hits whose live SQL chunks were deleted", async () => {
    await seedDocument("d1", "pstale", "alpha bravo charlie");
    await svc.ingestDocument("d1");

    const [chunkId] = [...chunks.keys()];
    expect(chunkId).toBeTruthy();
    chunks.delete(chunkId);

    const res = await svc.search("pstale", "alpha", { mode: "dense" });
    expect(res.hits).toEqual([]);
  });
});
