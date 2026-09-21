/**
 * Epic #518 (#543) — pgvector-backed vector store (multi-replica safe).
 *
 * Background. The RAG vector store originally used embedded LanceDB
 * ({@link LanceVectorStore} in vector-store.ts): a per-pod local directory under
 * `LANCEDB_PATH`. LanceDB is a single-writer embedded store — two replicas (EKS
 * HPA, N pods behind a load balancer) writing to the same data dir, even on an
 * EFS RWX volume, corrupt the index. That made the RAG layer NOT multi-replica
 * safe and is one of the last blockers to lifting `server.replicaCount=1`.
 *
 * This module adds a {@link PgVectorStore} behind the SAME {@link VectorStore}
 * interface, selected by `VECTOR_STORE=pgvector`. It stores embeddings in the
 * shared Postgres (#539's `DATABASE_URL`-scheme-selected adapter) using the
 * `pgvector` extension, so every replica reads AND writes the same vectors with
 * Postgres providing the concurrency control LanceDB lacked.
 *
 * Why pgvector (not Qdrant/Pinecone): identical to the #541/#542 rationale —
 * #539 already gives us a shared, replica-safe Postgres, so pgvector reuses it
 * with NO new managed service / failure domain / cost. The METIS RAG corpus is
 * well within pgvector's envelope; an external dedicated vector DB is revisited
 * only if corpus size / query latency later exceed it (documented in
 * docs/EKS_DEPLOYMENT.md as a future trigger, not now).
 *
 * Storage — ONE self-managed table, namespaced by `project_id`:
 *
 *   CREATE TABLE rag_vectors (
 *     project_id TEXT, id TEXT, embedding vector(<dim>),
 *     text, document_id, chunk_index, filename, model, created_at,
 *     PRIMARY KEY (project_id, id)
 *   )
 *
 *   A single table keyed by `(project_id, id)` keeps namespace isolation (every
 *   query is scoped `WHERE project_id = $1`, so cross-project leakage is
 *   impossible) without the table-per-project sprawl LanceDB used — Postgres
 *   handles thousands of projects in one indexed table far better than thousands
 *   of tables.
 *
 * Why self-managed (not a Prisma migration): the `embedding` column's dimension
 * is derived from the *configured embedder at runtime* (384 default, 768/512/...
 * for EmbeddingGemma) — a static Prisma migration cannot express a runtime-
 * derived `vector(N)` type, and a re-embed to a new model legitimately changes
 * it. So, exactly like the #541 rate-limit counter and the #542 SSO-state table,
 * this is RAG *infrastructure*, created idempotently behind a transaction-scoped
 * advisory lock and kept OUT of `schema.prisma` (and thus out of the dual-schema
 * parity guard + migration history). It is a LOGGED table (unlike those two
 * ephemeral UNLOGGED tables) because vectors are durable corpus state, not
 * seconds-lived counters — though they remain regenerable from source by a
 * re-embed (see the backfill path in docs/ARCHITECTURE.md).
 *
 * Index — HNSW. RAG is read-heavy (many top-k searches per write), and HNSW
 * gives markedly better recall/latency than IVFFlat for that profile, with no
 * "train on representative data first" step (IVFFlat's centroids must be built
 * after enough rows exist, awkward for incrementally-grown per-project corpora).
 * HNSW's higher build cost / memory is acceptable at METIS corpus scale. The
 * index is `vector_cosine_ops` because retrieval ranks by cosine similarity
 * (matching the LanceDB path's `metricType("cosine")`); `<=>` is cosine distance,
 * so similarity = 1 - distance.
 *
 * Security (OWASP A03 — injection): every value (project ids, ids, vectors,
 * filter terms) is bound via Prisma parameterised queries (`$queryRaw` tagged
 * templates / explicit `$N` placeholders), never string-interpolated. The only
 * interpolated token anywhere is the fixed table name and the integer dimension
 * in the one-time DDL — neither is user input.
 */
import { DEFAULT_EMBED_DIMENSION } from "@metis/shared";
import type { Prisma, PrismaClient } from "@prisma/client";

import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";

import { getEmbedder } from "./embedder.js";
import { reindexSwapMaxWaitMs, reindexSwapTimeoutMs } from "./reindex-swap-budget.js";
import {
  assertVectorGeneration,
  type ProjectVectorWrite,
  type VectorGeneration,
} from "./project-vector-write.js";
import {
  __setPgVectorStoreFactory,
  assertVectorDimension,
  type ModelCoverage,
  type RawSqlExecutor,
  type SearchFilter,
  type SearchHit,
  type StoredChunkRef,
  type SwapGuard,
  type VectorRow,
  type VectorStore,
  type VectorStoreOptions,
} from "./vector-store.js";

const log = createChildLogger("pgvector-store");

/** Self-managed vectors table. Quoted, fixed identifier — never interpolated. */
const TABLE = "rag_vectors";

/**
 * Fixed advisory-lock id guarding the concurrent extension+table create.
 * Arbitrary but stable, and distinct from the #541 (541_000_001) and #542
 * (542_000_001) lock ids so those creates never serialize against this one.
 */
const TABLE_LOCK_ID = 543_000_001;

// Issue #798 — the swap's wall-clock budget lives in its own leaf module, because the
// LEASE needs the same number (it renews `expires_at` to cover the transaction it
// fences). Re-exported here so this file stays the one place callers look for it.
export {
  DEFAULT_REINDEX_SWAP_MAX_WAIT_MS,
  DEFAULT_REINDEX_SWAP_TIMEOUT_MS,
  MAX_REINDEX_SWAP_MAX_WAIT_MS,
  MAX_REINDEX_SWAP_TIMEOUT_MS,
  reindexSwapMaxWaitMs,
  reindexSwapTimeoutMs,
} from "./reindex-swap-budget.js";

/** Options for {@link PgVectorStore}. */
export interface PgVectorStoreOptions {
  /** Shared Prisma client (defaults to the process singleton). */
  db?: PrismaClient;
  /**
   * Embedding dimension for the `vector(N)` column. When omitted it is derived
   * from the configured embedder ({@link getEmbedder}().dimension), falling back
   * to {@link DEFAULT_EMBED_DIMENSION}. NEVER hardcoded blindly — a non-384
   * embedder (e.g. EmbeddingGemma 768) must size the column to match or every
   * insert/search would be rejected by Postgres for a dimension mismatch.
   */
  dimension?: number;
}

interface PgVectorRow {
  id: string;
  embedding: unknown;
  text: string;
  document_id: string;
  chunk_index: number | bigint;
  filename: string;
  model: string;
}

/**
 * pgvector-backed {@link VectorStore}. Multi-replica safe: all state lives in the
 * shared Postgres, so two separately-constructed instances (= two pods) read and
 * write the same vectors with Postgres serializing concurrent writers — the
 * LanceDB single-writer corruption mode is gone.
 */
export class PgVectorStore implements VectorStore {
  private readonly db: PrismaClient;
  private readonly dimension: number;
  /** Lazily-run, memoised extension+table bootstrap (one DDL per process). */
  private ensured: Promise<void> | undefined;
  private generationsEnsured: Promise<void> | undefined;

  constructor(opts: PgVectorStoreOptions = {}) {
    this.db = opts.db ?? defaultPrisma;
    const derived = opts.dimension ?? resolveEmbedDimension();
    if (!Number.isInteger(derived) || derived <= 0) {
      throw new Error(`PgVectorStore: invalid embedding dimension ${String(derived)}`);
    }
    this.dimension = derived;
  }

  /**
   * Idempotently enable the `vector` extension, create the vectors table sized to
   * the configured embedding dimension, and build the HNSW cosine index — once
   * per process, serialized by a transaction-scoped advisory lock so two replicas
   * racing the first create don't collide on `pg_type` (the same 23505 race the
   * #541/#542 tables guard against). `IF NOT EXISTS` makes each step a no-op on
   * subsequent boots.
   */
  private ensureSchema(): Promise<void> {
    this.ensured ??= Promise.resolve()
      .then(() => this.assertEmbedderDimension())
      .then(() =>
        this.db.$executeRawUnsafe(
          `DO $$
         BEGIN
           PERFORM pg_advisory_xact_lock(${TABLE_LOCK_ID});
           CREATE EXTENSION IF NOT EXISTS vector;
           CREATE TABLE IF NOT EXISTS "${TABLE}" (
             "project_id"  TEXT          NOT NULL,
             "id"          TEXT          NOT NULL,
             "embedding"   vector(${this.dimension}) NOT NULL,
             "text"        TEXT          NOT NULL DEFAULT '',
             "document_id" TEXT          NOT NULL DEFAULT '',
             "chunk_index" INTEGER       NOT NULL DEFAULT 0,
             "filename"    TEXT          NOT NULL DEFAULT '',
             "model"       TEXT          NOT NULL DEFAULT '',
             "created_at"  BIGINT        NOT NULL DEFAULT 0,
             PRIMARY KEY ("project_id", "id")
           );
           CREATE INDEX IF NOT EXISTS "${TABLE}_embedding_hnsw"
             ON "${TABLE}" USING hnsw ("embedding" vector_cosine_ops);
           CREATE INDEX IF NOT EXISTS "${TABLE}_project_doc"
             ON "${TABLE}" ("project_id", "document_id");
         EXCEPTION WHEN duplicate_table OR duplicate_object THEN
           -- Another replica won the create race; the objects already exist.
           NULL;
         END $$;`,
        ),
      )
      .then(() => this.assertColumnDimension())
      .catch((err) => {
        // Reset the memo so a transient failure can be retried on the next call.
        this.ensured = undefined;
        throw err;
      });
    return this.ensured;
  }

  /**
   * Issue #783 — the guard that {@link assertColumnDimension} cannot see.
   *
   * That guard compares the column against the store's CONFIGURED width, which
   * `getVectorStore()` sources from `EMBED_DIM`. So it is blind to the single most
   * likely upgrade config there is: a leftover `EMBED_DIM=384` — which the pre-#783
   * `.env.example` literally suggested. `EMBED_DIM` is a NO-OP for the `xenova` and
   * `sidecar` backends (only `embeddinggemma` reads it, for Matryoshka truncation),
   * so that operator gets column 384 = configured 384 — the column guard PASSES,
   * boot is clean — while the active embedder emits 768-dim vectors. Every insert
   * then dies inside Postgres with "expected 384 dimensions, not 768", one row at a
   * time, from deep inside an ingest: exactly the failure the column guard exists to
   * replace.
   *
   * So: assert the configured width against the width the embedder ACTUALLY produces.
   * These two can only ever disagree by misconfiguration, and the fix is not a
   * reindex — it is to stop pinning `EMBED_DIM` — so this gets its own error that
   * says so.
   */
  private assertEmbedderDimension(): void {
    // Scoped to an EXPLICITLY PINNED `EMBED_DIM`, because that is the whole story:
    // it is the only way the store's width can be something other than the
    // embedder's (unset → `getVectorStore` passes no dimension → the store derives
    // it from `getEmbedder()`, and the two agree by construction). A width handed
    // in programmatically by a caller constructing the store directly is that
    // caller's deliberate choice, not a stale env var, and is left alone.
    if (!process.env.EMBED_DIM) return;

    let embedderDim: number;
    try {
      embedderDim = getEmbedder().dimension;
    } catch {
      // The embedder cannot even be CONSTRUCTED (e.g. a cloud backend with no
      // credentials). That failure is loud on its own at the first embed() call and
      // it is not this guard's story to tell. Same principle the column guard
      // applies: a width we cannot ESTABLISH is never ENFORCED.
      return;
    }
    if (embedderDim === this.dimension) return;
    // Deliberately NOT a VectorDimensionMismatchError: nothing is stored wrong yet
    // and a reindex would not help. The config is wrong, and the fix is one line of
    // env — so the error says that instead.
    throw new Error(
      `Embedding dimension misconfiguration: the vector store is configured for ` +
        `${this.dimension}-dim vectors (EMBED_DIM=${this.dimension}), but the active embedder ` +
        `("${getEmbedder().model}", backend "${getEmbedder().key}") produces ${embedderDim}-dim ` +
        `vectors. The pgvector column would be sized ${this.dimension} and EVERY insert would be ` +
        `rejected by Postgres ("expected ${this.dimension} dimensions, not ${embedderDim}") in the ` +
        `middle of an ingest.\n` +
        `EMBED_DIM does NOT resize the xenova/sidecar backends — it is only read by ` +
        `embeddinggemma (Matryoshka) and the cloud backends. Fix: UNSET EMBED_DIM (recommended — ` +
        `the store then derives ${embedderDim} from the embedder), or set EMBED_DIM=${embedderDim}. ` +
        `A leftover EMBED_DIM=384 from the pre-#783 384-dim default is the usual cause.`,
    );
  }

  /**
   * Issue #783 — the guard that keeps an EXISTING deployment from writing a new
   * vector generation into an old one's column.
   *
   * `CREATE TABLE IF NOT EXISTS … vector(768)` is a NO-OP against a table that is
   * already `vector(384)`: the DDL above cannot move the column, and it does not
   * complain. Every subsequent insert then fails inside Postgres with "expected
   * 384 dimensions, not 768" — an error that names the widths but not the CAUSE,
   * arrives one row at a time from deep in an ingest, and tells the operator
   * nothing about the embedding-model change that actually happened.
   *
   * So we read the column's real width straight out of the catalog (pgvector
   * stores the dimension in `atttypmod`) and refuse the whole store, once, at
   * boot, with an error that names the fix. Postgres would have rejected the
   * writes anyway — the point is that this rejection is COMPREHENSIBLE, and that
   * it lands before an ingest is half-done.
   */
  private async assertColumnDimension(): Promise<void> {
    // `to_regclass` takes its argument as TEXT, so this is one of the rare catalog
    // reads that parameterises cleanly — no dynamic identifier, and no
    // `$queryRawUnsafe` left in this file for a future auditor (or a Semgrep rule)
    // to have to clear. `TABLE` is a module constant either way.
    const rows = await this.db.$queryRaw<Array<{ dim: number | null }>>`
      SELECT a.atttypmod AS dim
        FROM pg_attribute a
       WHERE a.attrelid = to_regclass(${`"${TABLE}"`})
         AND a.attname = 'embedding'
         AND NOT a.attisdropped`;
    const raw = rows[0]?.dim;
    // No row → the table vanished between the DDL and this read (impossible in
    // practice). -1 → an unconstrained `vector` column, which this store never
    // creates. Neither is a mismatch we can prove, so neither is one we assert.
    if (raw === undefined || raw === null) return;
    const stored = Number(raw);
    if (!Number.isInteger(stored) || stored <= 0) return;
    assertVectorDimension({
      stored,
      incoming: this.dimension,
      where: `the shared pgvector table "${TABLE}"`,
    });
  }

  async ensureTable(projectId: string): Promise<void> {
    assertProjectId(projectId);
    await this.ensureSchema();
  }

  async withProjectWrite<T>(
    projectId: string,
    fn: (write: ProjectVectorWrite) => Promise<T>,
  ): Promise<T> {
    assertProjectId(projectId);
    await this.ensureSchema();
    // LOGGED, durable corpus metadata; speculative rows are not its authority.
    this.generationsEnsured ??= this.db
      .$executeRawUnsafe(
        `DO $$
      BEGIN
        PERFORM pg_advisory_xact_lock(543000002);
        CREATE TABLE IF NOT EXISTS rag_vector_generations (
          project_id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          dimension INTEGER NOT NULL CHECK (dimension > 0),
          pending BOOLEAN NOT NULL
        );
      END $$;`,
      )
      .then(() => undefined)
      .catch((error) => {
        this.generationsEnsured = undefined;
        throw error;
      });
    await this.generationsEnsured;
    return this.db.$transaction(
      async (tx) => {
        // Transaction lifetime, not a TTL. All participating SQL and vector writes
        // below use this exact connection; never nest swap's transaction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(543000003, hashtext(${projectId}))`;
        return fn({
          sql: tx,
          upsert: (id, rows) => this.upsert(id, rows, tx),
          deleteByChunkIds: (id, ids) => this.deleteByChunkIds(id, ids, tx),
          listChunkRefs: (id) => this.listChunkRefs(id, tx),
          swapTable: (id, shadow, guard) => this.swapTable(id, shadow, guard, tx),
          async readGeneration() {
            const rows = await tx.$queryRaw<VectorGeneration[]>`
            SELECT model, dimension, pending FROM rag_vector_generations
            WHERE project_id = ${projectId}`;
            if (!rows.length) return null;
            assertVectorGeneration(rows[0]);
            return rows[0];
          },
          async writeGeneration(generation) {
            assertVectorGeneration(generation);
            await tx.$executeRaw`
            INSERT INTO rag_vector_generations (project_id, model, dimension, pending)
            VALUES (${projectId}, ${generation.model}, ${generation.dimension}, ${generation.pending})
            ON CONFLICT (project_id) DO UPDATE SET model = EXCLUDED.model,
              dimension = EXCLUDED.dimension, pending = EXCLUDED.pending`;
          },
        });
      },
      { timeout: reindexSwapTimeoutMs(), maxWait: reindexSwapMaxWaitMs() },
    );
  }

  async dropTable(projectId: string): Promise<void> {
    assertProjectId(projectId);
    await this.ensureSchema();
    await this.db.$executeRaw`DELETE FROM "rag_vectors" WHERE "project_id" = ${projectId}`;
  }

  /**
   * Atomically replace `projectId`'s rows with `shadowProjectId`'s, then drop the
   * shadow — the reindex swap (issue #941). Done inside ONE transaction so a
   * mid-swap failure leaves the live namespace untouched (the shadow still holds
   * every row, recoverable). No table rename needed: namespaces are just a column
   * value, so the swap is a delete-then-relabel within the same table.
   *
   * Issue #798 — when a {@link SwapGuard} is supplied (the reindex lease), it is
   * re-checked INSIDE this transaction, before the destructive DELETE. This is the one
   * place in the reindex where an INTERACTIVE transaction is warranted: it is what makes
   * "I still hold the lease" and "the shadow is now live" a single atomic fact. The
   * guard's `SELECT … FOR UPDATE` on the lease row means a replica trying to steal the
   * lease must block behind this commit rather than racing it — so the half-open window
   * (renew → long pause → swap) is CLOSED, not merely narrowed. (Proved against a real
   * Postgres in `tests/reindex-lease-postgres.integration.test.ts` (c4/c5).)
   *
   * The GUARD lasts milliseconds; the DELETE + UPDATE it now shares a transaction with
   * do NOT — they rewrite the whole corpus. Hence the explicit deadline: an interactive
   * transaction would otherwise inherit Prisma's 5 s default and abort the cut-over with
   * P2028 on precisely the large corpora this exists to migrate. See
   * {@link DEFAULT_REINDEX_SWAP_TIMEOUT_MS} — that comment is the load-bearing one.
   */
  async swapTable(
    projectId: string,
    shadowProjectId: string,
    guard?: SwapGuard,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    assertProjectId(projectId);
    assertProjectId(shadowProjectId);
    if (transaction) {
      await guard?.assertHeld(transaction as unknown as RawSqlExecutor);
      await transaction.$executeRaw`DELETE FROM "rag_vectors" WHERE "project_id" = ${projectId}`;
      await transaction.$executeRaw`UPDATE "rag_vectors" SET "project_id" = ${projectId} WHERE "project_id" = ${shadowProjectId}`;
      return;
    }
    await this.ensureSchema();
    const shadowCount = await this.count(shadowProjectId);
    if (shadowCount === 0) {
      // Match the LanceDB/Local contract: a swap from a non-existent shadow is an
      // error, not a silent no-op that would wipe the live namespace.
      const liveCount = await this.count(projectId);
      if (liveCount === 0) {
        throw new Error(`swapTable: shadow "${shadowProjectId}" has no rows — nothing to swap in`);
      }
    }
    await this.db.$transaction(
      async (tx) => {
        await guard?.assertHeld(tx as unknown as RawSqlExecutor);
        await tx.$executeRaw`DELETE FROM "rag_vectors" WHERE "project_id" = ${projectId}`;
        await tx.$executeRaw`UPDATE "rag_vectors" SET "project_id" = ${projectId} WHERE "project_id" = ${shadowProjectId}`;
      },
      { timeout: reindexSwapTimeoutMs(), maxWait: reindexSwapMaxWaitMs() },
    );
  }

  async upsert(
    projectId: string,
    rows: VectorRow[],
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    assertProjectId(projectId);
    if (rows.length === 0) return;
    if (!transaction) await this.ensureSchema();

    // One fully-parameterised multi-row INSERT … ON CONFLICT … DO UPDATE. Each
    // row contributes 7 bound params; `model` and `created_at` are shared, bound
    // once at the tail of the list. The embedding is passed as a pgvector literal
    // string ("[a,b,c]") via a bound parameter and CAST to vector, so the vector
    // values are NEVER interpolated into SQL (OWASP A03). Concurrent upserts from
    // two replicas serialize per-row on the (project_id, id) primary key.
    const cols = 7;
    const values: unknown[] = [];
    rows.forEach((r) => {
      if (!Array.isArray(r.vector) || r.vector.length === 0) {
        throw new Error(`vector for row ${r.id} is empty`);
      }
      if (r.vector.length !== this.dimension) {
        throw new Error(
          `vector for row ${r.id} has dimension ${r.vector.length}, store expects ${this.dimension}`,
        );
      }
      values.push(
        projectId,
        r.id,
        toVectorLiteral(r.vector),
        r.metadata.text,
        r.metadata.documentId,
        r.metadata.position,
        r.metadata.filename,
      );
    });
    const modelIdx = rows.length * cols + 1;
    const createdIdx = rows.length * cols + 2;
    const rowTuples = rows
      .map((_r, i) => {
        const b = i * cols;
        return (
          `($${b + 1}, $${b + 2}, $${b + 3}::vector, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, ` +
          `$${modelIdx}, $${createdIdx})`
        );
      })
      .join(", ");
    const insertSql =
      `INSERT INTO "${TABLE}" ` +
      `("project_id", "id", "embedding", "text", "document_id", "chunk_index", "filename", "model", "created_at") ` +
      `VALUES ${rowTuples} ` +
      `ON CONFLICT ("project_id", "id") DO UPDATE SET ` +
      `"embedding" = EXCLUDED."embedding", "text" = EXCLUDED."text", ` +
      `"document_id" = EXCLUDED."document_id", "chunk_index" = EXCLUDED."chunk_index", ` +
      `"filename" = EXCLUDED."filename", "model" = EXCLUDED."model", ` +
      `"created_at" = EXCLUDED."created_at"`;

    const model = rows[0]?.metadata.embeddingModel ?? "";
    await (transaction ?? this.db).$executeRawUnsafe(insertSql, ...values, model, Date.now());
  }

  async deleteByDocument(projectId: string, documentId: string): Promise<number> {
    assertProjectId(projectId);
    await this.ensureSchema();
    const removed = await this.db
      .$executeRaw`DELETE FROM "rag_vectors" WHERE "project_id" = ${projectId} AND "document_id" = ${documentId}`;
    return Number(removed);
  }

  async deleteByChunkIds(
    projectId: string,
    chunkIds: string[],
    transaction?: Prisma.TransactionClient,
  ): Promise<number> {
    assertProjectId(projectId);
    if (chunkIds.length === 0) return 0;
    if (!transaction) await this.ensureSchema();
    // Build a parameterised `IN ($2,$3,…)` list — every id is a bound parameter.
    const placeholders = chunkIds.map((_id, i) => `$${i + 2}`).join(", ");
    const removed = await (transaction ?? this.db).$executeRawUnsafe(
      `DELETE FROM "${TABLE}" WHERE "project_id" = $1 AND "id" IN (${placeholders})`,
      projectId,
      ...chunkIds,
    );
    return Number(removed);
  }

  async count(projectId: string): Promise<number> {
    assertProjectId(projectId);
    await this.ensureSchema();
    const rows = await this.db.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT COUNT(*)::bigint AS n FROM "rag_vectors" WHERE "project_id" = ${projectId}`;
    return Number(rows[0]?.n ?? 0);
  }

  async search(
    projectId: string,
    query: number[],
    k: number,
    filter?: SearchFilter,
  ): Promise<SearchHit[]> {
    assertProjectId(projectId);
    if (k <= 0) return [];
    await this.ensureSchema();

    // Cosine distance `<=>`; similarity = 1 - distance. ORDER BY the distance so
    // pgvector uses the HNSW index. All bound parameters.
    const params: unknown[] = [projectId, toVectorLiteral(query)];
    const where: string[] = [`"project_id" = $1`];
    if (filter?.embeddingModel) {
      params.push(filter.embeddingModel);
      where.push(`"model" = $${params.length}`);
    }
    if (filter?.documentIds && filter.documentIds.length > 0) {
      const start = params.length;
      filter.documentIds.forEach((d) => params.push(d));
      const ph = filter.documentIds.map((_d, i) => `$${start + 1 + i}`).join(", ");
      where.push(`"document_id" IN (${ph})`);
    }
    params.push(k);
    const sql =
      `SELECT "id", "embedding"::text AS embedding, "text", "document_id", "chunk_index", "filename", "model", ` +
      `("embedding" <=> $2::vector) AS distance ` +
      `FROM "${TABLE}" WHERE ${where.join(" AND ")} ` +
      `ORDER BY "embedding" <=> $2::vector LIMIT $${params.length}`;
    const rows = await this.db.$queryRawUnsafe<
      Array<PgVectorRow & { distance: number; embedding: string }>
    >(sql, ...params);
    return rows.map((r) => ({
      row: fromPgRow(r),
      score: 1 - Number(r.distance),
    }));
  }

  async modelCoverage(projectId: string): Promise<ModelCoverage> {
    assertProjectId(projectId);
    await this.ensureSchema();
    const rows = await this.db.$queryRaw<Array<{ model: string; n: bigint | number }>>`
      SELECT "model", COUNT(*)::bigint AS n
      FROM "rag_vectors" WHERE "project_id" = ${projectId}
      GROUP BY "model"`;
    const modelCounts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n);
      modelCounts[r.model || "(unknown)"] = n;
      total += n;
    }
    return { totalChunks: total, modelCounts };
  }

  async listChunkRefs(
    projectId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<StoredChunkRef[]> {
    assertProjectId(projectId);
    if (!transaction) await this.ensureSchema();
    const rows = await (transaction ?? this.db).$queryRaw<
      Array<{ id: string; model: string; dimension: number }>
    >`
      SELECT "id", "model", vector_dims("embedding") AS "dimension"
      FROM "rag_vectors" WHERE "project_id" = ${projectId}`;
    return rows.map((r) => ({
      chunkId: r.id,
      embeddingModel: r.model ?? "",
      dimension: r.dimension ?? 0,
    }));
  }

  /**
   * Issue #787 — the width the shared `embedding` column is actually declared at,
   * read straight from the catalog. `null` when the table does not exist yet, or
   * when the column is unconstrained.
   *
   * Deliberately does NOT go through {@link ensureSchema}: the entire reason an
   * operator needs this number is that `ensureSchema` is REFUSING to run (the
   * #783 column guard threw because the column is 384 and the embedder is 768).
   * A diagnostic that only works when nothing is wrong is not a diagnostic.
   */
  async storedDimension(): Promise<number | null> {
    const rows = await this.db.$queryRaw<Array<{ dim: number | null }>>`
      SELECT a.atttypmod AS dim
        FROM pg_attribute a
       WHERE a.attrelid = to_regclass(${`"${TABLE}"`})
         AND a.attname = 'embedding'
         AND NOT a.attisdropped`;
    const raw = rows[0]?.dim;
    if (raw === undefined || raw === null) return null;
    const stored = Number(raw);
    if (!Number.isInteger(stored) || stored <= 0) return null;
    return stored;
  }

  /**
   * Issue #787 — widen (or narrow) the shared `embedding` column to this store's
   * configured dimension. DESTRUCTIVE, and never called automatically.
   *
   * ## Why this cannot preserve the old vectors
   *
   * `rag_vectors.embedding` is ONE `vector(N)` column shared by every project.
   * pgvector fixes N at the column, so 384-dim and 768-dim rows CANNOT coexist in
   * it — there is no per-row width. That is also why the "just re-run the DDL"
   * instinct fails silently: `CREATE TABLE IF NOT EXISTS … vector(768)` is a no-op
   * against an existing `vector(384)` table, and the first hint anyone gets is
   * Postgres rejecting inserts one row at a time from the middle of an ingest.
   *
   * So the old generation's vectors are DROPPED here. What that costs is nothing
   * that cannot be rebuilt: the chunk TEXT lives in `KnowledgeChunk` (Prisma) and
   * is untouched, so the old index is exactly one `reindexProject` away at any
   * time — pointing `EMBED_MODEL` back at the previous model and reindexing
   * restores it byte-for-byte. Vectors are derived data; text is the source of
   * truth. (An operator who would rather not pay the re-embed on a rollback should
   * `pg_dump -t rag_vectors` first — see docs/EMBEDDINGS_BACKENDS.md.)
   *
   * ## Why nothing here may fail AFTER the drop (PR #796 review, B2)
   *
   * The first cut of this ran `DROP TABLE` in its OWN transaction and only then
   * called `ensureSchema()` — which is precisely the code that can refuse: it runs
   * {@link assertEmbedderDimension} first and {@link assertColumnDimension} last,
   * and both throw. A stale `EMBED_DIM=384` — the exact misconfiguration
   * `assertEmbedderDimension`'s docblock calls "the single most likely upgrade
   * config there is" — therefore dropped the table and then refused to recreate it,
   * leaving the deployment with NO `rag_vectors` table at all. Not a re-widened
   * one, not the old one: none. So:
   *
   *   1. Everything that can refuse the new schema runs BEFORE anything
   *      destructive ({@link assertNotDegraded}, {@link assertEmbedderDimension}).
   *   2. The DROP and the CREATE ship as ONE statement, in ONE transaction, under
   *      the same `pg_advisory_xact_lock` as the bootstrap create — so a failure in
   *      the create (or in either index build) ROLLS THE DROP BACK, and no replica
   *      can observe a window in which the table does not exist.
   *
   * It is a no-op when the widths already agree.
   */
  async migrateColumnDimension(): Promise<{
    from: number | null;
    to: number;
    migrated: boolean;
    droppedRows: number;
  }> {
    // (1) VALIDATE FIRST. Both of these throw, and both are things `ensureSchema()`
    // would previously have refused on with the drop already committed.
    this.assertNotDegraded();
    this.assertEmbedderDimension();

    const from = await this.storedDimension();
    if (from === this.dimension) {
      return { from, to: this.dimension, migrated: false, droppedRows: 0 };
    }
    const droppedRows =
      from === null
        ? 0
        : Number(
            (
              await this.db.$queryRaw<Array<{ n: bigint | number }>>`
                SELECT COUNT(*)::bigint AS n FROM "rag_vectors"`
            )[0]?.n ?? 0,
          );

    // (2) DROP + recreate rather than ALTER: `ALTER COLUMN … TYPE vector(768)`
    // fails on every existing 384-dim row anyway, so an ALTER would have to be
    // preceded by a DELETE of the whole table. Same outcome, more statements.
    //
    // Both halves live in ONE `DO $$` block, which Postgres runs inside a single
    // implicit transaction: if the CREATE throws, the DROP is rolled back with it
    // and the old table is still standing. Two separate statements — the previous
    // shape — cannot offer that, and DDL-in-a-transaction is the one thing Postgres
    // gives us here that most engines do not.
    await this.db.$executeRawUnsafe(
      `DO $$
       BEGIN
         PERFORM pg_advisory_xact_lock(${TABLE_LOCK_ID});
         CREATE EXTENSION IF NOT EXISTS vector;
         DROP TABLE IF EXISTS "${TABLE}";
         CREATE TABLE "${TABLE}" (
           "project_id"  TEXT          NOT NULL,
           "id"          TEXT          NOT NULL,
           "embedding"   vector(${this.dimension}) NOT NULL,
           "text"        TEXT          NOT NULL DEFAULT '',
           "document_id" TEXT          NOT NULL DEFAULT '',
           "chunk_index" INTEGER       NOT NULL DEFAULT 0,
           "filename"    TEXT          NOT NULL DEFAULT '',
           "model"       TEXT          NOT NULL DEFAULT '',
           "created_at"  BIGINT        NOT NULL DEFAULT 0,
           PRIMARY KEY ("project_id", "id")
         );
         CREATE INDEX "${TABLE}_embedding_hnsw"
           ON "${TABLE}" USING hnsw ("embedding" vector_cosine_ops);
         CREATE INDEX "${TABLE}_project_doc"
           ON "${TABLE}" ("project_id", "document_id");
       END $$;`,
    );
    // The table now exists at the configured width. Re-run the memoised bootstrap:
    // its `IF NOT EXISTS` steps no-op, and its two asserts VERIFY the result — the
    // migration's own proof that the column it just built is the one it meant to.
    this.ensured = undefined;
    await this.ensureSchema();

    log.warn("pgvector embedding column migrated to a new dimension", {
      from,
      to: this.dimension,
      droppedRows,
    });
    return { from, to: this.dimension, migrated: true, droppedRows };
  }

  /**
   * PR #796 review (B1), defence in depth — a DEGRADED embedder must never be the
   * dimension source for a destructive column migration.
   *
   * `this.dimension` is derived from `getEmbedder().dimension` whenever `EMBED_DIM`
   * is unset (the recommended config). After a hash fallback the façade reports the
   * STUB's width and the STUB's model id, so a `prepare --force` in that state would
   * drop every vector in the deployment and rebuild the column at the stub's width —
   * a fleet-wide, non-resumable loss, executed by a command whose only gate was the
   * operator's INTENT.
   *
   * The CLI refuses this first (`prepareRefusal`, on `planMigration().blocked`), and
   * that is the gate an operator actually meets. This one exists because the CLI is
   * not the only possible caller and because the destructive statement should carry
   * its own guard.
   *
   * Deliberately SYNCHRONOUS. `fellBack` / `lastError` are only ever set by a warm
   * attempt that has already happened, so this never warms a model, never touches
   * the network, and never fires on a cold-but-healthy embedder — whose reported
   * width is the CONFIGURED backend's, which is the correct target.
   */
  private assertNotDegraded(): void {
    let embedder: ReturnType<typeof getEmbedder>;
    try {
      embedder = getEmbedder();
    } catch {
      // Cannot even be constructed — so it is not the dimension source either (the
      // store fell back to DEFAULT_EMBED_DIMENSION), and that failure is loud on its
      // own. Same principle the other two guards apply: a width we cannot ESTABLISH
      // is never one we ENFORCE.
      return;
    }
    if (!embedder.fellBack && !embedder.lastError) return;
    throw new Error(
      `REFUSING to migrate the "${TABLE}".embedding column: the active embedder is DEGRADED (` +
        (embedder.fellBack
          ? `it has fallen back to the hash stub "${embedder.model}"`
          : `it failed to load: ${embedder.lastError ?? "unknown error"}`) +
        `).\n` +
        `This migration DROPS every vector in the deployment and rebuilds the column at the width ` +
        `the embedder reports — which, after a fallback, is the STUB's width, not the model's. ` +
        `Fix the embedding backend first; \`pnpm embeddings:migrate status\` will confirm it is ` +
        `healthy.`,
    );
  }

  /** Test/admin helper — wipe the whole table. */
  async reset(): Promise<void> {
    await this.db.$executeRawUnsafe(`TRUNCATE TABLE "${TABLE}"`).catch(() => {
      /* table may not exist yet */
    });
  }
}

// ---- Helpers --------------------------------------------------------------

/**
 * Resolve the embedding dimension from the configured embedder, falling back to
 * the shared default. Reading `getEmbedder().dimension` ties the vector column to
 * whatever backend the deployment runs (bge-small 384, EmbeddingGemma 768/512/…)
 * so the column is never sized by a stale hardcoded constant.
 */
export function resolveEmbedDimension(): number {
  try {
    const dim = getEmbedder().dimension;
    if (Number.isInteger(dim) && dim > 0) return dim;
  } catch (err) {
    log.warn("could not resolve embedder dimension, using default", {
      error: (err as Error).message,
      default: DEFAULT_EMBED_DIMENSION,
    });
  }
  return DEFAULT_EMBED_DIMENSION;
}

/** Render a number[] as a pgvector text literal: `[1,2,3]`. Bound, not interpolated. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/** Parse a pgvector text literal (`[1,2,3]`) back to number[]. */
export function parseVectorLiteral(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== "string") return [];
  const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed === "") return [];
  return trimmed.split(",").map((n) => Number(n));
}

function fromPgRow(r: PgVectorRow & { embedding: string | number[] }): VectorRow {
  return {
    id: r.id,
    vector: parseVectorLiteral(r.embedding),
    metadata: {
      chunkId: r.id,
      documentId: r.document_id,
      filename: r.filename,
      position: Number(r.chunk_index),
      text: r.text,
      embeddingModel: r.model,
    },
  };
}

function assertProjectId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("projectId must be a non-empty string");
  }
  // pgvector stores the id as a bound parameter so injection is impossible, but
  // we keep the same defensive guard the LanceDB path used for parity.
  if (id.includes("\0")) {
    throw new Error("invalid projectId (null byte)");
  }
}

/**
 * Register the pgvector store factory with the resolver seam. Importing this
 * module (done at server startup) wires `VECTOR_STORE=pgvector` to
 * {@link PgVectorStore} without `vector-store.ts` statically depending on the
 * Prisma client. The `dimension` from {@link VectorStoreOptions} (set via
 * `EMBED_DIM`) takes precedence; otherwise the store derives it from the embedder.
 */
export function registerPgVectorStore(db: PrismaClient = defaultPrisma): void {
  __setPgVectorStoreFactory(
    (opts: VectorStoreOptions) => new PgVectorStore({ db, dimension: opts.dimension }),
  );
}
