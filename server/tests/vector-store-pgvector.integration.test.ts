/**
 * Issue #543 (epic #518) — end-to-end proof that the pgvector-backed vector store
 * gives RAG retrieval parity AND multi-replica read/write safety against a REAL
 * Postgres, using two separately-constructed store instances (= two pods) that
 * share one database.
 *
 *   "Vectors written via one store instance are searchable via a SEPARATE
 *    instance sharing the backend (cross-replica), top-k ranks the expected docs
 *    (parity), and two instances can write AND read concurrently with no
 *    corruption (the LanceDB single-writer failure mode is gone)."
 *
 * Gated exactly like rate-limit-store-postgres.integration.test.ts and
 * sso-state-store-postgres.integration.test.ts: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (via
 * `pnpm test:integration`). In CI a `postgres:16-alpine` service is provided with
 * the `pgvector` extension created on first use by the store itself (no migration,
 * no schema setup beyond a reachable Postgres with CREATE EXTENSION rights — the
 * stock postgres image ships the `vector` extension control files via the
 * pgvector image; CI uses `pgvector/pgvector:pg16`, see ci.yml). Locally it is
 * skipped unless those conditions hold, so the default `pnpm test` never needs a
 * live database.
 *
 * Assertions are on store/retrieve MECHANICS + dimension, never embedding quality:
 * we use deterministic hand-built unit vectors so ranking is exact regardless of
 * whether a real embedder or the hash fallback is configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgVectorStore } from "../src/lib/rag/vector-store-pgvector.js";
import type { VectorRow } from "../src/lib/rag/vector-store.js";
import {
  ensurePgTestSchema,
  isPostgresUrl,
  makeSchemaScopedPrismaClient,
} from "./lib/pg/pg-test-schema.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgresUrl(databaseUrl);

// Issue #806 — this suite owns a PRIVATE Postgres schema, so its `rag_vectors` cannot
// collide with any other suite's. The width is therefore a purely LOCAL choice: 16 here vs
// the reindex-lease suite's 8 is deliberate PROOF that different-width suites now coexist in
// one CI run. `search_path=<schema>,public` is pinned at connect time by the helper.
const SCHEMA = "metis_it_vecstore";
const DIM = 16;

function vec(seed: number): number[] {
  // A deterministic unit-ish vector pointing mostly along axis `seed`.
  const v = new Array<number>(DIM).fill(0);
  v[seed % DIM] = 1;
  return v;
}

function row(id: string, v: number[], extra: Partial<VectorRow["metadata"]> = {}): VectorRow {
  return {
    id,
    vector: v,
    metadata: {
      chunkId: id,
      documentId: extra.documentId ?? "doc-1",
      filename: extra.filename ?? "f.md",
      position: extra.position ?? 0,
      text: extra.text ?? id,
      embeddingModel: extra.embeddingModel ?? "it-model",
      ...extra,
    },
  };
}

describe.runIf(enabled)("PgVectorStore parity + multi-replica safety (integration)", () => {
  // Every client the suite builds is pinned to this suite's private schema at connect time.
  const prisma = makeSchemaScopedPrismaClient(SCHEMA, databaseUrl);

  // Two SEPARATELY-CONSTRUCTED stores sharing ONE Postgres = two replicas/pods.
  const replicaA = new PgVectorStore({ db: prisma, dimension: DIM });
  const replicaB = new PgVectorStore({ db: prisma, dimension: DIM });

  // Unique project per run so reruns / parallel jobs never collide.
  const project = `it-pgvec-${Date.now()}`;

  beforeAll(async () => {
    // Create the private schema + the DATABASE-scoped `vector` extension in `public`.
    await ensurePgTestSchema(SCHEMA, databaseUrl);
  });

  beforeEach(async () => {
    await replicaA.dropTable(project);
  });

  afterAll(async () => {
    await replicaA.dropTable(project);
    await prisma.$disconnect();
  });

  it("retrieval parity: top-k returns the nearest docs in rank order", async () => {
    await replicaA.upsert(project, [
      row("near", vec(0), { text: "near" }),
      row("mid", vec(1), { text: "mid" }),
      row("far", vec(4), { text: "far" }),
    ]);
    // Query along axis 0 -> "near" exact match first.
    const hits = await replicaA.search(project, vec(0), 3);
    expect(hits[0]?.row.id).toBe("near");
    expect(hits[0]?.score).toBeGreaterThan(0.99); // cosine ~1 for the exact match
    // Ranked, descending similarity.
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });

  it("cross-replica: vectors written on replica A are searchable on replica B", async () => {
    await replicaA.upsert(project, [row("x", vec(2), { text: "written-by-A" })]);
    const hits = await replicaB.search(project, vec(2), 1);
    expect(hits[0]?.row.metadata.text).toBe("written-by-A");
  });

  it("MULTI-REPLICA: two instances write AND read concurrently with no corruption", async () => {
    // Concurrent writes from both "pods" to the SAME project — the LanceDB
    // single-writer corruption mode cannot occur; Postgres serializes the writes.
    await Promise.all([
      replicaA.upsert(project, [row("a", vec(0), { text: "from-A" })]),
      replicaB.upsert(project, [row("b", vec(1), { text: "from-B" })]),
    ]);
    expect(await replicaA.count(project)).toBe(2);
    expect(await replicaB.count(project)).toBe(2);

    // Concurrent reads from both pods both see the full, uncorrupted set.
    const [hitsA, hitsB] = await Promise.all([
      replicaA.search(project, vec(0), 10),
      replicaB.search(project, vec(1), 10),
    ]);
    expect(hitsA.map((h) => h.row.id).sort()).toEqual(["a", "b"]);
    expect(hitsB.map((h) => h.row.id).sort()).toEqual(["a", "b"]);

    // A delete on B is visible on A (shared state).
    await replicaB.deleteByDocument(project, "doc-1");
    expect(await replicaA.count(project)).toBe(0);
  });

  it("namespace isolation: a search never crosses project boundaries", async () => {
    const other = `${project}-other`;
    await replicaA.upsert(project, [row("here", vec(3), { text: "here" })]);
    await replicaA.upsert(other, [row("there", vec(3), { text: "there" })]);
    const hits = await replicaB.search(project, vec(3), 10);
    expect(hits.every((h) => h.row.metadata.text === "here")).toBe(true);
    await replicaA.dropTable(other);
  });

  it("swapTable atomically relabels a freshly-built shadow over the live namespace", async () => {
    const shadow = `${project}__shadow`;
    await replicaA.upsert(project, [row("old", vec(0), { text: "old" })]);
    await replicaA.upsert(shadow, [row("new", vec(1), { text: "new" })]);
    await replicaA.swapTable(project, shadow);
    expect(await replicaB.count(project)).toBe(1);
    expect(await replicaB.count(shadow)).toBe(0);
    const hits = await replicaB.search(project, vec(1), 1);
    expect(hits[0]?.row.metadata.text).toBe("new");
  });
});
