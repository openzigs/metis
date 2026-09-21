/**
 * BM25 sparse index + reciprocal rank fusion tests (issue #131).
 *
 * Mocks Prisma so the lazy load returns the chunks we seed, then asserts
 * the index ranks lexically-relevant chunks first and that RRF combines
 * dense + sparse lists in the documented way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockChunk {
  id: string;
  projectId: string;
  documentId: string;
  position: number;
  text: string;
}

const chunks: MockChunk[] = [];
const documents: { id: string; projectId: string; filename: string; deletedAt: Date | null }[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    knowledgeChunk: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) =>
        chunks.filter((c) => c.projectId === where.projectId),
      ),
    },
    document: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string; deletedAt: null } }) =>
        documents.filter((d) => d.projectId === where.projectId && d.deletedAt == null),
      ),
    },
  },
}));

import {
  BM25Index,
  __resetBM25IndexSingleton,
  getBM25Index,
  reciprocalRankFusion,
} from "../src/lib/rag/bm25-index.js";

beforeEach(() => {
  chunks.length = 0;
  documents.length = 0;
  __resetBM25IndexSingleton();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BM25Index", () => {
  it("lazy-loads chunks on first search and ranks lexical matches first", async () => {
    documents.push({ id: "d1", projectId: "p1", filename: "a.md", deletedAt: null });
    documents.push({ id: "d2", projectId: "p1", filename: "b.md", deletedAt: null });
    chunks.push({
      id: "c1",
      projectId: "p1",
      documentId: "d1",
      position: 0,
      text: "Reciprocal rank fusion combines dense and sparse retrievers.",
    });
    chunks.push({
      id: "c2",
      projectId: "p1",
      documentId: "d2",
      position: 0,
      text: "The vector store uses cosine similarity for nearest-neighbour search.",
    });
    chunks.push({
      id: "c3",
      projectId: "p1",
      documentId: "d2",
      position: 1,
      text: "An unrelated paragraph about settlements and forecasts.",
    });

    const idx = new BM25Index();
    const hits = await idx.search("p1", "rank fusion sparse", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunkId).toBe("c1");
  });

  it("returns [] for empty / whitespace queries", async () => {
    const idx = new BM25Index();
    expect(await idx.search("p1", "", 5)).toEqual([]);
    expect(await idx.search("p1", "   ", 5)).toEqual([]);
  });

  it("upsertDocumentChunks replaces prior chunks for the document", async () => {
    documents.push({ id: "d1", projectId: "p1", filename: "a.md", deletedAt: null });
    chunks.push({
      id: "c1",
      projectId: "p1",
      documentId: "d1",
      position: 0,
      text: "alpha alpha alpha",
    });
    const idx = new BM25Index();
    await idx.ensureProject("p1");
    expect((await idx.search("p1", "alpha", 5)).length).toBe(1);
    await idx.upsertDocumentChunks("p1", "d1", "a.md", [
      { id: "c1-new", position: 0, text: "beta beta beta" },
    ]);
    expect((await idx.search("p1", "alpha", 5)).length).toBe(0);
    const beta = await idx.search("p1", "beta", 5);
    expect(beta.map((h) => h.chunkId)).toEqual(["c1-new"]);
  });

  it("removeDocument drops every chunk for the document", async () => {
    documents.push({ id: "d1", projectId: "p1", filename: "a.md", deletedAt: null });
    chunks.push(
      { id: "c1", projectId: "p1", documentId: "d1", position: 0, text: "alpha alpha" },
      { id: "c2", projectId: "p1", documentId: "d1", position: 1, text: "alpha bravo" },
    );
    const idx = new BM25Index();
    await idx.ensureProject("p1");
    expect((await idx.search("p1", "alpha", 5)).length).toBe(2);
    await idx.removeDocument("p1", "d1");
    expect((await idx.search("p1", "alpha", 5)).length).toBe(0);
  });

  it("dropProject discards the entire index", async () => {
    documents.push({ id: "d1", projectId: "p1", filename: "a.md", deletedAt: null });
    chunks.push({
      id: "c1",
      projectId: "p1",
      documentId: "d1",
      position: 0,
      text: "alpha",
    });
    const idx = new BM25Index();
    await idx.ensureProject("p1");
    idx.dropProject("p1");
    // After drop, the next ensureProject re-loads from prisma.
    chunks.length = 0;
    expect((await idx.search("p1", "alpha", 5)).length).toBe(0);
  });

  it("getBM25Index() returns a singleton until reset", () => {
    const a = getBM25Index();
    const b = getBM25Index();
    expect(a).toBe(b);
    __resetBM25IndexSingleton();
    const c = getBM25Index();
    expect(c).not.toBe(a);
  });
});

describe("reciprocalRankFusion", () => {
  it("ranks documents that appear in multiple lists higher than singletons", () => {
    const dense = [{ chunkId: "a" }, { chunkId: "b" }, { chunkId: "c" }];
    const sparse = [{ chunkId: "c" }, { chunkId: "a" }, { chunkId: "d" }];
    const fused = reciprocalRankFusion([dense, sparse]);
    expect(
      fused
        .map((f) => f.chunkId)
        .slice(0, 2)
        .sort(),
    ).toEqual(["a", "c"]);
  });

  it("uses k=60 by default and respects topK truncation", () => {
    const dense = Array.from({ length: 20 }, (_, i) => ({ chunkId: `d${i}` }));
    const sparse = Array.from({ length: 20 }, (_, i) => ({ chunkId: `s${i}` }));
    const fused = reciprocalRankFusion([dense, sparse], { topK: 5 });
    expect(fused.length).toBe(5);
    // Default k = 60 → first item score = 1/(60+1) ≈ 0.01639
    expect(fused[0].score).toBeCloseTo(1 / 61, 4);
  });

  it("supports a custom k parameter", () => {
    const a = reciprocalRankFusion([[{ chunkId: "x" }]], { k: 10 });
    expect(a[0].score).toBeCloseTo(1 / 11, 4);
  });

  it("returns [] for no input lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});
