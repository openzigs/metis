/**
 * Issue #792 — a pooling/dtype flip INVALIDATES chunk reuse and drives the real
 * reindex flow.
 *
 * This exercises the REAL `KnowledgeService.coverageReport` and
 * `KnowledgeService.reindexProject` (no coverage stub): an in-memory Prisma
 * double holds the `KnowledgeChunk` rows, a real `LocalVectorStore` holds the
 * vectors, and the embedder is a deterministic double whose IDENTITY is computed
 * by the PRODUCTION `resolvePooling` / `resolveDtype` / `formatEmbeddingIdentity`
 * against `process.env`. So flipping `EMBED_POOLING_MAP` / `EMBED_DTYPE` moves the
 * identity exactly as the shipped in-process backend would, and the coverage +
 * reindex decisions are the real code under test.
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

/** Configurable symbol-port double so a coverage test can inject a mismatched tag. */
const symbolState: { modelCounts: Record<string, number>; totalSymbols: number } = {
  modelCounts: {},
  totalSymbols: 0,
};

vi.mock("../src/lib/code-graph/symbol-embedding-service.js", () => ({
  getSymbolEmbeddingsPort: () => ({
    coverage: async () => ({
      totalSymbols: symbolState.totalSymbols,
      modelCounts: symbolState.modelCounts,
    }),
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
          where = {},
          select,
        }: {
          where?: { projectId?: string; id?: { in: string[] } };
          select?: Record<string, unknown>;
        }) => {
          // Every read sees complete current membership. Tests introduce rows
          // during embedding, after the initial snapshot has actually been read.
          return rows
            .filter((r) => (where.projectId ? r.projectId === where.projectId : true))
            .filter((r) => (where.id ? where.id.in.includes(r.id) : true))
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
                    projectId: r.projectId, // #804 — retag groups candidates by project
                    documentId: r.documentId,
                    position: r.position,
                    text: r.text,
                    embeddingModel: r.embeddingModel,
                    document: { filename: r.filename },
                  },
            );
        },
      ),
      groupBy: vi.fn(async ({ by, where }: { by: string[]; where?: { projectId?: string } }) => {
        const byProject = by.includes("projectId");
        const counts = new Map<string, number>();
        for (const r of rows) {
          if (where?.projectId && r.projectId !== where.projectId) continue;
          const key = byProject ? `${r.projectId}\0${r.embeddingModel}` : r.embeddingModel;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()].map(([key, count]) => {
          if (byProject) {
            const [projectId, embeddingModel] = key.split("\0");
            return { projectId, embeddingModel, _count: { _all: count } };
          }
          return { embeddingModel: key, _count: { _all: count } };
        });
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { projectId?: string; id?: { in: string[] }; embeddingModel?: { not: string } };
          data: { embeddingModel: string };
        }) => {
          let count = 0;
          for (const r of rows) {
            if (where.projectId && r.projectId !== where.projectId) continue;
            const match = where.id
              ? where.id.in.includes(r.id)
              : where.embeddingModel
                ? r.embeddingModel !== where.embeddingModel.not
                : false;
            if (match) {
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

import { LocalVectorStore } from "../src/lib/rag/vector-store.js";
import { KnowledgeService, reindexShadowId } from "../src/lib/rag/knowledge-service.js";
import { resolveDtype, resolvePooling } from "../src/lib/rag/embed-model-config.js";
import { formatEmbeddingIdentity } from "../src/lib/rag/embedding-identity.js";
import { __resetReindexLeaseBackend } from "../src/lib/rag/reindex-lease.js";
import type { Embedder } from "../src/lib/rag/embedder.js";
import type { BM25Index } from "../src/lib/rag/bm25-index.js";

const GTE = "Alibaba-NLP/gte-modernbert-base"; // built-in cls, default dtype q8

/** The production identity for a model under the CURRENT `process.env`. */
function resolveEnvIdentity(model: string): string {
  const pooling = resolvePooling(model, undefined, process.env).pooling;
  const dtype = resolveDtype(process.env);
  return formatEmbeddingIdentity(model, pooling, dtype);
}

const ORIGINAL_ENV = { ...process.env };
let tmpDir: string;

/**
 * Deterministic embedder whose identity is the PRODUCTION identity for the
 * current `process.env` (built-in pooling/dtype unless an operator knob flips it).
 */
function identityEmbedder(model: string, dimension: number): Embedder {
  return {
    model,
    dimension,
    key: "fake",
    requiresEgress: false,
    capabilities: () => ({ key: "fake", model, dimension, requiresEgress: false }),
    async currentIdentity() {
      return resolveEnvIdentity(model);
    },
    async embed(texts: string[]) {
      const identity = resolveEnvIdentity(model);
      const vectors = texts.map((t) => {
        const v = new Array<number>(dimension).fill(0);
        for (let i = 0; i < t.length; i += 1) v[i % dimension] += t.charCodeAt(i) / 255;
        return v;
      });
      return { vectors, model, dimension, identity };
    },
    async warm() {},
    async health() {
      return { ok: true } as never;
    },
  } as unknown as Embedder;
}

function seed(projectId: string, identity: string, n: number): void {
  for (let i = 0; i < n; i += 1) {
    rows.push({
      id: `${projectId}-c${i}`,
      projectId,
      documentId: `${projectId}-doc`,
      position: i,
      text: `chunk number ${i} about throttling logins`,
      embeddingModel: identity,
      filename: "f.md",
    });
  }
}

beforeEach(async () => {
  // #876 — Prisma is stubbed here, so the reindex lease must resolve to the no-op backend.
  // `resolveReindexLeaseBackend()` reads `DATABASE_URL` lazily, so an ambient Postgres URL
  // (a developer dogfooding on Postgres) would otherwise wire a real
  // `PostgresReindexLeaseBackend` to the mock and fail on `$executeRawUnsafe`.
  delete process.env.DATABASE_URL;
  __resetReindexLeaseBackend();
  rows.length = 0;
  symbolState.modelCounts = {};
  symbolState.totalSymbols = 0;
  delete process.env.EMBED_POOLING_MAP;
  delete process.env.EMBED_POOLING;
  delete process.env.EMBED_DTYPE;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "identity-reindex-"));
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("pooling/dtype flip → reindex (#792)", () => {
  it("ACCEPTS reuse when config is unchanged (existing bare-id index, default config)", async () => {
    // Existing rows carry the BARE model id — exactly what a pre-#792 default index
    // stores. The default config produces the same bare identity, so no reindex.
    seed("proj-reuse", GTE, 4);
    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8),
      vectorStore: new LocalVectorStore({ root: tmpDir }),
    });
    const cov = await svc.coverageReport("proj-reuse");
    expect(cov.currentModel).toBe(GTE); // bare — grandfathers the existing index
    expect(cov.needsReindex).toBe(false);
    expect(cov.matchingChunks).toBe(4);
    expect(cov.mismatchedModels).toEqual([]);
  });

  it("REJECTS reuse after an EMBED_POOLING_MAP flip, and the reindex re-embeds + converges", async () => {
    seed("proj-flip", GTE, 5);
    const store = new LocalVectorStore({ root: tmpDir });

    // Flip pooling for this model on a LIVE deployment (the #792 footgun).
    process.env.EMBED_POOLING_MAP = `${GTE}=mean`;
    const flipped = `${GTE}|mean|q8`;
    expect(resolveEnvIdentity(GTE)).toBe(flipped);

    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8),
      vectorStore: store,
    });

    // The REAL coverage path now reports the bare rows as stale.
    const before = await svc.coverageReport("proj-flip");
    expect(before.currentModel).toBe(flipped);
    expect(before.needsReindex).toBe(true);
    expect(before.matchingChunks).toBe(0);
    expect(before.mismatchedModels).toEqual([GTE]);

    // The reindex actually re-embeds every chunk and retags them to the flipped
    // identity.
    const result = await svc.reindexProject("proj-flip");
    expect(result.embeddedChunks).toBe(5);
    expect(result.previousModels).toEqual([GTE]);

    // Coverage converges: the corpus is now homogeneous at the flipped identity.
    const after = await svc.coverageReport("proj-flip");
    expect(after.needsReindex).toBe(false);
    expect(after.matchingChunks).toBe(5);
    expect(after.mismatchedModels).toEqual([]);
    // And every stored row carries the composite identity, not the bare model id.
    expect(new Set(rows.map((r) => r.embeddingModel))).toEqual(new Set([flipped]));
  });

  it("REJECTS reuse after an EMBED_DTYPE flip", async () => {
    seed("proj-dtype", GTE, 3);
    process.env.EMBED_DTYPE = "fp32";
    const dtypeFlipped = `${GTE}|cls|fp32`;
    expect(resolveEnvIdentity(GTE)).toBe(dtypeFlipped);

    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8),
      vectorStore: new LocalVectorStore({ root: tmpDir }),
    });
    const cov = await svc.coverageReport("proj-dtype");
    expect(cov.currentModel).toBe(dtypeFlipped);
    expect(cov.needsReindex).toBe(true);
    expect(cov.mismatchedModels).toEqual([GTE]);
  });

  it("a redundant EMBED_POOLING_MAP=cls (already the built-in) stays BARE — no needless reindex", async () => {
    // cls IS gte-modernbert's built-in pooling: the vectors are identical, so the
    // identity must remain bare and reuse must be accepted.
    seed("proj-noop", GTE, 2);
    process.env.EMBED_POOLING_MAP = `${GTE}=cls`;
    expect(resolveEnvIdentity(GTE)).toBe(GTE);
    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8),
      vectorStore: new LocalVectorStore({ root: tmpDir }),
    });
    const cov = await svc.coverageReport("proj-noop");
    expect(cov.needsReindex).toBe(false);
    expect(cov.currentModel).toBe(GTE);
  });

  it("catches up SQL membership BEFORE swap at the flipped identity (#99 + #792)", async () => {
    // The sixth row becomes selected only AFTER the snapshot is read. No
    // timestamp filter or fixture-only delta marker decides its visibility.
    seed("proj-delta", GTE, 5);
    const delta: Row = {
      id: "proj-delta-delta",
      projectId: "proj-delta",
      documentId: "proj-delta-doc",
      position: 99,
      text: "a chunk ingested mid-reindex",
      embeddingModel: GTE,
      filename: "f.md",
    };
    process.env.EMBED_POOLING_MAP = `${GTE}=mean`;
    const flipped = `${GTE}|mean|q8`;

    const embedder = identityEmbedder(GTE, 8);
    const store = new LocalVectorStore({ root: tmpDir });
    const realEmbed = embedder.embed.bind(embedder);
    const embed = vi.spyOn(embedder, "embed").mockImplementation(async (texts) => {
      if (!rows.some((row) => row.id === delta.id)) rows.push(delta);
      // This also runs for catch-up: embedding AFTER swap is a regression.
      expect(swap).not.toHaveBeenCalled();
      return realEmbed(texts);
    });
    const realSwap = store.swapTable.bind(store);
    const swap = vi.spyOn(store, "swapTable").mockImplementation(async (id, shadow, guard) => {
      const refs = await store.listChunkRefs(shadow);
      expect(refs.map((ref) => ref.chunkId).sort()).toEqual(rows.map((row) => row.id).sort());
      expect(refs.every((ref) => ref.embeddingModel === flipped)).toBe(true);
      // SQL tags are reconciled only AFTER the complete shadow swaps in.
      expect(rows.every((row) => row.embeddingModel === GTE)).toBe(true);
      await realSwap(id, shadow, guard);
    });
    const svc = new KnowledgeService({
      embedder,
      vectorStore: store,
    });
    const result = await svc.reindexProject("proj-delta");
    // 5 snapshot + 1 membership catch-up, all present at the instant of swap.
    expect(result.totalChunks).toBe(5);
    expect(result.embeddedChunks).toBe(6);
    expect(result.reindexedChunks).toBe(6);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[0][0]).toHaveLength(5);
    expect(embed.mock.calls[1][0]).toEqual([delta.text]);
    expect(swap).toHaveBeenCalledExactlyOnceWith(
      "proj-delta",
      reindexShadowId("proj-delta"),
      expect.anything(),
    );
    expect(rows.find((row) => row.id === delta.id)?.embeddingModel).toBe(flipped);
    expect(rows.every((row) => row.embeddingModel === flipped)).toBe(true);
    const hits = await store.search("proj-delta", new Array<number>(8).fill(1), 6);
    expect(hits.map((hit) => hit.row.id).sort()).toEqual(rows.map((row) => row.id).sort());
    expect(
      hits.every(
        (hit) => hit.row.metadata.embeddingModel === flipped && hit.row.vector.length === 8,
      ),
    ).toBe(true);
    expect(await store.withProjectWrite("proj-delta", (write) => write.readGeneration())).toEqual({
      model: flipped,
      dimension: 8,
      pending: false,
    });
  });

  it("coverageReport keys DOCUMENTS on the identity and SYMBOLS on the model id (#792/#797 split)", async () => {
    // Docs are at the flipped identity (matching); symbols carry the bare model id
    // (their own #797 key). A pooling flip must NOT permanently flag symbols.
    seed("proj-split", `${GTE}|mean|q8`, 2);
    symbolState.totalSymbols = 3;
    symbolState.modelCounts = { [GTE]: 3 }; // symbols keyed on the bare model id
    process.env.EMBED_POOLING_MAP = `${GTE}=mean`;

    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8),
      vectorStore: new LocalVectorStore({ root: tmpDir }),
    });
    const cov = await svc.coverageReport("proj-split");
    expect(cov.currentModel).toBe(`${GTE}|mean|q8`);
    expect(cov.matchingChunks).toBe(2); // docs match the identity
    expect(cov.matchingSymbols).toBe(3); // symbols match the bare model id
    expect(cov.needsReindex).toBe(false); // neither corpus is stale
    expect(cov.mismatchedModels).toEqual([]);
  });

  it("flags a stale SYMBOL corpus while documents are current", async () => {
    seed("proj-sym", GTE, 1); // doc at default identity (bare) → matches
    symbolState.totalSymbols = 2;
    symbolState.modelCounts = { "old-model": 2 }; // symbols on a previous model
    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8),
      vectorStore: new LocalVectorStore({ root: tmpDir }),
    });
    const cov = await svc.coverageReport("proj-sym");
    expect(cov.matchingChunks).toBe(1);
    expect(cov.needsReindex).toBe(true); // driven by the symbol corpus
    expect(cov.mismatchedModels).toEqual(["old-model"]);
  });

  it("deploymentCoverage reports the composite identity as current (#792)", async () => {
    process.env.EMBED_POOLING_MAP = `${GTE}=mean`;
    const flipped = `${GTE}|mean|q8`;
    seed("proj-a", GTE, 2); // stale (bare)
    seed("proj-b", flipped, 3); // current
    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8),
      vectorStore: new LocalVectorStore({ root: tmpDir }),
    });
    const dep = await svc.deploymentCoverage();
    expect(dep.currentModel).toBe(flipped);
    expect(dep.modelCounts[flipped]).toBe(3);
    expect(dep.modelCounts[GTE]).toBe(2);
    const a = dep.projects.find((p) => p.projectId === "proj-a");
    const b = dep.projects.find((p) => p.projectId === "proj-b");
    expect(a?.needsReindex).toBe(true);
    expect(b?.needsReindex).toBe(false);
    expect(dep.projectsNeedingReindex).toBe(1);
  });

  it("retagToActiveModel rewrites every chunk to the composite identity without re-embedding", async () => {
    process.env.EMBED_POOLING_MAP = `${GTE}=mean`;
    const flipped = `${GTE}|mean|q8`;
    seed("proj-retag", GTE, 4); // Prisma rows all on the bare (old) tag
    // #804 — retag only vouches for chunks the store actually holds under the ACTIVE
    // identity. The pg_dump rollback restores vectors that WERE produced by the
    // flipped identity, so seed the store with those (tagged `flipped`); the Prisma
    // tags are the stale `GTE` bare id the forward migration left behind.
    const store = new LocalVectorStore({ root: tmpDir });
    await store.ensureTable("proj-retag");
    await store.upsert(
      "proj-retag",
      rows.map((r) => ({
        id: r.id,
        vector: new Array<number>(8).fill(1),
        metadata: {
          chunkId: r.id,
          documentId: r.documentId,
          filename: r.filename,
          position: r.position,
          text: r.text,
          embeddingModel: flipped,
        },
      })),
    );
    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8),
      vectorStore: store,
    });
    const res = await svc.retagToActiveModel();
    expect(res.model).toBe(flipped);
    expect(res.retagged).toBe(4);
    expect(res.skipped).toBe(0);
    expect(new Set(rows.map((r) => r.embeddingModel))).toEqual(new Set([flipped]));
  });

  it("retagToActiveModel REFUSES a chunk the store has no vector for (#804)", async () => {
    process.env.EMBED_POOLING_MAP = `${GTE}=mean`;
    const flipped = `${GTE}|mean|q8`;
    seed("proj-retag-gap", GTE, 3); // three stale Prisma rows
    // The store only has vectors (under the active identity) for TWO of the three —
    // the third was never embedded, or its vector was dropped by `prepare --force`.
    const store = new LocalVectorStore({ root: tmpDir });
    await store.ensureTable("proj-retag-gap");
    await store.upsert(
      "proj-retag-gap",
      rows.slice(0, 2).map((r) => ({
        id: r.id,
        vector: new Array<number>(8).fill(1),
        metadata: {
          chunkId: r.id,
          documentId: r.documentId,
          filename: r.filename,
          position: r.position,
          text: r.text,
          embeddingModel: flipped,
        },
      })),
    );
    const svc = new KnowledgeService({ embedder: identityEmbedder(GTE, 8), vectorStore: store });

    const res = await svc.retagToActiveModel();
    expect(res.retagged).toBe(2);
    expect(res.skipped).toBe(1);

    // The vectorless chunk keeps its stale tag, so the REAL coverage path still
    // reports the project as needing a reindex — no phantom 100%-healthy index.
    const cov = await svc.coverageReport("proj-retag-gap");
    expect(cov.matchingChunks).toBe(2);
    expect(cov.needsReindex).toBe(true);
    expect(cov.mismatchedModels).toEqual([GTE]);
  });

  it("reindexShadowState reports resumable only when the shadow matches the current identity", async () => {
    seed("proj-shadow", GTE, 2);
    const store = new LocalVectorStore({ root: tmpDir });
    const svc = new KnowledgeService({ embedder: identityEmbedder(GTE, 8), vectorStore: store });
    // No shadow yet → nothing to resume.
    const empty = await svc.reindexShadowState("proj-shadow");
    expect(empty.shadowChunks).toBe(0);
    expect(empty.resumable).toBe(false);
  });

  it("search drops a BM25 sparse-only hit whose stored identity differs from the query's", async () => {
    // The row exists in Prisma tagged with a FOREIGN identity and is absent from the
    // vector store → it arrives only via BM25, and the sparse hydration must filter
    // it out because its identity is not the query's (the #792 filter at :577).
    seed("proj-search", "some-other-model|mean|q8", 1);
    const bm25 = {
      search: async () => [{ chunkId: "proj-search-c0", score: 1 }],
      add: () => {},
      removeDocument: () => {},
      dropProject: () => {},
    } as unknown as BM25Index;
    const svc = new KnowledgeService({
      embedder: identityEmbedder(GTE, 8), // query identity = bare GTE
      vectorStore: new LocalVectorStore({ root: tmpDir }),
      bm25,
    });
    const res = await svc.search("proj-search", "throttle logins", { mode: "hybrid" });
    // Filtered out — its identity is foreign to the query's.
    expect(res.hits).toEqual([]);
  });
});
