/**
 * Issue #783 — THE 384 → 768 UPGRADE GUARD.
 *
 * The default embedding model moved from 384 dims (bge-small) to 768
 * (gte-modernbert). Existing deployments have vector tables full of 384-dim rows.
 * The invariant this file defends is one sentence:
 *
 *   384-dim and 768-dim vectors are NEVER compared, and never land in one table.
 *
 * Retrieval is already safe by construction — chunks are model-TAGGED and
 * `KnowledgeService.search()` filters to the ACTIVE model, so old-generation
 * vectors are ignored rather than mixed (asserted below, because that property is
 * load-bearing and lives elsewhere). The WRITE path is what needed a guard: a
 * 768-dim row heading for a 384-dim table would otherwise surface as whatever the
 * storage engine happens to say ("expected 384 dimensions, not 768", an arrow
 * schema error), from inside an ingest, naming nothing that would lead an operator
 * to the embedding-model change that actually caused it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEmbedderSingleton } from "../src/lib/rag/embedder.js";
import { PgVectorStore } from "../src/lib/rag/vector-store-pgvector.js";
import {
  LocalVectorStore,
  VectorDimensionMismatchError,
  assertVectorDimension,
  type VectorRow,
} from "../src/lib/rag/vector-store.js";

function row(id: string, dim: number, model: string): VectorRow {
  return {
    id,
    vector: new Array<number>(dim).fill(1 / Math.sqrt(dim)),
    metadata: {
      documentId: "doc-1",
      chunkId: id,
      filename: "f.md",
      position: 0,
      text: "hello",
      embeddingModel: model,
    },
  };
}

describe("assertVectorDimension", () => {
  it("passes when the widths agree", () => {
    expect(() =>
      assertVectorDimension({ projectId: "p1", stored: 768, incoming: 768, where: "x" }),
    ).not.toThrow();
  });

  it("throws a typed, ACTIONABLE error naming both widths and the reindex route", () => {
    let caught: unknown;
    try {
      assertVectorDimension({
        projectId: "p1",
        stored: 384,
        incoming: 768,
        where: "the Lance vector table",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VectorDimensionMismatchError);
    const err = caught as VectorDimensionMismatchError;
    expect(err.code).toBe("VECTOR_DIMENSION_MISMATCH");
    expect(err.storedDimension).toBe(384);
    expect(err.embedderDimension).toBe(768);
    // An operator reading only this message must be able to act on it.
    expect(err.message).toContain("384-dim");
    expect(err.message).toContain("768-dim");
    expect(err.message).toContain("/api/admin/embeddings/projects/p1/reindex");
    expect(err.message).toMatch(/EMBED_MODEL/);
  });

  it("omits the per-project reindex route for a deployment-wide store", () => {
    const err = new VectorDimensionMismatchError({
      stored: 384,
      incoming: 768,
      where: 'the shared pgvector table "rag_vectors"',
    });
    expect(err.projectId).toBeNull();
    expect(err.message).toContain("Reindex every project");
    expect(err.message).not.toContain("/reindex");
  });
});

describe("LocalVectorStore — mixed-generation safety", () => {
  let root: string;
  let store: LocalVectorStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "metis-vec-"));
    store = new LocalVectorStore({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("IGNORES stale-generation vectors instead of comparing across widths", async () => {
    // The upgrade shape: a project holding 384-dim bge rows, now being searched by
    // a 768-dim gte embedder. The model filter (what KnowledgeService.search
    // passes) must exclude the old rows entirely — the query never touches them.
    await store.ensureTable("p1");
    // Two batches, as a real upgrade produces them: the 384-dim rows were written
    // by the old model and are still on disk; the new model writes 768-dim rows
    // beside them. (One MIXED batch is rejected — see the upsert guard below.)
    await store.upsert("p1", [row("old-1", 384, "Xenova/bge-small-en-v1.5")]);
    await store.upsert("p1", [row("new-1", 768, "Alibaba-NLP/gte-modernbert-base")]);

    const query = new Array<number>(768).fill(0.02);
    const hits = await store.search("p1", query, 10, {
      embeddingModel: "Alibaba-NLP/gte-modernbert-base",
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].row.id).toBe("new-1");
  });

  it("REFUSES a cross-width comparison rather than scoring one", async () => {
    // The only way to reach this is to ask for the old rows with the new embedder
    // (or to have poisoned one model id with two widths — see the hash-fallback
    // test). Either way it is a bug, and a wrong ranking would be worse than an
    // error, because a wrong ranking is invisible.
    await store.ensureTable("p1");
    await store.upsert("p1", [row("old-1", 384, "Xenova/bge-small-en-v1.5")]);

    const query = new Array<number>(768).fill(0.02);
    await expect(
      store.search("p1", query, 10, { embeddingModel: "Xenova/bge-small-en-v1.5" }),
    ).rejects.toThrow(VectorDimensionMismatchError);
  });

  it("REFUSES an upsert batch of mixed width — the write fails, not a later read", async () => {
    // The PR's claim is that the local store guards on upsert AND search. This is
    // the upsert half: a JSON file (unlike a Lance/pgvector table) would otherwise
    // swallow a mixed-width batch silently, and the caller would only learn of it
    // at some unrelated search later. A caller mixing widths in one batch is a bug.
    await store.ensureTable("p1");
    await expect(
      store.upsert("p1", [
        row("a", 768, "Alibaba-NLP/gte-modernbert-base"),
        row("b", 384, "Xenova/bge-small-en-v1.5"),
      ]),
    ).rejects.toThrow(VectorDimensionMismatchError);
    // And nothing was written — the batch is refused whole.
    expect(await store.count("p1")).toBe(0);
  });

  it("serves a same-width project exactly as before", async () => {
    await store.ensureTable("p1");
    await store.upsert("p1", [row("a", 768, "Alibaba-NLP/gte-modernbert-base")]);
    const hits = await store.search("p1", new Array<number>(768).fill(0.02), 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeGreaterThan(0);
  });
});

describe("PgVectorStore — EMBED_DIM vs the ACTIVE EMBEDDER (#783)", () => {
  // The blind spot in the column guard. It compares the pgvector column against the
  // store's CONFIGURED width (EMBED_DIM) — so a leftover `EMBED_DIM=384` (which the
  // pre-#783 .env.example suggested!) gives column 384 == configured 384, the guard
  // PASSES, and the xenova embedder — which ignores EMBED_DIM entirely — then emits
  // 768-dim vectors into a vector(384) column, dying one row at a time mid-ingest.
  // The number that is never consulted is the only one that matters: the embedder's.
  const ORIGINAL_OFFLINE = process.env.AI_OFFLINE;
  const ORIGINAL_DIM = process.env.EMBED_DIM;

  function fakeDb(): { db: PrismaClient; ddl: ReturnType<typeof vi.fn> } {
    const ddl = vi.fn(async () => 0);
    const db = {
      $executeRawUnsafe: ddl,
      // The column probe (tagged-template `$queryRaw`). No row → "a width we cannot
      // establish is never enforced", so the column guard is a no-op here and the
      // EMBEDDER guard is what these tests isolate.
      $queryRaw: vi.fn(async () => [] as unknown[]),
    } as unknown as PrismaClient;
    return { db, ddl };
  }

  beforeEach(() => {
    // The suite's setup pins AI_OFFLINE=1 (→ the 384-dim hash stub). Clear it so the
    // ACTIVE embedder is the real default: xenova / gte-modernbert-base, 768-dim.
    // Constructing it loads no model — the width is known from the constructor.
    delete process.env.AI_OFFLINE;
    __resetEmbedderSingleton();
  });

  afterEach(() => {
    if (ORIGINAL_OFFLINE === undefined) delete process.env.AI_OFFLINE;
    else process.env.AI_OFFLINE = ORIGINAL_OFFLINE;
    if (ORIGINAL_DIM === undefined) delete process.env.EMBED_DIM;
    else process.env.EMBED_DIM = ORIGINAL_DIM;
    __resetEmbedderSingleton();
  });

  it("REFUSES to bootstrap when EMBED_DIM disagrees with the embedder — before any DDL", async () => {
    const { db, ddl } = fakeDb();
    // The upgrade config, exactly as `getVectorStore()` builds it: EMBED_DIM=384
    // survived from the pre-#783 default, so the store is sized 384 — while the
    // active xenova embedder ignores EMBED_DIM and emits 768.
    process.env.EMBED_DIM = "384";
    const store = new PgVectorStore({ db, dimension: 384 });

    await expect(store.ensureTable("p1")).rejects.toThrow(
      /Embedding dimension misconfiguration[\s\S]*EMBED_DIM/,
    );
    // The naming test: the message must lead the operator to the env var, not to a
    // reindex (nothing is stored wrong yet) and not to Postgres.
    await expect(store.ensureTable("p1")).rejects.toThrow(/UNSET EMBED_DIM/);
    // And it must fire BEFORE the CREATE TABLE — a vector(384) column must never be
    // created for a 768-dim embedder in the first place.
    expect(ddl).not.toHaveBeenCalled();
  });

  it("bootstraps normally when the configured width matches the embedder", async () => {
    const { db, ddl } = fakeDb();
    process.env.EMBED_DIM = "768";
    const store = new PgVectorStore({ db, dimension: 768 });
    await expect(store.ensureTable("p1")).resolves.toBeUndefined();
    expect(ddl).toHaveBeenCalledTimes(1);
    expect(ddl.mock.calls[0][0]).toContain("vector(768)");
  });

  it("leaves a programmatically-supplied width alone when EMBED_DIM is unset", async () => {
    // The guard's subject is a STALE ENV VAR. With EMBED_DIM unset, getVectorStore()
    // passes no dimension at all and the store derives it from the embedder, so the
    // two agree by construction. A caller that constructs the store directly with an
    // explicit width (tests, the reindex tooling) has made a deliberate choice and
    // must not be second-guessed by a guard about an env var it never set.
    const { db, ddl } = fakeDb();
    delete process.env.EMBED_DIM;
    const store = new PgVectorStore({ db, dimension: 1024 }); // e.g. a Titan-sized table
    await expect(store.ensureTable("p1")).resolves.toBeUndefined();
    expect(ddl.mock.calls[0][0]).toContain("vector(1024)");
  });
});
