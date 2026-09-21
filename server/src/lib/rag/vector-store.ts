/**
 * Vector store (Phase 5 / issue #42).
 *
 * Two backends share the {@link VectorStore} interface:
 *
 *   1. {@link LanceVectorStore} — production default. Uses `vectordb`
 *      (LanceDB Node) with one table per project under `<root>/<projectId>`.
 *      Persists model metadata so queries can filter by embedder.
 *   2. {@link LocalVectorStore} — dependency-free JSON file backed store
 *      kept for tests and offline mode. Identical surface area; flips on
 *      automatically when `AI_OFFLINE=1` or `VECTOR_STORE=local`.
 *
 * Per-project tables guarantee namespace isolation — there is no global
 * index, so cross-project leakage is structurally impossible. Concurrent
 * writes are serialised per project via an in-process mutex; cross-project
 * writes proceed in parallel.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { DEFAULT_EMBED_DIMENSION, VECTOR_ANN_THRESHOLD } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import {
  withFileProjectWrite,
  type ProjectWriteCapability,
  type ProjectVectorWrite,
} from "./project-vector-write.js";

const log = createChildLogger("vector-store");

// ---- Dimension guard (issue #783) -----------------------------------------

/**
 * Thrown when the active embedder's vector width does not match the width a
 * project's existing vector table was built at.
 *
 * This exists because #783 moved the default model from 384 dims (bge-small) to
 * 768 (gte-modernbert). Retrieval itself is already safe across that boundary —
 * chunks are model-TAGGED and `KnowledgeService.search()` filters to the active
 * model, so old-generation vectors are IGNORED, never compared. The write path is
 * what needs a guard: a 768-dim row heading for a 384-dim table would otherwise
 * surface as whatever raw error the storage engine happens to emit (a pgvector
 * "expected 384 dimensions" from deep inside an INSERT, an opaque Lance schema
 * error), leaving an operator to guess that their embedding MODEL changed.
 *
 * Two vector spaces must never be mixed in one table. So: refuse, and say
 * precisely what happened and what the single fix is.
 */
export interface VectorDimensionMismatch {
  /** Omitted for a deployment-wide store (the shared pgvector table). */
  projectId?: string;
  stored: number;
  incoming: number;
  where: string;
}

export class VectorDimensionMismatchError extends Error {
  readonly code = "VECTOR_DIMENSION_MISMATCH";
  readonly projectId: string | null;
  readonly storedDimension: number;
  readonly embedderDimension: number;

  constructor(opts: VectorDimensionMismatch) {
    const scope = opts.projectId ? ` for project "${opts.projectId}"` : "";
    const reindex = opts.projectId
      ? `Reindex the project — Admin → Embedding backends → Reindex, or ` +
        `POST /api/admin/embeddings/projects/${opts.projectId}/reindex — which re-embeds every ` +
        `chunk with the active model and atomically swaps the table.`
      : `Reindex every project with stored vectors (Admin → Embedding backends → Reindex), which ` +
        `re-embeds their chunks with the active model.`;
    super(
      `Embedding dimension mismatch in ${opts.where}${scope}: the stored vectors are ` +
        `${opts.stored}-dim but the active embedder produces ${opts.incoming}-dim vectors. These ` +
        `are different vector spaces and comparing them is meaningless, so the operation is ` +
        `refused rather than corrupting the index.\n` +
        `This is expected right after an embedding-model change (e.g. the #783 flip from ` +
        `bge-small 384d to gte-modernbert-base 768d). ${reindex} ` +
        `Alternatively, point EMBED_MODEL back at the model these vectors were built with.`,
    );
    this.name = "VectorDimensionMismatchError";
    this.projectId = opts.projectId ?? null;
    this.storedDimension = opts.stored;
    this.embedderDimension = opts.incoming;
  }
}

/** Throw {@link VectorDimensionMismatchError} unless the two widths agree. */
export function assertVectorDimension(opts: VectorDimensionMismatch): void {
  if (opts.stored === opts.incoming) return;
  throw new VectorDimensionMismatchError(opts);
}

// ---- Common types ---------------------------------------------------------

export interface VectorMetadata {
  documentId: string;
  chunkId: string;
  filename: string;
  position: number;
  text: string;
  embeddingModel: string;
  [key: string]: unknown;
}

export interface VectorRow {
  id: string;
  vector: number[];
  metadata: VectorMetadata;
}

export interface SearchHit {
  row: VectorRow;
  score: number;
}

export interface ModelCoverage {
  totalChunks: number;
  modelCounts: Record<string, number>;
}

/**
 * Issue #787 — one stored row's identity, with no vector payload.
 *
 * This is the RESUME CHECKPOINT of a shadow reindex. The shadow table itself is
 * the durable record of "which chunks have already been re-embedded at the new
 * model" — there is no separate progress table to keep in sync with it (and
 * therefore no way for the two to disagree after a `SIGKILL`).
 */
export interface StoredChunkRef {
  chunkId: string;
  embeddingModel: string;
  /** Actual persisted vector width, never configured model metadata. All shipped
   * stores provide it (0 for missing/invalid evidence); optional only for legacy
   * structural test doubles. */
  dimension?: number;
}

/**
 * Issue #798 — the minimal raw-SQL surface a {@link SwapGuard} needs. Structural on
 * purpose: `vector-store.ts` must not import Prisma (the Lance/local stores have no
 * database), but a Prisma transaction client satisfies this shape, so the pgvector
 * store can hand its `tx` straight to the guard.
 */
export interface RawSqlExecutor {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Issue #798 — a fence the caller may attach to {@link VectorStore.swapTable}: the
 * store re-asserts, as late as it possibly can, that the caller is still ALLOWED to
 * cut its shadow over the live index.
 *
 * The reindex lease implements this. A store with a transactional swap (pgvector)
 * MUST call it INSIDE that transaction, passing the transaction client, so the check
 * and the cut-over commit together and a concurrent lease steal cannot slip between
 * them. A store without one (Lance, local JSON) calls it immediately before the
 * mutation, which is the best it can do — and enough, since those backends are
 * single-process by construction.
 *
 * Optional: `swapTable` with no guard behaves exactly as it did before #798.
 */
export interface SwapGuard {
  /** Throw unless the caller still holds the right to swap. */
  assertHeld(exec?: RawSqlExecutor): Promise<void>;
}

/**
 * Common contract for vector store backends. Both LanceDB and the offline
 * stub implement this so callers can switch backends with no code changes.
 */
export interface VectorStore extends ProjectWriteCapability {
  ensureTable(projectId: string): Promise<void>;
  dropTable(projectId: string): Promise<void>;
  /**
   * Issue #941 — atomically replace the LIVE table for `projectId` with the
   * contents of the shadow table `shadowProjectId`, then drop the shadow. After
   * this resolves the live name serves the shadow's rows and the shadow no
   * longer exists.
   *
   * Reindex uses this to swap a freshly-rebuilt index in only after every batch
   * has embedded successfully, so a mid-run failure never leaves the live index
   * empty. The swap also carries a (possibly different) vector dimension, which
   * is the whole point of a backend migration (384 → 768 → 1024).
   *
   * Issue #798 — an optional {@link SwapGuard} is re-checked as late as the backend
   * can manage (inside the swap transaction, on pgvector) and aborts the swap if the
   * caller has been fenced. This is what stops a reindex whose lease lapsed from
   * cutting a PARTIAL shadow over a live index that another replica has since
   * discarded — #787's guarantee, now enforced AT the mutation instead of assumed
   * from a lock taken minutes earlier.
   */
  swapTable(projectId: string, shadowProjectId: string, guard?: SwapGuard): Promise<void>;
  upsert(projectId: string, rows: VectorRow[]): Promise<void>;
  deleteByDocument(projectId: string, documentId: string): Promise<number>;
  deleteByChunkIds(projectId: string, chunkIds: string[]): Promise<number>;
  count(projectId: string): Promise<number>;
  search(
    projectId: string,
    query: number[],
    k: number,
    filter?: SearchFilter,
  ): Promise<SearchHit[]>;
  /** Returns the per-model row counts for the project (for coverage warnings). */
  modelCoverage(projectId: string): Promise<ModelCoverage>;
  /**
   * Issue #787 — every stored row's `(chunkId, embeddingModel, dimension)`, no vectors.
   *
   * Used to RESUME an interrupted shadow reindex: the rows already in the shadow
   * are the ones already re-embedded, so a restarted reindex can skip them. It
   * returns the model tag as well as the id because a shadow left behind by an
   * ABANDONED generation (operator started a reindex, changed `EMBED_MODEL`
   * again, restarted) must be discarded rather than resumed — resuming it would
   * build one table out of two vector spaces.
   *
   * Returns `[]` for a table that does not exist.
   */
  listChunkRefs(projectId: string): Promise<StoredChunkRef[]>;
  /**
   * Issue #787 — the vector width this store's storage is FIXED at, or `null`
   * when that cannot be established.
   *
   * Optional because only the pgvector backend has a deployment-wide fixed width
   * (one `vector(N)` column shared by every project) that an operator has to
   * MIGRATE before a model of a different width can be written at all. Lance's
   * width is per-table and is handled by the reindex swap; the local JSON store
   * has no fixed width.
   */
  storedDimension?(): Promise<number | null>;
}

/** Either a SQL-shaped filter (Lance) or a row predicate (Local). */
export interface SearchFilter {
  /** Filter rows to a specific embedding model (both backends honour this). */
  embeddingModel?: string;
  /** Restrict to a set of documentIds. */
  documentIds?: string[];
  /** Catch-all in-process predicate, used by LocalVectorStore. */
  predicate?: (row: VectorRow) => boolean;
}

export interface VectorStoreOptions {
  root: string;
  /**
   * Default vector dimension used when a new table is created without a seed
   * row and when introspection is unavailable. Defaults to
   * `DEFAULT_EMBED_DIMENSION`. Per-table dimensions are still inferred from
   * the first upserted row, so this only affects empty-table probes.
   */
  dimension?: number;
}

// ---- LocalVectorStore (offline / test stub) -------------------------------

export class LocalVectorStore implements VectorStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, VectorRow[]>();

  constructor(opts: VectorStoreOptions) {
    if (!opts.root) throw new Error("LocalVectorStore: root is required");
    this.root = opts.root;
  }

  withProjectWrite<T>(
    projectId: string,
    fn: (write: ProjectVectorWrite) => Promise<T>,
  ): Promise<T> {
    return withFileProjectWrite(
      this.root,
      projectId,
      {
        upsert: (id, rows) => this.upsert(id, rows),
        deleteByChunkIds: (id, ids) => this.deleteByChunkIds(id, ids),
        listChunkRefs: (id) => this.listChunkRefs(id),
        swapTable: (id, shadow, guard) => this.swapTable(id, shadow, guard),
      },
      (write) => {
        // Another instance in this process may have just cut over the same root.
        this.cache.delete(projectId);
        return fn(write);
      },
    );
  }

  async ensureTable(projectId: string): Promise<void> {
    assertProjectId(projectId);
    const dir = this.tableDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const file = this.tableFile(projectId);
    if (!existsSync(file)) {
      await fs.writeFile(file, "[]", "utf8");
    }
  }

  async dropTable(projectId: string): Promise<void> {
    assertProjectId(projectId);
    const dir = this.tableDir(projectId);
    this.cache.delete(projectId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async swapTable(projectId: string, shadowProjectId: string, guard?: SwapGuard): Promise<void> {
    assertProjectId(projectId);
    assertProjectId(shadowProjectId);
    // Serialise against in-flight writes to the live project so a concurrent
    // upsert cannot land between the drop and the rename.
    return this.runExclusive(projectId, async () => {
      const liveDir = this.tableDir(projectId);
      const shadowDir = this.tableDir(shadowProjectId);
      if (!existsSync(shadowDir)) {
        throw new Error(
          `swapTable: shadow table "${shadowProjectId}" does not exist — nothing to swap in`,
        );
      }
      // Issue #798 — last gate before the live table is destroyed. No transaction to
      // ride, so this is checked inside the per-project exclusive section, which is
      // the tightest window this backend has.
      await guard?.assertHeld();
      // Capture the shadow's rows before the move so the live cache reflects
      // the swapped-in data immediately (the JSON file is the source of truth).
      const shadowRows = await this.loadTable(shadowProjectId);
      // Drop the old live table, then move the shadow into its place. `rename`
      // is atomic within a filesystem, so readers never observe a half-state.
      await fs.rm(liveDir, { recursive: true, force: true });
      await fs.rename(shadowDir, liveDir);
      this.cache.delete(shadowProjectId);
      this.cache.set(projectId, shadowRows);
    });
  }

  async upsert(projectId: string, rows: VectorRow[]): Promise<void> {
    assertProjectId(projectId);
    if (rows.length === 0) return;
    return this.runExclusive(projectId, async () => {
      const existing = await this.loadTable(projectId);
      const byId = new Map(existing.map((r) => [r.id, r]));
      // #783 — the write-side half of the guard, mirroring LanceVectorStore.upsert:
      // every row in ONE batch must share a width. A caller mixing widths within a
      // batch is a bug in the caller, and here — unlike Lance/pgvector, where the
      // storage engine would refuse it — a JSON file would happily swallow it.
      //
      // The check is deliberately per-BATCH and not against the rows already on
      // disk: a mixed-generation FILE is a legitimate, expected state right after a
      // model change (old 384-dim rows sit untouched beside new 768-dim ones, and
      // are excluded by the model tag at search — see `search` below). It is the
      // COMPARISON across widths that is forbidden, not their coexistence.
      const batchWidth = rows[0].vector.length;
      for (const row of rows) {
        if (!Number.isInteger(row.vector.length) || row.vector.length === 0) {
          throw new Error(`vector for row ${row.id} is empty`);
        }
        assertVectorDimension({
          projectId,
          stored: batchWidth,
          incoming: row.vector.length,
          where: "an upsert batch (rows of mixed width)",
        });
        byId.set(row.id, row);
      }
      const next = Array.from(byId.values());
      await this.persist(projectId, next);
    });
  }

  async deleteByDocument(projectId: string, documentId: string): Promise<number> {
    assertProjectId(projectId);
    return this.runExclusive(projectId, async () => {
      const existing = await this.loadTable(projectId);
      const next = existing.filter((r) => r.metadata.documentId !== documentId);
      const removed = existing.length - next.length;
      await this.persist(projectId, next);
      return removed;
    });
  }

  async deleteByChunkIds(projectId: string, chunkIds: string[]): Promise<number> {
    assertProjectId(projectId);
    if (chunkIds.length === 0) return 0;
    const set = new Set(chunkIds);
    return this.runExclusive(projectId, async () => {
      const existing = await this.loadTable(projectId);
      const next = existing.filter((r) => !set.has(r.id));
      const removed = existing.length - next.length;
      await this.persist(projectId, next);
      return removed;
    });
  }

  async count(projectId: string): Promise<number> {
    assertProjectId(projectId);
    const rows = await this.loadTable(projectId);
    return rows.length;
  }

  async search(
    projectId: string,
    query: number[],
    k: number,
    filter?: SearchFilter,
  ): Promise<SearchHit[]> {
    assertProjectId(projectId);
    if (k <= 0) return [];
    const rows = await this.loadTable(projectId);
    const candidates = rows.filter((r) => matchesFilter(r, filter));
    if (candidates.length === 0) return [];
    // #783 — a JSON file happily holds rows of two different widths (a Lance or
    // pgvector table cannot). Every candidate that survived the model filter MUST
    // share the query's width; if one does not, the caller is comparing across a
    // model generation and gets the guard error, not a silently wrong ranking.
    for (const row of candidates) {
      assertVectorDimension({
        projectId,
        stored: row.vector.length,
        incoming: query.length,
        where: "the local vector store",
      });
    }
    const scored: SearchHit[] = candidates.map((row) => ({
      row,
      score: cosineSimilarity(query, row.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  async modelCoverage(projectId: string): Promise<ModelCoverage> {
    assertProjectId(projectId);
    const rows = await this.loadTable(projectId);
    const modelCounts: Record<string, number> = {};
    for (const r of rows) {
      const m = r.metadata.embeddingModel ?? "(unknown)";
      modelCounts[m] = (modelCounts[m] ?? 0) + 1;
    }
    return { totalChunks: rows.length, modelCounts };
  }

  async listChunkRefs(projectId: string): Promise<StoredChunkRef[]> {
    assertProjectId(projectId);
    const rows = await this.loadTable(projectId);
    return rows.map((r) => ({
      chunkId: r.id,
      embeddingModel: r.metadata.embeddingModel ?? "",
      dimension: Array.isArray(r.vector) ? r.vector.length : 0,
    }));
  }

  private tableDir(projectId: string): string {
    return path.join(this.root, projectId);
  }

  private tableFile(projectId: string): string {
    return path.join(this.tableDir(projectId), "table.json");
  }

  private async loadTable(projectId: string): Promise<VectorRow[]> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    const file = this.tableFile(projectId);
    if (!existsSync(file)) {
      this.cache.set(projectId, []);
      return [];
    }
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as VectorRow[];
      this.cache.set(projectId, parsed);
      return parsed;
    } catch (err) {
      log.error("vector table read failed", {
        projectId,
        error: (err as Error).message,
      });
      this.cache.set(projectId, []);
      return [];
    }
  }

  private async persist(projectId: string, rows: VectorRow[]): Promise<void> {
    const file = this.tableFile(projectId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rows), "utf8");
    await fs.rename(tmp, file);
    this.cache.set(projectId, rows);
  }

  private async runExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      projectId,
      next.catch(() => undefined),
    );
    try {
      return await next;
    } finally {
      if (this.locks.get(projectId) === next.catch(() => undefined)) {
        this.locks.delete(projectId);
      }
    }
  }
}

// ---- LanceVectorStore (production default) --------------------------------

interface LanceConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, data: Array<Record<string, unknown>>): Promise<LanceTable>;
  dropTable(name: string): Promise<void>;
  /**
   * Optional native rename. Newer LanceDB builds expose this; the legacy
   * `vectordb` client does not. {@link LanceVectorStore.swapTable} uses it for a
   * gap-free swap when present and falls back to drop+recreate otherwise.
   */
  renameTable?(from: string, to: string): Promise<void>;
}

interface LanceTable {
  name: string;
  add(data: Array<Record<string, unknown>>): Promise<number>;
  delete(filter: string): Promise<void>;
  countRows(filter?: string): Promise<number>;
  search(query: number[]): LanceQuery;
  /** Vector-free scan. Unlike `search()`, this never goes through the ANN index. */
  filter?(predicate: string): LanceQuery;
  createIndex(params: Record<string, unknown>): Promise<unknown>;
  /** apache-arrow schema (newer vectordb). Optional — used to detect dim. */
  schema?: Promise<LanceSchema> | LanceSchema;
}

interface LanceSchema {
  fields?: Array<{ name: string; type?: { listSize?: number } }>;
}

interface LanceQuery {
  limit(value: number): LanceQuery;
  filter(value: string): LanceQuery;
  where(value: string): LanceQuery;
  metricType(value: string): LanceQuery;
  execute<T = Record<string, unknown>>(): Promise<T[]>;
}

interface LanceModule {
  connect(uri: string): Promise<LanceConnection>;
}

interface LanceRow extends Record<string, unknown> {
  id: string;
  vector: number[];
  text: string;
  document_id: string;
  chunk_index: number;
  filename: string;
  model: string;
  created_at: number;
}

export class LanceVectorStore implements VectorStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly tableCache = new Map<string, LanceTable>();
  /** Per-project vector dimension, discovered from seed rows or table schema. */
  private readonly dimensions = new Map<string, number>();
  /** Fallback dimension when a table's schema cannot be introspected. */
  private readonly defaultDimension: number;
  private connection: LanceConnection | null = null;
  private connectPromise: Promise<LanceConnection> | null = null;

  constructor(opts: VectorStoreOptions) {
    if (!opts.root) throw new Error("LanceVectorStore: root is required");
    this.root = opts.root;
    this.defaultDimension = opts.dimension ?? DEFAULT_EMBED_DIMENSION;
  }

  withProjectWrite<T>(
    projectId: string,
    fn: (write: ProjectVectorWrite) => Promise<T>,
  ): Promise<T> {
    return withFileProjectWrite(
      this.root,
      projectId,
      {
        upsert: (id, rows) => this.upsert(id, rows),
        deleteByChunkIds: (id, ids) => this.deleteByChunkIds(id, ids),
        listChunkRefs: (id) => this.listChunkRefs(id),
        swapTable: (id, shadow, guard) => this.swapTable(id, shadow, guard),
      },
      (write) => {
        this.tableCache.delete(projectId);
        this.dimensions.delete(projectId);
        return fn(write);
      },
    );
  }

  private async getConnection(): Promise<LanceConnection> {
    if (this.connection) return this.connection;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        await fs.mkdir(this.root, { recursive: true });
        const moduleName = "vectordb";
        const lance = (await import(moduleName)) as LanceModule;
        this.connection = await lance.connect(this.root);
        return this.connection;
      })();
    }
    return this.connectPromise;
  }

  private tableName(projectId: string): string {
    assertProjectId(projectId);
    // Lance allows alphanumerics + `_`. ProjectIds use ULIDs / kebab-case so
    // we normalise hyphens to underscores to keep the table name SQL-safe.
    return `p_${projectId.replace(/[^A-Za-z0-9]/g, "_")}`;
  }

  private async openOrCreateTable(projectId: string, seed?: LanceRow[]): Promise<LanceTable> {
    const cached = this.tableCache.get(projectId);
    if (cached) return cached;
    const conn = await this.getConnection();
    const name = this.tableName(projectId);
    const names = await conn.tableNames();
    let table: LanceTable;
    if (names.includes(name)) {
      table = await conn.openTable(name);
    } else {
      // Lance requires a non-empty seed to infer the schema. We synthesise a
      // single sentinel row, then immediately delete it. The sentinel vector
      // dimension is taken from the seed (a real upsert) or the configured
      // default — NEVER a hardcoded constant, so non-384 backends work.
      const seedDim = seed?.[0]?.vector?.length ?? this.defaultDimension;
      const sentinel: LanceRow = seed?.[0] ?? {
        id: "__schema__",
        vector: new Array<number>(seedDim).fill(0),
        text: "",
        document_id: "",
        chunk_index: 0,
        filename: "",
        model: "",
        created_at: 0,
      };
      table = await conn.createTable(name, [sentinel]);
      await table.delete("id = '__schema__'");
      // Only a table we CREATED gets its dimension from the seed. #783: doing
      // this on the open path too (as it did) meant an incoming 768-dim upsert
      // silently re-labelled a 384-dim table as 768-dim — destroying the very
      // fact any dimension guard needs, and mis-sizing every later probe vector.
      this.dimensions.set(projectId, seedDim);
    }
    this.tableCache.set(projectId, table);
    return table;
  }

  /**
   * The table's vector width when it can be established WITH CERTAINTY — from a
   * create/upsert in this process, or from the Lance schema. `null` when neither
   * is available (older `vectordb` builds expose no schema).
   *
   * Deliberately does NOT fall back to {@link defaultDimension}: the guard in
   * `upsert`/`search` refuses writes on a mismatch, and a GUESSED width could
   * refuse a perfectly good write (e.g. a 1024-dim Bedrock table on a build with
   * no schema introspection). Unknown → do not guard; let the engine speak.
   */
  private async knownTableDimension(projectId: string, table: LanceTable): Promise<number | null> {
    const cached = this.dimensions.get(projectId);
    if (cached) return cached;
    try {
      const schema = await table.schema;
      const field = schema?.fields?.find((f) => f.name === "vector");
      const size = field?.type?.listSize;
      if (typeof size === "number" && size > 0) {
        this.dimensions.set(projectId, size);
        return size;
      }
    } catch {
      // schema introspection unsupported on this vectordb version — unknown.
    }
    return null;
  }

  /**
   * Resolve a project table's vector dimension. Cached from the last
   * create/upsert; otherwise introspected from the Lance schema; otherwise
   * the configured default. Used to build correctly-sized probe vectors.
   */
  private async resolveTableDimension(projectId: string, table: LanceTable): Promise<number> {
    return (await this.knownTableDimension(projectId, table)) ?? this.defaultDimension;
  }

  async ensureTable(projectId: string): Promise<void> {
    await this.openOrCreateTable(projectId);
  }

  async dropTable(projectId: string): Promise<void> {
    const conn = await this.getConnection();
    const name = this.tableName(projectId);
    this.tableCache.delete(projectId);
    this.dimensions.delete(projectId);
    const names = await conn.tableNames();
    if (names.includes(name)) {
      await conn.dropTable(name);
    }
  }

  async swapTable(projectId: string, shadowProjectId: string, guard?: SwapGuard): Promise<void> {
    assertProjectId(projectId);
    assertProjectId(shadowProjectId);
    return this.runExclusive(projectId, async () => {
      const conn = await this.getConnection();
      const liveName = this.tableName(projectId);
      const shadowName = this.tableName(shadowProjectId);
      const names = await conn.tableNames();
      if (!names.includes(shadowName)) {
        throw new Error(
          `swapTable: shadow table "${shadowProjectId}" does not exist — nothing to swap in`,
        );
      }
      // Issue #798 — last gate before the live table is dropped (see LocalVectorStore).
      await guard?.assertHeld();

      // Prefer a native rename when the installed client exposes one. NOTE:
      // this is NOT truly gap-free — it is a drop-then-rename, so there is a
      // brief window after the old live table is dropped and before the shadow
      // is renamed into its place where the live name does not resolve. Rename
      // is a metadata-only operation (no row copy), so the window is tiny, and
      // the shadow retains every row until the rename commits — a failure
      // between the two calls leaves the data recoverable under the shadow name
      // (live empty until a retry), never silently destroyed mid-embed.
      if (typeof conn.renameTable === "function") {
        if (names.includes(liveName)) await conn.dropTable(liveName);
        await conn.renameTable(shadowName, liveName);
      } else {
        // Fallback: the legacy `vectordb` client has no rename, so we cannot
        // cut over atomically. We minimise the destructive window and NEVER
        // drop the live table until a durable copy of the new content exists:
        //   1. Read the shadow rows (live untouched).
        //   2. Build the new content into a STAGING table (live untouched). If
        //      this throws — the most likely failure mode (bad schema/dimension,
        //      out-of-disk) — the OLD live table is left fully intact and the
        //      staging + shadow tables are cleaned up.
        //   3. Cut over: drop the old live table and recreate it from the same
        //      rows. Because step 2 already proved the create succeeds, this
        //      second create is highly unlikely to fail.
        //   4. Drop the now-stale staging + shadow tables.
        // Residual limitation: a crash *between* dropping live and recreating
        // it (step 3) leaves the live name empty for that instant — but every
        // row still exists in the staging table, so the data is recoverable,
        // never lost. Native renameTable (above) shrinks this window to a
        // single metadata op.
        const stagingName = `${liveName}_staging`;
        const shadowTable = await conn.openTable(shadowName);
        const shadowRows = await this.readAllRows(shadowProjectId, shadowTable);
        const emptyDim = this.dimensions.get(shadowProjectId) ?? this.defaultDimension;

        // Clear any stale staging table left by a previously-crashed swap.
        if (names.includes(stagingName)) await conn.dropTable(stagingName);

        // (1)+(2) Stage the new content first. Live is still intact here.
        try {
          await this.createTableFromRows(conn, stagingName, shadowRows, emptyDim);
        } catch (err) {
          // PR #796 review (S1) — clean up the half-built STAGING table, and NOTHING
          // else. This branch used to drop the shadow too, which quietly made the
          // "a failed swap retains the shadow, so the retry costs no embed calls"
          // guarantee BACKEND-DEPENDENT: `vectordb` (the client we actually ship) has
          // no `renameTable`, so this fallback IS the production path for Lance, and
          // a staging-create failure — bad schema/dimension, out of disk, i.e. the
          // MOST LIKELY swap failure — threw away a complete checkpoint and forced a
          // full re-embed of the project.
          //
          // The shadow is the checkpoint. Live was never touched on this path, so
          // keeping it costs one stale table and saves the whole corpus. The next
          // run finds it complete and replays the swap with zero embed calls.
          await conn.dropTable(stagingName).catch(() => {});
          throw err;
        }

        // (3) Cut over. The staging copy is durable, so dropping live no longer
        // risks permanent data loss.
        if (names.includes(liveName)) await conn.dropTable(liveName);
        await this.createTableFromRows(conn, liveName, shadowRows, emptyDim);

        // (4) Drop the stale staging + shadow tables.
        await conn.dropTable(stagingName).catch(() => {});
        await conn.dropTable(shadowName).catch(() => {});
      }

      // Repoint caches/dimension from the shadow onto the live project.
      this.tableCache.delete(projectId);
      this.tableCache.delete(shadowProjectId);
      const shadowDim = this.dimensions.get(shadowProjectId);
      this.dimensions.delete(shadowProjectId);
      if (shadowDim) this.dimensions.set(projectId, shadowDim);
      else this.dimensions.delete(projectId);
    });
  }

  /**
   * Create a Lance table named `name` from `rows`. When `rows` is empty we
   * still materialise a schema-only table (seeded with a sentinel that is then
   * deleted) at `emptyDim`, so subsequent searches resolve cleanly instead of
   * auto-creating the table at the wrong dimension. Shared by both the live and
   * staging legs of {@link swapTable}'s drop+recreate fallback.
   */
  private async createTableFromRows(
    conn: LanceConnection,
    name: string,
    rows: LanceRow[],
    emptyDim: number,
  ): Promise<void> {
    if (rows.length > 0) {
      await conn.createTable(name, rows);
      return;
    }
    const sentinel: LanceRow = {
      id: "__schema__",
      vector: new Array<number>(emptyDim).fill(0),
      text: "",
      document_id: "",
      chunk_index: 0,
      filename: "",
      model: "",
      created_at: 0,
    };
    const created = await conn.createTable(name, [sentinel]);
    await created.delete("id = '__schema__'");
  }

  /**
   * Pull every row from a Lance table.
   *
   * MUST NOT go through `search()`. A vector query is served by the ANN index
   * once one exists, which probes only a few IVF partitions and silently
   * returns a fraction of the table — measured at 294/3218 rows on a real
   * project, with `limit(total)` set. `swapTable` drops and recreates live
   * from these rows, so a short read here is silent vector loss, not a slow
   * query. `filter()` is a true scan and ignores the index.
   */
  private async readAllRows(projectId: string, table: LanceTable): Promise<LanceRow[]> {
    const total = await table.countRows();
    if (total === 0) return [];
    const raw = await this.scanAllRows(projectId, table, total);
    if (raw.length !== total) {
      throw new Error(
        `Lance scan returned ${raw.length} of ${total} rows for ${table.name}; refusing to treat a short read as the whole table`,
      );
    }
    // Strip Lance's synthetic `_distance` (and any other extra fields) so the
    // recreated table schema matches the canonical column set exactly.
    return raw.map((r) => ({
      id: r.id,
      vector: r.vector,
      text: r.text,
      document_id: r.document_id,
      chunk_index: r.chunk_index,
      filename: r.filename,
      model: r.model,
      created_at: r.created_at,
    }));
  }

  /**
   * Vector-free scan where the client supports it. The ANN fallback exists only
   * for structural test doubles; `readAllRows` rejects any short read it returns.
   */
  private async scanAllRows(
    projectId: string,
    table: LanceTable,
    total: number,
  ): Promise<LanceRow[]> {
    if (typeof table.filter === "function") {
      return table.filter("id IS NOT NULL").limit(total).execute<LanceRow>();
    }
    const dim = await this.resolveTableDimension(projectId, table);
    return table.search(new Array<number>(dim).fill(0)).limit(total).execute<LanceRow>();
  }

  /**
   * Issue #783 — the write-side dimension guard for a Lance table.
   *
   * A Lance vector column has a FIXED list size, chosen when the table was
   * created. Three cases, and the distinction between the last two is the whole
   * value of this method:
   *
   *   - width agrees, or the table's width cannot be established → proceed;
   *   - width differs and the table HOLDS ROWS → refuse. Those rows are a
   *     different vector space; the fix is a reindex, and saying so beats an
   *     arrow schema error from four frames deeper;
   *   - width differs and the table is EMPTY → there is nothing to protect.
   *     Recreate it at the incoming width and write. This is the ordinary shape
   *     of a fresh project on an upgraded deployment: `ensureTable()` materialised
   *     a schema-only table at the DEFAULT width before the first upsert ever
   *     revealed the real one. Demanding a "reindex" of an empty table would be
   *     nonsense, and it is the failure an operator would hit first.
   *
   * Returns the table to keep using; a DIFFERENT table object means it was
   * recreated and `rows` are already persisted.
   */
  private async guardWriteDimension(
    projectId: string,
    table: LanceTable,
    rows: LanceRow[],
  ): Promise<LanceTable> {
    const tableDim = await this.knownTableDimension(projectId, table);
    if (tableDim === null) return table;

    const incoming = rows[0].vector.length;
    for (const row of rows) {
      // Homogeneity first — a caller mixing widths within one batch is a bug in
      // the caller, and the guard below would only catch it by luck of ordering.
      assertVectorDimension({
        projectId,
        stored: incoming,
        incoming: row.vector.length,
        where: "an upsert batch (rows of mixed width)",
      });
    }
    if (tableDim === incoming) return table;

    if ((await table.countRows()) > 0) {
      assertVectorDimension({
        projectId,
        stored: tableDim,
        incoming,
        where: "the Lance vector table",
      });
    }

    // The one DESTRUCTIVE branch in this store, and the only one that leans on the
    // single-writer assumption the embedded-Lance store already documents (see
    // `getVectorStore`: this backend is NOT multi-replica safe). `runExclusive` is a
    // PROCESS-LOCAL mutex, so the count→drop window above is not atomic across
    // processes: two replicas sharing one Lance directory could interleave (A
    // recreates and writes; B, holding a stale `count === 0`, drops A's rows). Within
    // a single writer — the only configuration this store supports — the branch drops
    // nothing but a provably empty table of the wrong width.
    log.warn("recreating empty vector table at the active embedder's dimension", {
      projectId,
      was: tableDim,
      now: incoming,
    });
    const conn = await this.getConnection();
    const name = this.tableName(projectId);
    this.tableCache.delete(projectId);
    this.dimensions.delete(projectId);
    if ((await conn.tableNames()).includes(name)) {
      await conn.dropTable(name);
    }
    await this.createTableFromRows(conn, name, rows, incoming);
    const recreated = await conn.openTable(name);
    this.tableCache.set(projectId, recreated);
    this.dimensions.set(projectId, incoming);
    return recreated;
  }

  async upsert(projectId: string, rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    return this.runExclusive(projectId, async () => {
      const lanceRows = rows.map((r) => toLanceRow(r));
      const table = await this.openOrCreateTable(projectId, lanceRows);
      // #783 — a Lance table's vector column has a FIXED list size, fixed when the
      // table was created. Writing a 768-dim row into a 384-dim table fails deep
      // inside the engine with an arrow schema error that names no model; catch it
      // here, where we can say "your embedding model changed — reindex".
      const guarded = await this.guardWriteDimension(projectId, table, lanceRows);
      if (guarded !== table) {
        // The table was empty and typed at the wrong width; it has been recreated
        // FROM these rows, which means they are already written.
        return;
      }
      // Upsert = delete by id then add. Lance does not yet expose merge
      // semantics through the JS client.
      const ids = lanceRows.map((r) => sqlString(r.id));
      await table.delete(`id IN (${ids.join(", ")})`);
      await table.add(lanceRows);
      // Promote to ANN index when the table grows past the threshold. The
      // call is idempotent — Lance no-ops if the index already covers the
      // current row count.
      const total = await table.countRows();
      if (total > VECTOR_ANN_THRESHOLD) {
        try {
          await table.createIndex({
            type: "ivf_pq",
            column: "vector",
            num_partitions: 256,
            num_sub_vectors: 16,
          });
        } catch (err) {
          log.warn("createIndex failed", { error: (err as Error).message });
        }
      }
    });
  }

  async deleteByDocument(projectId: string, documentId: string): Promise<number> {
    return this.runExclusive(projectId, async () => {
      const table = await this.openOrCreateTable(projectId);
      const before = await table.countRows();
      await table.delete(`document_id = ${sqlString(documentId)}`);
      const after = await table.countRows();
      return Math.max(0, before - after);
    });
  }

  async deleteByChunkIds(projectId: string, chunkIds: string[]): Promise<number> {
    if (chunkIds.length === 0) return 0;
    return this.runExclusive(projectId, async () => {
      const table = await this.openOrCreateTable(projectId);
      const before = await table.countRows();
      await table.delete(`id IN (${chunkIds.map(sqlString).join(", ")})`);
      const after = await table.countRows();
      return Math.max(0, before - after);
    });
  }

  async count(projectId: string): Promise<number> {
    const table = await this.openOrCreateTable(projectId);
    return table.countRows();
  }

  async search(
    projectId: string,
    query: number[],
    k: number,
    filter?: SearchFilter,
  ): Promise<SearchHit[]> {
    if (k <= 0) return [];
    const table = await this.openOrCreateTable(projectId);
    // #783 — same guard as `upsert`, from the read side: a 768-dim query against a
    // populated 384-dim table is a model-generation mismatch, not a Lance bug. An
    // EMPTY table of the wrong width holds nothing to mismatch against, so it
    // answers with no hits rather than failing a search that has no data to serve.
    const tableDim = await this.knownTableDimension(projectId, table);
    if (tableDim !== null && tableDim !== query.length) {
      if ((await table.countRows()) === 0) return [];
      assertVectorDimension({
        projectId,
        stored: tableDim,
        incoming: query.length,
        where: "the Lance vector table",
      });
    }
    let q: LanceQuery = table.search(query).limit(k).metricType("cosine");
    const where = buildLanceWhere(filter);
    if (where) q = q.where(where);
    const results = await q.execute<Record<string, unknown> & { _distance?: number }>();
    return results.map((r) => ({
      row: fromLanceRow(r as LanceRow),
      // Lance cosine returns 1 - cos_sim. Map back to a similarity score.
      score: typeof r._distance === "number" ? 1 - r._distance : 0,
    }));
  }

  async modelCoverage(projectId: string): Promise<ModelCoverage> {
    const table = await this.openOrCreateTable(projectId);
    const total = await table.countRows();
    if (total === 0) return { totalChunks: 0, modelCounts: {} };
    // No GROUP BY in the JS client — pull a wide sample and bucket in-process.
    // For very large tables this is approximate; coverage warnings only need
    // to know "is the current model the dominant one or not". The probe vector
    // MUST match the table's stored dimension or Lance rejects the query.
    const dim = await this.resolveTableDimension(projectId, table);
    const sampleVec = new Array<number>(dim).fill(0);
    let rows: LanceRow[];
    try {
      rows = await table.search(sampleVec).limit(Math.min(total, 5000)).execute<LanceRow>();
    } catch (err) {
      // A dimension mismatch here means the table predates a backend swap.
      // Report the total so callers can still raise a coverage/dimension
      // warning instead of crashing the search path.
      log.warn("modelCoverage probe failed (likely dimension mismatch)", {
        projectId,
        probeDimension: dim,
        error: (err as Error).message,
      });
      return { totalChunks: total, modelCounts: {} };
    }
    const modelCounts: Record<string, number> = {};
    for (const r of rows) {
      const m = r.model ?? "(unknown)";
      modelCounts[m] = (modelCounts[m] ?? 0) + 1;
    }
    return { totalChunks: total, modelCounts };
  }

  /**
   * Issue #787 — the shadow-reindex resume checkpoint.
   *
   * Deliberately probes `tableNames()` FIRST rather than going through
   * `openOrCreateTable`: the caller asks this about a shadow table that usually
   * does NOT exist (the common case is a first, uninterrupted reindex), and
   * creating one as a side effect of asking whether it exists would materialise
   * it at `defaultDimension` — a width that has nothing to do with the model the
   * reindex is about to embed with.
   */
  async listChunkRefs(projectId: string): Promise<StoredChunkRef[]> {
    const conn = await this.getConnection();
    const name = this.tableName(projectId);
    if (!(await conn.tableNames()).includes(name)) return [];
    const table = await this.openOrCreateTable(projectId);
    const rows = await this.readAllRows(projectId, table);
    return rows.map((r) => ({
      chunkId: r.id,
      embeddingModel: r.model ?? "",
      dimension: r.vector?.length ?? 0,
    }));
  }

  private async runExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      projectId,
      next.catch(() => undefined),
    );
    try {
      return await next;
    } finally {
      if (this.locks.get(projectId) === next.catch(() => undefined)) {
        this.locks.delete(projectId);
      }
    }
  }
}

// ---- Helpers --------------------------------------------------------------

function toLanceRow(r: VectorRow): LanceRow {
  return {
    id: r.id,
    vector: r.vector,
    text: r.metadata.text,
    document_id: r.metadata.documentId,
    chunk_index: r.metadata.position,
    filename: r.metadata.filename,
    model: r.metadata.embeddingModel,
    created_at: Date.now(),
  };
}

function fromLanceRow(r: LanceRow): VectorRow {
  return {
    id: r.id,
    vector: Array.isArray(r.vector) ? r.vector : Array.from(r.vector as ArrayLike<number>),
    metadata: {
      chunkId: r.id,
      documentId: r.document_id,
      filename: r.filename,
      position: r.chunk_index,
      text: r.text,
      embeddingModel: r.model,
    },
  };
}

function buildLanceWhere(filter: SearchFilter | undefined): string {
  if (!filter) return "";
  const clauses: string[] = [];
  if (filter.embeddingModel) clauses.push(`model = ${sqlString(filter.embeddingModel)}`);
  if (filter.documentIds && filter.documentIds.length > 0) {
    clauses.push(`document_id IN (${filter.documentIds.map(sqlString).join(", ")})`);
  }
  return clauses.join(" AND ");
}

/** SQL string literal escaping. Lance accepts single-quoted strings. */
function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function matchesFilter(row: VectorRow, filter: SearchFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.embeddingModel && row.metadata.embeddingModel !== filter.embeddingModel) return false;
  if (
    filter.documentIds &&
    filter.documentIds.length > 0 &&
    !filter.documentIds.includes(row.metadata.documentId)
  ) {
    return false;
  }
  if (filter.predicate && !filter.predicate(row)) return false;
  return true;
}

function assertProjectId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("projectId must be a non-empty string");
  }
  if (id.includes("/") || id.includes("..") || id.includes("\\") || id.includes("\0")) {
    throw new Error("invalid projectId for filesystem table name");
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `vector length mismatch: ${a.length} vs ${b.length} — store and query must share dimension`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ---- Factory --------------------------------------------------------------

let singleton: VectorStore | null = null;

/**
 * Factory indirection for the pgvector backend (issue #543). Keeps this module
 * free of a static import of the Postgres store (which pulls in the Prisma
 * client), exactly like the #541/#542 store seams. The real factory is injected
 * at startup by `vector-store-pgvector.ts`. Until then, selecting `pgvector`
 * fails loud rather than silently degrading to the per-pod LanceDB store — that
 * would re-introduce the multi-replica corruption #543 fixes.
 */
let pgvectorStoreFactory: ((opts: VectorStoreOptions) => VectorStore) | null = null;

/** Register the pgvector-backed store factory (called once at startup). */
export function __setPgVectorStoreFactory(
  factory: (opts: VectorStoreOptions) => VectorStore,
): void {
  pgvectorStoreFactory = factory;
  singleton = null;
}

/** Test seam — clear the registered pgvector factory + singleton. */
export function __clearPgVectorStoreFactory(): void {
  pgvectorStoreFactory = null;
  singleton = null;
}

/**
 * Resolve the configured vector-store backend.
 *
 * Backend ladder (selected by `VECTOR_STORE`):
 *   - `pgvector` — **production / multi-replica setting.** pgvector on the shared
 *     Postgres (#539). Every replica reads AND writes the same vectors; the
 *     LanceDB single-writer corruption mode is gone.
 *   - `local`    — dependency-free JSON store for tests / offline mode (also
 *     selected by `AI_OFFLINE=1`). Per-process; not multi-replica safe.
 *   - (default)  — embedded LanceDB. Per-pod local directory; NOT multi-replica
 *     safe (kept as the default for single-replica dev/local compatibility).
 */
export function getVectorStore(): VectorStore {
  if (!singleton) {
    const root = process.env.LANCEDB_PATH ?? path.resolve(process.cwd(), "data", "lancedb");
    const dimension = process.env.EMBED_DIM ? Number(process.env.EMBED_DIM) : undefined;
    const opts: VectorStoreOptions = {
      root,
      dimension: dimension !== undefined && Number.isFinite(dimension) ? dimension : undefined,
    };
    if (isOfflineVectorMode()) {
      singleton = new LocalVectorStore(opts);
    } else if (isPgVectorMode()) {
      if (!pgvectorStoreFactory) {
        throw new Error(
          "VECTOR_STORE=pgvector selected but the pgvector store factory was not " +
            "registered. Ensure vector-store-pgvector.ts is imported at startup.",
        );
      }
      singleton = pgvectorStoreFactory(opts);
    } else {
      singleton = new LanceVectorStore(opts);
    }
  }
  return singleton;
}

function isOfflineVectorMode(): boolean {
  if (process.env.AI_OFFLINE === "1" || process.env.AI_OFFLINE === "true") return true;
  if (process.env.VECTOR_STORE === "local") return true;
  return false;
}

function isPgVectorMode(): boolean {
  return (process.env.VECTOR_STORE ?? "").trim().toLowerCase() === "pgvector";
}

/** Test seam — drop the singleton between tests. */
export function __resetVectorStoreSingleton(): void {
  singleton = null;
}
