/**
 * Issue #277 — once a LanceDB table has a vector index (past `VECTOR_ANN_THRESHOLD`),
 * the `_distance` a query returns is the index's PQ approximation, about TWICE the
 * cosine distance. `score = 1 - _distance` was therefore about `cos` for a small
 * project and about `2·cos − 1` for a large one, so any fixed score threshold meant
 * something different above and below 1,000 chunks.
 *
 * These tests drive the real `vectordb` binding and read scores back through
 * `search()`, the path every consumer uses.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VECTOR_ANN_THRESHOLD } from "@metis/shared";
import { cosineSimilarity, LanceVectorStore, type VectorRow } from "../src/lib/rag/vector-store.js";
import { filterByScoreThreshold } from "../src/lib/analysis/graph-context-builder.js";

interface LanceTableRaw {
  listIndices(): Promise<Array<{ name: string; columns: string[] }>>;
  createIndex(params: Record<string, unknown>): Promise<unknown>;
}
interface VectordbModule {
  connect(uri: string): Promise<{
    openTable(name: string): Promise<LanceTableRaw>;
    createTable(name: string, rows: Array<Record<string, unknown>>): Promise<LanceTableRaw>;
  }>;
}

// Resolved at collection time so the skip is real on a host without the binding.
let vectordb: VectordbModule | null = null;
try {
  vectordb = (await import("vectordb")) as unknown as VectordbModule;
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("vectordb not loadable on this host, skipping #277 tests:", err);
}
const describeIfLance = vectordb ? describe : describe.skip;

const DIM = 64;
const PROJECT = "scale";

/** Deterministic pseudo-random unit vectors. */
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

/**
 * A probe whose exact cosine to `target` is `cos`: `cos·target + sin·u`, with `u`
 * the part of a random direction orthogonal to `target`. Against the other random
 * rows its cosine is small, so `target` is reliably its top hit.
 */
function probeAt(target: number[], cos: number, seed: number): number[] {
  const [r] = vectors(1, seed);
  const dot = r.reduce((acc, x, i) => acc + x * target[i], 0);
  const orth = r.map((x, i) => x - dot * target[i]);
  const n = Math.hypot(...orth);
  const sin = Math.sqrt(1 - cos * cos);
  return target.map((t, i) => cos * t + (sin * orth[i]) / n);
}

/**
 * A pool whose row `target` is the unit vector e0 and every other row lies in the
 * subspace orthogonal to e0 and e1, plus a probe at exactly `cos` to the target and
 * exactly 0 to everything else. IVF centroids of the other partitions have no e0/e1
 * component, so the target's partition is always the probe's nearest: the target
 * comes back from an indexed table on every run, not on most.
 */
function isolatedTarget(count: number, seed: number, target: number, cos: number) {
  const pool = vectors(count, seed).map((v, i) => {
    if (i === target) return v.map((_, j) => (j === 0 ? 1 : 0));
    const w = v.map((x, j) => (j < 2 ? 0 : x));
    const n = Math.hypot(...w);
    return w.map((x) => x / n);
  });
  const probe = pool[0].map((_, j) => (j === 0 ? cos : j === 1 ? Math.sqrt(1 - cos * cos) : 0));
  return { pool, probe };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-lance-277-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function hasVectorIndex(): Promise<boolean> {
  const table = await (await vectordb!.connect(root)).openTable(`p_${PROJECT}`);
  return (await table.listIndices()).some((i) => i.columns.includes("vector"));
}

/** Upsert documents `from`..`to` of 100 rows each from one deterministic vector pool. */
async function load(store: LanceVectorStore, pool: number[][], from: number, to: number) {
  for (let d = from; d < to; d++) {
    await store.upsert(PROJECT, rowsFor(d, pool.slice(d * 100, (d + 1) * 100)));
  }
}

/**
 * Take the project past the threshold the way a shadow reindex does: every row is
 * written to the shadow, `swapTable` recreates the live table from them (one
 * fragment — `vectordb` has no `renameTable`, so this is the production path), and
 * the next write crosses the threshold and builds the index.
 *
 * Measured on `vectordb` 0.21.2: in that state `_distance` is the IVF_PQ
 * approximation (max |`_distance` − exact cosine distance| ≈ 0.74 over ten probes),
 * where a table built by many small upserts happens to read back exact distances.
 */
async function reindexPastThreshold(store: LanceVectorStore, pool: number[][]): Promise<void> {
  const shadow = `${PROJECT}-shadow`;
  for (let d = 0; d < 12; d++) {
    await store.upsert(shadow, rowsFor(d, pool.slice(d * 100, (d + 1) * 100)));
  }
  await store.swapTable(PROJECT, shadow);
  await store.upsert(PROJECT, rowsFor(12, pool.slice(1200, 1300)));
}

/** A table indexed by the pre-#255 code: default (`l2`) metric, never compacted. */
async function legacyIndexedTable(pool: number[][]): Promise<void> {
  const conn = await vectordb!.connect(root);
  const table = await conn.createTable(
    `p_${PROJECT}`,
    pool.map((vector, i) => ({
      id: `d${Math.floor(i / 100)}-c${i % 100}`,
      vector,
      text: "t",
      document_id: `d${Math.floor(i / 100)}`,
      chunk_index: i % 100,
      filename: "f",
      model: "test-model",
      created_at: 0,
    })),
  );
  await table.createIndex({
    type: "ivf_pq",
    column: "vector",
    num_partitions: 256,
    num_sub_vectors: 16,
  });
}

// IVF_PQ training is CPU work; the budget covers a loaded CI runner.
describeIfLance(
  "LanceVectorStore search scores are on one scale (#277)",
  { timeout: 60_000 },
  () => {
    const TARGET = 437; // row d4-c37
    const TARGET_ID = "d4-c37";
    const COS = 0.6;

    it("gives a row the same score below and above the index threshold", async () => {
      const { pool, probe } = isolatedTarget(1300, 21, TARGET, COS);
      const store = new LanceVectorStore({ root });

      await load(store, pool, 0, 9); // 900 rows: below the threshold, exhaustive search
      expect(await hasVectorIndex()).toBe(false);
      const below = (await store.search(PROJECT, probe, 10)).find((h) => h.row.id === TARGET_ID);
      expect(below, "target is a top-10 hit below the threshold").toBeDefined();

      await reindexPastThreshold(store, pool); // 1,300 rows: past the threshold, indexed
      expect(await store.count(PROJECT)).toBeGreaterThan(VECTOR_ANN_THRESHOLD);
      expect(await hasVectorIndex()).toBe(true);
      const above = (await store.search(PROJECT, probe, 10)).find((h) => h.row.id === TARGET_ID);
      expect(above, "target is a top-10 hit above the threshold").toBeDefined();

      // The exact cosine is the one scale; both sides must report it.
      expect(below!.score).toBeCloseTo(COS, 4);
      expect(above!.score).toBeCloseTo(below!.score, 4);
    });

    it("returns every indexed hit with its exact cosine, ranked by it", async () => {
      const pool = vectors(1300, 33);
      const store = new LanceVectorStore({ root });
      await reindexPastThreshold(store, pool);
      expect(await hasVectorIndex()).toBe(true);

      for (const [i, seed] of [
        [3, 5],
        [512, 6],
        [1111, 7],
      ] as const) {
        const probe = probeAt(pool[i], 0.7, seed);
        const hits = await store.search(PROJECT, probe, 10);
        expect(hits.length).toBe(10);
        for (const h of hits) {
          expect(h.score, `score of ${h.row.id}`).toBeCloseTo(
            cosineSimilarity(probe, h.row.vector),
            6,
          );
        }
        const scores = hits.map((h) => h.score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
      }
    });

    it("scores a table still carrying a pre-#255 l2 index on the cosine scale", async () => {
      // Every table indexed before PR #255 is served by its l2 index until the first
      // write re-trains it. On unit vectors l2² = 2·(1 − cos), so the old score was
      // exactly 2·cos − 1: 0.2 for a chunk at cosine 0.6.
      const { pool, probe } = isolatedTarget(1200, 44, TARGET, COS);
      await legacyIndexedTable(pool);

      const hit = (await new LanceVectorStore({ root }).search(PROJECT, probe, 10)).find(
        (h) => h.row.id === TARGET_ID,
      );
      expect(hit).toBeDefined();
      expect(hit!.score).toBeCloseTo(COS, 4);
    });

    it("keeps a fixed-threshold consumer's decision the same above the threshold", async () => {
      // `filterByScoreThreshold` (graph-context-builder, default 0.3) keeps a chunk at
      // cosine 0.6 on a small project. Scored 2·0.6 − 1 = 0.2 on an indexed one, the
      // same chunk was dropped.
      const { pool, probe } = isolatedTarget(1200, 55, TARGET, COS);
      await legacyIndexedTable(pool);

      const hits = await new LanceVectorStore({ root }).search(PROJECT, probe, 10);
      const kept = filterByScoreThreshold(hits, 0.3).map((h) => h.row.id);
      expect(kept).toContain(TARGET_ID);
    });
  },
);
