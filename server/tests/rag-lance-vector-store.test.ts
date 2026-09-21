/**
 * LanceVectorStore tests (Phase 5 / issue #42).
 *
 * Drives the real `vectordb` (LanceDB) Node binding against a tmp directory.
 * The native binding ships pre-built for darwin-arm64 / linux-x64. If the
 * binding fails to load on this host, the suite reports a clear skip rather
 * than a noisy stack trace.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VECTOR_ANN_THRESHOLD } from "@metis/shared";
import { LanceVectorStore, type VectorRow } from "../src/lib/rag/vector-store.js";

let lanceLoadable = true;

beforeAll(async () => {
  try {
    await import("vectordb");
  } catch (err) {
    lanceLoadable = false;
    // eslint-disable-next-line no-console
    console.warn("vectordb not loadable on this host, skipping LanceVectorStore tests:", err);
  }
});

const describeIfLance = lanceLoadable ? describe : describe.skip;

let root: string;
let store: LanceVectorStore;

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
      embeddingModel: extra.embeddingModel ?? "test-model",
      ...extra,
    },
  };
}

function vec(seed: number, dim = 384): number[] {
  // Build a deterministic, normalised, distinguishable vector.
  const out = new Array<number>(dim).fill(0);
  out[seed % dim] = 1;
  return out;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-lance-"));
  store = new LanceVectorStore({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describeIfLance("LanceVectorStore", () => {
  it("constructor refuses missing root", () => {
    expect(() => new LanceVectorStore({ root: "" })).toThrow(/root/);
  });

  it("upsert + count round-trip through the native binding", async () => {
    await store.upsert("p1", [row("a", vec(0)), row("b", vec(1))]);
    expect(await store.count("p1")).toBe(2);
  });

  it("search returns nearest neighbours by cosine similarity", async () => {
    await store.upsert("p1", [
      row("a", vec(0), { text: "alpha" }),
      row("b", vec(1), { text: "beta" }),
      row("c", vec(2), { text: "gamma" }),
    ]);
    const hits = await store.search("p1", vec(1), 1);
    expect(hits.length).toBe(1);
    expect(hits[0].row.id).toBe("b");
    expect(hits[0].score).toBeGreaterThan(0.5);
  });

  it("search filters by embeddingModel", async () => {
    await store.upsert("p1", [
      row("old", vec(0), { embeddingModel: "old-model" }),
      row("new", vec(0), { embeddingModel: "new-model" }),
    ]);
    const hits = await store.search("p1", vec(0), 5, { embeddingModel: "new-model" });
    expect(hits.length).toBe(1);
    expect(hits[0].row.metadata.embeddingModel).toBe("new-model");
  });

  it("search filters by documentIds", async () => {
    await store.upsert("p1", [
      row("d1-c1", vec(0), { documentId: "d1" }),
      row("d2-c1", vec(0), { documentId: "d2" }),
    ]);
    const hits = await store.search("p1", vec(0), 5, { documentIds: ["d2"] });
    expect(hits.length).toBe(1);
    expect(hits[0].row.metadata.documentId).toBe("d2");
  });

  it("upsert is idempotent — same id replaces", async () => {
    await store.upsert("p1", [row("a", vec(0), { text: "first" })]);
    await store.upsert("p1", [row("a", vec(0), { text: "second" })]);
    expect(await store.count("p1")).toBe(1);
    const hits = await store.search("p1", vec(0), 1);
    expect(hits[0].row.metadata.text).toBe("second");
  });

  it("deleteByDocument removes rows for that document", async () => {
    await store.upsert("p1", [
      row("d1-c1", vec(0), { documentId: "d1" }),
      row("d1-c2", vec(1), { documentId: "d1" }),
      row("d2-c1", vec(2), { documentId: "d2" }),
    ]);
    const removed = await store.deleteByDocument("p1", "d1");
    expect(removed).toBe(2);
    expect(await store.count("p1")).toBe(1);
  });

  it("deleteByChunkIds removes specific rows", async () => {
    await store.upsert("p1", [row("a", vec(0)), row("b", vec(1))]);
    const removed = await store.deleteByChunkIds("p1", ["a"]);
    expect(removed).toBe(1);
    expect(await store.count("p1")).toBe(1);
  });

  it("dropTable removes the project's table", async () => {
    await store.upsert("p1", [row("a", vec(0))]);
    await store.dropTable("p1");
    // After drop a follow-up count opens a fresh empty table.
    expect(await store.count("p1")).toBe(0);
  });

  it("rejects projectIds that look like path traversal", async () => {
    await expect(store.ensureTable("../escape")).rejects.toThrow();
    await expect(store.ensureTable("a/b")).rejects.toThrow();
    await expect(store.ensureTable("")).rejects.toThrow();
  });

  it("modelCoverage reports per-model row counts", async () => {
    await store.upsert("p1", [
      row("a", vec(0), { embeddingModel: "m1" }),
      row("b", vec(1), { embeddingModel: "m1" }),
      row("c", vec(2), { embeddingModel: "m2" }),
    ]);
    const cov = await store.modelCoverage("p1");
    expect(cov.totalChunks).toBe(3);
    expect(cov.modelCounts).toEqual({ m1: 2, m2: 1 });
  });

  it("empty upsert is a no-op", async () => {
    await store.upsert("p1", []);
    expect(await store.count("p1")).toBe(0);
  });

  it("search with k=0 returns []", async () => {
    expect(await store.search("p1", vec(0), 0)).toEqual([]);
  });

  it("concurrent writes to different projects do not block", async () => {
    await Promise.all([
      store.upsert("p1", [row("a", vec(0))]),
      store.upsert("p2", [row("b", vec(1))]),
    ]);
    expect(await store.count("p1")).toBe(1);
    expect(await store.count("p2")).toBe(1);
  });

  /**
   * Issue #783 — the embedding model moved from 384 to 768 dims. A Lance table's
   * vector column has a FIXED list size, set when the table was created, so an
   * upgraded deployment is writing new-width rows at an old-width table. These
   * cases pin the three outcomes: refuse a POPULATED table, recreate an EMPTY one,
   * and never compare across widths on read.
   */
  describe("dimension guard (#783)", () => {
    it("REFUSES to write 768-dim rows into a populated 384-dim table", async () => {
      await store.upsert("p1", [row("old", vec(0, 384))]);
      await expect(store.upsert("p1", [row("new", vec(0, 768))])).rejects.toThrow(
        /Embedding dimension mismatch/,
      );
      // The old table is untouched — no half-migrated vector space.
      expect(await store.count("p1")).toBe(1);
    });

    it("names both widths and the reindex route, so the cause is not a guess", async () => {
      await store.upsert("p1", [row("old", vec(0, 384))]);
      await expect(store.upsert("p1", [row("new", vec(0, 768))])).rejects.toThrow(
        /384-dim.*768-dim/s,
      );
      await expect(store.upsert("p1", [row("new", vec(0, 768))])).rejects.toThrow(
        /projects\/p1\/reindex/,
      );
    });

    it("REFUSES a cross-width SEARCH of a populated table rather than ranking one", async () => {
      await store.upsert("p1", [row("old", vec(0, 384))]);
      await expect(store.search("p1", vec(0, 768), 5)).rejects.toThrow(
        /Embedding dimension mismatch/,
      );
    });

    it("recreates an EMPTY table at the new width instead of demanding a reindex", async () => {
      // The ordinary shape of a fresh project on an upgraded deployment:
      // `ensureTable()` materialises a schema-only table at the DEFAULT width
      // before the first upsert ever reveals the real one. There is nothing to
      // protect here, and telling an operator to "reindex" an empty project would
      // be nonsense.
      const narrow = new LanceVectorStore({ root, dimension: 384 });
      await narrow.ensureTable("p2");
      expect(await narrow.count("p2")).toBe(0);

      await narrow.upsert("p2", [row("a", vec(0, 768)), row("b", vec(1, 768))]);
      expect(await narrow.count("p2")).toBe(2);

      const hits = await narrow.search("p2", vec(1, 768), 1);
      expect(hits[0].row.id).toBe("b");
    });

    it("searches an empty wrong-width table as empty, rather than failing", async () => {
      const narrow = new LanceVectorStore({ root, dimension: 384 });
      await narrow.ensureTable("p3");
      expect(await narrow.search("p3", vec(0, 768), 5)).toEqual([]);
    });

    it("rejects an upsert batch that mixes widths — a bug in the caller", async () => {
      await expect(
        store.upsert("p4", [row("a", vec(0, 384)), row("b", vec(1, 768))]),
      ).rejects.toThrow(/Embedding dimension mismatch/);
    });
  });
});

describeIfLance("LanceVectorStore.listChunkRefs — #787 resume checkpoint", () => {
  it("returns every row's id, model tag and persisted width rather than the configured default", async () => {
    await store.upsert("p1", [
      row("a", vec(0, 3), { embeddingModel: "m-new" }),
      row("b", vec(1, 3), { embeddingModel: "m-new" }),
    ]);

    const refs = await new LanceVectorStore({ root, dimension: 99 }).listChunkRefs("p1");
    expect(refs).toHaveLength(2);
    expect(new Set(refs.map((r) => r.chunkId))).toEqual(new Set(["a", "b"]));
    expect(refs.every((r) => r.embeddingModel === "m-new")).toBe(true);
    expect(refs.every((r) => r.dimension === 3)).toBe(true);
  });

  it("returns [] for a table that does not exist — and does NOT create it as a side effect", async () => {
    // Asking whether a shadow exists must not MATERIALISE one: `openOrCreateTable`
    // would have built it at the default width, which has nothing to do with the
    // model the reindex is about to embed with.
    expect(await store.listChunkRefs("never-indexed")).toEqual([]);
    expect(await store.count("never-indexed")).toBe(0);
  });

  it("reads EVERY row once the table is past VECTOR_ANN_THRESHOLD and carries an IVF index", async () => {
    // Regression: readAllRows used to emulate a scan with a zero-vector `search()`.
    // Past the threshold the store promotes the table to ivf_pq, after which a
    // vector query probes a few of 256 partitions and returns a fraction of the
    // table — 294 of 3218 rows on a real project. `swapTable` rebuilds live from
    // these rows, so a short read here silently destroys the rest of the index.
    const total = VECTOR_ANN_THRESHOLD + 200;
    const rows = Array.from({ length: total }, (_, i) => row(`c${i}`, vec(i)));
    for (let i = 0; i < rows.length; i += 250) {
      await store.upsert("wide", rows.slice(i, i + 250));
    }
    expect(await store.count("wide")).toBe(total);

    const refs = await store.listChunkRefs("wide");
    expect(refs).toHaveLength(total);
    expect(new Set(refs.map((r) => r.chunkId)).size).toBe(total);
  });
});

/**
 * PR #796 review (S1) — the retained-shadow guarantee, on the swap path we ACTUALLY SHIP.
 *
 * `knowledge-service.resume.test.ts` proves that `runReindex` does not drop the shadow
 * when `swapTable` rejects — but it proves it with `swapTable` mocked away, so it never
 * executes the store's own swap logic. That is a weaker claim than the one the CLI makes
 * to operators ("its shadow was retained — re-run to resume where it stopped").
 *
 * It matters because `server/package.json` pins `vectordb@^0.21.2` — the legacy client,
 * which has NO `renameTable`. So `LanceVectorStore.swapTable()`'s drop-and-recreate
 * FALLBACK is not a legacy curiosity: it is the production branch for Lance today. And
 * that branch used to drop the shadow itself when the staging create failed — which is
 * the MOST LIKELY swap failure there is (bad schema/dimension, out of disk) — throwing
 * away a complete checkpoint and forcing a full re-embed of the project.
 *
 * This test drives the real `swapTable()` down the real fallback, fails the real staging
 * create, and asserts the checkpoint survives.
 */
describeIfLance(
  "LanceVectorStore.swapTable — #796 review S1: a failed swap KEEPS the shadow",
  () => {
    const LIVE = "p_swap_fail";
    const SHADOW = `${LIVE}__reindex`;

    /** The connection, with any native rename REMOVED — pinning the shipped client's shape. */
    async function fallbackConnection(s: LanceVectorStore): Promise<{
      tableNames(): Promise<string[]>;
      renameTable?: unknown;
    }> {
      const conn = await (
        s as unknown as { getConnection(): Promise<{ tableNames(): Promise<string[]> }> }
      ).getConnection();
      // `vectordb@0.21.2` has no renameTable, so swapTable takes the fallback. If a future
      // client adds one, this test must STILL exercise the fallback — that is the branch
      // whose failure path we are pinning. Shadow it on the instance either way.
      Object.defineProperty(conn, "renameTable", { value: undefined, configurable: true });
      return conn;
    }

    it("keeps the shadow (and the old live table) when the staging create fails", async () => {
      await store.upsert(LIVE, [row("old-a", vec(0)), row("old-b", vec(1))]);
      await store.upsert(SHADOW, [
        row("a", vec(2), { embeddingModel: "m-new" }),
        row("b", vec(3), { embeddingModel: "m-new" }),
      ]);
      const conn = await fallbackConnection(store);

      // Fail the FIRST create — the staging one. Live is untouched at that point, so this
      // is the failure mode where the shadow is pure profit: it is complete, and the retry
      // can replay the swap with zero embed calls.
      const create = vi
        .spyOn(
          LanceVectorStore.prototype as unknown as { createTableFromRows: () => Promise<unknown> },
          "createTableFromRows",
        )
        .mockRejectedValueOnce(new Error("No space left on device"));

      await expect(store.swapTable(LIVE, SHADOW)).rejects.toThrow(/No space left on device/);
      create.mockRestore();

      // THE CHECKPOINT SURVIVED. This is what the fallback used to destroy.
      expect(await store.listChunkRefs(SHADOW)).toHaveLength(2);
      // The live index was never touched (the staging create runs BEFORE the cut-over).
      expect(await store.count(LIVE)).toBe(2);
      // And the half-built staging table was cleaned up — the one thing this path SHOULD drop.
      expect(await conn.tableNames()).not.toContain(`${LIVE}_staging`);
    });

    it("the retry then replays the swap successfully off the retained shadow", async () => {
      await store.upsert(LIVE, [row("old-a", vec(0))]);
      await store.upsert(SHADOW, [
        row("a", vec(2), { embeddingModel: "m-new" }),
        row("b", vec(3), { embeddingModel: "m-new" }),
      ]);
      await fallbackConnection(store);

      const create = vi
        .spyOn(
          LanceVectorStore.prototype as unknown as { createTableFromRows: () => Promise<unknown> },
          "createTableFromRows",
        )
        .mockRejectedValueOnce(new Error("No space left on device"));
      await expect(store.swapTable(LIVE, SHADOW)).rejects.toThrow();
      create.mockRestore();

      // Same call again, no embed work in between — exactly what re-running the CLI does.
      await store.swapTable(LIVE, SHADOW);

      const refs = await store.listChunkRefs(LIVE);
      expect(new Set(refs.map((r) => r.chunkId))).toEqual(new Set(["a", "b"]));
      expect(refs.every((r) => r.embeddingModel === "m-new")).toBe(true);
      // The shadow is dropped only AFTER the cut-over has committed.
      expect(await store.listChunkRefs(SHADOW)).toEqual([]);
    });
  },
);
