/**
 * Issue #804 — `retag` must not vouch for chunks that have no vector.
 *
 * `retagToActiveModel()` is the second half of the `pg_dump` rollback (#796 S2):
 * restore `rag_vectors`, then reconcile the Prisma `embeddingModel` tags to the
 * vectors you put back. The bug: it blanket-`updateMany`d EVERY row whose tag
 * disagreed with the active model, with NO join against the store. A chunk with a
 * Prisma row but no vector at all — never embedded, or its vector dropped by
 * `prepare --force` — got stamped "current". Because `coverageReport()` /
 * `deploymentCoverage()` are computed FROM the tags, coverage then reported a
 * 100%-healthy index that did not exist; dense retrieval returned nothing for
 * those chunks and BM25 masked it.
 *
 * The fix intersects the candidates with what `store.listChunkRefs()` actually
 * holds, UNDER THE ACTIVE IDENTITY (#792), stamps only those, and reports the
 * count it refused. These tests prove the bug end-to-end through coverage: a
 * vectorless chunk is NOT reported as covered after a retag, and the refusal is
 * surfaced to the operator.
 *
 * ## Main-vs-fix evidence
 *
 * Run against the PRE-#804 source, the "leaves a vectorless chunk uncovered" test
 * FAILS at `expect(after.matchingChunks).toBe(2)` (main stamps all three, so it is
 * 3) and at `expect(after.needsReindex).toBe(true)` (main reports false — the
 * phantom 100%). `result.skipped` is also `undefined` on main.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { LocalVectorStore, type VectorStore } from "./vector-store.js";
import { KnowledgeService } from "./knowledge-service.js";
import type { Embedder } from "./embedder.js";

const PROJECT = "proj_retag_804";
const OLD_MODEL = "Xenova/bge-small-en-v1.5"; // the rollback TARGET == active model
const NEW_MODEL = "Alibaba-NLP/gte-modernbert-base"; // the bad forward tag

// ---- In-memory Prisma over KnowledgeChunk ---------------------------------
// A real store (not just a spy) so the retag → coverage round-trip is genuine:
// `updateMany` mutates the rows, `groupBy` reports what `retag` actually left
// behind. This is what lets one test span retag AND coverageReport.
interface Row {
  id: string;
  projectId: string;
  embeddingModel: string;
}
let rows: Row[] = [];

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  if (typeof where.projectId === "string" && row.projectId !== where.projectId) return false;
  const em = where.embeddingModel as { not?: string } | string | undefined;
  if (typeof em === "string" && row.embeddingModel !== em) return false;
  if (em && typeof em === "object" && "not" in em && row.embeddingModel === em.not) return false;
  const id = where.id as { in?: string[] } | undefined;
  if (id?.in && !id.in.includes(row.id)) return false;
  return true;
}

const mockKnowledgeChunk = {
  findMany: vi.fn((args: { where?: Record<string, unknown> }) =>
    Promise.resolve(rows.filter((r) => matches(r, args?.where)).map((r) => ({ ...r }))),
  ),
  updateMany: vi.fn(
    (args: { where?: Record<string, unknown>; data: { embeddingModel: string } }) => {
      let count = 0;
      for (const r of rows) {
        if (matches(r, args.where)) {
          r.embeddingModel = args.data.embeddingModel;
          count += 1;
        }
      }
      return Promise.resolve({ count });
    },
  ),
  groupBy: vi.fn((args: { where?: Record<string, unknown> }) => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (matches(r, args?.where))
        counts.set(r.embeddingModel, (counts.get(r.embeddingModel) ?? 0) + 1);
    }
    return Promise.resolve(
      [...counts].map(([embeddingModel, n]) => ({ embeddingModel, _count: { _all: n } })),
    );
  }),
};

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
    $transaction: (fn: (tx: { knowledgeChunk: typeof mockKnowledgeChunk }) => Promise<unknown>) =>
      fn({ knowledgeChunk: mockKnowledgeChunk }),
    knowledgeChunk: {
      findMany: (...a: unknown[]) => mockKnowledgeChunk.findMany(...(a as [never])),
      updateMany: (...a: unknown[]) => mockKnowledgeChunk.updateMany(...(a as [never])),
      groupBy: (...a: unknown[]) => mockKnowledgeChunk.groupBy(...(a as [never])),
    },
  },
}));

function makeEmbedder(model = OLD_MODEL): Embedder {
  return {
    model,
    dimension: 4,
    embed: async () => {
      throw new Error("retag must not embed");
    },
  } as unknown as Embedder;
}

function makeStore(): { store: VectorStore; root: string } {
  const root = path.join(os.tmpdir(), `retag804-${Math.random().toString(36).slice(2)}`);
  return { store: new LocalVectorStore({ root }), root };
}

/** Put a live vector for `chunkId` into the store, tagged `model`. */
async function seedVector(store: VectorStore, chunkId: string, model: string): Promise<void> {
  await store.ensureTable(PROJECT);
  await store.upsert(PROJECT, [
    {
      id: chunkId,
      vector: [1, 1, 1, 1],
      metadata: {
        chunkId,
        documentId: "doc1",
        filename: "doc1.md",
        position: 0,
        text: `text ${chunkId}`,
        embeddingModel: model,
      },
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DATABASE_URL;
});

describe("retagToActiveModel — #804: only stamp chunks that have a vector", () => {
  it.each([
    { name: "wrong dimension", model: OLD_MODEL, vector: [1, 2] },
    { name: "wrong model with equal dimensions", model: NEW_MODEL, vector: [1, 2, 3, 4] },
    { name: "absent vector", model: OLD_MODEL, vector: null },
  ])("does not bless a restored corpus with $name", async ({ model, vector }) => {
    const { store, root } = makeStore();
    rows = [{ id: "c1", projectId: PROJECT, embeddingModel: NEW_MODEL }];
    const previous = { model: NEW_MODEL, dimension: 4, pending: true };
    await store.withProjectWrite!(PROJECT, (write) => write.writeGeneration(previous));
    if (vector)
      await store.upsert(PROJECT, [
        {
          id: "c1",
          vector,
          metadata: {
            chunkId: "c1",
            documentId: "doc1",
            filename: "doc1.md",
            position: 0,
            text: "alpha",
            embeddingModel: model,
          },
        },
      ]);
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });
    expect(await svc.retagToActiveModel()).toMatchObject({ retagged: 0, skipped: 1 });
    expect(rows[0].embeddingModel).toBe(NEW_MODEL);
    expect(await store.withProjectWrite!(PROJECT, (write) => write.readGeneration())).toEqual(
      previous,
    );
    expect(mockKnowledgeChunk.updateMany).not.toHaveBeenCalled();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("repairs the descriptor on retry even when SQL tags already committed", async () => {
    const { store, root } = makeStore();
    rows = [{ id: "c1", projectId: PROJECT, embeddingModel: NEW_MODEL }];
    await seedVector(store, "c1", OLD_MODEL);
    const coordinated = store.withProjectWrite!.bind(store);
    vi.spyOn(store, "withProjectWrite").mockImplementationOnce((id, fn) =>
      coordinated(id, (write) =>
        fn({
          ...write,
          async writeGeneration(value) {
            if (!value.pending) throw new Error("descriptor finalize failed");
            await write.writeGeneration(value);
          },
        }),
      ),
    );
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });
    await expect(svc.retagToActiveModel()).rejects.toThrow("descriptor finalize failed");
    expect(rows[0].embeddingModel).toBe(OLD_MODEL);
    expect(await coordinated(PROJECT, (write) => write.readGeneration())).toMatchObject({
      pending: true,
    });
    expect(await svc.retagToActiveModel()).toMatchObject({ retagged: 0, skipped: 0 });
    expect(await coordinated(PROJECT, (write) => write.readGeneration())).toEqual({
      model: OLD_MODEL,
      dimension: 4,
      pending: false,
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("leaves a vectorless chunk uncovered and reports it as skipped (end-to-end through coverage)", async () => {
    const { store, root } = makeStore();
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });

    // Post-restore state: every Prisma row still carries the bad forward tag.
    rows = [
      { id: "c1", projectId: PROJECT, embeddingModel: NEW_MODEL },
      { id: "c2", projectId: PROJECT, embeddingModel: NEW_MODEL },
      { id: "c3", projectId: PROJECT, embeddingModel: NEW_MODEL }, // NEVER embedded
    ];
    // The dump restored vectors for c1 and c2 (tagged OLD_MODEL == active), but c3
    // has no vector at all — the row exists, the vector never did.
    await seedVector(store, "c1", OLD_MODEL);
    await seedVector(store, "c2", OLD_MODEL);

    // BEFORE: coverage sees three chunks, none on the active model, reindex owed.
    const before = await svc.coverageReport(PROJECT);
    expect(before.matchingChunks).toBe(0);
    expect(before.needsReindex).toBe(true);

    const result = await svc.retagToActiveModel();

    // The refusal is operator-visible via the return value: two vouched, one owed.
    expect(result).toEqual({ model: OLD_MODEL, retagged: 2, skipped: 1, retaggedSymbols: 0 });
    // Only the vectored ids were stamped — never c3.
    expect(mockKnowledgeChunk.updateMany).toHaveBeenCalledWith({
      where: { projectId: PROJECT, id: { in: ["c1", "c2"] }, embeddingModel: { not: OLD_MODEL } },
      data: { embeddingModel: OLD_MODEL },
    });
    expect(rows.find((r) => r.id === "c3")?.embeddingModel).toBe(NEW_MODEL);

    // AFTER (the load-bearing assertions — these are what FAIL on `main`, where the
    // blanket updateMany stamps c3 too and coverage then reports 3/3, needsReindex
    // false: a 100%-healthy index that does not exist).
    const after = await svc.coverageReport(PROJECT);
    expect(after.matchingChunks).toBe(2);
    expect(after.totalChunks).toBe(3);
    expect(after.modelCounts).toEqual({ [OLD_MODEL]: 2, [NEW_MODEL]: 1 });
    expect(after.needsReindex).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses a chunk whose vector is from a DIFFERENT generation (#792 identity intersection)", async () => {
    const { store, root } = makeStore();
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });

    rows = [
      { id: "c1", projectId: PROJECT, embeddingModel: NEW_MODEL }, // vector on OLD == active
      { id: "c4", projectId: PROJECT, embeddingModel: NEW_MODEL }, // vector on NEW != active
    ];
    await seedVector(store, "c1", OLD_MODEL);
    await seedVector(store, "c4", NEW_MODEL); // a vector, but the WRONG generation

    const result = await svc.retagToActiveModel();

    // c4 HAS a vector, so a presence-only check would wrongly vouch for it. Because
    // the store vector is tagged NEW_MODEL and the active identity is OLD_MODEL, it
    // is refused — the retag only claims vectors actually produced by the active
    // model. This is the #792 half of the fix.
    expect(result).toMatchObject({ model: OLD_MODEL, retagged: 1, skipped: 1 });
    expect(mockKnowledgeChunk.updateMany).toHaveBeenCalledWith({
      where: { projectId: PROJECT, id: { in: ["c1"] }, embeddingModel: { not: OLD_MODEL } },
      data: { embeddingModel: OLD_MODEL },
    });

    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses an ENTIRE project's chunks when its vector table cannot be read", async () => {
    const failing: VectorStore = {
      ...new LocalVectorStore({ root: path.join(os.tmpdir(), `retag804-x`) }),
      listChunkRefs: async () => {
        throw new Error("store unreachable");
      },
    } as unknown as VectorStore;
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: failing });

    rows = [
      { id: "c1", projectId: PROJECT, embeddingModel: NEW_MODEL },
      { id: "c2", projectId: PROJECT, embeddingModel: NEW_MODEL },
    ];

    const result = await svc.retagToActiveModel();

    // Cannot confirm any vector exists, so vouch for nothing: all refused, none
    // stamped. Fail closed — never stamp vectors we could not read.
    expect(result).toMatchObject({ model: OLD_MODEL, retagged: 0, skipped: 2 });
    expect(mockKnowledgeChunk.updateMany).not.toHaveBeenCalled();
  });

  it("stamps nothing and skips nothing when every tag already matches", async () => {
    const { store, root } = makeStore();
    const svc = new KnowledgeService({ embedder: makeEmbedder(), vectorStore: store });
    rows = [{ id: "c1", projectId: PROJECT, embeddingModel: OLD_MODEL }];
    await seedVector(store, "c1", OLD_MODEL);

    const result = await svc.retagToActiveModel();

    expect(result).toEqual({ model: OLD_MODEL, retagged: 0, skipped: 0, retaggedSymbols: 0 });
    expect(mockKnowledgeChunk.updateMany).not.toHaveBeenCalled();

    await fs.rm(root, { recursive: true, force: true });
  });
});
