/**
 * Vector store tests (Phase 5 / issue #42).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalVectorStore, cosineSimilarity, type VectorRow } from "../src/lib/rag/vector-store.js";

let root: string;
let store: LocalVectorStore;

function row(id: string, vec: number[], extra: Partial<VectorRow["metadata"]> = {}): VectorRow {
  return {
    id,
    vector: vec,
    metadata: {
      chunkId: id,
      documentId: extra.documentId ?? "doc-1",
      filename: extra.filename ?? "f.md",
      position: extra.position ?? 0,
      text: extra.text ?? id,
      embeddingModel: "metis-offline-hash-v1",
      ...extra,
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-vec-"));
  store = new LocalVectorStore({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("cosineSimilarity", () => {
  it("equals 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });
  it("equals 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("equals -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it("returns 0 for zero-norm vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/length mismatch/);
  });
});

describe("LocalVectorStore", () => {
  it("ensureTable creates an empty table file", async () => {
    await store.ensureTable("p1");
    const file = path.join(root, "p1", "table.json");
    const stat = await fs.stat(file);
    expect(stat.isFile()).toBe(true);
    expect(await store.count("p1")).toBe(0);
  });

  it("upsert + count round-trip", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0]), row("b", [0, 1, 0])]);
    expect(await store.count("p1")).toBe(2);
  });

  it("lists each persisted vector's actual width even with same-model mixed dimensions", async () => {
    await store.upsert("p1", [row("a", [1, 2, 3])]);
    await store.upsert("p1", [row("b", [4, 5])]);
    const reopened = new LocalVectorStore({ root, dimension: 99 });
    expect(await reopened.listChunkRefs("p1")).toEqual([
      { chunkId: "a", embeddingModel: "metis-offline-hash-v1", dimension: 3 },
      { chunkId: "b", embeddingModel: "metis-offline-hash-v1", dimension: 2 },
    ]);
  });

  it.each([undefined, null, [], { length: 3 }])(
    "reports invalid persisted vector evidence instead of a configured width: %j",
    async (vector) => {
      await store.ensureTable("p1");
      await fs.writeFile(
        path.join(root, "p1", "table.json"),
        JSON.stringify([{ ...row("a", []), vector }]),
      );
      expect(await new LocalVectorStore({ root, dimension: 3 }).listChunkRefs("p1")).toEqual([
        { chunkId: "a", embeddingModel: "metis-offline-hash-v1", dimension: 0 },
      ]);
    },
  );

  it("upsert overwrites by id (no duplicates)", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0])]);
    await store.upsert("p1", [row("a", [0, 1, 0], { text: "updated" })]);
    expect(await store.count("p1")).toBe(1);
    const hits = await store.search("p1", [0, 1, 0], 1);
    expect(hits[0].row.metadata.text).toBe("updated");
  });

  it("search returns top-k by cosine similarity", async () => {
    await store.upsert("p1", [
      row("near", [1, 0, 0]),
      row("orthogonal", [0, 1, 0]),
      row("opposite", [-1, 0, 0]),
    ]);
    const hits = await store.search("p1", [1, 0, 0], 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].row.id).toBe("near");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("search supports a custom filter", async () => {
    await store.upsert("p1", [
      row("d1-c1", [1, 0, 0], { documentId: "d1" }),
      row("d2-c1", [1, 0, 0], { documentId: "d2" }),
    ]);
    const hits = await store.search("p1", [1, 0, 0], 5, {
      predicate: (r) => r.metadata.documentId === "d2",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].row.metadata.documentId).toBe("d2");
  });

  it("search filters by embedding model", async () => {
    await store.upsert("p1", [
      row("old", [1, 0, 0], { embeddingModel: "old-model" }),
      row("new", [1, 0, 0], { embeddingModel: "new-model" }),
    ]);
    const hits = await store.search("p1", [1, 0, 0], 5, { embeddingModel: "new-model" });
    expect(hits).toHaveLength(1);
    expect(hits[0].row.metadata.embeddingModel).toBe("new-model");
  });

  it("modelCoverage reports per-model row counts", async () => {
    await store.upsert("p1", [
      row("a", [1, 0, 0], { embeddingModel: "m1" }),
      row("b", [0, 1, 0], { embeddingModel: "m1" }),
      row("c", [0, 0, 1], { embeddingModel: "m2" }),
    ]);
    const cov = await store.modelCoverage("p1");
    expect(cov.totalChunks).toBe(3);
    expect(cov.modelCounts).toEqual({ m1: 2, m2: 1 });
  });

  it("dropTable removes the project's data on disk", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0])]);
    await store.dropTable("p1");
    const exists = await fs
      .stat(path.join(root, "p1"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("deleteByDocument removes all rows with matching documentId", async () => {
    await store.upsert("p1", [
      row("d1-c1", [1, 0, 0], { documentId: "d1" }),
      row("d1-c2", [0, 1, 0], { documentId: "d1" }),
      row("d2-c1", [0, 0, 1], { documentId: "d2" }),
    ]);
    const removed = await store.deleteByDocument("p1", "d1");
    expect(removed).toBe(2);
    expect(await store.count("p1")).toBe(1);
  });

  it("deleteByChunkIds removes only the specified rows", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0]), row("b", [0, 1, 0])]);
    const removed = await store.deleteByChunkIds("p1", ["a"]);
    expect(removed).toBe(1);
    expect(await store.count("p1")).toBe(1);
  });

  it("concurrent writes to different projects don't block each other", async () => {
    await Promise.all([
      store.upsert("p1", [row("a", [1, 0, 0])]),
      store.upsert("p2", [row("b", [0, 1, 0])]),
      store.upsert("p3", [row("c", [0, 0, 1])]),
    ]);
    expect(await store.count("p1")).toBe(1);
    expect(await store.count("p2")).toBe(1);
    expect(await store.count("p3")).toBe(1);
  });

  it("concurrent writes to the SAME project are serialised (no lost updates)", async () => {
    const writes = Array.from({ length: 8 }, (_, i) =>
      store.upsert("p1", [row(`r${i}`, [1, 0, 0])]),
    );
    await Promise.all(writes);
    expect(await store.count("p1")).toBe(8);
  });

  it("rejects projectId values that look like path traversal", async () => {
    await expect(store.ensureTable("../escape")).rejects.toThrow();
    await expect(store.ensureTable("a/b")).rejects.toThrow();
    await expect(store.ensureTable("")).rejects.toThrow();
  });

  it("upsert with empty rows is a no-op", async () => {
    await store.upsert("p1", []);
    expect(await store.count("p1")).toBe(0);
  });

  it("rejects empty vectors", async () => {
    await expect(store.upsert("p1", [row("a", [])])).rejects.toThrow(/empty/);
  });

  it("search with k=0 returns []", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0])]);
    expect(await store.search("p1", [1, 0, 0], 0)).toEqual([]);
  });

  it("search on an empty table returns []", async () => {
    expect(await store.search("p1", [1, 0, 0], 5)).toEqual([]);
  });

  it("constructor refuses missing root", () => {
    expect(() => new LocalVectorStore({ root: "" })).toThrow(/root/);
  });
});
