/**
 * Epic #157 — Quarantine state machine + auto-approve unit tests.
 *
 * Backed by an in-memory Prisma stub plus stub vector store + BM25 index that
 * `approveDocument` accepts via `ApprovalDeps`. Verifies the full ingest →
 * quarantine → approve / reject lifecycle without touching the filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockDoc {
  id: string;
  projectId: string;
  filename: string;
  indexState: string;
  autoApproveTrusted: boolean;
  aclSubjects: string;
  status: string;
  chunkCount: number;
  errorMessage: string | null;
  processedAt: Date | null;
  deletedAt: Date | null;
  uploadedById: string;
  uploadedAt: Date;
}

interface MockChunk {
  id: string;
  documentId: string;
  projectId: string;
  position: number;
  text: string;
  md5: string;
  embeddingModel: string;
  /** Issue #1182 — the chunker generation; `null` is the pre-#1182 generation. */
  chunkerIdentity: string | null;
  vectorRef: string | null;
  metadata: string | null;
  aclSubjects: string;
}

interface MockQuarantine {
  id: string;
  documentId: string;
  projectId: string;
  ord: number;
  text: string;
  embedding: string;
  metadata: string;
}

interface MockProj {
  id: string;
  autoApproveTrustedSources: boolean;
  deletedAt: Date | null;
}

const docs = new Map<string, MockDoc>();
const chunks = new Map<string, MockChunk>();
const quarantine = new Map<string, MockQuarantine>();
const projs = new Map<string, MockProj>();
let nextChunkId = 0;
let nextQId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; deletedAt?: null; indexState?: { in: string[] } };
          data: Partial<MockDoc>;
        }) => {
          const doc = docs.get(where.id);
          if (
            !doc ||
            (where.deletedAt === null && doc.deletedAt) ||
            (where.indexState && !where.indexState.in.includes(doc.indexState))
          )
            return { count: 0 };
          docs.set(where.id, { ...doc, ...data });
          return { count: 1 };
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt?: null } }) => {
        const d = docs.get(where.id);
        if (!d) return null;
        if ("deletedAt" in where && d.deletedAt) return null;
        return d;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MockDoc> }) => {
        const d = docs.get(where.id);
        if (!d) throw new Error("missing");
        const next = { ...d, ...data } as MockDoc;
        docs.set(where.id, next);
        return next;
      }),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            projectId: string;
            deletedAt: null;
            OR: Array<{
              indexState: string;
              NOT?: { id: { startsWith: string } };
              quarantineChunks?: { some: { ord: number } };
            }>;
          };
        }) => {
          const out: MockDoc[] = [];
          for (const d of docs.values()) {
            if (
              d.projectId === where.projectId &&
              d.deletedAt == null &&
              where.OR.some((condition) => {
                const selectedOrd = condition.quarantineChunks?.some.ord;
                return (
                  d.indexState === condition.indexState &&
                  (!condition.NOT || !d.id.startsWith(condition.NOT.id.startsWith)) &&
                  (selectedOrd === undefined ||
                    [...quarantine.values()].some(
                      (q) => q.documentId === d.id && q.ord === selectedOrd,
                    ))
                );
              })
            ) {
              out.push(d);
            }
          }
          return out;
        },
      ),
    },
    knowledgeChunk: {
      create: vi.fn(async ({ data }: { data: Omit<MockChunk, "id"> & { id?: string } }) => {
        nextChunkId += 1;
        const id = data.id ?? `c_${nextChunkId}`;
        const row: MockChunk = { id, ...data, vectorRef: data.vectorRef ?? null } as MockChunk;
        chunks.set(id, row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { documentId: string } }) =>
        [...chunks.values()].filter((c) => c.documentId === where.documentId),
      ),
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
        let count = 0;
        for (const [id, c] of chunks) {
          if (c.documentId === where.documentId) {
            chunks.delete(id);
            count += 1;
          }
        }
        return { count };
      }),
    },
    quarantineChunk: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; documentId?: string; ord: number | { in: number[] } };
          data: Partial<MockQuarantine>;
        }) => {
          let count = 0;
          for (const [id, q] of quarantine) {
            if (
              (!where.id || q.id === where.id) &&
              (!where.documentId || q.documentId === where.documentId) &&
              (typeof where.ord === "number" ? q.ord === where.ord : where.ord.in.includes(q.ord))
            ) {
              quarantine.set(id, { ...q, ...data });
              count++;
            }
          }
          return { count };
        },
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { documentId: string; ord?: { gte: number } } }) => {
          let count = 0;
          for (const [id, q] of quarantine) {
            if (q.documentId === where.documentId && (!where.ord || q.ord >= where.ord.gte)) {
              quarantine.delete(id);
              count += 1;
            }
          }
          return { count };
        },
      ),
      createMany: vi.fn(
        async ({ data }: { data: (Omit<MockQuarantine, "id"> & { id?: string })[] }) => {
          for (const d of data) {
            nextQId += 1;
            const id = d.id ?? `q_${nextQId}`;
            quarantine.set(id, { id, ...d });
          }
          return { count: data.length };
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { documentId: string; ord?: number | { gte: number } | { lt: number } };
        }) => {
          const out: MockQuarantine[] = [];
          for (const q of quarantine.values()) {
            if (
              q.documentId === where.documentId &&
              (where.ord === undefined ||
                (typeof where.ord === "number"
                  ? q.ord === where.ord
                  : "gte" in where.ord
                    ? q.ord >= where.ord.gte
                    : q.ord < where.ord.lt))
            )
              out.push(q);
          }
          out.sort((a, b) => a.ord - b.ord);
          return out;
        },
      ),
      groupBy: vi.fn(async () => []),
    },
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        return projs.get(where.id) ?? null;
      }),
    },
    $transaction: vi.fn(async (ops: unknown[] | ((tx: unknown) => Promise<unknown>)) => {
      if (typeof ops === "function") return ops((await import("../src/lib/prisma.js")).prisma);
      return Promise.all(ops as Promise<unknown>[]);
    }),
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: vi.fn(() => ({})),
}));

vi.mock("../src/lib/rag/vector-store.js", async () => {
  return {
    getVectorStore: vi.fn(() => ({
      ensureTable: vi.fn(),
      deleteByDocument: vi.fn(),
      upsert: vi.fn(),
    })),
  };
});

vi.mock("../src/lib/rag/bm25-index.js", () => ({
  getBM25Index: vi.fn(() => ({ upsertDocumentChunks: vi.fn() })),
}));

import {
  approveDocument,
  listQuarantine,
  rejectDocument,
  shouldAutoApprove,
  writeQuarantine,
} from "../src/lib/rag/quarantine.js";

const stubVector = {
  ensureTable: vi.fn(async () => undefined),
  deleteByDocument: vi.fn(async () => undefined),
  deleteByChunkIds: vi.fn(async () => undefined),
  upsert: vi.fn(async () => undefined),
};

const stubBm25 = {
  documentChunkIds: vi.fn(async () => [] as string[]),
  removeChunkIds: vi.fn(async () => undefined),
  removeUnselectedChunks: vi.fn(async () => undefined),
  removeDocument: vi.fn(async () => undefined),
  upsertDocumentChunks: vi.fn(async () => undefined),
};

function seedDocument(opts: Partial<MockDoc> & Pick<MockDoc, "id" | "projectId">) {
  docs.set(opts.id, {
    filename: "doc.md",
    indexState: "pending",
    autoApproveTrusted: false,
    aclSubjects: "[]",
    status: "pending",
    chunkCount: 0,
    errorMessage: null,
    processedAt: null,
    deletedAt: null,
    uploadedById: "u1",
    uploadedAt: new Date(),
    ...opts,
  });
}

beforeEach(() => {
  docs.clear();
  chunks.clear();
  quarantine.clear();
  projs.clear();
  nextChunkId = 0;
  nextQId = 0;
  stubVector.ensureTable.mockClear();
  stubVector.deleteByDocument.mockClear();
  stubVector.upsert.mockClear();
  stubBm25.upsertDocumentChunks.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("writeQuarantine", () => {
  it("parks chunks and flips indexState to quarantined", async () => {
    seedDocument({ id: "d1", projectId: "p1" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [
        { ord: 0, text: "hello", md5: "m0", embedding: [0.1, 0.2] },
        { ord: 1, text: "world", md5: "m1", embedding: [0.3, 0.4], headings: ["H"] },
      ],
      embeddingModel: "metis-offline-hash-v1",
      aclSubjects: [],
    });
    expect(quarantine.size).toBe(2);
    expect(docs.get("d1")?.indexState).toBe("quarantined");
    expect(docs.get("d1")?.chunkCount).toBe(2);
  });

  it("clears prior quarantine rows on re-ingest", async () => {
    seedDocument({ id: "d1", projectId: "p1" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "old", md5: "m", embedding: [0.1] }],
      embeddingModel: "m",
      aclSubjects: [],
    });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "new", md5: "m2", embedding: [0.5] }],
      embeddingModel: "m",
      aclSubjects: [],
    });
    expect(quarantine.size).toBe(1);
    const only = [...quarantine.values()][0];
    expect(only.text).toBe("new");
  });

  it("persists caller metadata through quarantine for later approval", async () => {
    seedDocument({ id: "d1", projectId: "p1" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [
        {
          ord: 0,
          text: "hello",
          md5: "m0",
          embedding: [0.1, 0.2],
          metadata: { source: "generated-doc", generatedRevisionId: "rev-1", sectionSlug: "intro" },
        },
      ],
      embeddingModel: "metis-offline-hash-v1",
      aclSubjects: [],
    });

    const parked = [...quarantine.values()][0];
    expect(JSON.parse(parked.metadata)).toMatchObject({
      source: "generated-doc",
      generatedRevisionId: "rev-1",
      sectionSlug: "intro",
    });
  });
});

describe("shouldAutoApprove", () => {
  it("respects per-document override first", async () => {
    seedDocument({
      id: "d1",
      projectId: "p1",
      autoApproveTrusted: true,
    });
    projs.set("p1", { id: "p1", autoApproveTrustedSources: false, deletedAt: null });
    expect(await shouldAutoApprove("d1")).toBe(true);
  });

  it("falls back to project-level flag", async () => {
    seedDocument({ id: "d1", projectId: "p1", autoApproveTrusted: false });
    projs.set("p1", { id: "p1", autoApproveTrustedSources: true, deletedAt: null });
    expect(await shouldAutoApprove("d1")).toBe(true);
  });

  it("returns false when neither flag is set", async () => {
    seedDocument({ id: "d1", projectId: "p1", autoApproveTrusted: false });
    projs.set("p1", { id: "p1", autoApproveTrustedSources: false, deletedAt: null });
    expect(await shouldAutoApprove("d1")).toBe(false);
  });

  it("returns false when document is missing", async () => {
    expect(await shouldAutoApprove("nope")).toBe(false);
  });
});

describe("approveDocument", () => {
  it("moves quarantined chunks to KnowledgeChunk + flips indexState=indexed", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [
        { ord: 0, text: "alpha", md5: "m0", embedding: [0.1, 0.2] },
        { ord: 1, text: "beta", md5: "m1", embedding: [0.3, 0.4] },
      ],
      embeddingModel: "metis-offline-hash-v1",
      aclSubjects: [{ kind: "user", value: "u1" }],
    });
    const result = await approveDocument(
      "d1",
      { id: "u1" },
      { vectorStore: stubVector, bm25: stubBm25 },
    );
    expect(result.chunkCount).toBe(2);
    expect(docs.get("d1")?.indexState).toBe("indexed");
    expect(docs.get("d1")?.status).toBe("ready");
    expect([...quarantine.values()].filter((q) => q.ord >= 0)).toHaveLength(0);
    expect(chunks.size).toBe(2);
    for (const c of chunks.values()) {
      expect(JSON.parse(c.aclSubjects)).toEqual([{ kind: "user", value: "u1" }]);
    }
    // Speculative write plus final-selection replay of the same immutable rows.
    // This structural double exercises replay, not production project locking.
    expect(stubVector.upsert).toHaveBeenCalledTimes(2);
    expect(stubVector.upsert.mock.calls[1]).toEqual(stubVector.upsert.mock.calls[0]);
    expect(stubBm25.upsertDocumentChunks).toHaveBeenCalledTimes(1);
  });

  /**
   * Issue #1182 — the chunker generation has to survive the quarantine hop.
   *
   * Ingest is the only place `chunkMarkdown` runs, so it is the only place that
   * can say how a chunk was cut. If the tag were recomputed at approve time it
   * would describe the configuration active when an operator clicked Approve,
   * not the one that produced the boundaries — and a document can sit in
   * quarantine across a config change.
   */
  it("carries chunkerIdentity from ingest through to KnowledgeChunk", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "alpha", md5: "m0", embedding: [0.1] }],
      embeddingModel: "metis-offline-hash-v1",
      chunkerIdentity: "doc:v2:2048/256",
      aclSubjects: [],
    });
    await approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 });

    expect([...chunks.values()].map((c) => c.chunkerIdentity)).toEqual(["doc:v2:2048/256"]);
  });

  it("preserves non-housekeeping metadata into live chunks and vector rows", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [
        {
          ord: 0,
          text: "alpha",
          md5: "m0",
          embedding: [0.1],
          metadata: {
            source: "generated-doc",
            generatedDocumentId: "doc-1",
            generatedDocumentVersion: 3,
            generatedRevisionId: "rev-3",
            sectionSlug: "overview",
          },
        },
      ],
      embeddingModel: "metis-offline-hash-v1",
      aclSubjects: [],
    });

    await approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 });

    const stored = [...chunks.values()][0];
    expect(JSON.parse(stored.metadata ?? "{}")).toMatchObject({
      source: "generated-doc",
      generatedDocumentId: "doc-1",
      generatedDocumentVersion: 3,
      generatedRevisionId: "rev-3",
      sectionSlug: "overview",
    });
    expect(stubVector.upsert).toHaveBeenCalledWith(
      "p1",
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            source: "generated-doc",
            generatedDocumentId: "doc-1",
            generatedDocumentVersion: 3,
            generatedRevisionId: "rev-3",
            sectionSlug: "overview",
          }),
        }),
      ]),
    );
  });

  it("preserves quarantine on BM25 upsert failure and succeeds on retry", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "pending" });
    stubBm25.upsertDocumentChunks.mockRejectedValueOnce(new Error("bm25 offline"));
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "alpha", md5: "m0", embedding: [0.1] }],
      embeddingModel: "metis-offline-hash-v1",
      aclSubjects: [],
    });

    await expect(
      approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 }),
    ).rejects.toThrow("bm25 offline");
    expect(docs.get("d1")?.indexState).toBe("quarantined");
    expect([...quarantine.values()].filter((q) => q.ord >= 0)).toHaveLength(1);
    await expect(
      approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 }),
    ).resolves.toEqual({ chunkCount: 1 });
    expect(docs.get("d1")?.indexState).toBe("indexed");
  });

  it("uses metadata defaults for malformed quarantine metadata with a valid embedding", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    quarantine.set("q_manual", {
      id: "q_manual",
      documentId: "d1",
      projectId: "p1",
      ord: 0,
      text: "alpha",
      embedding: JSON.stringify([0.1, 0.2]),
      metadata: "not-json",
    });

    await expect(
      approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 }),
    ).resolves.toEqual({ chunkCount: 1 });

    expect(chunks.size).toBe(1);
    const stored = [...chunks.values()][0];
    expect(stored.embeddingModel).toBe("metis-offline-hash-v1");
    expect(stored.chunkerIdentity).toBeNull();
    expect(JSON.parse(stored.metadata ?? "{}")).toEqual({ headings: [] });
    expect(stubVector.upsert).toHaveBeenCalledWith("p1", [
      expect.objectContaining({ id: stored.id, vector: [0.1, 0.2] }),
    ]);
    expect(stubBm25.upsertDocumentChunks).toHaveBeenCalledWith(
      "p1",
      "d1",
      "doc.md",
      [{ id: stored.id, position: 0, text: "alpha" }],
      false,
    );
    expect(docs.get("d1")?.indexState).toBe("indexed");
    expect([...quarantine.values()].filter((q) => q.ord >= 0)).toHaveLength(0);
  });

  it("rejects a non-array embedding without selecting chunks or consuming quarantine source", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    const source: MockQuarantine = {
      id: "q_manual",
      documentId: "d1",
      projectId: "p1",
      ord: 0,
      text: "alpha",
      embedding: JSON.stringify({ not: "an-array" }),
      metadata: JSON.stringify({ embeddingModel: "metis-offline-hash-v1" }),
    };
    quarantine.set(source.id, { ...source });

    await expect(
      approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 }),
    ).rejects.toThrow("Quarantine embedding missing; re-ingest before approval");

    expect(chunks.size).toBe(0);
    expect(docs.get("d1")?.indexState).toBe("quarantined");
    // Attempt journals may be added/revoked; the nonnegative source row is intact.
    expect([...quarantine.values()].filter((q) => q.ord >= 0)).toEqual([source]);
    expect(stubVector.upsert).not.toHaveBeenCalled();
    expect(stubBm25.upsertDocumentChunks).not.toHaveBeenCalled();
  });

  it("writes NULL — never a fabricated default — when the tag is absent", async () => {
    // A quarantine row parked before #1182 genuinely does not know its chunker
    // generation. Inventing a value would report a clean store over gapped chunks,
    // which is precisely the blindness the column was added to remove.
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "alpha", md5: "m0", embedding: [0.1] }],
      embeddingModel: "metis-offline-hash-v1",
      aclSubjects: [],
    });
    // Asserted BEFORE approval: `approveDocument` deletes the quarantine rows, so
    // reading them afterwards would assert against an empty collection and pass
    // for the wrong reason.
    const parked = [...quarantine.values()];
    expect(parked).toHaveLength(1);
    expect(JSON.parse(parked[0].metadata)).not.toHaveProperty("chunkerIdentity");

    await approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 });

    const stored = [...chunks.values()][0];
    expect(stored.chunkerIdentity).toBeNull();
    // Not the active generation, and not the empty string either — those would
    // both read as "on the current chunker" downstream.
    expect(stored.chunkerIdentity).not.toBe("doc:v2:2048/256");
  });

  it("rejects when the document is in an invalid state", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "rejected" });
    await expect(
      approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 }),
    ).rejects.toThrow(/not in approvable state/);
  });

  it("throws when the document is missing", async () => {
    await expect(
      approveDocument("missing", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 }),
    ).rejects.toThrow(/not found/);
  });

  it("fails closed and cleans up when the document is deleted before live chunk mutation", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "alpha", md5: "m0", embedding: [0.1] }],
      embeddingModel: "metis-offline-hash-v1",
      aclSubjects: [],
    });
    const { prisma } = await import("../src/lib/prisma.js");
    vi.mocked(prisma.document.updateMany).mockResolvedValueOnce({ count: 0 });

    await expect(
      approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 }),
    ).rejects.toThrow(/no longer approvable/);

    expect(chunks.size).toBe(0);
    expect([...quarantine.values()].filter((q) => q.ord >= 0)).toHaveLength(1);
    expect(stubVector.deleteByChunkIds).toHaveBeenCalledWith("p1", expect.any(Array));
    expect(stubVector.upsert).not.toHaveBeenCalled();
    expect(stubBm25.upsertDocumentChunks).not.toHaveBeenCalled();
  });

  it("removes resurrected live rows when the document is deleted before finalize", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "alpha", md5: "m0", embedding: [0.1] }],
      embeddingModel: "metis-offline-hash-v1",
      aclSubjects: [],
    });
    const { prisma } = await import("../src/lib/prisma.js");
    stubBm25.upsertDocumentChunks.mockImplementationOnce(async () => {
      vi.mocked(prisma.document.updateMany).mockResolvedValueOnce({ count: 0 });
    });

    await expect(
      approveDocument("d1", { id: "u1" }, { vectorStore: stubVector, bm25: stubBm25 }),
    ).rejects.toThrow(/no longer approvable/);

    expect(chunks.size).toBe(0);
    expect([...quarantine.values()].filter((q) => q.ord >= 0)).toHaveLength(1);
    // Final SQL CAS fails before replay, so only the speculative write occurred.
    expect(stubVector.upsert).toHaveBeenCalledTimes(1);
    expect(stubVector.deleteByChunkIds).toHaveBeenCalledWith("p1", expect.any(Array));
    expect(stubBm25.upsertDocumentChunks).toHaveBeenCalledTimes(1);
    expect(docs.get("d1")?.indexState).toBe("quarantined");
  });
});

describe("rejectDocument", () => {
  it("drops quarantine rows + flips indexState to rejected", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "quarantined" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "x", md5: "m", embedding: [0.1] }],
      embeddingModel: "m",
      aclSubjects: [],
    });
    await rejectDocument("d1", { id: "u1" }, "looked sketchy");
    expect(docs.get("d1")?.indexState).toBe("rejected");
    expect(quarantine.size).toBe(0);
  });

  it("is idempotent on already-rejected documents", async () => {
    seedDocument({ id: "d1", projectId: "p1", indexState: "rejected" });
    await rejectDocument("d1", { id: "u1" });
    expect(docs.get("d1")?.indexState).toBe("rejected");
  });
});

describe("listQuarantine", () => {
  it("returns rows for the given project", async () => {
    seedDocument({ id: "d1", projectId: "p1" });
    seedDocument({ id: "d2", projectId: "p2" });
    await writeQuarantine({
      documentId: "d1",
      projectId: "p1",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "x", md5: "m", embedding: [0.1] }],
      embeddingModel: "m",
      aclSubjects: [],
    });
    await writeQuarantine({
      documentId: "d2",
      projectId: "p2",
      filename: "doc.md",
      chunks: [{ ord: 0, text: "y", md5: "m", embedding: [0.2] }],
      embeddingModel: "m",
      aclSubjects: [],
    });
    const rows = await listQuarantine("p1");
    expect(rows).toHaveLength(1);
    expect(rows[0].documentId).toBe("d1");
  });
});
