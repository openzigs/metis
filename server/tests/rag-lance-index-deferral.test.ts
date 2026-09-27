/**
 * Issue #207 — `LanceVectorStore.upsert` rebuilt the IVF_PQ index on EVERY write once
 * a table passed `VECTOR_ANN_THRESHOLD`, so a repository ingest (one upsert per
 * document) was quadratic and the table grew to gigabytes of stale index builds.
 *
 * These tests drive the real `vectordb` binding against a temp directory and read
 * the result back through the same paths a consumer uses: the index count through
 * the client's own `createIndex`, the disk footprint through the table directory,
 * and retrieval through `search()`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VECTOR_ANN_THRESHOLD } from "@metis/shared";
import {
  LANCE_CLEANUP_EVERY_WRITES,
  LANCE_INDEX_METRIC,
  LANCE_INDEX_REBUILD_GROWTH_FACTOR,
  LanceVectorStore,
  type VectorRow,
} from "../src/lib/rag/vector-store.js";

interface LanceIntrospection {
  listIndices(): Promise<Array<{ name: string; columns: string[] }>>;
  indexStats(name: string): Promise<{
    numIndexedRows: number | null;
    numUnindexedRows: number | null;
    distanceType?: string;
  }>;
}
interface VectordbModule {
  LocalTable: { prototype: Record<string, unknown> };
  connect(uri: string): Promise<{ openTable(name: string): Promise<LanceIntrospection> }>;
}

// PR #255 review — resolved at COLLECTION time, so the skip below is real. (It used
// to be set in a `beforeAll`, which runs after `describe` has already been chosen.)
let vectordb: VectordbModule | null = null;
try {
  vectordb = (await import("vectordb")) as unknown as VectordbModule;
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("vectordb not loadable on this host, skipping #207 tests:", err);
}
const LocalTable = vectordb?.LocalTable ?? null;

const describeIfLance = vectordb ? describe : describe.skip;

const DIM = 64;
const PROJECT = "ingest";

/** Deterministic pseudo-random unit vectors — realistic for IVF_PQ, unlike one-hots. */
function vectors(count: number, seed: number): number[][] {
  let s = seed >>> 0;
  const next = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5;
  return Array.from({ length: count }, () => {
    const v = Array.from({ length: DIM }, next);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
}

function rowsFor(doc: number, vecs: number[][]): VectorRow[] {
  return vecs.map((vector, c) => {
    const id = `d${doc}-c${c}`;
    return {
      id,
      vector,
      metadata: {
        chunkId: id,
        documentId: `d${doc}`,
        filename: `f${doc}.ts`,
        position: c,
        text: id,
        embeddingModel: "test-model",
      },
    };
  });
}

/** Ingest `docs` documents of `perDoc` chunks each, one upsert per document. */
async function ingest(
  store: LanceVectorStore,
  docs: number,
  perDoc: number,
  startDoc = 0,
): Promise<VectorRow[]> {
  const all: VectorRow[] = [];
  const vecs = vectors(docs * perDoc, 7 + startDoc);
  for (let d = 0; d < docs; d++) {
    const rows = rowsFor(startDoc + d, vecs.slice(d * perDoc, (d + 1) * perDoc));
    all.push(...rows);
    await store.upsert(PROJECT, rows);
  }
  return all;
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-lance-207-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function tableDir(): string {
  return path.join(root, `p_${PROJECT}.lance`);
}

/** The table's vector-index stats as Lance reports them, or null when it has none. */
async function vectorIndexStats(): Promise<Awaited<
  ReturnType<LanceIntrospection["indexStats"]>
> | null> {
  const table = await (await vectordb!.connect(root)).openTable(`p_${PROJECT}`);
  const index = (await table.listIndices()).find((i) => i.columns.includes("vector"));
  return index ? table.indexStats(index.name) : null;
}

// Real IVF_PQ training (k-means over 256 partitions) is CPU work, not contended I/O;
// the budget covers a loaded CI runner.
describeIfLance("LanceVectorStore ANN index deferral (#207)", { timeout: 60_000 }, () => {
  it("builds the index once when the table crosses the threshold, not once per upsert", async () => {
    const spy = vi.spyOn(LocalTable!.prototype as never, "createIndex" as never);
    const store = new LanceVectorStore({ root });
    // 1,050 → 1,500 rows: past the threshold, below the rebuild factor. The pre-#207
    // store called createIndex on every one of the ~10 upserts past 1,000.
    await ingest(store, 30, 50);
    expect(await store.count(PROJECT)).toBe(1500);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it(`re-trains only at x${LANCE_INDEX_REBUILD_GROWTH_FACTOR} growth, and reclaims superseded builds and versions`, async () => {
    const spy = vi.spyOn(LocalTable!.prototype as never, "createIndex" as never);
    const store = new LanceVectorStore({ root, cleanupOlderThanMinutes: 0 });
    // 100-row documents: builds at 1,100 and at 2,200 (= 1,100 x 2), nowhere else.
    await ingest(store, 25, 100);
    expect(spy).toHaveBeenCalledTimes(2);

    // …and the superseded build and old table versions are reclaimed.
    // Lance deletes a superseded build's files but leaves its empty directory, so
    // count the builds that still hold bytes.
    const indicesDir = path.join(tableDir(), "_indices");
    const live: string[] = [];
    for (const dir of await fs.readdir(indicesDir)) {
      if ((await fs.readdir(path.join(indicesDir, dir))).length > 0) live.push(dir);
    }
    expect(live).toHaveLength(1);
    const versions = await fs.readdir(path.join(tableDir(), "_versions"));
    // 25 upserts are ~50 versions (a delete and an add each) plus the index and
    // compaction commits. Cleanup after the second build leaves only what followed it.
    expect(versions.length).toBeLessThan(15);
    // …and the data are all still there.
    expect(await store.count(PROJECT)).toBe(2500);
    const refs = await store.listChunkRefs(PROJECT);
    expect(new Set(refs.map((r) => r.chunkId)).size).toBe(2500);
  });

  it("does not rebuild after a restart when the on-disk index still covers the table", async () => {
    await ingest(new LanceVectorStore({ root }), 24, 50); // 1,200 rows, indexed at 1,050
    const spy = vi.spyOn(LocalTable!.prototype as never, "createIndex" as never);
    // A fresh store has no in-memory history: it must read the index's coverage from
    // the table rather than treating "unknown" as "never built".
    const restarted = new LanceVectorStore({ root });
    await ingest(restarted, 2, 50, 100);
    expect(await restarted.count(PROJECT)).toBe(1300);
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps every row retrievable — rows added after the last build are searched too", async () => {
    const store = new LanceVectorStore({ root });
    const all = await ingest(store, 30, 50); // indexed at 1,050; 450 rows unindexed
    // Sample across the whole run, weighted to the unindexed tail.
    const probes = [0, 400, 1049, 1050, 1200, 1350, 1499].map((i) => all[i]);
    for (const probe of probes) {
      const hits = await store.search(PROJECT, probe.vector, 5);
      expect(hits[0]?.row.id, `self-hit for ${probe.id}`).toBe(probe.id);
    }
  });

  it("keeps an index covering the table through a re-sync that re-upserts the same rows", async () => {
    // PR #255 review — a re-sync deletes and re-adds every row by id, so the row count
    // stays flat. Lance drops the index whose rows are gone; a trigger that reads only
    // the count left the table with NO index until it doubled or the process restarted.
    const spy = vi.spyOn(LocalTable!.prototype as never, "createIndex" as never);
    const store = new LanceVectorStore({ root });
    for (let pass = 0; pass < 3; pass++) {
      await ingest(store, 30, 50);
      expect(await store.count(PROJECT)).toBe(1500);
      const stats = await vectorIndexStats();
      expect(stats, `a vector index exists after pass ${pass}`).not.toBeNull();
      // The same invariant growth-by-doubling keeps for an append-only table: the
      // index covers the larger part of it.
      expect(stats!.numIndexedRows ?? 0).toBeGreaterThan(stats!.numUnindexedRows ?? 0);
    }
    // Bounded, not per write: 90 upserts. One build at the crossing, then two per
    // full re-sync (a build covers the table; half of it replaced, it no longer does).
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it("forgets a dropped table's index state, so the recreated table is indexed again", async () => {
    // PR #255 review — `dropTable` must reset the per-table bookkeeping. Otherwise the
    // new table inherits the old one's coverage (2,400 here) and, with 1,200 rows of
    // coverage-check budget left over, stays unindexed past the threshold.
    const spy = vi.spyOn(LocalTable!.prototype as never, "createIndex" as never);
    const store = new LanceVectorStore({ root });
    await ingest(store, 1, 2400); // one write, one build over 2,400 rows
    expect(spy).toHaveBeenCalledTimes(1);
    await store.dropTable(PROJECT);
    await ingest(store, 11, 100); // crosses the threshold again at 1,100
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await vectorIndexStats()).not.toBeNull();
  });

  it("forgets the live table's index state on swapTable, so the swapped-in table is indexed", async () => {
    // PR #255 review — same as drop, for the shadow-reindex cut-over. `vectordb` has no
    // `renameTable`, so this drives the drop+recreate fallback that production uses;
    // the recreated live table carries rows, not the shadow's index.
    const store = new LanceVectorStore({ root });
    await ingest(store, 25, 100); // live indexed at 2,200
    const shadow = `${PROJECT}-shadow`;
    const vecs = vectors(1200, 99);
    for (let d = 0; d < 12; d++) {
      await store.upsert(shadow, rowsFor(500 + d, vecs.slice(d * 100, (d + 1) * 100)));
    }
    await store.swapTable(PROJECT, shadow);
    expect(await store.count(PROJECT)).toBe(1200);
    expect(await vectorIndexStats(), "the recreated live table starts unindexed").toBeNull();

    const spy = vi.spyOn(LocalTable!.prototype as never, "createIndex" as never);
    await ingest(store, 1, 50, 900);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await vectorIndexStats()).not.toBeNull();
  });

  it("re-trains an index built with another metric, as every table indexed before this fix was", async () => {
    // PR #255 review — until now `createIndex` passed no metric, so every existing
    // table was indexed with `l2`. It is re-trained once, on the first write after
    // a restart, rather than served by the wrong metric until it doubles.
    const conn = await vectordb!.connect(root);
    const vecs = vectors(1100, 5);
    const legacy = await (
      conn as unknown as {
        createTable(
          name: string,
          rows: Array<Record<string, unknown>>,
        ): Promise<{
          createIndex(p: Record<string, unknown>): Promise<unknown>;
        }>;
      }
    ).createTable(
      `p_${PROJECT}`,
      vecs.map((vector, i) => ({
        id: `legacy-${i}`,
        vector,
        text: "t",
        document_id: "legacy",
        chunk_index: i,
        filename: "f",
        model: "test-model",
        created_at: 0,
      })),
    );
    await legacy.createIndex({
      type: "ivf_pq",
      column: "vector",
      num_partitions: 256,
      num_sub_vectors: 16,
    });
    expect((await vectorIndexStats())?.distanceType).toBe("l2");

    const spy = vi.spyOn(LocalTable!.prototype as never, "createIndex" as never);
    await ingest(new LanceVectorStore({ root }), 1, 50, 700);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await vectorIndexStats())?.distanceType).toBe(LANCE_INDEX_METRIC);
  });

  it(`trains the index with the metric search() queries with (${LANCE_INDEX_METRIC}), so ranking matches an exhaustive search`, async () => {
    // PR #255 review — `vectordb` ranks an indexed table by the INDEX's metric and
    // ignores the query's `metricType`. Trained with the default `l2`, a query for a
    // stored vector at a different magnitude (cosine distance 0) found whatever lay
    // nearest in Euclidean space instead.
    const store = new LanceVectorStore({ root });
    const base = vectors(1100, 3);
    const norm = (i: number): number => 0.2 + ((i * 37) % 50) / 5; // 0.2 … 10
    const stored = base.map((v, i) => v.map((x) => x * norm(i)));
    for (let d = 0; d < 11; d++) {
      await store.upsert(PROJECT, rowsFor(d, stored.slice(d * 100, (d + 1) * 100)));
    }
    const stats = await vectorIndexStats();
    expect(stats?.distanceType).toBe(LANCE_INDEX_METRIC);

    // Exhaustive cosine top-1 of `c * stored[i]` is row i by construction.
    const probeRows = [0, 137, 404, 555, 811, 1099];
    for (const i of probeRows) {
      const probe = base[i].map((x) => x * 3.3);
      const hits = await store.search(PROJECT, probe, 5);
      expect(hits[0]?.row.id, `cosine top-1 for row ${i}`).toBe(
        `d${Math.floor(i / 100)}-c${i % 100}`,
      );
    }
  });
});

/**
 * Structural doubles for the paths the native binding cannot reach on demand: a
 * failing `createIndex`, and a client with no index introspection or cleanup API.
 */
describe("LanceVectorStore index deferral — client edge cases (#207)", () => {
  interface FakeTable {
    name: string;
    rows: number;
    createIndex: ReturnType<typeof vi.fn>;
    add(data: unknown[]): Promise<number>;
    delete(): Promise<void>;
    countRows(): Promise<number>;
  }

  function fakeStore(createIndex: ReturnType<typeof vi.fn>): {
    store: LanceVectorStore;
    table: FakeTable;
  } {
    const table: FakeTable = {
      name: "p_fake",
      rows: 0,
      createIndex,
      async add(data) {
        table.rows += data.length;
        return table.rows;
      },
      async delete() {},
      async countRows() {
        return table.rows;
      },
    };
    const store = new LanceVectorStore({ root: "/nonexistent-metis-207" });
    const conn = {
      tableNames: async () => ["p_fake"],
      openTable: async () => table,
      createTable: async () => table,
      dropTable: async () => {},
    };
    Object.assign(store as unknown as Record<string, unknown>, { connection: conn });
    return { store, table };
  }

  function batch(start: number, n: number): VectorRow[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `r${start + i}`,
      vector: [1, 0, 0],
      metadata: {
        chunkId: `r${start + i}`,
        documentId: "d",
        filename: "f",
        position: i,
        text: "t",
        embeddingModel: "m",
      },
    }));
  }

  it("does not retry a failed build on every following upsert", async () => {
    const createIndex = vi.fn().mockRejectedValue(new Error("not enough rows to train PQ"));
    const { store } = fakeStore(createIndex);
    for (let i = 0; i < VECTOR_ANN_THRESHOLD + 500; i += 100) {
      await store.upsert("fake", batch(i, 100));
    }
    // One failed attempt at the crossing; the next is due only at the growth factor.
    expect(createIndex).toHaveBeenCalledTimes(1);
  });

  it("works on a client with no listIndices / cleanupOldVersions", async () => {
    const createIndex = vi.fn().mockResolvedValue(undefined);
    const { store } = fakeStore(createIndex);
    for (let i = 0; i < 2 * VECTOR_ANN_THRESHOLD + 400; i += 100) {
      await store.upsert("fake", batch(i, 100));
    }
    expect(createIndex).toHaveBeenCalledTimes(2);
    expect(createIndex.mock.calls[0][0]).toMatchObject({ type: "ivf_pq", replace: true });
  });

  it(`compacts and reclaims old versions every ${LANCE_CLEANUP_EVERY_WRITES} writes, below the threshold too`, async () => {
    const { store, table } = fakeStore(vi.fn());
    const compactFiles = vi.fn().mockResolvedValue({});
    const cleanupOldVersions = vi.fn().mockResolvedValue({});
    Object.assign(table, { compactFiles, cleanupOldVersions });
    for (let i = 0; i < LANCE_CLEANUP_EVERY_WRITES * 2 + 5; i++) {
      await store.upsert("fake", batch(i, 1));
    }
    expect(compactFiles).toHaveBeenCalledTimes(2);
    expect(cleanupOldVersions).toHaveBeenCalledTimes(2);
    // The grace period keeps an in-flight search from losing the files it is reading.
    expect(cleanupOldVersions).toHaveBeenCalledWith(1);
  });

  it("dropTable resets the cleanup counter along with the index state", async () => {
    const { store, table } = fakeStore(vi.fn());
    const compactFiles = vi.fn().mockResolvedValue({});
    Object.assign(table, { compactFiles });
    const half = LANCE_CLEANUP_EVERY_WRITES / 2 + 10;
    for (let i = 0; i < half; i++) await store.upsert("fake", batch(i, 1));
    await store.dropTable("fake");
    for (let i = 0; i < half; i++) await store.upsert("fake", batch(i, 1));
    // Neither table has taken LANCE_CLEANUP_EVERY_WRITES writes.
    expect(compactFiles).not.toHaveBeenCalled();
  });

  it("a failing cleanup is logged, never surfaced as a failed write", async () => {
    const { store, table } = fakeStore(vi.fn().mockResolvedValue(undefined));
    Object.assign(table, {
      cleanupOldVersions: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    await expect(store.upsert("fake", batch(0, VECTOR_ANN_THRESHOLD + 1))).resolves.toBeUndefined();
    expect(table.rows).toBe(VECTOR_ANN_THRESHOLD + 1);
  });

  it("treats a failed index introspection as 'no index' and builds one", async () => {
    const createIndex = vi.fn().mockResolvedValue(undefined);
    const { store, table } = fakeStore(createIndex);
    Object.assign(table, {
      listIndices: vi.fn().mockRejectedValue(new Error("manifest unreadable")),
      indexStats: vi.fn(),
    });
    await store.upsert("fake", batch(0, VECTOR_ANN_THRESHOLD + 1));
    expect(createIndex).toHaveBeenCalledTimes(1);
  });
});
