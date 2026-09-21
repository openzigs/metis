/** Real PgVectorStore SQL adapter over a READ COMMITTED statement double.
 * This proves service/adapter wiring, NOT PostgreSQL locking or durability.
 * SQLite + real file IO/approval proofs live in approval-reindex-local-persistence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Embedder } from "./embedder.js";
import type { SymbolEmbeddingsPort } from "../code-graph/symbol-embedding-service.js";
import type { StorageBackend } from "../documents/storage.js";
import { assertApprovalGeneration, type VectorGeneration } from "./project-vector-write.js";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("../prisma.js", () => ({
  get prisma() {
    return state.db;
  },
}));
import { KnowledgeService } from "./knowledge-service.js";
import { PgVectorStore } from "./vector-store-pgvector.js";
import { NullReindexLeaseBackend } from "./reindex-lease.js";

const PROJECT = "pg_followon";
const MODEL_A = "rollback-a";
const MODEL_B = "rollback-b";
const symbols: SymbolEmbeddingsPort = {
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
  isBusy: () => false,
};
const row = (id: string, model = MODEL_A) => ({
  id,
  vector: [1, 2],
  metadata: {
    chunkId: id,
    documentId: id,
    filename: `${id}.md`,
    position: 0,
    text: id,
    embeddingModel: model,
  },
});
function fixture() {
  let chunks = ["kept", "deleted"].map((id) => ({
    id,
    projectId: PROJECT,
    documentId: id,
    position: 0,
    text: id,
    embeddingModel: MODEL_B,
    document: { filename: `${id}.md` },
  }));
  let vectors = [row("kept"), row("deleted")].map((value) => ({ ...value, project: PROJECT }));
  let generation: VectorGeneration = { model: MODEL_B, dimension: 2, pending: false };
  const trace: string[] = [];
  const knowledgeChunk = {
    findMany: vi.fn(async ({ where }: { where?: { projectId?: string; id?: { in: string[] } } }) =>
      chunks
        .filter(
          (chunk) =>
            (!where?.projectId || chunk.projectId === where.projectId) &&
            (!where?.id || where.id.in.includes(chunk.id)),
        )
        .map((chunk) => ({ ...chunk })),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: { in: string[] }; embeddingModel?: { not: string } };
        data: { embeddingModel: string };
      }) => {
        let count = 0;
        for (const chunk of chunks)
          if (
            where.id.in.includes(chunk.id) &&
            chunk.embeddingModel !== where.embeddingModel?.not
          ) {
            chunk.embeddingModel = data.embeddingModel;
            count++;
          }
        return { count };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: { documentId: string } }) => {
      chunks = chunks.filter((chunk) => chunk.documentId !== where.documentId);
    }),
  };
  const execute = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    trace.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) return 1;
    if (sql.includes("INSERT INTO rag_vector_generations")) {
      generation = {
        model: values[1] as string,
        dimension: values[2] as number,
        pending: values[3] as boolean,
      };
      return 1;
    }
    if (sql.startsWith('DELETE FROM "rag_vectors"')) {
      vectors = vectors.filter(
        (value) =>
          value.project !== values[0] ||
          (sql.includes('"document_id"') && value.metadata.documentId !== values[1]),
      );
      return 1;
    }
    if (sql.startsWith('UPDATE "rag_vectors"')) {
      for (const value of vectors)
        if (value.project === values[1]) value.project = values[0] as string;
      return 1;
    }
    throw new Error(`Unexpected statement: ${sql}`);
  });
  const executeUnsafe = vi.fn(async (sql: string, ...values: unknown[]) => {
    trace.push(sql);
    if (sql.startsWith("DO $$")) return 0;
    if (sql.startsWith('DELETE FROM "rag_vectors"')) {
      vectors = vectors.filter(
        (value) => value.project !== values[0] || !values.slice(1).includes(value.id),
      );
      return 1;
    }
    if (sql.startsWith('INSERT INTO "rag_vectors"')) {
      const n = (values.length - 2) / 7;
      for (let index = 0; index < n; index++) {
        const [project, id, vector, text, documentId, position, filename] = values.slice(
          index * 7,
          index * 7 + 7,
        );
        vectors = vectors.filter((value) => value.project !== project || value.id !== id);
        vectors.push({
          id: id as string,
          project: project as string,
          vector: JSON.parse(vector as string) as number[],
          metadata: {
            chunkId: id as string,
            text: text as string,
            documentId: documentId as string,
            position: position as number,
            filename: filename as string,
            embeddingModel: values[n * 7] as string,
          },
        });
      }
      return n;
    }
    throw new Error(`Unexpected statement: ${sql}`);
  });
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    trace.push(sql);
    if (sql.includes("atttypmod")) return [{ dim: 2 }];
    if (sql.includes("FROM rag_vector_generations")) return [{ ...generation }];
    if (sql.includes('vector_dims("embedding")'))
      return vectors
        .filter((value) => value.project === values[0])
        .map((value) => ({
          id: value.id,
          model: value.metadata.embeddingModel,
          dimension: value.vector.length,
        }));
    throw new Error(`Unexpected query: ${sql}`);
  });
  const tx = {
    knowledgeChunk,
    document: { update: vi.fn(async () => ({})) },
    quarantineChunk: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $executeRaw: execute,
    $executeRawUnsafe: executeUnsafe,
    $queryRaw: query,
  };
  const db = {
    ...tx,
    document: {
      ...tx.document,
      findFirst: vi.fn(async () => ({ projectId: PROJECT, storagePath: "deleted.md" })),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  state.db = db as unknown as PrismaClient;
  const store = new PgVectorStore({ db: state.db, dimension: 2 });
  const service = new KnowledgeService({
    embedder: {
      model: MODEL_A,
      dimension: 2,
      embed: async (texts: string[]) => ({
        model: MODEL_A,
        dimension: 2,
        vectors: texts.map(() => [1, 2]),
      }),
    } as unknown as Embedder,
    vectorStore: store,
    symbolEmbeddings: symbols,
    reindexLeaseBackend: new NullReindexLeaseBackend(),
    storage: { remove: vi.fn(async () => {}) } as unknown as StorageBackend,
  });
  return { service, store, db, tx, trace, chunks: () => chunks, generation: () => generation };
}
afterEach(() => vi.restoreAllMocks());

describe("pgvector follow-on service/adapter contracts (not live PostgreSQL)", () => {
  it("reconciles a completed service deletion at the final-read/swap barrier without deleting a concurrent winner", async () => {
    const f = fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const swap = f.store.swapTable.bind(f.store);
    vi.spyOn(f.store, "swapTable").mockImplementationOnce(async (...args) => {
      expect(f.tx.knowledgeChunk.findMany).toHaveBeenCalledTimes(3);
      expect(args[3]).toBe(f.tx);
      enter();
      await resumed;
      await swap(...args);
      // Winner inserted AFTER replacement, not in the cutover-owned ID set.
      await f.store.upsert(PROJECT, [row("winner")], args[3]);
    });
    const running = f.service.reindexProject(PROJECT);
    try {
      await entered;
      await f.service.deleteDocument("deleted");
      expect(f.chunks().map((chunk) => chunk.id)).toEqual(["kept"]);
      expect((await f.store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId)).toEqual(["kept"]);
      release();
      await running;
      expect((await f.store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId).sort()).toEqual([
        "kept",
        "winner",
      ]);
      expect(f.tx.knowledgeChunk.findMany).toHaveBeenLastCalledWith({
        where: { projectId: PROJECT, id: { in: ["kept", "deleted"] } },
        select: { id: true },
      });
    } finally {
      release();
      await running;
    }
  });

  it("retag reconciles restored model A and SQL through the advisory transaction before admitting A writes", async () => {
    const f = fixture();
    expect(f.generation().model).toBe(MODEL_B);
    await f.service.retagToActiveModel();
    expect(f.db.$transaction).toHaveBeenCalledOnce();
    expect(f.generation()).toEqual({ model: MODEL_A, dimension: 2, pending: false });
    expect(f.chunks().every((chunk) => chunk.embeddingModel === MODEL_A)).toBe(true);
    const lock = f.trace.findIndex((sql) => sql.includes("pg_advisory_xact_lock(543000003"));
    const descriptor = f.trace.findIndex((sql) =>
      sql.includes("INSERT INTO rag_vector_generations"),
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(descriptor).toBeGreaterThan(lock);
    await f.store.withProjectWrite(PROJECT, async (write) => {
      const generation = await write.readGeneration();
      expect(() => assertApprovalGeneration(generation, [row("candidate", MODEL_B)])).toThrow(
        "generation is stale",
      );
      assertApprovalGeneration(generation, [row("candidate")]);
      await write.upsert(PROJECT, [row("candidate")]);
    });
    expect((await f.store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId)).toContain("candidate");
  });
});
