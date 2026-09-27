/**
 * Issue #253 — `LanceVectorStore.upsert` ran `table.delete("id IN (...)")` before
 * every add. On `vectordb` 0.21.2 a delete scans the `id` column of every fragment
 * and commits a new table version even when it matches nothing, so the cost of an
 * upsert grew with the table's fragment count — which, on the ingest path, nothing
 * bounded (see the `withProjectWrite` test below).
 *
 * The real-binding tests read results back the way a consumer does: row counts,
 * `listChunkRefs`, `search()`, and Lance's own index introspection.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LANCE_CLEANUP_EVERY_WRITES,
  LANCE_ID_INDEX_COLUMN,
  LanceVectorStore,
  type VectorRow,
} from "../src/lib/rag/vector-store.js";

interface LanceIntrospection {
  listIndices(): Promise<Array<{ name: string; columns: string[] }>>;
  indexStats(name: string): Promise<{
    numIndexedRows: number | null;
    numUnindexedRows: number | null;
    indexType?: string;
  }>;
}
interface VectordbModule {
  LocalTable: { prototype: Record<string, unknown> };
  connect(uri: string): Promise<{ openTable(name: string): Promise<LanceIntrospection> }>;
}

// Resolved at collection time so the skip is real on a host without the binding.
let vectordb: VectordbModule | null = null;
try {
  vectordb = (await import("vectordb")) as unknown as VectordbModule;
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("vectordb not loadable on this host, skipping #253 tests:", err);
}
const LocalTable = vectordb?.LocalTable ?? null;
const describeIfLance = vectordb ? describe : describe.skip;

const DIM = 32;
const PROJECT = "bounded";

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

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-lance-253-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function idIndexStats() {
  const table = await (await vectordb!.connect(root)).openTable(`p_${PROJECT}`);
  const index = (await table.listIndices()).find((i) => i.columns.includes(LANCE_ID_INDEX_COLUMN));
  return index ? table.indexStats(index.name) : null;
}

describeIfLance("LanceVectorStore bounded upsert (#253)", { timeout: 60_000 }, () => {
  it("does not delete (scan every fragment, commit a version) when every id is new", async () => {
    const store = new LanceVectorStore({ root });
    const vecs = vectors(40 * 8, 1);
    // The first upsert creates the table (seeded with its first row), so it is the
    // one write that does find a row to replace.
    await store.upsert(PROJECT, rowsFor(0, vecs.slice(0, 8)));
    const del = vi.spyOn(LocalTable!.prototype as never, "delete" as never);
    for (let d = 1; d < 40; d++) {
      await store.upsert(PROJECT, rowsFor(d, vecs.slice(d * 8, (d + 1) * 8)));
    }
    expect(await store.count(PROJECT)).toBe(320);
    expect(del).not.toHaveBeenCalled();
  });

  it("still replaces a re-upserted row, wherever it lives, with no duplicate", async () => {
    const store = new LanceVectorStore({ root, cleanupOlderThanMinutes: 0 });
    const vecs = vectors(130 * 8, 2);
    // Past one maintenance cycle, so the id index exists and covers the early rows;
    // the rows written after it sit in unindexed fragments.
    for (let d = 0; d < 130; d++) {
      await store.upsert(PROJECT, rowsFor(d, vecs.slice(d * 8, (d + 1) * 8)));
    }
    const stats = await idIndexStats();
    expect(stats, "an id index exists after a maintenance cycle").not.toBeNull();
    expect(stats!.numIndexedRows ?? 0).toBeGreaterThan(0);
    expect(stats!.numUnindexedRows ?? 0).toBeGreaterThan(0);

    const fresh = vectors(16, 99);
    for (const doc of [3, 128]) {
      // doc 3 is under the id index, doc 128 is not
      const replaced = rowsFor(doc, doc === 3 ? fresh.slice(0, 8) : fresh.slice(8, 16));
      await store.upsert(PROJECT, replaced);
    }
    expect(await store.count(PROJECT)).toBe(130 * 8);
    const refs = await store.listChunkRefs(PROJECT);
    expect(new Set(refs.map((r) => r.chunkId)).size).toBe(130 * 8);
    for (const [doc, v] of [
      [3, fresh[0]],
      [128, fresh[8]],
    ] as const) {
      const [top] = await store.search(PROJECT, v, 1);
      expect(top.row.id).toBe(`d${doc}-c0`);
      expect(top.score).toBeCloseTo(1, 5);
    }
  });

  it(`keeps the id index current: at most ${LANCE_CLEANUP_EVERY_WRITES} writes' rows outside it`, async () => {
    const store = new LanceVectorStore({ root, cleanupOlderThanMinutes: 0 });
    const perWrite = 4;
    const writes = 3 * LANCE_CLEANUP_EVERY_WRITES + 50; // crosses the ANN threshold too
    const vecs = vectors(writes * perWrite, 3);
    for (let d = 0; d < writes; d++) {
      const rows = rowsFor(d, vecs.slice(d * perWrite, (d + 1) * perWrite));
      await store.upsert(PROJECT, rows);
      if ((d + 1) % 50 !== 0) continue;
      // The bound holds throughout the run, not only at the end: whatever the index
      // does not cover is what a lookup still scans.
      const stats = await idIndexStats();
      if (d + 1 < LANCE_CLEANUP_EVERY_WRITES) continue;
      expect(stats, `id index after ${d + 1} writes`).not.toBeNull();
      expect(stats!.numIndexedRows! + stats!.numUnindexedRows!).toBe((d + 1) * perWrite);
      expect(stats!.numUnindexedRows!).toBeLessThan(LANCE_CLEANUP_EVERY_WRITES * perWrite);
    }
  });
});

/** Structural doubles for paths the native binding cannot be driven into on demand. */
describe("LanceVectorStore bounded upsert — client edge cases (#253)", () => {
  interface FakeTable {
    name: string;
    rows: number;
    add(data: unknown[]): Promise<number>;
    delete(): Promise<void>;
    countRows(): Promise<number>;
    createIndex(): Promise<void>;
  }

  function fakeStore(): { store: LanceVectorStore; table: FakeTable } {
    const table: FakeTable = {
      name: "p_fake",
      rows: 0,
      async add(data) {
        table.rows += data.length;
        return table.rows;
      },
      async delete() {},
      async countRows() {
        return table.rows;
      },
      async createIndex() {},
    };
    const store = new LanceVectorStore({ root: path.join(os.tmpdir(), "metis-253-fake") });
    const conn = {
      tableNames: async () => ["p_fake"],
      openTable: async () => table,
      createTable: async () => table,
      dropTable: async () => {},
    };
    Object.assign(store as unknown as Record<string, unknown>, { connection: conn });
    return { store, table };
  }

  const row = (i: number): VectorRow => ({
    id: `r${i}`,
    vector: [1, 0, 0],
    metadata: {
      chunkId: `r${i}`,
      documentId: "d",
      filename: "f",
      position: i,
      text: "t",
      embeddingModel: "m",
    },
  });

  it("counts writes made through withProjectWrite, so ingest still compacts", async () => {
    // Document approval replays its rows inside `withProjectWrite`, which drops the
    // cached table (another instance may have cut it over). It used to drop the
    // write counter too, so on the ingest path compaction never ran and fragments
    // — the thing a delete scans — grew with every document.
    const { store, table } = fakeStore();
    const compactFiles = vi.fn().mockResolvedValue({});
    Object.assign(table, { compactFiles });
    for (let i = 0; i < LANCE_CLEANUP_EVERY_WRITES * 2; i++) {
      await store.withProjectWrite("fake", (write) => write.upsert("fake", [row(i)]));
    }
    expect(compactFiles).toHaveBeenCalledTimes(2);
  });

  it("refreshes the id index after compaction and before version cleanup", async () => {
    const { store, table } = fakeStore();
    const order: string[] = [];
    Object.assign(table, {
      compactFiles: vi.fn(async () => order.push("compact")),
      createScalarIndex: vi.fn(async (col: string, replace: boolean) =>
        order.push(`scalar:${col}:${replace}`),
      ),
      cleanupOldVersions: vi.fn(async () => order.push("cleanup")),
    });
    for (let i = 0; i < LANCE_CLEANUP_EVERY_WRITES; i++) await store.upsert("fake", [row(i)]);
    expect(order).toEqual(["compact", `scalar:${LANCE_ID_INDEX_COLUMN}:true`, "cleanup"]);
  });

  it("a failing compaction is logged, never a failed write, and the id index is still refreshed", async () => {
    const { store, table } = fakeStore();
    const createScalarIndex = vi.fn().mockResolvedValue(undefined);
    Object.assign(table, {
      compactFiles: vi.fn().mockRejectedValue(new Error("disk full")),
      createScalarIndex,
    });
    for (let i = 0; i < LANCE_CLEANUP_EVERY_WRITES; i++) {
      await expect(store.upsert("fake", [row(i)])).resolves.toBeUndefined();
    }
    expect(createScalarIndex).toHaveBeenCalledTimes(1);
  });

  it("a failing id-index build is logged, never a failed write, and cleanup still runs", async () => {
    const { store, table } = fakeStore();
    const cleanupOldVersions = vi.fn().mockResolvedValue({});
    Object.assign(table, {
      createScalarIndex: vi.fn().mockRejectedValue(new Error("unsupported")),
      cleanupOldVersions,
    });
    for (let i = 0; i < LANCE_CLEANUP_EVERY_WRITES; i++) {
      await expect(store.upsert("fake", [row(i)])).resolves.toBeUndefined();
    }
    expect(table.rows).toBe(LANCE_CLEANUP_EVERY_WRITES);
    expect(cleanupOldVersions).toHaveBeenCalledTimes(1);
  });
});
