/**
 * Reindex hardening tests — issues #99 (delta re-apply) and #100 (cross-process
 * advisory lock).
 *
 * #99: a chunk ingested into the LIVE table mid-reindex must survive the shadow
 *      swap and be present in the new index afterwards.
 * #100: the per-project reindex guard is backed by a Postgres advisory lock when
 *      the deployment runs on Postgres, with the in-process Set as the fast path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { LocalVectorStore, type VectorStore } from "./vector-store.js";
import {
  KnowledgeService,
  ReindexConflictError,
  ReindexFencedError,
  reindexShadowId,
} from "./knowledge-service.js";
import {
  __resetReindexLeaseBackend,
  MemoryReindexLeaseBackend,
  reindexLockName,
} from "./reindex-lease.js";
import type { Embedder } from "./embedder.js";
import { assertApprovalGeneration } from "./project-vector-write.js";

// ---- Prisma mock ----------------------------------------------------------

const mockKnowledgeChunk = {
  findMany: vi.fn(),
  updateMany: vi.fn(),
};
const mockQueryRaw = vi.fn();
const mockExecuteRaw = vi.fn();
let inTransaction = false;
// Keep separate transaction-client spies: calling the root client during
// cutover must not satisfy the transactional membership/reconciliation checks.
const mockTransactionClient = {
  knowledgeChunk: {
    findMany: vi.fn((...args: unknown[]) => mockKnowledgeChunk.findMany(...args)),
    updateMany: vi.fn((...args: unknown[]) => mockKnowledgeChunk.updateMany(...args)),
  },
};
const mockTransaction = vi.fn(
  async (fn: (tx: typeof mockTransactionClient) => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn(mockTransactionClient);
    } finally {
      inTransaction = false;
    }
  },
);

// Issue #797 — KnowledgeService now drives a SECOND corpus (code-symbol vectors)
// through the same reindex/coverage/drop path. These suites are about the
// DOCUMENT half, so the symbol port is stubbed to an empty project; #797's own
// suites exercise the real one.
vi.mock("../code-graph/symbol-embedding-service.js", () => ({
  getSymbolEmbeddingsPort: () => ({
    coverage: async () => ({ totalSymbols: 0, modelCounts: {} }),
    deploymentCoverage: async () => new Map(),
    reindexProject: async (projectId: string) => ({
      projectId,
      totalSymbols: 0,
      resumedSymbols: 0,
      embeddedSymbols: 0,
      currentModel: "",
    }),
    dropProject: async () => {},
    isBusy: () => false,
    retagToActiveModel: async () => 0,
  }),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    knowledgeChunk: {
      findMany: (...a: unknown[]) => mockKnowledgeChunk.findMany(...a),
      updateMany: (...a: unknown[]) => mockKnowledgeChunk.updateMany(...a),
    },
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
    $transaction: (fn: (tx: typeof mockTransactionClient) => Promise<unknown>) =>
      mockTransaction(fn),
  },
}));

// ---- Fake embedder --------------------------------------------------------

/**
 * Deterministic embedder: maps text → a 4-dim vector keyed on its first char so
 * cosine search can resolve a known chunk back out of the store.
 */
function makeEmbedder(model = "fake-model-v2"): Embedder {
  const embed = async (texts: string[]) => ({
    vectors: texts.map((t) => {
      const code = t.charCodeAt(0) || 1;
      return [code, code % 7, code % 5, 1];
    }),
    model,
    dimension: 4,
  });
  return { model, dimension: 4, embed } as unknown as Embedder;
}

function makeStore(): { store: VectorStore; root: string } {
  const root = path.join(os.tmpdir(), `kbtest-${Math.random().toString(36).slice(2)}`);
  return { store: new LocalVectorStore({ root }), root };
}

const PROJECT = "proj_reindex_test";

/** A Prisma-shaped chunk row for the snapshot query. */
function chunkRow(n: number) {
  return {
    id: `c${n}`,
    documentId: "d1",
    position: n,
    text: `text ${n}`,
    embeddingModel: "old-model",
    document: { filename: "f.md" },
  };
}

/** One stored vector row, for seeding a namespace directly. */
function storedRow(id: string) {
  return {
    id,
    vector: [1, 2, 3, 4],
    metadata: {
      chunkId: id,
      documentId: "d1",
      filename: "f.md",
      position: 0,
      text: id,
      embeddingModel: "fake-model-v2",
    },
  };
}

/** Put one row in the project's shadow, so it LOOKS like a resumable checkpoint. */
async function seedShadow(store: VectorStore): Promise<void> {
  await store.upsert(reindexShadowId(PROJECT), [
    {
      id: "c1",
      vector: [1, 2, 3, 4],
      metadata: {
        chunkId: "c1",
        documentId: "d1",
        filename: "f.md",
        position: 0,
        text: "t",
        embeddingModel: "fake-model-v2",
      },
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // A failed run may leave unconsumed mockResolvedValueOnce entries behind.
  mockKnowledgeChunk.findMany.mockReset();
  inTransaction = false;
  delete process.env.DATABASE_URL;
  __resetReindexLeaseBackend();
  mockKnowledgeChunk.updateMany.mockResolvedValue({ count: 0 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DATABASE_URL;
});

/**
 * Issue #1182 — a reindex must NOT stamp `chunkerIdentity`.
 *
 * This is the invariant that keeps the new drift report honest. `reindexProject`
 * re-embeds stored chunk TEXT; it never calls `chunkMarkdown`, so it moves no
 * boundary. If its post-swap `updateMany` also refreshed the chunker tag, a
 * reindex would silently convert a gapped corpus into one that REPORTS as
 * current — the same class of lie #804 fixed for `retag`, where coverage
 * confidently described an index that did not exist.
 */
describe("reindexProject — #1182: re-embedding never re-tags the chunker generation", () => {
  it("writes only embeddingModel in the post-swap reconcile", async () => {
    const { store, root } = makeStore();
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });

    const chunk = {
      id: "chunkA",
      documentId: "doc1",
      position: 0,
      text: "Apple",
      embeddingModel: "old-model",
      document: { filename: "a.md" },
    };
    mockKnowledgeChunk.findMany
      .mockResolvedValueOnce([chunk])
      .mockResolvedValueOnce([chunk])
      .mockResolvedValue([{ id: "chunkA" }]);

    await svc.reindexProject(PROJECT);

    // There must be at least one write, or this test would pass vacuously against
    // a reindex that reconciled nothing at all.
    expect(mockKnowledgeChunk.updateMany.mock.calls.length).toBeGreaterThan(0);
    expect(mockTransactionClient.knowledgeChunk.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { projectId: PROJECT, id: { in: ["chunkA"] } },
      data: { embeddingModel: "fake-model-v2" },
    });
    for (const [args] of mockKnowledgeChunk.updateMany.mock.calls) {
      const data = (args as { data: Record<string, unknown> }).data;
      expect(Object.keys(data)).toEqual(["embeddingModel"]);
      expect(data).not.toHaveProperty("chunkerIdentity");
    }

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("reindexProject — #99 pre-swap SQL membership catch-up", () => {
  it("removes exact tombstones when deletion completes AFTER the final membership read and BEFORE swap", async () => {
    const { store, root } = makeStore();
    const rows = [chunkRow(1), { ...chunkRow(2), documentId: "deleted" }];
    let selected = rows;
    mockKnowledgeChunk.findMany.mockImplementation(async () => [...selected]);
    await store.upsert(PROJECT, [
      storedRow("c1"),
      {
        ...storedRow("c2"),
        metadata: { ...storedRow("c2").metadata, documentId: "deleted" },
      },
    ]);
    let entered!: () => void;
    let resume!: () => void;
    const atSwap = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const swap = store.swapTable.bind(store);
    vi.spyOn(store, "swapTable").mockImplementationOnce(async (...args) => {
      expect(mockTransactionClient.knowledgeChunk.findMany).toHaveBeenCalledTimes(2);
      entered();
      await released;
      await swap(...args);
      await store.upsert(PROJECT, [storedRow("winner")]);
    });
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });
    const running = svc.reindexProject(PROJECT);
    try {
      await atSwap;
      // SQL is a READ COMMITTED model here (SQLite cannot run a second writer
      // inside its open transaction). File vector deletion and swap are REAL.
      selected = [rows[0]];
      await store.deleteByDocument(PROJECT, "deleted");
      expect((await store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId)).toEqual(["c1"]);
      // The swap hook writes a concurrent speculative winner after replacement;
      // it is not a cutover-owned tombstone and must survive reconciliation.
      resume();
      await running;
      expect(
        (await new LocalVectorStore({ root }).listChunkRefs(PROJECT))
          .map((ref) => ref.chunkId)
          .sort(),
      ).toEqual(["c1", "winner"]);
    } finally {
      resume();
      await running;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("re-embeds and upserts a chunk ingested mid-reindex so it survives the swap", async () => {
    const { store, root } = makeStore();
    const embedder = makeEmbedder();
    const svc = new KnowledgeService({ embedder, vectorStore: store });

    // Seed the original (pre-reindex) snapshot with chunk "A".
    const original = [
      {
        id: "chunkA",
        documentId: "doc1",
        position: 0,
        text: "Apple",
        embeddingModel: "old-model",
        document: { filename: "a.md" },
      },
    ];
    // B becomes SQL-selected after the initial snapshot. Its creation timestamp
    // is irrelevant: membership, not a createdAt watermark, drives catch-up.
    const delta = [
      {
        id: "chunkB",
        documentId: "doc2",
        position: 0,
        text: "Banana",
        embeddingModel: "old-model",
        document: { filename: "b.md" },
      },
    ];

    // Initial snapshot; COMPLETE membership under the cutover transaction;
    // selected IDs re-read in that same transaction before pruning the shadow.
    mockKnowledgeChunk.findMany
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce([...original, ...delta])
      .mockResolvedValue([{ id: "chunkA" }, { id: "chunkB" }]);

    await store.upsert(PROJECT, [storedRow("old-live")]);
    const realEmbed = embedder.embed.bind(embedder);
    const embed = vi.spyOn(embedder, "embed").mockImplementation(async (texts) => {
      if (texts.includes("Banana")) {
        expect(inTransaction).toBe(true);
        expect(swap).not.toHaveBeenCalled();
        expect((await store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId)).toEqual([
          "old-live",
        ]);
      }
      return realEmbed(texts);
    });
    const realSwap = store.swapTable.bind(store);
    const swap = vi.spyOn(store, "swapTable").mockImplementation(async (id, shadow, guard) => {
      expect(inTransaction).toBe(true);
      expect(mockTransactionClient.knowledgeChunk.findMany).toHaveBeenCalledTimes(2);
      // File-store intent must already be durable BEFORE destructive cutover.
      const generation: unknown = JSON.parse(
        await fs.readFile(path.join(root, ".generations", `${PROJECT}.json`), "utf8"),
      );
      expect(generation).toEqual({ model: "fake-model-v2", dimension: 4, pending: true });
      expect((await store.listChunkRefs(shadow)).map((ref) => ref.chunkId).sort()).toEqual([
        "chunkA",
        "chunkB",
      ]);
      await realSwap(id, shadow, guard);
    });

    const result = await svc.reindexProject(PROJECT);
    expect(result.totalChunks).toBe(1);
    expect(result.embeddedChunks).toBe(2);
    expect(result.reindexedChunks).toBe(2);
    expect(embed.mock.calls.map(([texts]) => texts)).toEqual([["Apple"], ["Banana"]]);
    expect(swap).toHaveBeenCalledOnce();

    // The new live table must contain BOTH the snapshot chunk and the delta.
    const count = await store.count(PROJECT);
    expect(count).toBe(2);

    // Catch-up reads ALL membership through the transaction client, without a
    // watermark. The third read selects IDs only, still before the swap.
    expect(mockKnowledgeChunk.findMany).toHaveBeenCalledTimes(4);
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockTransactionClient.knowledgeChunk.findMany).toHaveBeenNthCalledWith(1, {
      where: { projectId: PROJECT },
      select: {
        id: true,
        documentId: true,
        position: true,
        text: true,
        document: { select: { filename: true } },
      },
      orderBy: [{ documentId: "asc" }, { position: "asc" }],
    });
    expect(mockTransactionClient.knowledgeChunk.findMany).toHaveBeenNthCalledWith(2, {
      where: { projectId: PROJECT },
      select: { id: true },
    });
    expect(mockTransactionClient.knowledgeChunk.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { projectId: PROJECT, id: { in: ["chunkA", "chunkB"] } },
      data: { embeddingModel: "fake-model-v2" },
    });
    expect(inTransaction).toBe(false);
    const generation: unknown = JSON.parse(
      await fs.readFile(path.join(root, ".generations", `${PROJECT}.json`), "utf8"),
    );
    expect(generation).toEqual({ model: "fake-model-v2", dimension: 4, pending: false });

    await fs.rm(root, { recursive: true, force: true });
  });

  it("reconciles a chunk deleted from the DB mid-reindex so it does not survive the swap", async () => {
    const { store, root } = makeStore();
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });

    // Snapshot at reindex start has two chunks: A and B (both embedded into shadow).
    const original = [
      {
        id: "chunkA",
        documentId: "doc1",
        position: 0,
        text: "Apple",
        embeddingModel: "old-model",
        document: { filename: "a.md" },
      },
      {
        id: "chunkB",
        documentId: "doc2",
        position: 0,
        text: "Banana",
        embeddingModel: "old-model",
        document: { filename: "b.md" },
      },
    ];

    // Snapshot and complete membership contain A,B; B is deleted before the
    // selected-ID re-read. It must be pruned from the SHADOW before cutover.
    mockKnowledgeChunk.findMany
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValue([{ id: "chunkA" }]);

    const prune = vi.spyOn(store, "deleteByChunkIds");
    const realSwap = store.swapTable.bind(store);
    const swap = vi.spyOn(store, "swapTable").mockImplementation(async (id, shadow, guard) => {
      expect(inTransaction).toBe(true);
      expect(prune).toHaveBeenCalledExactlyOnceWith(reindexShadowId(PROJECT), ["chunkB"]);
      expect((await store.listChunkRefs(shadow)).map((ref) => ref.chunkId)).toEqual(["chunkA"]);
      await realSwap(id, shadow, guard);
    });
    await svc.reindexProject(PROJECT);
    expect(swap).toHaveBeenCalledOnce();
    expect(mockTransactionClient.knowledgeChunk.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { projectId: PROJECT, id: { in: ["chunkA"] } },
      data: { embeddingModel: "fake-model-v2" },
    });

    // Only chunkA should remain live; chunkB (deleted mid-reindex) is gone.
    const count = await store.count(PROJECT);
    expect(count).toBe(1);

    // The prune pass must have re-read selected IDs through the transaction.
    expect(mockKnowledgeChunk.findMany).toHaveBeenCalledTimes(4);
    const reconcileCall = mockTransactionClient.knowledgeChunk.findMany.mock.calls[1][0] as {
      where: { projectId: string };
      select: { id: boolean };
    };
    expect(reconcileCall.where.projectId).toBe(PROJECT);
    expect(reconcileCall.select.id).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("reconciles a re-ingested document (old ids deleted, new ids kept) with no orphans", async () => {
    const { store, root } = makeStore();
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });

    // Snapshot has the OLD chunk for doc1.
    const original = [
      {
        id: "chunkOld",
        documentId: "doc1",
        position: 0,
        text: "Apple",
        embeddingModel: "old-model",
        document: { filename: "a.md" },
      },
    ];
    // doc1 was re-ingested mid-reindex: complete current SQL membership contains
    // only the NEW chunk, regardless of when it was originally created.
    const delta = [
      {
        id: "chunkNew",
        documentId: "doc1",
        position: 0,
        text: "Cherry",
        embeddingModel: "old-model",
        document: { filename: "a.md" },
      },
    ];
    mockKnowledgeChunk.findMany
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(delta)
      .mockResolvedValue([{ id: "chunkNew" }]);

    await svc.reindexProject(PROJECT);

    // Only the NEW chunk is live; the old id was reconciled away.
    const count = await store.count(PROJECT);
    expect(count).toBe(1);
    expect((await store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId)).toEqual(["chunkNew"]);
    expect(mockTransactionClient.knowledgeChunk.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { projectId: PROJECT, id: { in: ["chunkNew"] } },
      data: { embeddingModel: "fake-model-v2" },
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not re-apply chunks that were already part of the reindex snapshot", async () => {
    const { store, root } = makeStore();
    const embedder = makeEmbedder();
    const embed = vi.spyOn(embedder, "embed");
    const svc = new KnowledgeService({ embedder, vectorStore: store });
    const original = [
      {
        id: "chunkA",
        documentId: "doc1",
        position: 0,
        text: "Apple",
        embeddingModel: "old-model",
        document: { filename: "a.md" },
      },
    ];
    // Complete membership includes the snapshot chunk; shadow coverage means
    // catch-up must not embed it again. The third read supplies selected IDs.
    mockKnowledgeChunk.findMany
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValue([{ id: "chunkA" }]);

    await svc.reindexProject(PROJECT);
    const count = await store.count(PROJECT);
    expect(count).toBe(1);
    expect(embed).toHaveBeenCalledExactlyOnceWith(["Apple"]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    { name: "identity", model: "foreign-model", vectors: [[1, 2, 3, 4]] },
    { name: "dimension", model: "fake-model-v2", vectors: [[1, 2, 3]] },
    { name: "vector count", model: "fake-model-v2", vectors: [] },
    { name: "non-finite vector", model: "fake-model-v2", vectors: [[1, 2, 3, Number.NaN]] },
  ])(
    "refuses a catch-up $name mismatch BEFORE upsert or swap and retains a resumable shadow",
    async ({ model, vectors }) => {
      const { store, root } = makeStore();
      const backend = new MemoryReindexLeaseBackend();
      await store.upsert(PROJECT, [storedRow("old-live")]);
      const embedder = makeEmbedder();
      const embed = vi.spyOn(embedder, "embed");
      embed
        .mockImplementationOnce(makeEmbedder().embed)
        .mockResolvedValueOnce({ model, vectors, dimension: 4 });
      const upsert = vi.spyOn(store, "upsert");
      const swap = vi.spyOn(store, "swapTable");
      mockKnowledgeChunk.findMany
        .mockResolvedValueOnce([chunkRow(1)])
        .mockResolvedValueOnce([chunkRow(1), chunkRow(2)]);
      const svc = new KnowledgeService({
        embedder,
        vectorStore: store,
        reindexLeaseBackend: backend,
      });

      await expect(svc.reindexProject(PROJECT)).rejects.toThrow(
        "Reindex catch-up embedding identity/dimension changed",
      );
      expect(embed).toHaveBeenCalledTimes(2);
      expect(mockTransactionClient.knowledgeChunk.findMany).toHaveBeenCalledOnce();
      expect(upsert).toHaveBeenCalledOnce(); // Only the valid snapshot batch landed.
      expect(upsert.mock.calls[0][0]).toBe(reindexShadowId(PROJECT));
      expect(swap).not.toHaveBeenCalled();
      expect(mockKnowledgeChunk.updateMany).not.toHaveBeenCalled();
      expect((await store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId)).toEqual(["old-live"]);
      expect(
        (await store.listChunkRefs(reindexShadowId(PROJECT))).map((ref) => ref.chunkId),
      ).toEqual(["c1"]);
      expect(await backend.read(reindexLockName(PROJECT))).toBeNull();

      // Retry resumes the valid snapshot; only the missing member is re-embedded.
      embed.mockClear();
      mockKnowledgeChunk.findMany.mockResolvedValue([chunkRow(1), chunkRow(2)]);
      const retried = await svc.reindexProject(PROJECT);
      expect(retried).toMatchObject({ resumedChunks: 1, embeddedChunks: 1, reindexedChunks: 2 });
      expect(embed).toHaveBeenCalledExactlyOnceWith(["text 2"]);
      expect((await store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId).sort()).toEqual([
        "c1",
        "c2",
      ]);
      await fs.rm(root, { recursive: true, force: true });
    },
  );

  it("refuses a selected ID missing from the shadow instead of swapping an incomplete index", async () => {
    const { store, root } = makeStore();
    await store.upsert(PROJECT, [storedRow("old-live")]);
    const swap = vi.spyOn(store, "swapTable");
    mockKnowledgeChunk.findMany
      .mockResolvedValueOnce([chunkRow(1)])
      .mockResolvedValueOnce([chunkRow(1)])
      .mockResolvedValueOnce([{ id: "c1" }, { id: "uncoordinated-addition" }]);
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });

    await expect(svc.reindexProject(PROJECT)).rejects.toThrow(
      "Reindex SQL membership changed outside project coordination; retry",
    );
    expect(mockTransactionClient.knowledgeChunk.findMany).toHaveBeenCalledTimes(2);
    expect(swap).not.toHaveBeenCalled();
    expect(mockKnowledgeChunk.updateMany).not.toHaveBeenCalled();
    expect((await store.listChunkRefs(PROJECT)).map((ref) => ref.chunkId)).toEqual(["old-live"]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("cuts over an empty project and persists its generation without embedding", async () => {
    const { store, root } = makeStore();
    const embedder = makeEmbedder();
    const embed = vi.spyOn(embedder, "embed");
    const swap = vi.spyOn(store, "swapTable");
    const svc = new KnowledgeService({ embedder, vectorStore: store });
    mockKnowledgeChunk.findMany.mockResolvedValue([]);
    const result = await svc.reindexProject(PROJECT);
    expect(result.totalChunks).toBe(0);
    expect(result.reindexedChunks).toBe(0);
    expect(result.embeddedChunks).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect(mockKnowledgeChunk.findMany).toHaveBeenCalledTimes(3);
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockTransactionClient.knowledgeChunk.findMany).toHaveBeenCalledTimes(2);
    expect(mockKnowledgeChunk.updateMany).not.toHaveBeenCalled();
    expect(swap).toHaveBeenCalledExactlyOnceWith(
      PROJECT,
      reindexShadowId(PROJECT),
      expect.anything(),
    );
    // A new store instance reads the durable descriptor, not cached vector rows.
    const reopened = new LocalVectorStore({ root });
    const generation = await reopened.withProjectWrite(PROJECT, (write) => write.readGeneration());
    expect(generation).toEqual({ model: "fake-model-v2", dimension: 4, pending: false });
    const stale = storedRow("approval");
    stale.metadata.embeddingModel = "old-model";
    expect(() => assertApprovalGeneration(generation, [stale])).toThrow(/generation is stale/);
    expect(() => assertApprovalGeneration(generation, [storedRow("approval")])).not.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});

/**
 * Issue #798 — the reindex LEASE (replacing #100's session advisory lock).
 *
 * The lock it replaces was taken with `pg_try_advisory_lock` on one pooled connection
 * and released with `pg_advisory_unlock` on whatever connection Prisma's pool happened
 * to hand the release statement. When those differed the unlock returned `false` — a
 * value the code discarded — and the lock stayed held until the pod restarted, wedging
 * every later reindex of that project. `tests/reindex-lease-postgres.integration.test.ts`
 * reproduces that against a real Postgres (8 of 8 locks leaked).
 *
 * These suites model MULTIPLE PODS the way the leader-election tests do: separate
 * `KnowledgeService` instances (separate in-process `reindexing` Sets, exactly as two
 * pods have) sharing ONE {@link MemoryReindexLeaseBackend} (= one database).
 */
describe("reindexProject — #798 reindex lease", () => {
  beforeEach(() => {
    __resetReindexLeaseBackend();
    mockKnowledgeChunk.findMany.mockReset();
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
    mockKnowledgeChunk.updateMany.mockResolvedValue({ count: 0 });
  });

  it("rejects a concurrent in-process reindex with ReindexConflictError (fast path)", async () => {
    const { store, root } = makeStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      model: "fake-model-v2",
      dimension: 4,
      embed: async (texts: string[]) => {
        await gate;
        return { vectors: texts.map(() => [1, 2, 3, 4]), model: "fake-model-v2", dimension: 4 };
      },
    } as unknown as Embedder;
    const svc = new KnowledgeService({ embedder: slow, vectorStore: store });

    mockKnowledgeChunk.findMany.mockResolvedValue([chunkRow(1)]);

    const first = svc.reindexProject(PROJECT);
    await expect(svc.reindexProject(PROJECT)).rejects.toBeInstanceOf(ReindexConflictError);
    release();
    await first;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("takes the lease and RELEASES it — nothing is left held after the run", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    mockKnowledgeChunk.findMany.mockResolvedValue([]);

    await svc.reindexProject(PROJECT);

    // THE #798 ASSERTION. Pre-fix this was `pg_advisory_unlock` on a pooled connection
    // that may never have held the lock; the release silently no-opped and the project
    // stayed wedged. A lease release is an ordinary DELETE — pool-agnostic.
    expect(await backend.read(reindexLockName(PROJECT))).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("throws ReindexConflictError when ANOTHER POD holds a live lease", async () => {
    const backend = new MemoryReindexLeaseBackend();
    await backend.acquire(reindexLockName(PROJECT), "pod-a:run-1", Date.now(), 60_000);

    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    mockKnowledgeChunk.findMany.mockResolvedValue([]);

    const err = await svc.reindexProject(PROJECT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReindexConflictError);
    // The 409 now names the holder — an operator can tell WHICH pod to look at.
    expect((err as ReindexConflictError).holder).toBe("pod-a:run-1");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("STEALS an expired lease — a SIGKILLed run does not wedge the next attempt (AC 1)", async () => {
    const backend = new MemoryReindexLeaseBackend();
    // A holder that died mid-run: it never released, and it stopped renewing, so its
    // lease has lapsed. THIS is the state that used to require a pod restart.
    await backend.acquire(reindexLockName(PROJECT), "pod-dead:run-0", Date.now() - 300_000, 1);

    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    mockKnowledgeChunk.findMany.mockResolvedValue([chunkRow(1)]);

    const result = await svc.reindexProject(PROJECT);

    expect(result.reindexedChunks).toBe(1);
    expect(await backend.read(reindexLockName(PROJECT))).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("releases the lease when the reindex throws mid-loop", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const throwing = {
      model: "fake-model-v2",
      dimension: 4,
      embed: async () => {
        throw new Error("embedder boom");
      },
    } as unknown as Embedder;
    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: throwing,
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    mockKnowledgeChunk.findMany.mockResolvedValue([chunkRow(1)]);

    await expect(svc.reindexProject(PROJECT)).rejects.toThrow("embedder boom");
    expect(await backend.read(reindexLockName(PROJECT))).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("re-proves the lease ONCE PER BATCH, before each upsert", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const renew = vi.spyOn(backend, "renew");
    const assertHeld = vi.spyOn(backend, "assertHeld");
    const { store, root } = makeStore();
    const upsert = vi.spyOn(store, "upsert");
    const swap = vi.spyOn(store, "swapTable");
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    mockKnowledgeChunk.findMany.mockResolvedValue([1, 2, 3, 4].map(chunkRow));

    await svc.reindexProject(PROJECT, { batchSize: 2 });

    // Batch renewals and cutover assertHeld fences are separate: no post-swap
    // replay writes to live remain. Local swap checks again inside its mutex.
    expect(renew).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i += 1) {
      expect(renew.mock.invocationCallOrder[i]).toBeLessThan(upsert.mock.invocationCallOrder[i]);
      expect(upsert.mock.calls[i][0]).toBe(reindexShadowId(PROJECT));
    }
    expect(assertHeld).toHaveBeenCalledTimes(3);
    expect(assertHeld.mock.invocationCallOrder[0]).toBeLessThan(
      mockTransaction.mock.invocationCallOrder[0],
    );
    expect(assertHeld.mock.invocationCallOrder[1]).toBeLessThan(
      mockTransactionClient.knowledgeChunk.findMany.mock.invocationCallOrder[0],
    );
    expect(assertHeld.mock.invocationCallOrder[2]).toBeGreaterThan(
      swap.mock.invocationCallOrder[0],
    );
    expect(assertHeld.mock.invocationCallOrder[2]).toBeLessThan(
      mockTransactionClient.knowledgeChunk.updateMany.mock.invocationCallOrder[0],
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses no raw lease SQL on sqlite, but still transacts cutover membership", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { store, root } = makeStore();
    // No injected backend: the env resolver must pick the NO-OP one.
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });
    mockKnowledgeChunk.findMany.mockResolvedValue([]);

    await svc.reindexProject(PROJECT);

    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockTransactionClient.knowledgeChunk.findMany).toHaveBeenCalledTimes(2);
    const state = await svc.reindexShadowState(PROJECT);
    expect(state.lease).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});

/**
 * Issue #798 — FENCING: #787's no-partial-cutover guarantee under a TTL lease.
 *
 * This is the suite a reviewer should read first. A naive lease would REINTRODUCE the
 * data-loss path #787 closed, because a TTL can lapse under a run that is merely slow:
 *
 *   pod B is mid-reindex → B stalls (GC pause / partition) → B's lease expires →
 *   pod A's discard legitimately takes the free lease and drops the shadow →
 *   B wakes up, its next upsert RECREATES the shadow → B swaps a PARTIAL shadow into
 *   the live name and reports success.
 *
 * The fencing token (`holder` = `<podId>:<runId>`) closes it: every mutating step
 * re-proves ownership AT the instant it mutates, so a fenced B aborts BEFORE the upsert
 * and BEFORE the swap. Both gates are asserted here.
 */
describe("reindex fencing — #787's guarantee survives the lease (#798)", () => {
  beforeEach(() => {
    __resetReindexLeaseBackend();
    mockKnowledgeChunk.findMany.mockReset();
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
    mockKnowledgeChunk.updateMany.mockResolvedValue({ count: 0 });
  });

  /** An embedder that PARKS after `parkAfter` chunks, so a race can be staged mid-run. */
  function parkingEmbedder(parkAfter: number): {
    embedder: Embedder;
    parked: Promise<void>;
    resume: () => void;
  } {
    let onParked!: () => void;
    const parked = new Promise<void>((r) => (onParked = r));
    let resume!: () => void;
    const gate = new Promise<void>((r) => (resume = r));
    let done = 0;
    const embedder = {
      model: "fake-model-v2",
      dimension: 4,
      embed: async (texts: string[]) => {
        if (done === parkAfter) {
          onParked();
          await gate;
        }
        done += texts.length;
        return {
          vectors: texts.map((t) => {
            const code = t.charCodeAt(t.length - 1) || 1;
            return [code, code % 7, code % 5, 1];
          }),
          model: "fake-model-v2",
          dimension: 4,
        };
      },
    } as unknown as Embedder;
    return { embedder, parked, resume };
  }

  it("a FENCED run aborts BEFORE the upsert — it cannot resurrect the shadow a discard dropped", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    mockKnowledgeChunk.findMany.mockResolvedValue([1, 2, 3, 4].map(chunkRow));

    const { embedder, parked, resume } = parkingEmbedder(2);
    const replicaB = new KnowledgeService({
      embedder,
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    const replicaA = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });

    const reindexing = replicaB.reindexProject(PROJECT, { batchSize: 2 });
    await parked;
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(2);

    // B STALLS long enough for its lease to lapse (the 90s-partition case). A's discard
    // is now entirely legitimate: as far as the cluster can tell, B is dead.
    backend.expire(reindexLockName(PROJECT));
    await replicaA.discardReindexShadow(PROJECT);
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(0);

    // B wakes up. Pre-fencing this is where the damage happened: B's next upsert
    // recreated the shadow with ONLY the remaining 2 chunks, and swapTable cut that
    // partial index over the live name.
    const upsertSpy = vi.spyOn(store, "upsert");
    const swapSpy = vi.spyOn(store, "swapTable");
    resume();

    await expect(reindexing).rejects.toBeInstanceOf(ReindexFencedError);
    // THE ASSERTIONS THAT MATTER: B never wrote again, and never swapped.
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(swapSpy).not.toHaveBeenCalled();
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(0);
    expect(await store.listChunkRefs(PROJECT)).toHaveLength(0);

    upsertSpy.mockRestore();
    swapSpy.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("a run fenced AFTER its last batch is refused AT THE SWAP — the live index is untouched", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    mockKnowledgeChunk.findMany.mockResolvedValue([chunkRow(1), chunkRow(2)]);

    // Seed a LIVE index, so a bad swap would be observable as data LOSS.
    await store.upsert(PROJECT, [
      {
        id: "live-1",
        vector: [9, 9, 9, 9],
        metadata: {
          chunkId: "live-1",
          documentId: "d1",
          filename: "f.md",
          position: 0,
          text: "the live index",
          embeddingModel: "old-model",
        },
      },
    ]);

    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });

    // The steal lands in the WINDOW the per-batch fence cannot see: after the final
    // upsert, before the swap. Only the pre-swap fence can catch this one.
    const realUpsert = store.upsert.bind(store);
    vi.spyOn(store, "upsert").mockImplementation(async (id, rows) => {
      await realUpsert(id, rows);
      await backend.acquire(reindexLockName(PROJECT), "pod-a:steal", Date.now(), 60_000, {
        force: true,
      });
    });
    const swapSpy = vi.spyOn(store, "swapTable");

    await expect(svc.reindexProject(PROJECT)).rejects.toBeInstanceOf(ReindexFencedError);

    // The swap was never even attempted, and the live index still serves its old rows.
    expect(swapSpy).not.toHaveBeenCalled();
    const live = await store.listChunkRefs(PROJECT);
    expect(live.map((r) => r.chunkId)).toEqual(["live-1"]);

    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("dropProject (project ARCHIVE) FORCE-takes the lease and fences a running reindex", async () => {
    // Adjacent finding (i) from #798: `dropProject()` is the one discard path #787's
    // lock never covered. Archive on replica A while replica B reindexes, and B's swap
    // rebuilds a live index for a project that has just been archived.
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    mockKnowledgeChunk.findMany.mockResolvedValue([1, 2, 3, 4].map(chunkRow));

    const { embedder, parked, resume } = parkingEmbedder(2);
    const replicaB = new KnowledgeService({
      embedder,
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    const replicaA = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });

    const reindexing = replicaB.reindexProject(PROJECT, { batchSize: 2 });
    await parked;

    // The archive must NOT be refusable — an operator cannot be told "you may not
    // archive this project, a reindex is running". So it force-takes the lease, which
    // is also what makes it SAFE: B is fenced by the very act of taking it.
    await replicaA.dropProject(PROJECT);

    resume();
    await expect(reindexing).rejects.toBeInstanceOf(ReindexFencedError);

    // Nothing was rebuilt under the archived project — neither live nor shadow.
    expect(await store.listChunkRefs(PROJECT)).toHaveLength(0);
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(0);
    // And the archive released what it took.
    expect(await backend.read(reindexLockName(PROJECT))).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * PR #805 review (finding 3b) — the archive must be fail-SAFE, and `force: true` only
   * makes the lease unable to REFUSE us. It does not make it unable to FAIL on us.
   *
   * Wrapping `dropProject` in the lease put `acquire()` (and its lazy
   * `CREATE UNLOGGED TABLE`) in front of the drop, so ANY lease-backend error — Postgres
   * unreachable, a DDL failure, permissions — would have propagated and failed the
   * archive hook, for a reason with nothing to do with a reindex. That is precisely the
   * "no lever to pull" state the force-take exists to avoid: fail-CLOSED, by omission.
   */
  it("archives ANYWAY when the lease backend is DOWN — fail-safe, not fail-closed", async () => {
    const { store, root } = makeStore();
    const brokenBackend = new MemoryReindexLeaseBackend();
    const dbDown = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    vi.spyOn(brokenBackend, "acquire").mockRejectedValue(dbDown);

    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: brokenBackend,
    });

    // Vectors exist for the project being archived (live AND a retained shadow).
    await store.upsert(PROJECT, [storedRow("live-1")]);
    await store.upsert(reindexShadowId(PROJECT), [storedRow("shadow-1")]);

    // The archive completes. Unfenced (the degraded trade the docblock argues for
    // explicitly) — but it completes, which an archive must.
    await expect(svc.dropProject(PROJECT)).resolves.toBeUndefined();

    expect(await store.listChunkRefs(PROJECT)).toHaveLength(0);
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("still SURFACES a failure of the DROP itself — fail-safe on the lease, not on the work", async () => {
    // The other half of the same trade: swallowing lease errors must not turn into
    // swallowing the archive's actual failure. If the vectors could not be dropped, the
    // archive hook has to hear about it.
    const { store, root } = makeStore();
    const backend = new MemoryReindexLeaseBackend();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    vi.spyOn(store, "dropTable").mockRejectedValue(new Error("disk is on fire"));

    await expect(svc.dropProject(PROJECT)).rejects.toThrow(/disk is on fire/);
    // The lease was taken and released cleanly — the drop is what failed.
    expect(await backend.read(reindexLockName(PROJECT))).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});

/**
 * PR #796 review (B3), re-proved on the lease (#798) — `discard` must not be able to
 * truncate the LIVE index. Two `KnowledgeService` instances (two pods, two separate
 * in-process Sets) over ONE store, with ONE lease backend (the database) as the only
 * thing that knows about both.
 */
describe("discardReindexShadow — the cross-replica race, on the lease", () => {
  beforeEach(() => {
    __resetReindexLeaseBackend();
    mockKnowledgeChunk.findMany.mockReset();
    mockQueryRaw.mockReset();
    mockExecuteRaw.mockReset();
    mockKnowledgeChunk.updateMany.mockResolvedValue({ count: 0 });
  });

  it("REFUSES a discard while another REPLICA holds the lease — and the live index keeps every chunk", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    const chunks = [1, 2, 3, 4].map(chunkRow);
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    let parked!: () => void;
    const isParked = new Promise<void>((r) => (parked = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let embeddedSoFar = 0;
    const slow = {
      model: "fake-model-v2",
      dimension: 4,
      embed: async (texts: string[]) => {
        if (embeddedSoFar === 2) {
          parked();
          await gate;
        }
        embeddedSoFar += texts.length;
        return {
          vectors: texts.map((t) => {
            const code = t.charCodeAt(t.length - 1) || 1;
            return [code, code % 7, code % 5, 1];
          }),
          model: "fake-model-v2",
          dimension: 4,
        };
      },
    } as unknown as Embedder;

    const replicaB = new KnowledgeService({
      embedder: slow,
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    const reindexing = replicaB.reindexProject(PROJECT, { batchSize: 2 });
    await isParked;
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(2);

    // Replica A: a DIFFERENT process, empty Set — the lease is the only thing standing
    // between this call and the shadow B is still writing into.
    const replicaA = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    const dropSpy = vi.spyOn(store, "dropTable");
    const outcome = await replicaA.discardReindexShadow(PROJECT).then(
      () => "discarded" as const,
      (err: unknown) => err,
    );

    release();
    const result = await reindexing;

    expect(outcome).toBeInstanceOf(ReindexConflictError);
    expect(dropSpy).not.toHaveBeenCalled();
    dropSpy.mockRestore();
    // B's LIVE reindex completed with every chunk — no partial cut-over.
    expect(result.totalChunks).toBe(4);
    expect(await store.listChunkRefs(PROJECT)).toHaveLength(4);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("takes AND releases the lease when no reindex is running (the CLI's happy path)", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    await seedShadow(store);

    await svc.discardReindexShadow(PROJECT);

    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(0);
    expect(await backend.read(reindexLockName(PROJECT))).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("releases the lease even when the drop itself fails", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    vi.spyOn(store, "dropTable").mockRejectedValueOnce(new Error("disk gone"));

    await expect(svc.discardReindexShadow(PROJECT)).rejects.toThrow("disk gone");
    expect(await backend.read(reindexLockName(PROJECT))).toBeNull();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("still works on a non-postgres runtime, where the in-process Set is the only guard", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    const { store, root } = makeStore();
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });

    await expect(svc.discardReindexShadow(PROJECT)).resolves.toBeUndefined();
    expect(mockQueryRaw).not.toHaveBeenCalled();
    expect(mockExecuteRaw).not.toHaveBeenCalled();
    await fs.rm(root, { recursive: true, force: true });
  });
});

/** Issue #798 (AC 3) — observability + the operator escape hatch. */
describe("reindex lease — operator visibility and unlock", () => {
  beforeEach(() => {
    __resetReindexLeaseBackend();
    mockKnowledgeChunk.findMany.mockReset();
    mockKnowledgeChunk.updateMany.mockResolvedValue({ count: 0 });
  });

  it("reindexShadowState reports another replica's live lease — holder, age, inProgress", async () => {
    const backend = new MemoryReindexLeaseBackend();
    await backend.acquire(reindexLockName(PROJECT), "pod-b:run-9", Date.now() - 5_000, 60_000);
    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    await seedShadow(store);

    const state = await svc.reindexShadowState(PROJECT);

    // The old answer — read off THIS replica's empty Set — was `resumable: true`, which
    // is how an operator ended up reaching for `discard` on a live reindex.
    expect(state.inProgress).toBe(true);
    expect(state.resumable).toBe(false);
    expect(state.shadowChunks).toBe(1);
    expect(state.lease?.holder).toBe("pod-b:run-9");
    expect(state.lease?.expired).toBe(false);
    expect(state.lease?.ageMs).toBeGreaterThanOrEqual(5_000);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("an EXPIRED lease is NOT 'in progress' — the shadow is resumable, not wedged", async () => {
    const backend = new MemoryReindexLeaseBackend();
    await backend.acquire(reindexLockName(PROJECT), "pod-dead:run-0", Date.now() - 300_000, 1);
    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    await seedShadow(store);

    const state = await svc.reindexShadowState(PROJECT);

    expect(state.inProgress).toBe(false);
    expect(state.resumable).toBe(true);
    expect(state.lease?.expired).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("forceReleaseReindexLock clears a wedged lease and FENCES its holder (no pod restart)", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    const name = reindexLockName(PROJECT);
    await backend.acquire(name, "pod-wedged:run-1", Date.now(), 600_000);

    expect((await svc.reindexLockStatus(PROJECT))?.holder).toBe("pod-wedged:run-1");

    const cleared = await svc.forceReleaseReindexLock(PROJECT);

    expect(cleared?.holder).toBe("pod-wedged:run-1");
    expect(await svc.reindexLockStatus(PROJECT)).toBeNull();
    // The cleared holder is fenced: its token no longer renews, so if it is somehow
    // still alive it aborts at its next batch instead of swapping.
    expect(await backend.renew(name, "pod-wedged:run-1", Date.now(), 60_000)).toBe(false);
    // And the next reindex simply proceeds.
    mockKnowledgeChunk.findMany.mockResolvedValue([]);
    await expect(svc.reindexProject(PROJECT)).resolves.toMatchObject({ projectId: PROJECT });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("unlocking a project nobody holds is a no-op, not an error", async () => {
    const backend = new MemoryReindexLeaseBackend();
    const { store, root } = makeStore();
    const svc = new KnowledgeService({
      embedder: makeEmbedder(),
      vectorStore: store,
      reindexLeaseBackend: backend,
    });
    expect(await svc.forceReleaseReindexLock(PROJECT)).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });
});
