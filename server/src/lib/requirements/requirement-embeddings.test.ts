/**
 * Issue #1835 — the writer-side enqueue (debounced, switchable, never throwing)
 * and the reconcile's failure handling. The read/write behaviour over real
 * stores and a real database is in tests/requirement-embeddings-1835.sqlite.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirementFindMany: vi.fn(),
  embeddingFindMany: vi.fn(),
  embeddingUpsert: vi.fn(),
  embeddingDeleteMany: vi.fn(),
  listChunkRefs: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: { findMany: mocks.requirementFindMany },
    requirementEmbedding: {
      findMany: mocks.embeddingFindMany,
      upsert: mocks.embeddingUpsert,
      deleteMany: mocks.embeddingDeleteMany,
    },
  },
}));
vi.mock("../rag/vector-store.js", () => ({
  getVectorStore: () => ({
    listChunkRefs: mocks.listChunkRefs,
    ensureTable: vi.fn(),
    upsert: vi.fn(),
    deleteByChunkIds: vi.fn(),
    dropTable: vi.fn(),
  }),
}));
vi.mock("../rag/embedder.js", () => ({
  getEmbedder: () => ({
    model: "m",
    embed: async (texts: string[]) => ({
      vectors: texts.map(() => [1, 0]),
      model: "m",
      dimension: 2,
    }),
  }),
}));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn: mocks.warn, info: vi.fn() }),
}));

import {
  __cancelRequirementSyncTimers,
  enqueueRequirementEmbeddingSync,
  enqueueRequirementEmbeddingSyncFor,
  REQUIREMENT_SYNC_DEBOUNCE_MS,
  requirementContentHash,
  requirementSyncOnWriteEnabled,
  syncRequirementEmbeddings,
} from "./requirement-embeddings.js";

const ON = "REQUIREMENT_EMBEDDINGS_SYNC_ON_WRITE";
let saved: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  saved = process.env[ON];
  process.env[ON] = "1";
  mocks.requirementFindMany.mockReset().mockResolvedValue([]);
  mocks.embeddingFindMany.mockReset().mockResolvedValue([]);
  mocks.embeddingUpsert.mockReset().mockResolvedValue({});
  mocks.embeddingDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  mocks.listChunkRefs.mockReset().mockResolvedValue([]);
  mocks.warn.mockReset();
});

afterEach(() => {
  __cancelRequirementSyncTimers();
  vi.useRealTimers();
  if (saved === undefined) delete process.env[ON];
  else process.env[ON] = saved;
});

/** How many reconciles have read the project's requirements. */
const reconciles = (projectId: string) =>
  mocks.requirementFindMany.mock.calls.filter(
    ([args]) => (args as { where: { projectId?: string } }).where.projectId === projectId,
  ).length;

describe("enqueueRequirementEmbeddingSync", () => {
  it("runs ONE reconcile after a burst of writes settles", async () => {
    enqueueRequirementEmbeddingSync("p1");
    await vi.advanceTimersByTimeAsync(REQUIREMENT_SYNC_DEBOUNCE_MS - 1);
    enqueueRequirementEmbeddingSync("p1");
    await vi.advanceTimersByTimeAsync(REQUIREMENT_SYNC_DEBOUNCE_MS - 1);
    expect(reconciles("p1")).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconciles("p1")).toBe(1);
  });

  it("does nothing when switched off", async () => {
    for (const off of ["0", "false", "OFF"]) {
      process.env[ON] = off;
      expect(requirementSyncOnWriteEnabled()).toBe(false);
      enqueueRequirementEmbeddingSync("p1");
      enqueueRequirementEmbeddingSyncFor(["r1"]);
    }
    await vi.advanceTimersByTimeAsync(REQUIREMENT_SYNC_DEBOUNCE_MS * 2);
    expect(mocks.requirementFindMany).not.toHaveBeenCalled();
  });

  it("is on by default", () => {
    delete process.env[ON];
    expect(requirementSyncOnWriteEnabled()).toBe(true);
  });

  it("logs a failed reconcile instead of throwing", async () => {
    mocks.requirementFindMany.mockRejectedValue(new Error("db down"));
    enqueueRequirementEmbeddingSync("p1");
    await vi.advanceTimersByTimeAsync(REQUIREMENT_SYNC_DEBOUNCE_MS);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("reconcile failed"),
      expect.objectContaining({ projectId: "p1", error: "db down" }),
    );
  });
});

describe("enqueueRequirementEmbeddingSyncFor", () => {
  it("resolves each requirement's project and reconciles each project once", async () => {
    mocks.requirementFindMany.mockImplementation(async (args: { where: { id?: unknown } }) =>
      args.where.id ? [{ projectId: "p1" }, { projectId: "p1" }, { projectId: "p2" }] : [],
    );
    enqueueRequirementEmbeddingSyncFor(["r1", "r2", "r2", "r3"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.requirementFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1", "r2", "r3"] } },
      select: { projectId: true },
    });
    await vi.advanceTimersByTimeAsync(REQUIREMENT_SYNC_DEBOUNCE_MS);
    expect(reconciles("p1")).toBe(1);
    expect(reconciles("p2")).toBe(1);
  });

  it("does nothing for no ids, and logs a failed lookup", async () => {
    enqueueRequirementEmbeddingSyncFor([]);
    expect(mocks.requirementFindMany).not.toHaveBeenCalled();
    mocks.requirementFindMany.mockRejectedValue(new Error("db down"));
    enqueueRequirementEmbeddingSyncFor(["r1"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not resolve"),
      expect.objectContaining({ error: "db down" }),
    );
  });
});

describe("syncRequirementEmbeddings", () => {
  it("rejects an embedder that returns the wrong number of vectors, and writes no bookkeeping", async () => {
    mocks.requirementFindMany.mockResolvedValue([
      { id: "r1", title: "A", body: "a", acceptanceCriteria: "[]" },
      { id: "r2", title: "B", body: "b", acceptanceCriteria: "[]" },
    ]);
    const embedService = { embed: async () => ({ vectors: [[1, 0]], model: "m", dimension: 2 }) };
    await expect(syncRequirementEmbeddings("p1", { embedService })).rejects.toThrow(
      /returned 1 vectors for 2 requirements/,
    );
    expect(mocks.embeddingUpsert).not.toHaveBeenCalled();
  });

  it("serialises reconciles of one project, and a failed one does not block the next", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    mocks.requirementFindMany
      .mockImplementationOnce(async () => {
        order.push("first:start");
        await gate;
        order.push("first:end");
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => {
        order.push("second");
        return [];
      });
    const first = syncRequirementEmbeddings("p1");
    const second = syncRequirementEmbeddings("p1");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["first:start"]);
    release();
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toMatchObject({ embedded: 0, deleted: 0 });
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("hashes the model with the text, so a model change changes the hash", () => {
    expect(requirementContentHash("a", "text")).not.toBe(requirementContentHash("b", "text"));
    expect(requirementContentHash("a", "text")).toBe(requirementContentHash("a", "text"));
  });
});
