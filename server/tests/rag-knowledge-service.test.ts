/**
 * Knowledge service tests (Phase 5 / issue #43) — end-to-end orchestration
 * with mocked Prisma + filesystem-backed vector store and the deterministic
 * offline embedder. Asserts:
 *
 *   - ingestDocument: 100-chunk doc → 100 vectors persisted
 *   - search: returns ranked snippets with source attribution
 *   - deleteDocument: removes chunks + vectors + blob
 *   - search-knowledge tool returns ranked text and refuses cross-project
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
  // Epic #157 — quarantine + ACL columns.
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
  aclSubjects?: string;
}

interface MockQuarantineChunk {
  id: string;
  documentId: string;
  projectId: string;
  ord: number;
  text: string;
  embedding: string;
  metadata: string;
}

const documents = new Map<string, MockDocument>();
const chunks = new Map<string, MockChunk>();
const quarantine = new Map<string, MockQuarantineChunk>();
let nextQuarantineId = 0;
let nextChunkId = 0;

/**
 * #1185 — the env half of the overlap clamp is announced, so the spy is the only way
 * to assert it. Every module in this test's import graph takes `createChildLogger`
 * and nothing else from `logger.js`, so a stub of the three exports is complete.
 */
const { logWarnSpy } = vi.hoisted(() => ({ logWarnSpy: vi.fn() }));
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: logWarnSpy,
  }),
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  redact: (v: unknown) => v,
}));

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
            (where.deletedAt === null && doc.deletedAt) ||
            (where.indexState && !where.indexState.in.includes(doc.indexState ?? ""))
          )
            return { count: 0 };
          documents.set(where.id, { ...doc, ...data });
          return { count: 1 };
        },
      ),
      findMany: vi.fn(async () => [...documents.values()]),
      findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) => {
        const d = documents.get(where.id);
        return d && !d.deletedAt ? d : null;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => documents.get(where.id) ?? null,
      ),
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
        }: {
          where: { id?: { in: string[] }; documentId?: string; projectId?: string };
        }) => {
          return [...chunks.values()].filter(
            (c) =>
              (!where.id || where.id.in.includes(c.id)) &&
              (!where.documentId || where.documentId === c.documentId) &&
              (!where.projectId || where.projectId === c.projectId),
          );
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
          where: { id?: string; documentId?: string; ord: number | { in: number[] } };
          data: Partial<MockQuarantineChunk>;
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
          let removed = 0;
          for (const [id, q] of quarantine) {
            if (q.documentId === where.documentId && (!where.ord || q.ord >= where.ord.gte)) {
              quarantine.delete(id);
              removed += 1;
            }
          }
          return { count: removed };
        },
      ),
      createMany: vi.fn(
        async ({ data }: { data: (Omit<MockQuarantineChunk, "id"> & { id?: string })[] }) => {
          for (const d of data) {
            nextQuarantineId += 1;
            const id = d.id ?? `q_${nextQuarantineId}`;
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
          const out: MockQuarantineChunk[] = [];
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
      if (typeof ops === "function") return ops((await import("../src/lib/prisma.js")).prisma);
      return Promise.all(ops as Promise<unknown>[]);
    }),
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { __resetEmbedderSingleton } from "../src/lib/rag/embedder.js";
import { LocalVectorStore } from "../src/lib/rag/vector-store.js";
import { DocumentStorage } from "../src/lib/documents/storage.js";
import {
  KnowledgeService,
  __resetKnowledgeServiceSingleton,
} from "../src/lib/rag/knowledge-service.js";
import { approveDocument } from "../src/lib/rag/quarantine.js";
import { Embedder } from "../src/lib/rag/embedder.js";
import { buildSearchKnowledgeTool } from "../src/lib/rag/search-knowledge-tool.js";

let storageRoot: string;
let vectorRoot: string;
let storage: DocumentStorage;
let store: LocalVectorStore;
let svc: KnowledgeService;

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
  });
}

beforeEach(async () => {
  documents.clear();
  chunks.clear();
  quarantine.clear();
  nextQuarantineId = 0;
  nextChunkId = 0;
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metis-storage-"));
  vectorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metis-vec-"));
  storage = new DocumentStorage({ root: storageRoot });
  store = new LocalVectorStore({ root: vectorRoot });
  __resetEmbedderSingleton();
  __resetKnowledgeServiceSingleton();
  svc = new KnowledgeService({
    storage,
    vectorStore: store,
    embedder: new Embedder(),
    chunkOptions: { chunkSize: 100, overlap: 8 },
  });
});

afterEach(async () => {
  await fs.rm(storageRoot, { recursive: true, force: true });
  await fs.rm(vectorRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("KnowledgeService.ingestDocument", () => {
  it("ingests a markdown document, persists chunks + vectors, and marks ready", async () => {
    const text = ["# Heading", "", ...Array.from({ length: 30 }, (_, i) => `paragraph ${i}.`)].join(
      "\n\n",
    );
    await seedDocument("d1", "p1", text);

    const result = await svc.ingestDocument("d1");
    expect(result.status).toBe("ready");
    expect(result.chunkCount).toBeGreaterThan(0);

    const doc = documents.get("d1");
    expect(doc?.status).toBe("ready");
    expect(doc?.chunkCount).toBe(result.chunkCount);

    const allChunks = [...chunks.values()].filter((c) => c.documentId === "d1");
    expect(allChunks.length).toBe(result.chunkCount);
    for (const c of allChunks) {
      expect(c.vectorRef).toBe(c.id);
      expect(c.embeddingModel).toBe("metis-offline-hash-v1");
    }
    expect(await store.count("p1")).toBe(result.chunkCount);
  });

  /**
   * Issue #1182 — ingest is the ONLY writer of `chunkerIdentity`, because
   * `chunkMarkdown` runs only here. If this call site ever loses the tag, every
   * newly-ingested chunk lands NULL and is reported as the pre-#1178 generation
   * forever, so the drift report becomes noise nobody can act on.
   */
  it("stamps the active chunker generation on every chunk it writes", async () => {
    svc = new KnowledgeService({
      storage,
      vectorStore: store,
      embedder: new Embedder(),
      chunkOptions: { chunkSize: 256, overlap: 32 },
    });
    const text = ["# Heading", "", ...Array.from({ length: 30 }, (_, i) => `paragraph ${i}.`)].join(
      "\n\n",
    );
    await seedDocument("d-tag", "p-tag", text);
    const result = await svc.ingestDocument("d-tag");

    const written = [...chunks.values()].filter((c) => c.documentId === "d-tag");
    expect(written.length).toBe(result.chunkCount);
    expect(written.length).toBeGreaterThan(0);
    for (const c of written) {
      // The service's OWN effective options, not the shipped default — a tag that
      // ignored configuration would report drift on every non-default deployment.
      expect(c.chunkerIdentity).toBe("doc:v2:256/32");
    }
  });

  it("a 100-chunk document persists 100 vectors", async () => {
    // Keep chunks small so we can hit ~100 cleanly.
    svc = new KnowledgeService({
      storage,
      vectorStore: store,
      embedder: new Embedder(),
      chunkOptions: { chunkSize: 80, overlap: 0 },
    });
    const text = Array.from({ length: 200 }, (_, i) => `sentence number ${i} here.`).join(" ");
    await seedDocument("dn", "pn", text);
    const result = await svc.ingestDocument("dn");
    expect(result.chunkCount).toBeGreaterThanOrEqual(50);
    expect(await store.count("pn")).toBe(result.chunkCount);
  });

  it("emits document:status events for the lifecycle", async () => {
    const events: Array<{ status: string; chunkCount?: number }> = [];
    svc = new KnowledgeService({
      storage,
      vectorStore: store,
      embedder: new Embedder(),
      chunkOptions: { chunkSize: 100, overlap: 8 },
      emit: (e) => events.push({ status: e.status, chunkCount: e.chunkCount }),
    });
    await seedDocument("d1", "p1", "# hi\n\npara");
    await svc.ingestDocument("d1");
    const statuses = events.map((e) => e.status);
    expect(statuses[0]).toBe("processing");
    expect(statuses[statuses.length - 1]).toBe("ready");
  });

  it("re-ingesting deletes prior chunks/vectors first (idempotent)", async () => {
    await seedDocument("d1", "p1", "para one\n\npara two");
    const a = await svc.ingestDocument("d1");
    const b = await svc.ingestDocument("d1");
    expect(a.chunkCount).toBe(b.chunkCount);
    expect(await store.count("p1")).toBe(b.chunkCount);
  });

  it("marks document as failed when storage read fails", async () => {
    documents.set("ghost", {
      id: "ghost",
      projectId: "p1",
      filename: "missing.md",
      mimeType: "text/markdown",
      storagePath: "p1/never/existed/abc",
      status: "pending",
      errorMessage: null,
      chunkCount: 0,
      processedAt: null,
      deletedAt: null,
    });
    const r = await svc.ingestDocument("ghost");
    expect(r.status).toBe("failed");
    expect(documents.get("ghost")?.status).toBe("failed");
  });

  it("leaves document pending when PDF parser fails on malformed bytes", async () => {
    // pdf-parse is installed, so a malformed PDF surfaces as PDF_PARSE_FAILED
    // (non-fatal — the doc stays in `pending` so a re-ingest can pick it up).
    const blob = await storage.write({ projectId: "p1", buffer: Buffer.from("%PDF-1.4 ...") });
    documents.set("d1", {
      id: "d1",
      projectId: "p1",
      filename: "x.pdf",
      mimeType: "application/pdf",
      storagePath: blob.storagePath,
      status: "pending",
      errorMessage: null,
      chunkCount: 0,
      processedAt: null,
      deletedAt: null,
    });
    const r = await svc.ingestDocument("d1");
    expect(r.status).toBe("pending");
    expect(documents.get("d1")?.errorMessage).toMatch(/^PDF_PARSE_FAILED/);
  });

  it("marks a content/type mismatch failed rather than pending", async () => {
    // #1279 — a PDF stored under a pptx type is refused by the parser router. Unlike a
    // parser failure this can never succeed on a retry, so leaving it `pending` would
    // make every ingest sweep re-read and re-refuse the same bytes forever.
    const blob = await storage.write({
      projectId: "p1",
      buffer: Buffer.from("%PDF-1.4 a real pdf header"),
    });
    documents.set("d-mismatch", {
      id: "d-mismatch",
      projectId: "p1",
      filename: "disguised.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      storagePath: blob.storagePath,
      status: "pending",
      errorMessage: null,
      chunkCount: 0,
      processedAt: null,
      deletedAt: null,
    });

    const r = await svc.ingestDocument("d-mismatch");

    expect(r.status).toBe("failed");
    expect(documents.get("d-mismatch")?.status).toBe("failed");
    expect(documents.get("d-mismatch")?.errorMessage).toMatch(/^CONTENT_TYPE_MISMATCH/);
  });

  it("throws when documentId does not exist", async () => {
    await expect(svc.ingestDocument("missing")).rejects.toThrow();
  });
});

describe("KnowledgeService.search", () => {
  it("returns ranked snippets with source attribution", async () => {
    await seedDocument("d1", "p1", "# Architecture\n\nThe vector store uses cosine similarity.");
    await seedDocument(
      "d2",
      "p1",
      "# Storage\n\nBlobs are deduplicated by sha256 content hash.",
      "storage.md",
    );
    await svc.ingestDocument("d1");
    await svc.ingestDocument("d2");
    const { hits } = await svc.search("p1", "vector cosine similarity", { k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(typeof h.score).toBe("number");
      expect(h.documentId).toMatch(/^d/);
      expect(typeof h.text).toBe("string");
      expect(typeof h.filename).toBe("string");
    }
  });

  it("returns [] for an empty query", async () => {
    const { hits } = await svc.search("p1", "  ", {});
    expect(hits).toEqual([]);
  });

  it("filter by documentIds restricts results", async () => {
    await seedDocument("a", "p1", "alpha alpha alpha");
    await seedDocument("b", "p1", "beta beta beta");
    await svc.ingestDocument("a");
    await svc.ingestDocument("b");
    const { hits } = await svc.search("p1", "alpha", { documentIds: ["b"], k: 5 });
    for (const h of hits) expect(h.documentId).toBe("b");
  });

  it("surfaces a coverageWarning when project has chunks from a different model", async () => {
    await seedDocument("d-old", "pmix", "# Heading\n\nold model paragraph.");
    const oldEmbedder = new Embedder({ backend: "offline", model: "older-model-vX" });
    const oldSvc = new KnowledgeService({
      storage,
      vectorStore: store,
      embedder: oldEmbedder,
      chunkOptions: { chunkSize: 100, overlap: 0 },
    });
    await oldSvc.ingestDocument("d-old");

    await seedDocument("d-new", "pmix", "# Heading\n\nnew model paragraph.");
    const newSvc = new KnowledgeService({
      storage,
      vectorStore: store,
      embedder: new Embedder({ backend: "offline" }),
      chunkOptions: { chunkSize: 100, overlap: 0 },
    });
    await newSvc.ingestDocument("d-new");

    const result = await newSvc.search("pmix", "paragraph", { k: 5 });
    expect(result.coverageWarning).toBeDefined();
    expect(result.coverageWarning?.mismatchedModels).toContain("older-model-vX");
    expect(result.coverageWarning?.currentModel).toBe("metis-offline-hash-v1");
    // Hits should only include current-model chunks.
    for (const h of result.hits) {
      expect(h.embeddingModel).toBe("metis-offline-hash-v1");
    }
  });
});

describe("KnowledgeService.deleteDocument", () => {
  it("removes chunks + vectors + blob and marks document deleted", async () => {
    await seedDocument("d1", "p1", "# t\n\nbody");
    await svc.ingestDocument("d1");
    expect(await store.count("p1")).toBeGreaterThan(0);
    await svc.deleteDocument("d1");
    expect(await store.count("p1")).toBe(0);
    expect(documents.get("d1")?.deletedAt).toBeInstanceOf(Date);
  });

  it("clears quarantined chunks so a deleted pending document cannot be approved later", async () => {
    await seedDocument("d1", "p1", "# t\n\nbody");
    documents.set("d1", {
      ...documents.get("d1")!,
      indexState: "pending",
      autoApproveTrusted: false,
      aclSubjects: "[]",
      uploadedById: "u1",
    });
    await prisma.quarantineChunk.createMany({
      data: [
        {
          documentId: "d1",
          projectId: "p1",
          ord: 0,
          text: "alpha",
          embedding: JSON.stringify([0.1, 0.2]),
          metadata: JSON.stringify({ headings: [] }),
        },
      ],
    });

    await svc.deleteDocument("d1");

    expect(quarantine.size).toBe(0);
    await expect(approveDocument("d1", { id: "u1" }, { vectorStore: store })).rejects.toThrow(
      /not found/,
    );
    expect(await store.count("p1")).toBe(0);
  });

  it("is a no-op for an unknown id", async () => {
    await expect(svc.deleteDocument("nope")).resolves.toBeUndefined();
  });
});

describe("KnowledgeService.dropProject", () => {
  it("drops the per-project vector table", async () => {
    await seedDocument("d1", "p1", "x");
    await svc.ingestDocument("d1");
    await svc.dropProject("p1");
    expect(await store.count("p1")).toBe(0);
  });
});

describe("search-knowledge tool", () => {
  it("returns formatted snippets with source attribution", async () => {
    await seedDocument("d1", "p1", "# Architecture\n\nVectors live in LanceDB tables per project.");
    await svc.ingestDocument("d1");
    const tool = buildSearchKnowledgeTool({ service: svc });
    const result = await tool.exec(
      { projectId: "p1", query: "vectors", k: 3 },
      { sessionId: "s1", userId: "u1" },
    );
    expect(result.text).toContain("Architecture");
    expect(result.text).toMatch(/score=/);
    expect(result.data).toHaveProperty("hits");
    expect(Array.isArray((result.data as { hits: unknown[] }).hits)).toBe(true);
  });

  it("refuses cross-project access when ctx.projectId is bound", async () => {
    const tool = buildSearchKnowledgeTool({ service: svc });
    const result = await tool.exec(
      { projectId: "p2", query: "x" },
      { sessionId: "s1", userId: "u1", projectId: "p1" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("cross-project");
  });

  it("returns '(no matches)' when the project has no chunks", async () => {
    const tool = buildSearchKnowledgeTool({ service: svc });
    const result = await tool.exec(
      { projectId: "empty", query: "x" },
      { sessionId: "s1", userId: "u1" },
    );
    expect(result.text).toBe("(no matches)");
  });
});

/**
 * #1185 — `RAG_CHUNK_OVERLAP` is an operator-facing dial, so this exercises the real
 * env path: no `chunkOptions` dependency injected, values read from `process.env` in
 * the constructor exactly as production does.
 */
describe("RAG_CHUNK_OVERLAP contract", () => {
  const saved = { size: process.env.RAG_CHUNK_SIZE, overlap: process.env.RAG_CHUNK_OVERLAP };

  const envService = (chunkSize: string, overlap: string): KnowledgeService => {
    process.env.RAG_CHUNK_SIZE = chunkSize;
    process.env.RAG_CHUNK_OVERLAP = overlap;
    return new KnowledgeService({ storage, vectorStore: store, embedder: new Embedder() });
  };

  /** Long enough that a collapsed window advance is unmistakable in the chunk count. */
  const LONG_DOC = ["# Ops", "", ...Array.from({ length: 400 }, (_, i) => `| row ${i} | v${i} |`)]
    .join("\n")
    .concat("\n");

  afterEach(() => {
    if (saved.size === undefined) delete process.env.RAG_CHUNK_SIZE;
    else process.env.RAG_CHUNK_SIZE = saved.size;
    if (saved.overlap === undefined) delete process.env.RAG_CHUNK_OVERLAP;
    else process.env.RAG_CHUNK_OVERLAP = saved.overlap;
    logWarnSpy.mockClear();
  });

  it("ingests, rather than failing, when an operator sets an out-of-range overlap", async () => {
    // The clamp-not-reject decision at the surface that motivated it. Before #1185
    // this same configuration ingested ~470x the chunks and embedded every one; the
    // alternative decision (reject) would have failed the ingest outright.
    const svcEnv = envService("2048", "2047");
    await seedDocument("denv", "penv", LONG_DOC);
    const result = await svcEnv.ingestDocument("denv");

    expect(result.status).toBe("ready");
    const shipped = new KnowledgeService({
      storage,
      vectorStore: store,
      embedder: new Embedder(),
      chunkOptions: { chunkSize: 2048, overlap: 256 },
    });
    await seedDocument("dship", "pship", LONG_DOC);
    const baseline = await shipped.ingestDocument("dship");
    expect(baseline.chunkCount).toBeGreaterThan(1);
    expect(result.chunkCount).toBeLessThanOrEqual(baseline.chunkCount * 3);
  });

  it("warns once, naming the requested and effective values", () => {
    envService("2048", "1500");
    expect(logWarnSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = logWarnSpy.mock.calls[0] as [string, Record<string, number>];
    expect(meta).toEqual({ requestedOverlap: 1500, effectiveOverlap: 512, chunkSize: 2048 });
    // Both numbers in the text, so the log line stands on its own without the meta.
    expect(message).toContain("1500");
    expect(message).toContain("512");
    expect(message).toContain("RAG_CHUNK_OVERLAP");
  });

  it("stays silent for an in-range overlap, including the shipped default", () => {
    envService("2048", "256");
    expect(logWarnSpy).not.toHaveBeenCalled();
    delete process.env.RAG_CHUNK_SIZE;
    delete process.env.RAG_CHUNK_OVERLAP;
    new KnowledgeService({ storage, vectorStore: store, embedder: new Embedder() });
    expect(logWarnSpy).not.toHaveBeenCalled();
  });
});
