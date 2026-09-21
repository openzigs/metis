/**
 * Issue #787 — an INTERRUPTED shadow reindex must be resumable.
 *
 * A reindex of a real corpus runs for minutes to hours, and on EKS the things
 * that interrupt it (pod eviction, OOM kill, a rolling deploy) are routine. If an
 * interruption meant re-embedding from zero, a long-enough corpus would have a
 * migration that can never finish.
 *
 * The load-bearing test here is `resumes an interrupted reindex without
 * re-embedding what the shadow already holds`: it KILLS a reindex mid-run (the
 * embedder throws, exactly as an evicted pod's in-flight batch would) and then
 * restarts it, asserting that the second run embeds ONLY the remainder and that
 * the resulting live index is complete and correct.
 *
 * The other tests fence the cases where resuming would be WRONG: a shadow from a
 * different embedding model (an abandoned migration) and a shadow holding chunks
 * that have since been deleted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { LocalVectorStore, type VectorStore } from "./vector-store.js";
import { KnowledgeService, reindexShadowId } from "./knowledge-service.js";
import type { Embedder } from "./embedder.js";

// ---- Prisma mock ----------------------------------------------------------

const mockKnowledgeChunk = {
  findMany: vi.fn(),
  updateMany: vi.fn(),
  groupBy: vi.fn(),
};
// Cutover reads membership and reconciles tags through the transaction client.
const mockTransactionClient = {
  knowledgeChunk: {
    findMany: vi.fn((...args: unknown[]) => mockKnowledgeChunk.findMany(...args)),
    updateMany: vi.fn((...args: unknown[]) => mockKnowledgeChunk.updateMany(...args)),
  },
};
const mockTransaction = vi.fn(async (fn: (tx: typeof mockTransactionClient) => Promise<unknown>) =>
  fn(mockTransactionClient),
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
      groupBy: (...a: unknown[]) => mockKnowledgeChunk.groupBy(...a),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: (fn: (tx: typeof mockTransactionClient) => Promise<unknown>) =>
      mockTransaction(fn),
  },
}));

const PROJECT = "proj_resume_test";
const NEW_MODEL = "Alibaba-NLP/gte-modernbert-base";
const OLD_MODEL = "Xenova/bge-small-en-v1.5";

interface Chunk {
  id: string;
  documentId: string;
  position: number;
  text: string;
  embeddingModel: string;
  document: { filename: string };
}

function chunk(n: number, model = OLD_MODEL): Chunk {
  return {
    id: `c${n}`,
    documentId: "doc1",
    position: n,
    text: `chunk text ${n}`,
    embeddingModel: model,
    document: { filename: "doc1.md" },
  };
}

/**
 * Embedder that can be made to DIE partway through a run — the pod-eviction
 * simulator. `failAfter` counts CHUNKS embedded within this embedder's lifetime;
 * once the next batch would push past it, `embed()` throws instead of resolving,
 * which is what an in-flight batch on an evicted pod looks like to the caller.
 *
 * `embeddedTexts` records every text it was ever asked to embed, which is how the
 * resume assertion proves the second run did NOT re-embed the first run's work.
 */
function makeEmbedder(opts: { model?: string; failAfter?: number } = {}) {
  const model = opts.model ?? NEW_MODEL;
  const embeddedTexts: string[] = [];
  let count = 0;
  const embed = async (texts: string[]) => {
    if (opts.failAfter !== undefined && count + texts.length > opts.failAfter) {
      throw new Error("pod evicted mid-batch");
    }
    count += texts.length;
    embeddedTexts.push(...texts);
    return {
      vectors: texts.map((t) => {
        const code = t.charCodeAt(t.length - 1) || 1;
        return [code, code % 7, code % 5, 1];
      }),
      model,
      dimension: 4,
    };
  };
  const embedder = { model, dimension: 4, embed } as unknown as Embedder;
  return { embedder, embeddedTexts };
}

function makeStore(): { store: VectorStore; root: string } {
  const root = path.join(os.tmpdir(), `resume-${Math.random().toString(36).slice(2)}`);
  return { store: new LocalVectorStore({ root }), root };
}

/** Seed the LIVE table with the OLD generation's vectors. */
async function seedLive(store: VectorStore, chunks: Chunk[]): Promise<void> {
  await store.ensureTable(PROJECT);
  await store.upsert(
    PROJECT,
    chunks.map((c) => ({
      id: c.id,
      vector: [1, 1, 1, 1],
      metadata: {
        chunkId: c.id,
        documentId: c.documentId,
        filename: c.document.filename,
        position: c.position,
        text: c.text,
        embeddingModel: OLD_MODEL,
      },
    })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKnowledgeChunk.findMany.mockReset();
  delete process.env.DATABASE_URL;
  mockKnowledgeChunk.updateMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("reindexProject — #787 resumability", () => {
  it("resumes an interrupted reindex without re-embedding what the shadow already holds", async () => {
    const { store, root } = makeStore();
    const chunks = [1, 2, 3, 4, 5].map((n) => chunk(n));
    await seedLive(store, chunks);

    // Snapshot, transactional catch-up and selected-ID re-read see the full corpus.
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    // COVERAGE, BEFORE: 100% of the live index is the OLD generation. This is what
    // every existing deployment looks like the moment #783 lands.
    expect(await store.modelCoverage(PROJECT)).toEqual({
      totalChunks: 5,
      modelCounts: { [OLD_MODEL]: 5 },
    });

    // --- Run 1: dies after 4 of 5 chunks (batchSize 2 → batches 1 and 2 land,
    //     the third batch throws).
    const dying = makeEmbedder({ failAfter: 4 });
    const svc1 = new KnowledgeService({ embedder: dying.embedder, vectorStore: store });
    await expect(svc1.reindexProject(PROJECT, { batchSize: 2 })).rejects.toThrow(
      "pod evicted mid-batch",
    );
    expect(dying.embeddedTexts).toHaveLength(4);

    // The shadow SURVIVED the crash and holds the 4 completed chunks — this is
    // the checkpoint. Before #787 it was dropped here and the work was gone.
    const shadowId = reindexShadowId(PROJECT);
    const shadowRefs = await store.listChunkRefs(shadowId);
    expect(shadowRefs).toHaveLength(4);
    expect(shadowRefs.every((r) => r.embeddingModel === NEW_MODEL)).toBe(true);

    // COVERAGE, DURING: the LIVE table is untouched — still 100% the old generation,
    // still serving. The mixed-generation state (4 new chunks in the shadow, 5 old
    // ones live) is safe precisely because the two never share a table.
    expect(await store.modelCoverage(PROJECT)).toEqual({
      totalChunks: 5,
      modelCounts: { [OLD_MODEL]: 5 },
    });
    const liveDuring = await store.listChunkRefs(PROJECT);
    expect(liveDuring).toHaveLength(5);
    expect(liveDuring.every((r) => r.embeddingModel === OLD_MODEL)).toBe(true);

    // --- Run 2: a fresh process (new service, new embedder) picks it back up.
    const healthy = makeEmbedder();
    const svc2 = new KnowledgeService({ embedder: healthy.embedder, vectorStore: store });
    const result = await svc2.reindexProject(PROJECT, { batchSize: 2 });

    // THE assertion: only the ONE remaining chunk was embedded. A non-resumable
    // reindex would have embedded all 5 again.
    expect(healthy.embeddedTexts).toEqual(["chunk text 5"]);
    expect(result.resumedChunks).toBe(4);
    expect(result.embeddedChunks).toBe(1);
    expect(result.totalChunks).toBe(5);

    // COVERAGE, AFTER: the cut-over happened and the live index is COMPLETE and
    // entirely the new generation — a resumed reindex is not a partial one.
    expect(await store.modelCoverage(PROJECT)).toEqual({
      totalChunks: 5,
      modelCounts: { [NEW_MODEL]: 5 },
    });
    const liveAfter = await store.listChunkRefs(PROJECT);
    expect(liveAfter).toHaveLength(5);
    expect(liveAfter.every((r) => r.embeddingModel === NEW_MODEL)).toBe(true);
    expect(new Set(liveAfter.map((r) => r.chunkId))).toEqual(
      new Set(["c1", "c2", "c3", "c4", "c5"]),
    );

    // Every chunk's Prisma tag was reconciled to the new model — including the 4
    // this run never embedded.
    const tagged = mockKnowledgeChunk.updateMany.mock.calls.flatMap(
      (c) => (c[0] as { where: { id: { in: string[] } } }).where.id.in,
    );
    expect(new Set(tagged)).toEqual(new Set(["c1", "c2", "c3", "c4", "c5"]));

    // Retrieval works over the rebuilt index (the sanity check, not a quality one).
    const { vectors } = await healthy.embedder.embed(["chunk text 3"]);
    const hits = await store.search(PROJECT, vectors[0], 1, { embeddingModel: NEW_MODEL });
    expect(hits[0]?.row.metadata.chunkId).toBe("c3");

    await fs.rm(root, { recursive: true, force: true });
  });

  it("is idempotent — a completed reindex re-run embeds the corpus again but converges on the same index", async () => {
    const { store, root } = makeStore();
    const chunks = [1, 2, 3].map((n) => chunk(n));
    await seedLive(store, chunks);
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    const first = makeEmbedder();
    const svc = new KnowledgeService({ embedder: first.embedder, vectorStore: store });
    const r1 = await svc.reindexProject(PROJECT, { batchSize: 2 });
    expect(r1.resumedChunks).toBe(0);

    // A completed reindex leaves NO shadow (it was swapped into the live name), so
    // a second run starts clean rather than "resuming" a stale checkpoint.
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(0);

    const r2 = await svc.reindexProject(PROJECT, { batchSize: 2 });
    expect(r2.resumedChunks).toBe(0);
    expect(r2.embeddedChunks).toBe(3);

    const live = await store.listChunkRefs(PROJECT);
    expect(live).toHaveLength(3);
    expect(live.every((r) => r.embeddingModel === NEW_MODEL)).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("DISCARDS a shadow built by a different model instead of resuming it", async () => {
    const { store, root } = makeStore();
    const chunks = [1, 2, 3, 4].map((n) => chunk(n));
    await seedLive(store, chunks);
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    // An ABANDONED migration: a reindex to "some-other-model" died halfway.
    const abandoned = makeEmbedder({ model: "some-other-model", failAfter: 2 });
    const svc1 = new KnowledgeService({ embedder: abandoned.embedder, vectorStore: store });
    await expect(svc1.reindexProject(PROJECT, { batchSize: 2 })).rejects.toThrow();
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(2);

    // The operator then changed EMBED_MODEL and restarted. Resuming that shadow
    // would splice two vector spaces into one table — so it must be thrown away.
    const current = makeEmbedder();
    const svc2 = new KnowledgeService({ embedder: current.embedder, vectorStore: store });
    const result = await svc2.reindexProject(PROJECT, { batchSize: 2 });

    expect(result.resumedChunks).toBe(0);
    expect(result.embeddedChunks).toBe(4);
    const live = await store.listChunkRefs(PROJECT);
    expect(live.every((r) => r.embeddingModel === NEW_MODEL)).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("prunes chunks deleted since the interrupted run out of the resumed shadow", async () => {
    const { store, root } = makeStore();
    const original = [1, 2, 3, 4, 5, 6].map((n) => chunk(n));
    await seedLive(store, original);
    mockKnowledgeChunk.findMany.mockResolvedValue(original);

    const dying = makeEmbedder({ failAfter: 4 });
    const svc1 = new KnowledgeService({ embedder: dying.embedder, vectorStore: store });
    await expect(svc1.reindexProject(PROJECT, { batchSize: 2 })).rejects.toThrow();
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(4);

    // Between the crash and the resume, a document was deleted: c3..c6 are gone.
    const survivors = [chunk(1), chunk(2)];
    mockKnowledgeChunk.findMany.mockResolvedValue(survivors);

    const healthy = makeEmbedder();
    const svc2 = new KnowledgeService({ embedder: healthy.embedder, vectorStore: store });
    const result = await svc2.reindexProject(PROJECT, { batchSize: 2 });

    // Nothing was re-embedded (c1/c2 were already in the shadow) and the deleted
    // chunks did NOT survive the swap as live orphans.
    expect(healthy.embeddedTexts).toEqual([]);
    expect(result.resumedChunks).toBe(2);
    const live = await store.listChunkRefs(PROJECT);
    expect(new Set(live.map((r) => r.chunkId))).toEqual(new Set(["c1", "c2"]));

    await fs.rm(root, { recursive: true, force: true });
  });

  it("fresh:true forces a full rebuild, ignoring a resumable shadow", async () => {
    const { store, root } = makeStore();
    const chunks = [1, 2, 3, 4].map((n) => chunk(n));
    await seedLive(store, chunks);
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    const dying = makeEmbedder({ failAfter: 2 });
    const svc1 = new KnowledgeService({ embedder: dying.embedder, vectorStore: store });
    await expect(svc1.reindexProject(PROJECT, { batchSize: 2 })).rejects.toThrow();

    const healthy = makeEmbedder();
    const svc2 = new KnowledgeService({ embedder: healthy.embedder, vectorStore: store });
    const result = await svc2.reindexProject(PROJECT, { batchSize: 2, fresh: true });

    expect(result.resumedChunks).toBe(0);
    expect(healthy.embeddedTexts).toHaveLength(4);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports resumable shadow state, and discardReindexShadow clears it", async () => {
    const { store, root } = makeStore();
    const chunks = [1, 2, 3, 4].map((n) => chunk(n));
    await seedLive(store, chunks);
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    const { embedder } = makeEmbedder();
    const svc = new KnowledgeService({ embedder, vectorStore: store });

    // No reindex has run: nothing to resume.
    expect(await svc.reindexShadowState(PROJECT)).toMatchObject({
      inProgress: false,
      shadowChunks: 0,
      resumable: false,
    });

    const dying = makeEmbedder({ failAfter: 2 });
    const svcDying = new KnowledgeService({ embedder: dying.embedder, vectorStore: store });
    await expect(svcDying.reindexProject(PROJECT, { batchSize: 2 })).rejects.toThrow();

    const state = await svc.reindexShadowState(PROJECT);
    expect(state).toMatchObject({
      inProgress: false,
      shadowChunks: 2,
      shadowModels: [NEW_MODEL],
      resumable: true,
    });

    await svc.discardReindexShadow(PROJECT);
    expect((await svc.reindexShadowState(PROJECT)).shadowChunks).toBe(0);
    // Discarding the checkpoint never touches the live index.
    expect(await store.listChunkRefs(PROJECT)).toHaveLength(4);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("rebuilds from scratch when the shadow cannot be READ", async () => {
    const { store, root } = makeStore();
    const chunks = [1, 2].map((n) => chunk(n));
    await seedLive(store, chunks);
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    // A corrupt / unreadable shadow table. We cannot know which of its rows are
    // trustworthy, so the only safe answer is to throw it away and re-embed —
    // never to resume a checkpoint we could not verify.
    const listRefs = vi
      .spyOn(store, "listChunkRefs")
      .mockRejectedValueOnce(new Error("corrupt table"));

    const { embedder, embeddedTexts } = makeEmbedder();
    const svc = new KnowledgeService({ embedder, vectorStore: store });
    const result = await svc.reindexProject(PROJECT, { batchSize: 2 });

    expect(result.resumedChunks).toBe(0);
    expect(embeddedTexts).toHaveLength(2);
    listRefs.mockRestore();
    expect(await store.listChunkRefs(PROJECT)).toHaveLength(2);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("clears a project's checkpoint when the project itself is dropped", async () => {
    const { store, root } = makeStore();
    const chunks = [1, 2, 3, 4].map((n) => chunk(n));
    await seedLive(store, chunks);
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    const dying = makeEmbedder({ failAfter: 2 });
    const svc = new KnowledgeService({ embedder: dying.embedder, vectorStore: store });
    await expect(svc.reindexProject(PROJECT, { batchSize: 2 })).rejects.toThrow();
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(2);

    // Archiving a project must not leave its retained checkpoint behind as orphan
    // vectors — the shadow is a checkpoint OF the project, not a separate corpus.
    await svc.dropProject(PROJECT);
    expect(await store.listChunkRefs(reindexShadowId(PROJECT))).toHaveLength(0);
    expect(await store.listChunkRefs(PROJECT)).toHaveLength(0);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps a COMPLETE shadow when the swap itself fails, so the retry costs no embed calls", async () => {
    const { store, root } = makeStore();
    const chunks = [1, 2].map((n) => chunk(n));
    await seedLive(store, chunks);
    mockKnowledgeChunk.findMany.mockResolvedValue(chunks);

    const swapFails = vi
      .spyOn(store, "swapTable")
      .mockRejectedValueOnce(new Error("disk full during swap"));

    const first = makeEmbedder();
    const svc = new KnowledgeService({ embedder: first.embedder, vectorStore: store });
    await expect(svc.reindexProject(PROJECT, { batchSize: 2 })).rejects.toThrow(
      "disk full during swap",
    );
    expect(first.embeddedTexts).toHaveLength(2);
    swapFails.mockRestore();

    // The retry finds a COMPLETE shadow: zero embed calls, straight to the swap.
    const second = makeEmbedder();
    const svc2 = new KnowledgeService({ embedder: second.embedder, vectorStore: store });
    const result = await svc2.reindexProject(PROJECT, { batchSize: 2 });
    expect(second.embeddedTexts).toEqual([]);
    expect(result.resumedChunks).toBe(2);
    expect(await store.listChunkRefs(PROJECT)).toHaveLength(2);

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("deploymentCoverage — #787 mixed-generation visibility", () => {
  it("rolls per-model chunk counts up across every project", async () => {
    const { store, root } = makeStore();
    const { embedder } = makeEmbedder();
    const svc = new KnowledgeService({ embedder, vectorStore: store });

    mockKnowledgeChunk.groupBy.mockResolvedValue([
      { projectId: "p1", embeddingModel: NEW_MODEL, _count: { _all: 10 } },
      { projectId: "p1", embeddingModel: OLD_MODEL, _count: { _all: 5 } },
      { projectId: "p2", embeddingModel: OLD_MODEL, _count: { _all: 40 } },
      { projectId: "p3", embeddingModel: NEW_MODEL, _count: { _all: 7 } },
    ]);

    const report = await svc.deploymentCoverage();

    expect(report.currentModel).toBe(NEW_MODEL);
    expect(report.totalChunks).toBe(62);
    expect(report.modelCounts).toEqual({ [NEW_MODEL]: 17, [OLD_MODEL]: 45 });
    expect(report.projectsNeedingReindex).toBe(2);

    // Sorted by size so the operator sees the expensive migrations first.
    expect(report.projects.map((p) => p.projectId)).toEqual(["p2", "p1", "p3"]);
    // p1 is the mixed-generation project — partially migrated, still needs work.
    expect(report.projects.find((p) => p.projectId === "p1")).toMatchObject({
      totalChunks: 15,
      matchingChunks: 10,
      needsReindex: true,
    });
    // p3 is fully on the new model.
    expect(report.projects.find((p) => p.projectId === "p3")?.needsReindex).toBe(false);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports an empty deployment without inventing projects", async () => {
    const { store, root } = makeStore();
    const { embedder } = makeEmbedder();
    const svc = new KnowledgeService({ embedder, vectorStore: store });
    mockKnowledgeChunk.groupBy.mockResolvedValue([]);

    const report = await svc.deploymentCoverage();
    expect(report).toMatchObject({
      totalChunks: 0,
      projects: [],
      projectsNeedingReindex: 0,
      modelCounts: {},
    });

    await fs.rm(root, { recursive: true, force: true });
  });
});

/**
 * PR #796 review (S2) — the other half of the `pg_dump` rollback.
 *
 * The runbook told operators to dump `rag_vectors` before the destructive `prepare`,
 * and then said they "do not even pay the re-embed" on a rollback. Both could not be
 * true: restoring the dump gives back the old VECTORS, but every chunk's Prisma tag
 * still names the new model, so `reindex --all` re-embedded the whole corpus and
 * swapped its shadow straight over the rows that had just been restored. The dump
 * bought nothing. `retagToActiveModel()` is what spends it: it reconciles the TAGS to
 * the restored vectors, and touches no vector at all.
 */
describe("retagToActiveModel — #796 review S2 / #804 store intersection", () => {
  it("re-labels every chunk THAT HAS A VECTOR, without embedding anything", async () => {
    const { store, root } = makeStore();
    const { embedder, embeddedTexts } = makeEmbedder({ model: OLD_MODEL });
    const svc = new KnowledgeService({ embedder, vectorStore: store });

    // The rollback state: the store has the OLD generation's vectors restored (from
    // a pg_dump taken while OLD_MODEL was active), while every Prisma tag still says
    // the NEW model the forward migration wrote. #804 — retag now only stamps rows
    // it can confirm have a vector, so seed the store for all three candidates.
    const chunks = [1, 2, 3].map((n) => chunk(n, NEW_MODEL));
    await store.ensureTable(PROJECT);
    await store.upsert(
      PROJECT,
      chunks.map((c) => ({
        id: c.id,
        vector: [1, 1, 1, 1],
        metadata: {
          chunkId: c.id,
          documentId: c.documentId,
          filename: c.document.filename,
          position: c.position,
          text: c.text,
          embeddingModel: OLD_MODEL, // the restored generation == the active model
        },
      })),
    );
    mockKnowledgeChunk.findMany.mockResolvedValue(
      chunks.map((c) => ({ id: c.id, projectId: PROJECT })),
    );
    mockKnowledgeChunk.updateMany.mockImplementation(
      (args: { where: { id: { in: string[] } } }) => ({ count: args.where.id.in.length }),
    );

    const result = await svc.retagToActiveModel();

    // #797 — the retag now also covers code-symbol rows (0 here: the symbol port
    // is stubbed empty in this suite). #804 — `skipped` is 0 because every
    // candidate has a live vector under the active identity.
    expect(result).toEqual({ model: OLD_MODEL, retagged: 3, skipped: 0, retaggedSymbols: 0 });
    // #804 — scoped to the ids the store vouches for (all three), not a blanket
    // `{ embeddingModel: { not } }`, and it still sets ONLY the tag.
    expect(mockKnowledgeChunk.updateMany).toHaveBeenCalledWith({
      where: {
        projectId: PROJECT,
        id: { in: ["c1", "c2", "c3"] },
        embeddingModel: { not: OLD_MODEL },
      },
      data: { embeddingModel: OLD_MODEL },
    });
    // The whole point of the fast path: not one embed call.
    expect(embeddedTexts).toEqual([]);

    await fs.rm(root, { recursive: true, force: true });
  });
});
