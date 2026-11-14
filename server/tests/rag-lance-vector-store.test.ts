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
import {
  LanceVectorStore,
  type SearchFilter,
  type VectorRow,
} from "../src/lib/rag/vector-store.js";

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

  describe("filters apply BEFORE the top-k is picked (#1917)", () => {
    // `vectordb` 0.21 post-filters by default: it ranks the k nearest rows and THEN
    // drops the ones the filter excludes. These tables hold more than k excluded rows
    // nearer the query than every match — a superseded revision's chunks, another
    // model's tags — so a post-filter returns none of the k matches asked for.
    const K = 5;

    /** A unit vector at cosine `cos` to `vec(0)`, distinct per `axis`. */
    function nearZero(cos: number, axis: number): number[] {
      const out = new Array<number>(384).fill(0);
      out[0] = cos;
      out[axis] = Math.sqrt(1 - cos * cos);
      return out;
    }

    it("documentIds: returns k matching rows past more than k nearer excluded rows", async () => {
      const stale = Array.from({ length: 4 * K }, (_, i) =>
        row(`stale-${i}`, nearZero(0.99, 10 + i), { documentId: "superseded" }),
      );
      const live = Array.from({ length: K + 2 }, (_, i) =>
        row(`live-${i}`, nearZero(0.5, 100 + i), { documentId: "current" }),
      );
      await store.upsert("p1", [...stale, ...live]);

      const hits = await store.search("p1", vec(0), K, { documentIds: ["current"] });
      expect(hits).toHaveLength(K);
      expect(new Set(hits.map((h) => h.row.metadata.documentId))).toEqual(new Set(["current"]));
    });

    it("embeddingModel: returns k matching rows past more than k nearer other-model rows", async () => {
      const other = Array.from({ length: 4 * K }, (_, i) =>
        row(`old-${i}`, nearZero(0.99, 10 + i), { embeddingModel: "old-model" }),
      );
      const active = Array.from({ length: K + 2 }, (_, i) =>
        row(`new-${i}`, nearZero(0.5, 100 + i), { embeddingModel: "new-model" }),
      );
      await store.upsert("p1", [...other, ...active]);

      const hits = await store.search("p1", vec(0), K, { embeddingModel: "new-model" });
      expect(hits).toHaveLength(K);
      expect(new Set(hits.map((h) => h.row.metadata.embeddingModel))).toEqual(
        new Set(["new-model"]),
      );
    });

    it("still ranks the matches nearest-first", async () => {
      await store.upsert("p1", [
        ...Array.from({ length: 4 * K }, (_, i) =>
          row(`stale-${i}`, nearZero(0.99, 10 + i), { documentId: "superseded" }),
        ),
        row("far", nearZero(0.2, 200), { documentId: "current" }),
        row("near", nearZero(0.8, 201), { documentId: "current" }),
        row("mid", nearZero(0.5, 202), { documentId: "current" }),
      ]);

      const hits = await store.search("p1", vec(0), 2, { documentIds: ["current"] });
      expect(hits.map((h) => h.row.id)).toEqual(["near", "mid"]);
    });

    it("holds once the table is past VECTOR_ANN_THRESHOLD and an IVF index serves the query", async () => {
      // Seeded random unit vectors, so the IVF partitions spread the way a real
      // table's do. Next to the query sit 4k superseded rows and, one step further
      // out, the k + 2 current ones; the rest of the table is unrelated noise. The
      // matches go in FIRST, so the index built at the threshold covers them and the
      // query is answered by the index rather than an exhaustive scan.
      let seed = 1917;
      const rand = (): number =>
        (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5;
      const unit = (): number[] => {
        const v = Array.from({ length: 384 }, rand);
        const n = Math.hypot(...v);
        return v.map((x) => x / n);
      };
      const query = unit();
      /** A unit vector at exactly cosine `cos` to `query`. */
      const around = (cos: number): number[] => {
        const r = unit();
        const dot = r.reduce((acc, x, i) => acc + x * query[i], 0);
        const orth = r.map((x, i) => x - dot * query[i]);
        const n = Math.hypot(...orth);
        return query.map((q, i) => cos * q + Math.sqrt(1 - cos * cos) * (orth[i] / n));
      };
      const live = Array.from({ length: K + 2 }, (_, i) =>
        row(`live-${i}`, around(0.8), { documentId: "current" }),
      );
      const near = Array.from({ length: 4 * K }, (_, i) =>
        row(`stale-${i}`, around(0.9), { documentId: "superseded" }),
      );
      const noise = Array.from({ length: VECTOR_ANN_THRESHOLD + 100 }, (_, i) =>
        row(`noise-${i}`, unit(), { documentId: "superseded" }),
      );
      const all = [...live, ...near, ...noise];
      for (let i = 0; i < all.length; i += 250) await store.upsert("wide", all.slice(i, i + 250));
      const table = await (
        store as unknown as {
          openOrCreateTable(
            p: string,
          ): Promise<{ listIndices(): Promise<Array<{ columns: string[] }>> }>;
        }
      ).openOrCreateTable("wide");
      expect((await table.listIndices()).some((ix) => ix.columns.includes("vector"))).toBe(true);

      const hits = await store.search("wide", query, K, { documentIds: ["current"] });
      expect(hits).toHaveLength(K);
      expect(new Set(hits.map((h) => h.row.metadata.documentId))).toEqual(new Set(["current"]));
    });

    // #1922 — prefiltering restricts the candidates, but the IVF index still probes
    // only `vectordb`'s default 20 of its 256 partitions. Every excluded row sits at
    // cosine 0.99 to the query and every match at 0.5, so the probed partitions hold
    // excluded rows only: measured on `vectordb` 0.21.2, nprobes 20, 64 and 128 all
    // returned 0 hits here, and 256 returned k.
    it.each<[string, SearchFilter, Partial<VectorRow["metadata"]>]>([
      ["documentIds", { documentIds: ["current"] }, { documentId: "superseded" }],
      ["embeddingModel", { embeddingModel: "new-model" }, { embeddingModel: "old-model" }],
    ])(
      "%s: an IVF-indexed table returns k matches that sit outside the default probed partitions (#1922)",
      async (_label, filter, excludedMeta) => {
        const matched = { documentId: "current", embeddingModel: "new-model" };
        const live = Array.from({ length: K + 2 }, (_, i) =>
          row(`live-${i}`, nearZero(0.5, 310 + i), matched),
        );
        const excluded = Array.from({ length: VECTOR_ANN_THRESHOLD + 100 }, (_, i) =>
          row(`stale-${i}`, nearZero(0.99, 1 + (i % 300)), { ...matched, ...excludedMeta }),
        );
        // One write past the threshold, so the index is trained over the matches too.
        await store.upsert("narrow", [...live, ...excluded]);
        const table = await (
          store as unknown as {
            openOrCreateTable(
              p: string,
            ): Promise<{ listIndices(): Promise<Array<{ columns: string[] }>> }>;
          }
        ).openOrCreateTable("narrow");
        expect((await table.listIndices()).some((ix) => ix.columns.includes("vector"))).toBe(true);

        const hits = await store.search("narrow", vec(0), K, filter);
        expect(hits).toHaveLength(K);
        expect(hits.every((h) => h.row.id.startsWith("live-"))).toBe(true);
      },
    );
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

describeIfLance("LanceVectorStore.getRows — #2346 a stored vector read back for reuse", () => {
  it("returns the asked rows with their vectors and metadata, and nothing else", async () => {
    await store.upsert("p1", [
      row("a", vec(0, 3), { filename: "src/a.ts", text: "function a in src/a.ts" }),
      row("b", vec(1, 3)),
      row("it's", vec(2, 3)),
    ]);
    const got = await store.getRows("p1", ["a", "it's", "missing"]);
    expect(got.map((r) => r.id).sort()).toEqual(["a", "it's"]);
    const a = got.find((r) => r.id === "a")!;
    expect(a.vector).toEqual([1, 0, 0]);
    expect(a.metadata).toMatchObject({ filename: "src/a.ts", text: "function a in src/a.ts" });
    expect(await store.getRows("p1", [])).toEqual([]);
  });

  it("returns [] for a table that does not exist, without creating it", async () => {
    expect(await store.getRows("never-indexed", ["a"])).toEqual([]);
    expect(await store.listChunkRefs("never-indexed")).toEqual([]);
  });
});

describeIfLance(
  "LanceVectorStore.listChunkModels — #2346 review: the consistency check's ids",
  () => {
    it("reads only the id and model columns, never the vectors or the text", async () => {
      await store.upsert("p1", [
        row("a", vec(0, 3), { embeddingModel: "m1", text: "x".repeat(4000) }),
        row("b", vec(1, 3), { embeddingModel: "m2" }),
      ]);
      // The table object is cached per project, so this is the one the scan uses.
      const table = await (
        store as unknown as {
          openOrCreateTable(p: string): Promise<{ filter(w: string): unknown }>;
        }
      ).openOrCreateTable("p1");
      const selected: string[][] = [];
      const realFilter = table.filter.bind(table);
      const spy = vi.spyOn(table, "filter").mockImplementation((where: string) => {
        const q = realFilter(where) as { select(cols: string[]): unknown };
        const realSelect = q.select.bind(q);
        q.select = (cols: string[]) => {
          selected.push(cols);
          return realSelect(cols);
        };
        return q;
      });
      const refs = await store.listChunkModels("p1");
      spy.mockRestore();
      expect(selected).toEqual([["id", "model"]]);
      expect(refs.sort((x, y) => x.chunkId.localeCompare(y.chunkId))).toEqual([
        { chunkId: "a", embeddingModel: "m1" },
        { chunkId: "b", embeddingModel: "m2" },
      ]);
    });

    it("returns [] for a table that does not exist, without creating it", async () => {
      expect(await store.listChunkModels("never-indexed")).toEqual([]);
      expect(await store.count("never-indexed")).toBe(0);
    });
  },
);

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
