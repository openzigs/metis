/**
 * Epic #930 / issue #937 — dimension migration + reindex tests.
 *
 * Exercises `KnowledgeService.coverageReport` and `KnowledgeService.reindexProject`
 * against the real `LocalVectorStore` (dimension-agnostic JSON store) with an
 * in-memory Prisma mock and swappable fake embedders so we can assert a
 * backend swap that *changes the vector dimension* rebuilds the table cleanly.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  projectId: string;
  documentId: string;
  position: number;
  text: string;
  embeddingModel: string;
  filename: string;
}

const rows: Row[] = [];

// Issue #797 — KnowledgeService now also drives the code-symbol vector corpus
// through reindex/coverage. This suite is about the DOCUMENT half; the symbol
// port is stubbed to an empty project (#797's own suites cover the real one).
vi.mock("../src/lib/code-graph/symbol-embedding-service.js", () => ({
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

vi.mock("../src/lib/prisma.js", () => {
  const tx = {
    knowledgeChunk: {
      findMany: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { projectId: string };
          select?: Record<string, unknown>;
          orderBy?: unknown;
        }) => {
          return rows
            .filter((r) => r.projectId === where.projectId)
            .sort((a, b) =>
              a.documentId === b.documentId
                ? a.position - b.position
                : a.documentId.localeCompare(b.documentId),
            )
            .map((r) =>
              select?.id && Object.keys(select).length === 1
                ? { id: r.id }
                : {
                    id: r.id,
                    documentId: r.documentId,
                    position: r.position,
                    text: r.text,
                    embeddingModel: r.embeddingModel,
                    document: { filename: r.filename },
                  },
            );
        },
      ),
      groupBy: vi.fn(async ({ where }: { where: { projectId: string } }) => {
        const counts = new Map<string, number>();
        for (const r of rows) {
          if (r.projectId !== where.projectId) continue;
          counts.set(r.embeddingModel, (counts.get(r.embeddingModel) ?? 0) + 1);
        }
        return [...counts.entries()].map(([embeddingModel, count]) => ({
          embeddingModel,
          _count: { _all: count },
        }));
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { projectId: string; id: { in: string[] } };
          data: { embeddingModel: string };
        }) => {
          let count = 0;
          for (const r of rows) {
            if (r.projectId === where.projectId && where.id.in.includes(r.id)) {
              r.embeddingModel = data.embeddingModel;
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };
});

/**
 * In-memory `vectordb` (LanceDB) double used ONLY to exercise
 * {@link LanceVectorStore.swapTable}'s drop+recreate FALLBACK — the path taken
 * when the installed client has no native `renameTable`. The fake omits
 * `renameTable` precisely so the fallback branch runs, and lets a test force a
 * `createTable` failure for a named table via `lanceState.failCreateFor`.
 */
const lanceState = vi.hoisted(() => ({
  tables: new Map<string, Array<Record<string, unknown>>>(),
  /** When set, the NEXT createTable for this table name throws once. */
  failCreateFor: null as string | null,
}));

vi.mock("vectordb", () => {
  function makeTable(name: string) {
    return {
      name,
      async add(data: Array<Record<string, unknown>>) {
        lanceState.tables.get(name)!.push(...data);
        return data.length;
      },
      async delete(filter: string) {
        const arr = lanceState.tables.get(name)!;
        if (filter.includes("__schema__")) {
          lanceState.tables.set(
            name,
            arr.filter((r) => r.id !== "__schema__"),
          );
          return;
        }
        const m = filter.match(/IN \((.*)\)/i);
        if (m) {
          const ids = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
          lanceState.tables.set(
            name,
            arr.filter((r) => !ids.includes(r.id as string)),
          );
        }
      },
      async countRows() {
        return lanceState.tables.get(name)!.length;
      },
      search() {
        let lim = Number.POSITIVE_INFINITY;
        const q = {
          limit(n: number) {
            lim = n;
            return q;
          },
          filter() {
            return q;
          },
          where() {
            return q;
          },
          metricType() {
            return q;
          },
          async execute() {
            return lanceState.tables
              .get(name)!
              .slice(0, lim)
              .map((r) => ({ ...r }));
          },
        };
        return q;
      },
      async createIndex() {
        return null;
      },
    };
  }
  const conn = {
    async tableNames() {
      return [...lanceState.tables.keys()];
    },
    async openTable(name: string) {
      if (!lanceState.tables.has(name)) throw new Error(`no such table: ${name}`);
      return makeTable(name);
    },
    async createTable(name: string, data: Array<Record<string, unknown>>) {
      if (lanceState.failCreateFor === name) {
        lanceState.failCreateFor = null;
        throw new Error(`createTable boom: ${name}`);
      }
      lanceState.tables.set(name, [...data]);
      return makeTable(name);
    },
    async dropTable(name: string) {
      lanceState.tables.delete(name);
    },
    // NOTE: intentionally NO `renameTable` — forces the swapTable fallback.
  };
  return { connect: async () => conn };
});

import { LocalVectorStore, LanceVectorStore, type VectorRow } from "../src/lib/rag/vector-store.js";
import {
  KnowledgeService,
  ReindexConflictError,
  reindexShadowId,
  type ReindexProgress,
} from "../src/lib/rag/knowledge-service.js";
import { __resetReindexLeaseBackend } from "../src/lib/rag/reindex-lease.js";
import type { Embedder } from "../src/lib/rag/embedder.js";
import { assertApprovalGeneration } from "../src/lib/rag/project-vector-write.js";

/** Deterministic fake embedder whose output dimension is configurable. */
function fakeEmbedder(model: string, dimension: number): Embedder {
  return {
    model,
    dimension,
    key: "fake",
    requiresEgress: false,
    capabilities: () => ({ key: "fake", model, dimension, requiresEgress: false }),
    async embed(texts: string[]) {
      const vectors = texts.map((t) => {
        const v = new Array<number>(dimension).fill(0);
        for (let i = 0; i < t.length; i += 1) v[i % dimension] += t.charCodeAt(i) / 255;
        return v;
      });
      return { vectors, model, dimension };
    },
    async health() {
      return { ok: true };
    },
  } as unknown as Embedder;
}

/**
 * Embedder whose first `embed()` call blocks until `release()` is invoked, so a
 * test can observe the LIVE table mid-reindex (it must still serve old vectors).
 */
function gatedEmbedder(
  model: string,
  dimension: number,
): { embedder: Embedder; release: () => void; started: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let signalStarted!: () => void;
  const started = new Promise<void>((r) => (signalStarted = r));
  const base = fakeEmbedder(model, dimension);
  let first = true;
  const embedder = {
    ...base,
    async embed(texts: string[]) {
      if (first) {
        first = false;
        signalStarted();
        await gate;
      }
      return base.embed(texts);
    },
  } as unknown as Embedder;
  return { embedder, release, started };
}

/** Embedder that throws once it has been called `failAfter` times. */
function failingEmbedder(model: string, dimension: number, failAfter: number): Embedder {
  const base = fakeEmbedder(model, dimension);
  let calls = 0;
  return {
    ...base,
    async embed(texts: string[]) {
      calls += 1;
      if (calls > failAfter) throw new Error("embed boom");
      return base.embed(texts);
    },
  } as unknown as Embedder;
}

let vectorRoot: string;
let store: LocalVectorStore;

async function seedChunk(store: LocalVectorStore, embedder: Embedder, r: Row): Promise<void> {
  rows.push(r);
  const { vectors, model } = await embedder.embed([r.text]);
  const row: VectorRow = {
    id: r.id,
    vector: vectors[0],
    metadata: {
      chunkId: r.id,
      documentId: r.documentId,
      filename: r.filename,
      position: r.position,
      text: r.text,
      embeddingModel: model,
    },
  };
  await store.upsert(r.projectId, [row]);
}

beforeEach(async () => {
  // #876 — Prisma is stubbed here, so the reindex lease must resolve to the no-op backend.
  // `resolveReindexLeaseBackend()` reads `DATABASE_URL` lazily, so an ambient Postgres URL
  // (a developer dogfooding on Postgres) would otherwise wire a real
  // `PostgresReindexLeaseBackend` to the mock and fail on `$executeRawUnsafe`.
  delete process.env.DATABASE_URL;
  __resetReindexLeaseBackend();
  rows.length = 0;
  vectorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metis-reindex-"));
  store = new LocalVectorStore({ root: vectorRoot });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(vectorRoot, { recursive: true, force: true });
});

describe("KnowledgeService.coverageReport", () => {
  it("reports no reindex needed when every chunk matches the active model", async () => {
    const embedder = fakeEmbedder("model-a", 4);
    await seedChunk(store, embedder, {
      id: "c1",
      projectId: "p1",
      documentId: "d1",
      position: 0,
      text: "alpha",
      embeddingModel: "model-a",
      filename: "a.md",
    });
    const svc = new KnowledgeService({ vectorStore: store, embedder });

    const report = await svc.coverageReport("p1");
    expect(report.totalChunks).toBe(1);
    expect(report.currentModel).toBe("model-a");
    expect(report.currentDimension).toBe(4);
    expect(report.matchingChunks).toBe(1);
    expect(report.mismatchedModels).toEqual([]);
    expect(report.needsReindex).toBe(false);
  });

  it("flags reindex when chunks were embedded by a different model", async () => {
    const oldEmbedder = fakeEmbedder("model-a", 4);
    await seedChunk(store, oldEmbedder, {
      id: "c1",
      projectId: "p1",
      documentId: "d1",
      position: 0,
      text: "alpha",
      embeddingModel: "model-a",
      filename: "a.md",
    });
    // Active backend is now model-b at a *different* dimension.
    const svc = new KnowledgeService({ vectorStore: store, embedder: fakeEmbedder("model-b", 6) });

    const report = await svc.coverageReport("p1");
    expect(report.needsReindex).toBe(true);
    expect(report.mismatchedModels).toEqual(["model-a"]);
    expect(report.matchingChunks).toBe(0);
    expect(report.currentDimension).toBe(6);
  });

  it("returns an empty report for a project with no chunks", async () => {
    const svc = new KnowledgeService({ vectorStore: store, embedder: fakeEmbedder("model-a", 4) });
    const report = await svc.coverageReport("empty");
    expect(report).toMatchObject({ totalChunks: 0, needsReindex: false, mismatchedModels: [] });
  });

  it("rejects an empty projectId", async () => {
    const svc = new KnowledgeService({ vectorStore: store, embedder: fakeEmbedder("model-a", 4) });
    await expect(svc.coverageReport("")).rejects.toThrow(/non-empty string/);
  });
});

describe("KnowledgeService.reindexProject", () => {
  it("re-embeds chunks at a new dimension and rebuilds the vector table", async () => {
    const oldEmbedder = fakeEmbedder("model-a", 4);
    for (let i = 0; i < 5; i += 1) {
      await seedChunk(store, oldEmbedder, {
        id: `c${i}`,
        projectId: "p1",
        documentId: "d1",
        position: i,
        text: `chunk ${i}`,
        embeddingModel: "model-a",
        filename: "a.md",
      });
    }

    const newEmbedder = fakeEmbedder("model-b", 6);
    const svc = new KnowledgeService({ vectorStore: store, embedder: newEmbedder });

    const progress: ReindexProgress[] = [];
    const result = await svc.reindexProject("p1", {
      batchSize: 2,
      onProgress: (p) => progress.push(p),
    });

    expect(result.totalChunks).toBe(5);
    expect(result.reindexedChunks).toBe(5);
    expect(result.previousModels).toEqual(["model-a"]);
    expect(result.currentModel).toBe("model-b");
    expect(result.currentDimension).toBe(6);
    // Batches of 2 over 5 chunks → progress reported 3 times, last = 5/5.
    expect(progress.length).toBe(3);
    expect(progress.at(-1)).toEqual({ processed: 5, total: 5 });

    // Persisted chunks now carry the new model.
    const coverage = await svc.coverageReport("p1");
    expect(coverage.modelCounts).toEqual({ "model-b": 5 });
    expect(coverage.needsReindex).toBe(false);

    // Stored vectors are now 6-dimensional (table rebuilt).
    const hits = await store.search("p1", new Array<number>(6).fill(0.1), 5);
    expect(hits.length).toBe(5);
    for (const h of hits) {
      expect(h.row.vector.length).toBe(6);
      expect(h.row.metadata.embeddingModel).toBe("model-b");
    }
  });

  it("cuts over an empty project to a durable generation that validates later approvals", async () => {
    const embedder = fakeEmbedder("model-b", 6);
    const embed = vi.spyOn(embedder, "embed");
    const svc = new KnowledgeService({ vectorStore: store, embedder });
    // SQL is empty even though a stale vector remains from the previous index.
    await store.upsert("p1", [
      {
        id: "orphan",
        vector: [1, 0, 0, 0],
        metadata: {
          chunkId: "orphan",
          documentId: "d1",
          filename: "a.md",
          position: 0,
          text: "old chunk",
          embeddingModel: "model-a",
        },
      },
    ]);
    const result = await svc.reindexProject("p1");
    expect(result.totalChunks).toBe(0);
    expect(result.reindexedChunks).toBe(0);
    expect(result.embeddedChunks).toBe(0);
    expect(result.resumedChunks).toBe(0);
    expect(result.previousModels).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(await store.listChunkRefs("p1")).toEqual([]);
    expect(await store.listChunkRefs(reindexShadowId("p1"))).toEqual([]);
    const reopened = new LocalVectorStore({ root: vectorRoot });
    const generation = await reopened.withProjectWrite("p1", (write) => write.readGeneration());
    expect(generation).toEqual({ model: "model-b", dimension: 6, pending: false });
    const approval: VectorRow = {
      id: "approval",
      vector: [1, 0, 0, 0, 0, 0],
      metadata: {
        chunkId: "approval",
        documentId: "d2",
        filename: "b.md",
        position: 0,
        text: "new chunk",
        embeddingModel: "model-b",
      },
    };
    expect(() => assertApprovalGeneration(generation, [approval])).not.toThrow();
    expect(() =>
      assertApprovalGeneration(generation, [{ ...approval, vector: [1, 0, 0, 0] }]),
    ).toThrow(/generation is stale/);
    expect(() =>
      assertApprovalGeneration(generation, [
        {
          ...approval,
          metadata: { ...approval.metadata, embeddingModel: "model-a" },
        },
      ]),
    ).toThrow(/generation is stale/);
  });

  it("rejects an empty projectId", async () => {
    const svc = new KnowledgeService({ vectorStore: store, embedder: fakeEmbedder("model-b", 6) });
    await expect(svc.reindexProject("  ")).rejects.toThrow(/non-empty string/);
  });

  it("keeps the LIVE table serving OLD vectors for the whole embed loop", async () => {
    const oldEmbedder = fakeEmbedder("model-a", 4);
    for (let i = 0; i < 4; i += 1) {
      await seedChunk(store, oldEmbedder, {
        id: `c${i}`,
        projectId: "p1",
        documentId: "d1",
        position: i,
        text: `chunk ${i}`,
        embeddingModel: "model-a",
        filename: "a.md",
      });
    }

    const gated = gatedEmbedder("model-b", 6);
    const svc = new KnowledgeService({ vectorStore: store, embedder: gated.embedder });
    const pending = svc.reindexProject("p1", { batchSize: 2 });

    // Wait until the reindex is mid-flight (first batch embedding, gate held).
    await gated.started;

    // The live table must still answer with the OLD 4-dim vectors.
    const midHits = await store.search("p1", new Array<number>(4).fill(0.1), 4);
    expect(midHits.length).toBe(4);
    for (const h of midHits) {
      expect(h.row.vector.length).toBe(4);
      expect(h.row.metadata.embeddingModel).toBe("model-a");
    }

    gated.release();
    await pending;

    // After the swap the live table serves the NEW 6-dim vectors.
    const finalHits = await store.search("p1", new Array<number>(6).fill(0.1), 4);
    expect(finalHits.length).toBe(4);
    for (const h of finalHits) expect(h.row.vector.length).toBe(6);
  });

  it("does not resurrect chunks deleted after the reindex snapshot, and preserves unrelated documents", async () => {
    const oldEmbedder = fakeEmbedder("model-a", 4);
    await seedChunk(store, oldEmbedder, {
      id: "gone-0",
      projectId: "p1",
      documentId: "d-gone",
      position: 0,
      text: "deleted chunk",
      embeddingModel: "model-a",
      filename: "gone.md",
    });
    await seedChunk(store, oldEmbedder, {
      id: "keep-0",
      projectId: "p1",
      documentId: "d-keep",
      position: 0,
      text: "kept chunk",
      embeddingModel: "model-a",
      filename: "keep.md",
    });

    const gated = gatedEmbedder("model-b", 6);
    const svc = new KnowledgeService({ vectorStore: store, embedder: gated.embedder });
    const pending = svc.reindexProject("p1", { batchSize: 1 });

    await gated.started;
    const deleted = rows.findIndex((row) => row.id === "gone-0");
    rows.splice(deleted, 1);

    gated.release();
    await pending;

    const live = await store.listChunkRefs("p1");
    expect(live.map((row) => row.chunkId).sort()).toEqual(["keep-0"]);
    expect(live[0]?.embeddingModel).toBe("model-b");

    const coverage = await svc.coverageReport("p1");
    expect(coverage.totalChunks).toBe(1);
    expect(coverage.matchingChunks).toBe(1);
    expect(coverage.needsReindex).toBe(false);
  });

  it("RETAINS the shadow as a resume checkpoint and leaves the live table intact on a mid-batch failure", async () => {
    const oldEmbedder = fakeEmbedder("model-a", 4);
    for (let i = 0; i < 5; i += 1) {
      await seedChunk(store, oldEmbedder, {
        id: `c${i}`,
        projectId: "p1",
        documentId: "d1",
        position: i,
        text: `chunk ${i}`,
        embeddingModel: "model-a",
        filename: "a.md",
      });
    }

    // Fails on the 2nd batch (batchSize 2 → 3 batches; throw before finishing).
    const svc = new KnowledgeService({
      vectorStore: store,
      embedder: failingEmbedder("model-b", 6, 1),
    });
    await expect(svc.reindexProject("p1", { batchSize: 2 })).rejects.toThrow(/embed boom/);

    // Live table is untouched: still 5 OLD 4-dim vectors.
    const hits = await store.search("p1", new Array<number>(4).fill(0.1), 5);
    expect(hits.length).toBe(5);
    for (const h of hits) {
      expect(h.row.vector.length).toBe(4);
      expect(h.row.metadata.embeddingModel).toBe("model-a");
    }
    // Persisted model tags are unchanged.
    const coverage = await svc.coverageReport("p1");
    expect(coverage.modelCounts).toEqual({ "model-a": 5 });

    // Issue #787 — the shadow is KEPT, not discarded. It holds the batches that DID
    // complete, and is the checkpoint a restarted reindex resumes from. Dropping it
    // (the pre-#787 behaviour this assertion used to encode) protected nothing — the
    // live table is untouched either way, because nothing has been swapped yet — and
    // it threw away every chunk the run had already paid to embed. On an evicting
    // cluster that made a long reindex unable to finish at all.
    const shadowCount = await store.count(reindexShadowId("p1"));
    expect(shadowCount).toBe(2); // the one batch that landed before the throw
    const refs = await store.listChunkRefs(reindexShadowId("p1"));
    expect(refs.every((r) => r.embeddingModel === "model-b")).toBe(true);
  });

  it.each([2, 3])(
    "resumes persisted same-model shadows only at the actual %i-dimensional width",
    async (dimension) => {
      const old = fakeEmbedder("model-a", 4);
      for (let i = 0; i < 3; i += 1) {
        await seedChunk(store, old, {
          id: `c${i}`,
          projectId: "p1",
          documentId: "d1",
          position: i,
          text: `chunk ${i}`,
          embeddingModel: "model-a",
          filename: "a.md",
        });
      }
      await expect(
        new KnowledgeService({
          vectorStore: store,
          embedder: failingEmbedder("same-model", 2, 1),
        }).reindexProject("p1", { batchSize: 2 }),
      ).rejects.toThrow("embed boom");
      const shadowId = reindexShadowId("p1");
      const diskRows = async (id: string): Promise<VectorRow[]> =>
        JSON.parse(await fs.readFile(path.join(vectorRoot, id, "table.json"), "utf8"));
      const oldShadow = await diskRows(shadowId);
      expect(oldShadow.map((r) => r.vector)).toEqual(
        (await fakeEmbedder("same-model", 2).embed(["chunk 0", "chunk 1"])).vectors,
      );

      // A new instance must use the persisted vectors, not an in-memory checkpoint.
      const reopened = new LocalVectorStore({ root: vectorRoot });
      const embedder = fakeEmbedder("same-model", dimension);
      const expected = (await embedder.embed(rows.map((r) => r.text))).vectors;
      const embed = vi.spyOn(embedder, "embed");
      const result = await new KnowledgeService({ vectorStore: reopened, embedder }).reindexProject(
        "p1",
        { batchSize: 2 },
      );
      expect(result.resumedChunks).toBe(dimension === 2 ? 2 : 0);
      expect(result.embeddedChunks).toBe(dimension === 2 ? 1 : 3);
      expect(embed.mock.calls.flatMap(([texts]) => texts)).toEqual(
        dimension === 2 ? ["chunk 2"] : ["chunk 0", "chunk 1", "chunk 2"],
      );
      const persisted = await diskRows("p1");
      expect(persisted.map((r) => r.id)).toEqual(["c0", "c1", "c2"]);
      expect(persisted.map((r) => r.vector)).toEqual(expected);
      expect(persisted.every((r) => r.metadata.embeddingModel === "same-model")).toBe(true);
      expect(await reopened.withProjectWrite("p1", (write) => write.readGeneration())).toEqual({
        model: "same-model",
        dimension,
        pending: false,
      });
    },
  );

  it.each(["mixed", "missing", "empty"])(
    "rebuilds a persisted shadow with %s dimension evidence",
    async (kind) => {
      for (let i = 0; i < 2; i += 1) {
        await seedChunk(store, fakeEmbedder("model-a", 4), {
          id: `c${i}`,
          projectId: "p1",
          documentId: "d1",
          position: i,
          text: `chunk ${i}`,
          embeddingModel: "model-a",
          filename: "a.md",
        });
      }
      const shadowId = reindexShadowId("p1");
      await store.ensureTable(shadowId);
      // First row matches; a later row must not be hidden by a table-level guess.
      const shadow = rows.map((r, i) => ({
        id: r.id,
        vector: i === 0 ? [1, 2, 3] : kind === "mixed" ? [7, 8] : kind === "empty" ? [] : undefined,
        metadata: { embeddingModel: "same-model" },
      }));
      await fs.writeFile(path.join(vectorRoot, shadowId, "table.json"), JSON.stringify(shadow));
      const reopened = new LocalVectorStore({ root: vectorRoot });
      const embedder = fakeEmbedder("same-model", 3);
      const result = await new KnowledgeService({ vectorStore: reopened, embedder }).reindexProject(
        "p1",
      );
      expect(result.resumedChunks).toBe(0);
      expect(result.embeddedChunks).toBe(2);
      const persisted: VectorRow[] = JSON.parse(
        await fs.readFile(path.join(vectorRoot, "p1", "table.json"), "utf8"),
      );
      expect(persisted.map((r) => r.vector)).toEqual(
        (await embedder.embed(rows.map((r) => r.text))).vectors,
      );
    },
  );

  it.each(["snapshot", "catch-up"])(
    "refuses cutover when persisted %s vectors have the wrong dimension",
    async (phase) => {
      await seedChunk(store, fakeEmbedder("model-a", 4), {
        id: "c0",
        projectId: "p1",
        documentId: "d1",
        position: 0,
        text: "chunk 0",
        embeddingModel: "model-a",
        filename: "a.md",
      });
      const liveFile = path.join(vectorRoot, "p1", "table.json");
      const before = await fs.readFile(liveFile, "utf8");
      const generation = { model: "model-a", dimension: 4, pending: false };
      await store.withProjectWrite("p1", (write) => write.writeGeneration(generation));
      const base = fakeEmbedder("same-model", 3);
      const embedder = {
        ...base,
        embed: async (texts: string[]) => {
          if (phase === "catch-up" && rows.length === 1) {
            rows.push({ ...rows[0], id: "c1", position: 1, text: "chunk 1" });
          }
          return base.embed(texts);
        },
      } as Embedder;
      const upsert = store.upsert.bind(store);
      vi.spyOn(store, "upsert").mockImplementation(async (id, batch) => {
        await upsert(id, batch);
        if (
          id === reindexShadowId("p1") &&
          batch.some((r) => r.id === (phase === "snapshot" ? "c0" : "c1"))
        ) {
          // Persist an actual wrong-width row after the embed output passed validation.
          await upsert(id, [{ ...batch[batch.length - 1], vector: [7, 8] }]);
        }
      });
      const swap = vi.spyOn(store, "swapTable");
      await expect(
        new KnowledgeService({ vectorStore: store, embedder }).reindexProject("p1"),
      ).rejects.toThrow("Reindex shadow embedding generation changed");
      expect(swap).not.toHaveBeenCalled();
      expect(await fs.readFile(liveFile, "utf8")).toBe(before);
      expect(await store.withProjectWrite("p1", (write) => write.readGeneration())).toEqual(
        generation,
      );
      expect(rows.every((r) => r.embeddingModel === "model-a")).toBe(true);
    },
  );

  it("rejects a concurrent reindex for the same project with a conflict error", async () => {
    const oldEmbedder = fakeEmbedder("model-a", 4);
    for (let i = 0; i < 4; i += 1) {
      await seedChunk(store, oldEmbedder, {
        id: `c${i}`,
        projectId: "p1",
        documentId: "d1",
        position: i,
        text: `chunk ${i}`,
        embeddingModel: "model-a",
        filename: "a.md",
      });
    }

    const gated = gatedEmbedder("model-b", 6);
    const svc = new KnowledgeService({ vectorStore: store, embedder: gated.embedder });
    const first = svc.reindexProject("p1", { batchSize: 2 });
    await gated.started;

    // A second reindex while the first is in flight is rejected, not queued.
    await expect(svc.reindexProject("p1", { batchSize: 2 })).rejects.toBeInstanceOf(
      ReindexConflictError,
    );

    gated.release();
    await first;

    // Once finished the guard is released — a fresh reindex succeeds.
    await expect(
      new KnowledgeService({
        vectorStore: store,
        embedder: fakeEmbedder("model-c", 8),
      }).reindexProject("p1"),
    ).resolves.toMatchObject({ currentModel: "model-c" });
  });
});

describe("LocalVectorStore.swapTable", () => {
  it("atomically replaces the live table with the shadow's rows", async () => {
    await store.ensureTable("p1");
    await store.upsert("p1", [
      {
        id: "old",
        vector: [1, 0, 0, 0],
        metadata: { chunkId: "old", documentId: "d", filename: "a", position: 0, text: "old" },
      },
    ]);
    const shadow = reindexShadowId("p1");
    await store.ensureTable(shadow);
    await store.upsert(shadow, [
      {
        id: "new",
        vector: [0, 1, 0, 0, 0, 0],
        metadata: { chunkId: "new", documentId: "d", filename: "a", position: 0, text: "new" },
      },
    ]);

    await store.swapTable("p1", shadow);

    expect(await store.count("p1")).toBe(1);
    expect(await store.count(shadow)).toBe(0);
    const hits = await store.search("p1", [0, 1, 0, 0, 0, 0], 1);
    expect(hits[0].row.id).toBe("new");
    expect(hits[0].row.vector.length).toBe(6);
  });

  it("throws when the shadow table does not exist", async () => {
    await store.ensureTable("p1");
    await expect(store.swapTable("p1", reindexShadowId("p1"))).rejects.toThrow(/does not exist/);
  });
});

describe("LanceVectorStore.swapTable fallback (no native renameTable)", () => {
  let lanceRoot: string;
  let lance: LanceVectorStore;

  beforeEach(async () => {
    lanceState.tables.clear();
    lanceState.failCreateFor = null;
    lanceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metis-lance-"));
    lance = new LanceVectorStore({ root: lanceRoot, dimension: 4 });
  });

  afterEach(async () => {
    await fs.rm(lanceRoot, { recursive: true, force: true });
  });

  function liveRow(id: string): VectorRow {
    return {
      id,
      vector: [1, 0, 0, 0],
      metadata: {
        chunkId: id,
        documentId: "d",
        filename: "a.md",
        position: 0,
        text: id,
        embeddingModel: "model-a",
      },
    };
  }
  function shadowRow(id: string): VectorRow {
    return {
      id,
      vector: [0, 1, 0, 0, 0, 0],
      metadata: {
        chunkId: id,
        documentId: "d",
        filename: "a.md",
        position: 0,
        text: id,
        embeddingModel: "model-b",
      },
    };
  }

  it("swaps the shadow into the live table via drop+recreate and removes shadow + staging", async () => {
    await lance.upsert("p1", [liveRow("old")]);
    const shadow = reindexShadowId("p1");
    await lance.ensureTable(shadow);
    await lance.upsert(shadow, [shadowRow("new")]);

    await lance.swapTable("p1", shadow);

    // Live now serves the NEW 6-dim row; staging + shadow tables are gone.
    expect(await lance.count("p1")).toBe(1);
    expect([...lanceState.tables.keys()]).toEqual(["p_p1"]);
    const hits = await lance.search("p1", [0, 1, 0, 0, 0, 0], 1);
    expect(hits[0].row.id).toBe("new");
    expect(hits[0].row.vector.length).toBe(6);
    expect(hits[0].row.metadata.embeddingModel).toBe("model-b");
  });

  it("leaves the OLD live data intact, cleans up staging, and KEEPS the shadow when the staging create fails", async () => {
    await lance.upsert("p1", [liveRow("old1"), liveRow("old2")]);
    const shadow = reindexShadowId("p1");
    await lance.ensureTable(shadow);
    await lance.upsert(shadow, [shadowRow("new")]);

    // Force the STAGING create (pre-cut-over) to throw, simulating a
    // schema/disk failure. The #941 reorder must catch it BEFORE the live
    // table is dropped, so the live index never goes empty.
    lanceState.failCreateFor = "p_p1_staging";

    await expect(lance.swapTable("p1", shadow)).rejects.toThrow(/createTable boom/);

    // The OLD live table is fully intact — still the two 4-dim model-a rows,
    // NOT empty and NOT replaced.
    expect(await lance.count("p1")).toBe(2);
    const hits = await lance.search("p1", [1, 0, 0, 0], 2);
    expect(hits.length).toBe(2);
    for (const h of hits) {
      expect(h.row.vector.length).toBe(4);
      expect(h.row.metadata.embeddingModel).toBe("model-a");
    }

    // The half-built STAGING table is cleaned up — that one is junk.
    expect([...lanceState.tables.keys()]).not.toContain("p_p1_staging");
    // ...but the SHADOW is KEPT (#787 resume; PR #796 review S1). It used to be
    // dropped here, which quietly made the "a failed swap retains the checkpoint"
    // guarantee backend-dependent: `vectordb` has no `renameTable`, so THIS fallback
    // is the production path for Lance, and this is its most likely failure. Dropping
    // the shadow threw away a COMPLETE checkpoint and forced a full re-embed of the
    // project. Live was never touched on this path, so keeping it costs one stale
    // table and saves the whole corpus.
    expect([...lanceState.tables.keys()].sort()).toEqual(["p_p1", "p_p1__reindex"]);
    expect(await lance.count(shadow)).toBe(1);
  });
});
