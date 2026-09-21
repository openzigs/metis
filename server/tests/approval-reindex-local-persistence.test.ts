/**
 * Companion to generated-doc-publication-ownership.test.ts: real SQLite,
 * on-disk LocalVectorStore and MiniSearch, through the REAL document reindex.
 * Only the embedder, audit/singleton setup and unrelated symbol corpus are substituted.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import type { Embedder } from "../src/lib/rag/embedder.js";
import type { SymbolEmbeddingsPort } from "../src/lib/code-graph/symbol-embedding-service.js";
import type { ProjectVectorWrite } from "../src/lib/rag/project-vector-write.js";

const state = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../src/lib/prisma.js", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/scheduler/index.js", () => ({ getSchedulerBootstrap: vi.fn() }));
vi.mock("../src/lib/rag/knowledge-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/knowledge-service.js")>()),
  // approveDocument touches this global after succeeding. All tested operations
  // use the actual exported class and explicitly injected stores, never this getter.
  getKnowledgeService: () => ({}),
}));

import { BM25Index } from "../src/lib/rag/bm25-index.js";
import { LocalVectorStore } from "../src/lib/rag/vector-store.js";
import { NullReindexLeaseBackend } from "../src/lib/rag/reindex-lease.js";
import { KnowledgeService, type ReindexOptions } from "../src/lib/rag/knowledge-service.js";
import { approveDocument, writeQuarantine } from "../src/lib/rag/quarantine.js";
import { reindexAll, type MigrationDeps } from "../src/lib/rag/embed-migration.js";

const PROJECT = "approval_reindex";
const OLD_MODEL = "approval-test-v1";
const NEW_MODEL = "approval-test-v2";
const DOCUMENTS = ["seed", "candidate"];
const sorted = (values: string[]) => [...values].sort();
type SelectedChunk = { id: string; documentId: string; position: number; text: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Observe lock scope without replacing acquisition, SQL, file IO or mutation. */
const projectWriteScope = new AsyncLocalStorage<boolean>();
class ObservedLocalVectorStore extends LocalVectorStore {
  override withProjectWrite<T>(
    projectId: string,
    fn: (write: ProjectVectorWrite) => Promise<T>,
  ): Promise<T> {
    return super.withProjectWrite(projectId, (write) =>
      projectWriteScope.run(true, () => fn(write)),
    );
  }
}
function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async pause() {
      // Moving the project lock around speculative IO would make the requested
      // ordering impossible. Fail immediately instead of awaiting a circular lock.
      if (projectWriteScope.getStore()) {
        throw new Error(
          "Test checkpoint holds project coordination; concurrent ordering unsupported",
        );
      }
      enter();
      await resumed;
    },
  };
}
function observe<T>(task: Promise<T>): Promise<Outcome<T>> {
  return task.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}
async function completed<T>(task: Promise<Outcome<T>>): Promise<T> {
  const result = await task;
  if (!result.ok) throw result.error;
  return result.value;
}
async function enteredBeforeCompletion<T>(
  gate: ReturnType<typeof barrier>,
  task: Promise<Outcome<T>>,
) {
  await Promise.race([
    gate.entered,
    task.then((result) => {
      if (!result.ok) throw result.error;
      throw new Error("Operation completed without reaching its required checkpoint");
    }),
  ]);
}
function vectorFor(text: string, dimension: number): number[] {
  return Array.from({ length: dimension }, (_, index) => (text.charCodeAt(0) || 1) + index);
}
function makeEmbedder(model = OLD_MODEL, dimension = 2) {
  const embed = vi.fn(async (texts: string[]) => ({
    model,
    dimension,
    vectors: texts.map((text) => vectorFor(text, dimension)),
  }));
  return { model, dimension, embed };
}
const emptySymbols: SymbolEmbeddingsPort = {
  isBusy: () => false,
  coverage: async () => ({ totalSymbols: 0, modelCounts: {} }),
  deploymentCoverage: async () => new Map(),
  reindexProject: async (projectId) => ({
    projectId,
    totalSymbols: 0,
    resumedSymbols: 0,
    embeddedSymbols: 0,
    currentModel: "",
  }),
  dropProject: async () => {},
  retagToActiveModel: async () => 0,
};
// The injected empty symbol corpus isolates only the unrelated second phase.
const documentReindexOptions: ReindexOptions = { batchSize: 1 };

describe.runIf(readGeneratedClientProvider() === "sqlite")(
  "approval/reindex real local persistence",
  () => {
    let db: PrismaClient;
    let directory: string;
    let root: string;
    let store: ObservedLocalVectorStore;
    let bm25: BM25Index;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "metis-approval-reindex-"));
      root = join(directory, "vectors");
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: `file:${join(directory, "db.sqlite")}` }),
      });
      state.db = db;
      // Scalar schema copied from the ownership harness and checked against the
      // actual Document/KnowledgeChunk/QuarantineChunk Prisma models. No app DB.
      for (const sql of [
        `CREATE TABLE documents (id TEXT PRIMARY KEY, projectId TEXT, filename TEXT, mimeType TEXT,
      sizeBytes INTEGER, storagePath TEXT, checksum TEXT, status TEXT DEFAULT 'pending',
      indexState TEXT DEFAULT 'pending', autoApproveTrusted BOOLEAN DEFAULT false,
      aclSubjects TEXT DEFAULT '[]', isSpec BOOLEAN DEFAULT false, errorMessage TEXT,
      chunkCount INTEGER DEFAULT 0, uploadedById TEXT, uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      processedAt DATETIME, deletedAt DATETIME)`,
        `CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, projectId TEXT, documentId TEXT,
      position INTEGER, text TEXT, md5 TEXT, embeddingModel TEXT, chunkerIdentity TEXT,
      vectorRef TEXT, metadata TEXT, aclSubjects TEXT DEFAULT '[]', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE quarantine_chunks (id TEXT PRIMARY KEY, documentId TEXT, projectId TEXT,
      ord INTEGER, text TEXT, embedding TEXT, metadata TEXT DEFAULT '{}', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      ])
        await db.$executeRawUnsafe(sql);
      store = new ObservedLocalVectorStore({ root });
      bm25 = new BM25Index();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.$disconnect();
      state.db = null;
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    function service(embedder = makeEmbedder()) {
      return new KnowledgeService({
        embedder: embedder as unknown as Embedder,
        vectorStore: store,
        bm25,
        symbolEmbeddings: emptySymbols,
        // Never resolve DATABASE_URL: even a developer configured for Postgres
        // runs this proof exclusively against the temporary SQLite database.
        reindexLeaseBackend: new NullReindexLeaseBackend(),
      });
    }
    function approve(documentId: string) {
      return approveDocument(documentId, { id: "actor" }, { vectorStore: store, bm25 });
    }
    async function quarantine(documentId: string, text: string, model = OLD_MODEL, dimension = 2) {
      await db.document.upsert({
        where: { id: documentId },
        update: {},
        create: {
          id: documentId,
          projectId: PROJECT,
          filename: `${documentId}.md`,
          mimeType: "text/markdown",
          sizeBytes: text.length,
          storagePath: `${documentId}.md`,
          checksum: text,
          uploadedById: "actor",
        },
      });
      await writeQuarantine({
        documentId,
        projectId: PROJECT,
        filename: `${documentId}.md`,
        chunks: [{ ord: 0, text, md5: text, embedding: vectorFor(text, dimension) }],
        embeddingModel: model,
        aclSubjects: [],
      });
    }
    async function selected(): Promise<SelectedChunk[]> {
      return db.knowledgeChunk.findMany({
        where: { projectId: PROJECT },
        select: { id: true, documentId: true, position: true, text: true },
        orderBy: { id: "asc" },
      });
    }
    async function seed() {
      await quarantine("seed", "alpha");
      await approve("seed");
      const rows = await selected();
      expect(rows).toHaveLength(1);
      return rows;
    }
    async function sourceRows() {
      return db.quarantineChunk.findMany({
        where: { documentId: "candidate", ord: { gte: 0 } },
        orderBy: { ord: "asc" },
      });
    }
    async function generation() {
      // A new instance must read the persisted descriptor, not a service cache.
      return new LocalVectorStore({ root }).withProjectWrite(PROJECT, (write) =>
        write.readGeneration(),
      );
    }
    async function assertIndexed(documentId: string) {
      expect(await db.document.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject({
        indexState: "indexed",
        status: "ready",
        deletedAt: null,
        chunkCount: 1,
        errorMessage: null,
      });
      expect(await db.quarantineChunk.count({ where: { documentId, ord: { gte: 0 } } })).toBe(0);
    }
    async function assertRevoked(candidateIds: string[]) {
      const journals = await db.quarantineChunk.findMany({
        where: { documentId: "candidate", ord: { lt: 0 } },
      });
      expect(journals).toHaveLength(1);
      expect(journals[0].ord).toBe(-1);
      expect(JSON.parse(journals[0].metadata)).toMatchObject({ approvalChunkIds: candidateIds });
    }
    async function assertExact(
      expected: SelectedChunk[],
      model = OLD_MODEL,
      dimension = 2,
      sqlModel = model,
    ) {
      const ids = sorted(expected.map((row) => row.id));
      expect(await selected()).toEqual([...expected].sort((a, b) => a.id.localeCompare(b.id)));
      expect(
        await db.knowledgeChunk.findMany({
          where: { projectId: PROJECT },
          select: { id: true, embeddingModel: true, vectorRef: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(ids.map((id) => ({ id, embeddingModel: sqlModel, vectorRef: id })));
      for (const vectors of [store, new LocalVectorStore({ root })]) {
        expect(sorted((await vectors.listChunkRefs(PROJECT)).map((row) => row.chunkId))).toEqual(
          ids,
        );
        expect(await vectors.count(PROJECT)).toBe(ids.length);
        const hits = await vectors.search(PROJECT, vectorFor("alpha", dimension), 100);
        expect(sorted(hits.map((hit) => hit.row.id))).toEqual(ids);
        for (const { row } of hits) {
          const chunk = expected.find((item) => item.id === row.id)!;
          expect(row.vector).toEqual(vectorFor(chunk.text, dimension));
          expect(row.metadata).toMatchObject({
            chunkId: chunk.id,
            documentId: chunk.documentId,
            text: chunk.text,
            embeddingModel: model,
          });
        }
      }
      // Check the REAL MiniSearch membership/count, not only a top-k query or the
      // by-document bookkeeping. Warm state exposes ghosts that a SQL reload hides.
      for (const sparse of [bm25, new BM25Index()]) {
        const project = await sparse.ensureProject(PROJECT);
        expect(project.index.documentCount).toBe(ids.length);
        expect(
          sorted(project.index.search("alpha bravo charlie").map((hit) => String(hit.id))),
        ).toEqual(ids);
        for (const id of ids) expect(project.index.has(id)).toBe(true);
        for (const documentId of DOCUMENTS) {
          expect(sorted(await sparse.documentChunkIds(PROJECT, documentId))).toEqual(
            sorted(expected.filter((row) => row.documentId === documentId).map((row) => row.id)),
          );
        }
      }
    }
    function pauseApproval() {
      const gate = barrier();
      const upsert = bm25.upsertDocumentChunks.bind(bm25);
      let candidates: SelectedChunk[] = [];
      vi.spyOn(bm25, "upsertDocumentChunks").mockImplementationOnce(async (...args) => {
        await upsert(...args);
        candidates = args[3].map((row) => ({ ...row, documentId: args[1] }));
        await gate.pause();
      });
      return { gate, candidates: () => candidates };
    }

    it("replays approval vectors after real reindex swaps them away before the SQL selection", async () => {
      const original = await seed();
      await quarantine("candidate", "bravo");
      const { gate, candidates } = pauseApproval();
      const approving = observe(approve("candidate"));
      try {
        await enteredBeforeCompletion(gate, approving);
        expect(await selected()).toEqual(original);
        const candidateIds = candidates().map((row) => row.id);
        expect(candidateIds).toHaveLength(1);
        expect(
          sorted(
            (await new LocalVectorStore({ root }).listChunkRefs(PROJECT)).map((row) => row.chunkId),
          ),
        ).toEqual(sorted([...original.map((row) => row.id), ...candidateIds]));
        expect(await bm25.documentChunkIds(PROJECT, "candidate")).toEqual(candidateIds);

        await service().reindexProject(PROJECT, documentReindexOptions);
        // Prove the actual destructive swap completed while approval is paused.
        expect(
          (await new LocalVectorStore({ root }).listChunkRefs(PROJECT)).map((row) => row.chunkId),
        ).toEqual(original.map((row) => row.id));
        expect(await selected()).toEqual(original);
        gate.release();
        expect(await completed(approving)).toEqual({ chunkCount: 1 });
        await assertExact([...original, ...candidates()]);
        await assertIndexed("candidate");
        expect(await generation()).toEqual({ model: OLD_MODEL, dimension: 2, pending: false });
      } finally {
        gate.release();
        await approving;
      }
    });

    it.each([
      { model: OLD_MODEL, dimension: 2 },
      { model: NEW_MODEL, dimension: 2 },
      { model: OLD_MODEL, dimension: 3 },
      { model: NEW_MODEL, dimension: 3 },
    ])(
      "catches up approval committed during shadow build at $model/$dimension",
      async ({ model, dimension }) => {
        const original = await seed();
        await quarantine("candidate", "bravo");
        const embedding = barrier();
        const embedder = makeEmbedder(model, dimension);
        const embed = embedder.embed.getMockImplementation()!;
        embedder.embed.mockImplementationOnce(async (texts) => {
          expect(texts).toEqual(["alpha"]);
          await embedding.pause();
          return embed(texts);
        });
        const reindexing = observe(
          service(embedder).reindexProject(PROJECT, documentReindexOptions),
        );
        try {
          await enteredBeforeCompletion(embedding, reindexing);
          // Initial embedding is OUTSIDE cutover coordination. Do not pause catch-up
          // embedding inside SQLite's transaction and then wait for another SQL writer.
          await approve("candidate");
          const committed = await selected();
          expect(committed).toHaveLength(2);
          expect(committed.filter((row) => row.documentId === "seed")).toEqual(original);
          expect(committed.find((row) => row.documentId === "candidate")?.text).toBe("bravo");
          await assertIndexed("candidate");
          embedding.release();
          expect(await completed(reindexing)).toMatchObject({
            totalChunks: 1,
            reindexedChunks: 2,
            currentModel: model,
          });
          expect(embedder.embed.mock.calls.map(([texts]) => texts)).toEqual([["alpha"], ["bravo"]]);
          await assertExact(committed, model, dimension);
          await assertIndexed("seed");
          await assertIndexed("candidate");
        } finally {
          embedding.release();
          await reindexing;
        }
      },
    );

    it.each([
      { model: NEW_MODEL, dimension: 2 },
      { model: OLD_MODEL, dimension: 3 },
      { model: NEW_MODEL, dimension: 3 },
    ])(
      "rejects stale paused approval after $model/$dimension cutover without consuming quarantine",
      async ({ model, dimension }) => {
        const original = await seed();
        await quarantine("candidate", "bravo");
        const source = await sourceRows();
        const { gate, candidates } = pauseApproval();
        const approving = observe(approve("candidate"));
        try {
          await enteredBeforeCompletion(gate, approving);
          await service(makeEmbedder(model, dimension)).reindexProject(
            PROJECT,
            documentReindexOptions,
          );
          gate.release();
          await expect(completed(approving)).rejects.toThrow(
            "Quarantine embedding generation is stale",
          );
          expect(await sourceRows()).toEqual(source);
          expect(await db.document.findUniqueOrThrow({ where: { id: "candidate" } })).toMatchObject(
            {
              indexState: "quarantined",
              chunkCount: 1,
            },
          );
          await assertRevoked(candidates().map((row) => row.id));
          await assertExact(original, model, dimension);
          await assertIndexed("seed");
          expect(await generation()).toEqual({ model, dimension, pending: false });
        } finally {
          gate.release();
          await approving;
        }
      },
    );

    it.each(["before", "after"] as const)(
      "persists pending intent across %s-swap failure and clears it only after retry",
      async (boundary) => {
        const original = await seed();
        const swap = store.swapTable.bind(store);
        vi.spyOn(store, "swapTable").mockImplementationOnce(async (...args) => {
          if (boundary === "after") await swap(...args);
          throw new Error("cutover acknowledgement unavailable");
        });
        await expect(
          service(makeEmbedder(NEW_MODEL, 3)).reindexProject(PROJECT, documentReindexOptions),
        ).rejects.toThrow("cutover acknowledgement unavailable");
        expect(await generation()).toEqual({ model: NEW_MODEL, dimension: 3, pending: true });
        // The after-swap failure must really have changed the disk, while the real
        // interactive SQL transaction rolled back its metadata reconciliation.
        expect(await selected()).toEqual(original);
        expect((await db.knowledgeChunk.findMany()).map((row) => row.embeddingModel)).toEqual([
          OLD_MODEL,
        ]);
        const disk = new LocalVectorStore({ root });
        expect(await disk.listChunkRefs(PROJECT)).toEqual([
          {
            chunkId: original[0].id,
            embeddingModel: boundary === "after" ? NEW_MODEL : OLD_MODEL,
            dimension: boundary === "after" ? 3 : 2,
          },
        ]);
        expect(
          (await disk.search(PROJECT, vectorFor("alpha", boundary === "after" ? 3 : 2), 10))[0].row
            .vector,
        ).toEqual(vectorFor("alpha", boundary === "after" ? 3 : 2));
        await assertExact(
          original,
          boundary === "after" ? NEW_MODEL : OLD_MODEL,
          boundary === "after" ? 3 : 2,
          OLD_MODEL,
        );

        // Reopen the store AND sparse index before attempting approval. The candidate
        // already matches the target generation: only pending intent can refuse it.
        store = new ObservedLocalVectorStore({ root });
        bm25 = new BM25Index();
        await quarantine("candidate", "bravo", NEW_MODEL, 3);
        const source = await sourceRows();
        await expect(approve("candidate")).rejects.toThrow("Vector migration pending");
        expect(await sourceRows()).toEqual(source);
        expect(await db.document.findUniqueOrThrow({ where: { id: "candidate" } })).toMatchObject({
          indexState: "quarantined",
        });
        expect(await generation()).toEqual({ model: NEW_MODEL, dimension: 3, pending: true });
        expect(await new LocalVectorStore({ root }).listChunkRefs(PROJECT)).toEqual(
          await disk.listChunkRefs(PROJECT),
        );
        expect(await bm25.documentChunkIds(PROJECT, "candidate")).toEqual([]);
        const [revoked] = await db.quarantineChunk.findMany({
          where: { documentId: "candidate", ord: -1 },
        });
        expect(revoked).toBeDefined();
        const attempt = JSON.parse(revoked.metadata) as { approvalChunkIds: string[] };
        expect(attempt.approvalChunkIds).toHaveLength(1);
        await assertRevoked(attempt.approvalChunkIds);
        await assertExact(
          original,
          boundary === "after" ? NEW_MODEL : OLD_MODEL,
          boundary === "after" ? 3 : 2,
          OLD_MODEL,
        );

        await service(makeEmbedder(NEW_MODEL, 3)).reindexProject(PROJECT, documentReindexOptions);
        expect(await generation()).toEqual({ model: NEW_MODEL, dimension: 3, pending: false });
        await assertExact(original, NEW_MODEL, 3);
        await approve("candidate");
        const committed = await selected();
        expect(committed).toHaveLength(2);
        await assertExact(committed, NEW_MODEL, 3);
        await assertIndexed("candidate");
      },
    );

    it("reindex replay cannot revive a journal revoked by a newer quarantine generation", async () => {
      const original = await seed();
      await quarantine("candidate", "bravo");
      const { gate, candidates } = pauseApproval();
      const approving = observe(approve("candidate"));
      try {
        await enteredBeforeCompletion(gate, approving);
        await quarantine("candidate", "charlie");
        const replacement = await sourceRows();
        await service().reindexProject(PROJECT, documentReindexOptions);
        gate.release();
        await expect(completed(approving)).rejects.toThrow("approval attempt revoked");
        await assertRevoked(candidates().map((row) => row.id));
        expect(await sourceRows()).toEqual(replacement);
        expect(await db.document.findUniqueOrThrow({ where: { id: "candidate" } })).toMatchObject({
          indexState: "quarantined",
          chunkCount: 1,
        });
        await assertExact(original);
        await approve("candidate");
        const committed = await selected();
        expect(committed).toHaveLength(2);
        expect(committed.find((row) => row.documentId === "candidate")?.text).toBe("charlie");
        await assertExact(committed);
        await assertIndexed("candidate");
      } finally {
        gate.release();
        await approving;
      }
    });

    it("bulk recovery discovers durable pending intent after SQL committed but the final descriptor write failed", async () => {
      const original = await seed();
      const coordinated = store.withProjectWrite.bind(store);
      vi.spyOn(store, "withProjectWrite").mockImplementationOnce((projectId, fn) =>
        coordinated(projectId, (write) =>
          fn({
            ...write,
            async writeGeneration(value) {
              if (!value.pending) throw new Error("final descriptor write failed");
              await write.writeGeneration(value);
            },
          }),
        ),
      );
      await expect(service(makeEmbedder(NEW_MODEL)).reindexProject(PROJECT)).rejects.toThrow(
        "final descriptor write failed",
      );
      expect(await generation()).toEqual({ model: NEW_MODEL, dimension: 2, pending: true });
      await assertExact(original, NEW_MODEL);

      store = new ObservedLocalVectorStore({ root });
      await quarantine("candidate", "bravo", NEW_MODEL);
      await expect(approve("candidate")).rejects.toThrow("Vector migration pending");
      const knowledge = service(makeEmbedder(NEW_MODEL));
      expect(await knowledge.coverageReport(PROJECT)).toMatchObject({
        matchingChunks: 1,
        needsReindex: true,
      });
      const coverage = await knowledge.deploymentCoverage();
      expect(coverage.projects).toEqual([
        expect.objectContaining({ projectId: PROJECT, matchingChunks: 1, needsReindex: true }),
      ]);
      const result = await reindexAll({ knowledge, store, kind: "local" } as MigrationDeps);
      expect(result.failures).toEqual([]);
      expect(result.results.map((item) => item.projectId)).toEqual([PROJECT]);
      expect(await generation()).toEqual({ model: NEW_MODEL, dimension: 2, pending: false });
      await approve("candidate");
      await assertExact(await selected(), NEW_MODEL);
      await assertIndexed("candidate");
    });

    it("retag reconciles a restored equal-width generation and permits a subsequent real approval", async () => {
      await seed();
      await service(makeEmbedder(NEW_MODEL)).reindexProject(PROJECT);
      const chunks = await selected();
      // The documented backup restores vectors, NOT rag_vector_generations or SQL tags.
      await store.upsert(
        PROJECT,
        chunks.map((chunk) => ({
          id: chunk.id,
          vector: vectorFor(chunk.text, 2),
          metadata: {
            chunkId: chunk.id,
            documentId: chunk.documentId,
            position: chunk.position,
            text: chunk.text,
            filename: "seed.md",
            embeddingModel: OLD_MODEL,
          },
        })),
      );
      expect(await generation()).toEqual({ model: NEW_MODEL, dimension: 2, pending: false });
      expect(await service().retagToActiveModel()).toMatchObject({ retagged: 1, skipped: 0 });
      expect(await generation()).toEqual({ model: OLD_MODEL, dimension: 2, pending: false });
      await quarantine("candidate", "bravo");
      await approve("candidate");
      await assertExact(await selected());
      await assertIndexed("candidate");
    });
  },
);
