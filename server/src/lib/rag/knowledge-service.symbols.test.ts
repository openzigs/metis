/**
 * Epic #780 / Issue #797 — `KnowledgeService` must migrate BOTH corpora.
 *
 * The failure this guards against is quiet and expensive: an operator flips
 * `EMBED_MODEL`, runs `pnpm embed-migrate reindex --all`, sees a green
 * fully-migrated deployment — and every code-symbol vector is still on the old
 * generation, where the model-tag filter ignores it. `search_code_symbols` then
 * falls silently back to its BM25 branch, i.e. straight back into the #797 defect
 * the reindex was supposed to have preserved us out of.
 *
 * So: symbols are counted in coverage, re-embedded in reindex, dropped on archive,
 * and retagged on rollback — or these tests fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeService } from "./knowledge-service.js";
import type { Embedder } from "./embedder.js";
import type { VectorStore } from "./vector-store.js";
import type {
  SymbolEmbeddingsPort,
  SymbolReindexResult,
} from "../code-graph/symbol-embedding-service.js";

const mockKnowledgeChunk = {
  findMany: vi.fn(),
  updateMany: vi.fn(),
  groupBy: vi.fn(),
};
// Document cutover completes transactionally before the symbol phase starts.
const mockTransactionClient = {
  knowledgeChunk: {
    findMany: vi.fn((...args: unknown[]) => mockKnowledgeChunk.findMany(...args)),
    updateMany: vi.fn((...args: unknown[]) => mockKnowledgeChunk.updateMany(...args)),
  },
};
const mockTransaction = vi.fn(async (fn: (tx: typeof mockTransactionClient) => Promise<unknown>) =>
  fn(mockTransactionClient),
);

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

const MODEL = "gte-modernbert";
const OLD = "bge-small";

function embedder(): Embedder {
  return {
    model: MODEL,
    dimension: 768,
    embed: async (texts: string[]) => ({
      vectors: texts.map(() => [1, 2, 3]),
      model: MODEL,
      dimension: 768,
    }),
  } as unknown as Embedder;
}

function store(): VectorStore {
  return {
    ensureTable: vi.fn(async () => {}),
    dropTable: vi.fn(async () => {}),
    swapTable: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    deleteByDocument: vi.fn(async () => 0),
    deleteByChunkIds: vi.fn(async () => 0),
    count: vi.fn(async () => 0),
    search: vi.fn(async () => []),
    modelCoverage: vi.fn(async () => ({ totalChunks: 0, modelCounts: {} })),
    listChunkRefs: vi.fn(async () => []),
  } as unknown as VectorStore;
}

function symbolPort(over: Partial<SymbolEmbeddingsPort> = {}): SymbolEmbeddingsPort {
  return {
    coverage: vi.fn(async () => ({ totalSymbols: 0, modelCounts: {} })),
    deploymentCoverage: vi.fn(async () => new Map<string, Record<string, number>>()),
    reindexProject: vi.fn(
      async (projectId: string): Promise<SymbolReindexResult> => ({
        projectId,
        totalSymbols: 0,
        resumedSymbols: 0,
        embeddedSymbols: 0,
        currentModel: MODEL,
      }),
    ),
    dropProject: vi.fn(async () => {}),
    retagToActiveModel: vi.fn(async () => 0),
    isBusy: vi.fn(() => false),
    ...over,
  };
}

/** A `ReindexFence`-shaped argument — what phase 2 and the archive drop MUST be handed. */
function isFence(value: unknown): boolean {
  const f = value as { renew?: unknown; assertHeld?: unknown; holder?: unknown } | undefined;
  return (
    typeof f?.renew === "function" &&
    typeof f.assertHeld === "function" &&
    typeof f.holder === "string"
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DATABASE_URL;
  mockKnowledgeChunk.findMany.mockResolvedValue([]);
  mockKnowledgeChunk.updateMany.mockResolvedValue({ count: 0 });
  mockKnowledgeChunk.groupBy.mockResolvedValue([]);
});

describe("coverageReport", () => {
  it("flags a reindex when only the SYMBOLS are stale, even with zero documents", async () => {
    const symbols = symbolPort({
      coverage: vi.fn(async () => ({ totalSymbols: 40, modelCounts: { [OLD]: 40 } })),
    });
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: store(),
      symbolEmbeddings: symbols,
    });

    const report = await svc.coverageReport("p1");

    // A repo-only project has no KnowledgeChunk at all. Counting documents alone
    // would call this deployment fully migrated.
    expect(report.totalChunks).toBe(0);
    expect(report.totalSymbols).toBe(40);
    expect(report.matchingSymbols).toBe(0);
    expect(report.needsReindex).toBe(true);
    expect(report.mismatchedModels).toContain(OLD);
  });

  it("counts PENDING symbols as needing work", async () => {
    const symbols = symbolPort({
      // "" = a row ingest wrote whose vector the background job has not computed.
      coverage: vi.fn(async () => ({ totalSymbols: 5, modelCounts: { "": 5 } })),
    });
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: store(),
      symbolEmbeddings: symbols,
    });

    const report = await svc.coverageReport("p1");
    expect(report.needsReindex).toBe(true);
    expect(report.symbolModelCounts).toEqual({ "": 5 });
  });
});

describe("deploymentCoverage", () => {
  it("includes projects that have symbols but no documents", async () => {
    const symbols = symbolPort({
      deploymentCoverage: vi.fn(async () => new Map([["repo-only", { [OLD]: 12 }]])),
    });
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: store(),
      symbolEmbeddings: symbols,
    });

    const coverage = await svc.deploymentCoverage();

    // `reindexAll` drives off this list. Omit the project here and its symbol
    // vectors stay on the old model forever, with nothing reporting it.
    const project = coverage.projects.find((p) => p.projectId === "repo-only");
    expect(project).toBeDefined();
    expect(project?.totalSymbols).toBe(12);
    expect(project?.needsReindex).toBe(true);
    expect(coverage.totalSymbols).toBe(12);
    expect(coverage.projectsNeedingReindex).toBe(1);
  });
});

describe("reindexProject", () => {
  it("runs the symbol reindex as phase 2, HANDING IT THE LEASE (not merely nesting it)", async () => {
    const reindexProject = vi.fn(
      async (projectId: string): Promise<SymbolReindexResult> => ({
        projectId,
        totalSymbols: 200,
        resumedSymbols: 0,
        embeddedSymbols: 200,
        currentModel: MODEL,
      }),
    );
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: store(),
      symbolEmbeddings: symbolPort({ reindexProject }),
    });

    const result = await svc.reindexProject("p1", { batchSize: 64, fresh: true });

    // PR #803 review (D1). Lexical nesting inside the leased closure buys ORDERING and
    // no fencing whatsoever: phase 2 can only re-prove ownership before it mutates if it
    // is actually GIVEN the fencing token. So the third argument is the assertion.
    expect(reindexProject).toHaveBeenCalledWith(
      "p1",
      { batchSize: 64, fresh: true },
      expect.anything(),
    );
    expect(isFence(reindexProject.mock.calls[0]?.[2])).toBe(true);
    expect(result.symbols).toMatchObject({ totalSymbols: 200, embeddedSymbols: 200 });
  });

  it("reports no symbol phase when the project has none", async () => {
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: store(),
      symbolEmbeddings: symbolPort(),
    });
    const result = await svc.reindexProject("p1");
    expect(result.symbols).toBeNull();
  });

  it("propagates a symbol-reindex failure rather than reporting a clean migration", async () => {
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: store(),
      symbolEmbeddings: symbolPort({
        reindexProject: vi.fn(async () => {
          throw new Error("embedder died");
        }),
      }),
    });

    // The documents swapped fine. Swallowing this would tell the operator the
    // migration succeeded while half the corpus is still on the old model.
    await expect(svc.reindexProject("p1")).rejects.toThrow("embedder died");
  });
});

describe("dropProject + retagToActiveModel", () => {
  it("drops the project's symbol vectors alongside its document vectors", async () => {
    const symbols = symbolPort();
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: store(),
      symbolEmbeddings: symbols,
      bm25: { dropProject: vi.fn() } as never,
    });

    await svc.dropProject("p1");
    // The archive force-takes the lease; the drop must be handed it, so the symbol side is
    // acting under the SAME fence the document drop is (PR #803 review, D2).
    expect(symbols.dropProject).toHaveBeenCalledWith("p1", expect.anything());
    expect(isFence(vi.mocked(symbols.dropProject).mock.calls[0]?.[1])).toBe(true);
  });

  it("refuses a reindex while this pod is embedding the project's symbols", async () => {
    // PR #803 review (D3). The old advisory lock threw from INSIDE phase 2 — after the
    // document swap and retag had committed — which is how a leaked lock produced a
    // permanently half-migrated project. Refuse at the door instead.
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: store(),
      symbolEmbeddings: symbolPort({ isBusy: vi.fn(() => true) }),
    });

    await expect(svc.reindexProject("p1")).rejects.toThrow(/already in progress/);
    expect(mockKnowledgeChunk.findMany).not.toHaveBeenCalled();
  });

  it("retags symbol rows too — the pg_dump rollback restores both corpora", async () => {
    // #804 — the document retag now only stamps chunks the store vouches for, so
    // seed 42 candidate rows AND 42 live vectors under the active identity.
    const ids = Array.from({ length: 42 }, (_, i) => `c${i}`);
    mockKnowledgeChunk.findMany.mockResolvedValue(ids.map((id) => ({ id, projectId: "p1" })));
    mockKnowledgeChunk.updateMany.mockImplementation(
      (args: { where: { id: { in: string[] } } }) => ({ count: args.where.id.in.length }),
    );
    const vouchingStore = store();
    (vouchingStore.listChunkRefs as ReturnType<typeof vi.fn>).mockResolvedValue(
      ids.map((id) => ({ chunkId: id, embeddingModel: MODEL })),
    );
    const symbols = symbolPort({ retagToActiveModel: vi.fn(async () => 7) });
    const svc = new KnowledgeService({
      embedder: embedder(),
      vectorStore: vouchingStore,
      symbolEmbeddings: symbols,
    });

    const result = await svc.retagToActiveModel();

    expect(result).toEqual({ model: MODEL, retagged: 42, skipped: 0, retaggedSymbols: 7 });
  });
});
