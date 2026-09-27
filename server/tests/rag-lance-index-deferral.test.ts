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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VECTOR_ANN_THRESHOLD } from "@metis/shared";
import {
  LANCE_CLEANUP_EVERY_WRITES,
  LANCE_INDEX_REBUILD_GROWTH_FACTOR,
  LanceVectorStore,
  type VectorRow,
} from "../src/lib/rag/vector-store.js";

let lanceLoadable = true;
let LocalTable: { prototype: Record<string, unknown> } | null = null;

beforeAll(async () => {
  try {
    const mod = (await import("vectordb")) as unknown as {
      LocalTable: { prototype: Record<string, unknown> };
    };
    LocalTable = mod.LocalTable;
  } catch (err) {
    lanceLoadable = false;
    // eslint-disable-next-line no-console
    console.warn("vectordb not loadable on this host, skipping #207 tests:", err);
  }
});

const describeIfLance = lanceLoadable ? describe : describe.skip;

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
