/**
 * Epic #518 (#543) — pgvector-backed vector store unit tests.
 *
 * The point of #543 is that the RAG vector store becomes *multi-replica safe*:
 * two pods read AND write the same vectors through shared Postgres instead of a
 * per-pod LanceDB dir that concurrent writers corrupt. These tests prove the
 * store/retrieve mechanics, the dimension contract, namespace isolation, and the
 * cross-replica behaviour against a {@link FakeSharedPg} that models ONE shared
 * `rag_vectors` table — exactly as the #541 rate-limit tests model one shared
 * counter table. Two separately-constructed {@link PgVectorStore} instances (=
 * two replicas) share that one fake DB.
 *
 * Tests assert store/retrieve mechanics + dimension, NOT embedding quality: the
 * local embedder silently falls back to a hash embedder when HF is unauthorized,
 * so semantic-similarity assertions would be flaky. We rank deterministic hand-
 * built vectors instead.
 *
 * (The end-to-end proof against a real `postgres:16-alpine` lives in the gated
 * vector-store-pgvector.integration.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  withVectorSql,
  type ProjectVectorWrite,
  type VectorGeneration,
} from "./project-vector-write.js";

/**
 * PR #796 review (B1) — a seam for the ACTIVE embedder.
 *
 * `migrateColumnDimension()` refuses to run off a DEGRADED embedder, so the tests
 * for that need to be able to hand it one that has fallen back to the hash stub.
 * Everything else in `embedder.js` stays real: only `getEmbedder()` is overridable,
 * and only while a test has installed a fake.
 */
const { fakeEmbedder } = vi.hoisted(() => ({
  fakeEmbedder: {
    current: null as null | {
      model: string;
      dimension: number;
      fellBack: boolean;
      lastError: string | null;
    },
  },
}));
vi.mock("./embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedder.js")>();
  return {
    ...actual,
    getEmbedder: () => fakeEmbedder.current ?? actual.getEmbedder(),
  };
});

import { reindexSwapLeaseExtensionMs } from "./reindex-swap-budget.js";
import {
  DEFAULT_REINDEX_SWAP_MAX_WAIT_MS,
  DEFAULT_REINDEX_SWAP_TIMEOUT_MS,
  MAX_REINDEX_SWAP_MAX_WAIT_MS,
  MAX_REINDEX_SWAP_TIMEOUT_MS,
  PgVectorStore,
  parseVectorLiteral,
  registerPgVectorStore,
  reindexSwapMaxWaitMs,
  reindexSwapTimeoutMs,
  resolveEmbedDimension,
  toVectorLiteral,
} from "./vector-store-pgvector.js";
import {
  __clearPgVectorStoreFactory,
  __resetVectorStoreSingleton,
  __setPgVectorStoreFactory,
  getVectorStore,
  type RawSqlExecutor,
  type VectorRow,
} from "./vector-store.js";

const DIM = 4;

/**
 * Prisma's default wall-clock deadline for an INTERACTIVE `$transaction` callback.
 * Not ours to choose — it is what applies when the call site passes no options, and
 * `lib/prisma.ts` sets no client-wide `transactionOptions`.
 */
const PRISMA_DEFAULT_TX_TIMEOUT_MS = 5_000;

interface StoredRow {
  project_id: string;
  id: string;
  embedding: number[];
  text: string;
  document_id: string;
  chunk_index: number;
  filename: string;
  model: string;
  created_at: number;
}

/**
 * Minimal fake of the Prisma surface the pgvector store uses, modelling ONE
 * shared `rag_vectors` table. Mutations serialize through a promise chain so two
 * store instances' concurrent calls interleave the way Postgres row-locking would
 * serialize concurrent replicas (no lost writes). It interprets both the
 * tagged-template (`$queryRaw`/`$executeRaw`) and string (`*Unsafe`) query forms
 * the store issues.
 */
class FakeSharedPg {
  rows: StoredRow[] = [];
  ddlCount = 0;
  /** Statements applied, in call order — lets a test assert the fence ran BEFORE the mutations. */
  readonly trace: string[] = [];
  /** Simulated wall-clock cost of ONE mutating statement inside a transaction. */
  msPerStatement = 0;
  /** Options the last INTERACTIVE `$transaction` was opened with. */
  lastTxOptions: { timeout?: number; maxWait?: number } | undefined;
  /** Model the PRE-FIX call site: discard the caller's options, so Prisma's defaults bite. */
  ignoreTxOptions = false;
  private txBudgetMs: number | undefined;
  private txCostMs = 0;
  /**
   * #783 — the width the `embedding` column ALREADY has, as the catalog would
   * report it (pgvector keeps the dimension in `atttypmod`). `CREATE TABLE IF NOT
   * EXISTS … vector(N)` cannot change it, so this is what an upgraded deployment's
   * store actually finds. Defaults to the width these tests create at.
   */
  columnDim: number | null = DIM;
  /**
   * PR #796 review (B2) — make the CREATE half of the DDL fail (out of disk, a
   * refused type, no `vector` extension…).
   *
   * Modelled the way Postgres actually behaves, so that it discriminates between the
   * two possible statement shapes rather than flattering either:
   *
   *   - CREATE in the SAME statement as the DROP (one `DO $$` block = one implicit
   *     transaction): the failure rolls the DROP back with it. Nothing mutates.
   *   - CREATE in a SEPARATE statement from the DROP: the DROP already COMMITTED. It
   *     stands, and the deployment is left with no table at all.
   */
  failCreateDdl = false;
  /** Every DDL string the store issued, so a test can assert what shipped as ONE statement. */
  ddlLog: string[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(
      () =>
        new Promise<T>((resolve, reject) =>
          setImmediate(() => {
            // A statement that fails must REJECT the query promise, the way a driver
            // reports a Postgres error — not throw out of the timer callback, which
            // would surface as an unhandled exception instead of a failed query.
            try {
              resolve(fn());
            } catch (err) {
              reject(err as Error);
            }
          }),
        ),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  // ---- DDL + TRUNCATE (string form) ----
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number> {
    // DDL. Two shapes reach here:
    //   - the bootstrap block: CREATE EXTENSION + CREATE TABLE IF NOT EXISTS + indexes.
    //   - #787's column-width migration block: the same, with a DROP TABLE in front of
    //     it. Both arrive as ONE `DO $$` statement = ONE transaction (PR #796, B2).
    if (
      sql.includes("DROP TABLE") ||
      sql.includes("CREATE TABLE") ||
      sql.includes("CREATE EXTENSION")
    ) {
      this.ddlLog.push(sql);
      const drops = sql.includes("DROP TABLE");
      const creates = sql.includes("CREATE TABLE");
      if (creates) this.ddlCount += 1;
      return this.serialize(() => {
        if (creates && this.failCreateDdl) {
          // The statement fails. Everything IT did rolls back — which, when the DROP
          // is in this same statement, includes the DROP. A drop that committed in an
          // EARLIER statement is already gone and does not come back.
          throw new Error('relation "vector" does not exist');
        }
        if (drops) {
          this.rows = [];
          this.columnDim = null;
        }
        // `CREATE TABLE IF NOT EXISTS … vector(N)` only fixes the width when the
        // table does NOT already exist — the silent no-op that #783's column guard
        // and #787's migration both exist to deal with. After a DROP in the same
        // block, it does exist no longer, so the new width lands.
        if (this.columnDim === null) {
          const m = /vector\((\d+)\)/.exec(sql);
          if (m) this.columnDim = Number(m[1]);
        }
        return 0;
      });
    }
    if (sql.startsWith("TRUNCATE")) {
      return this.serialize(() => {
        this.rows = [];
        return 0;
      });
    }
    if (sql.startsWith("INSERT INTO")) {
      return this.serialize(() => this.applyInsert(params));
    }
    if (sql.startsWith("DELETE FROM") && sql.includes("IN (")) {
      // deleteByChunkIds: $1 = projectId, $2.. = ids
      return this.serialize(() => {
        const [projectId, ...ids] = params as [string, ...string[]];
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => !(r.project_id === projectId && ids.includes(r.id)));
        return before - this.rows.length;
      });
    }
    return Promise.resolve(0);
  }

  // ---- search (string form, $queryRawUnsafe) ----
  $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
    if (sql.startsWith("SELECT") && sql.includes("<=>")) {
      return this.serialize(() => this.applySearch(sql, params)) as Promise<T>;
    }
    return Promise.resolve([] as unknown as T);
  }

  // ---- tagged-template forms ----
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join("?");
    if (sql.includes("DELETE FROM") && sql.includes("document_id")) {
      // deleteByDocument: values = [projectId, documentId]
      return this.serialize(() => {
        const [projectId, documentId] = values as [string, string];
        const before = this.rows.length;
        this.rows = this.rows.filter(
          (r) => !(r.project_id === projectId && r.document_id === documentId),
        );
        return before - this.rows.length;
      });
    }
    if (sql.includes("DELETE FROM") && sql.includes("project_id")) {
      // dropTable / swap delete: values = [projectId]
      return this.serialize(() => {
        this.trace.push("DELETE");
        this.chargeTx();
        const [projectId] = values as [string];
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => r.project_id !== projectId);
        return before - this.rows.length;
      });
    }
    if (sql.includes("UPDATE") && sql.includes("SET")) {
      // swap relabel: values = [newProjectId, shadowProjectId]
      return this.serialize(() => {
        this.trace.push("UPDATE");
        this.chargeTx();
        const [target, shadow] = values as [string, string];
        let n = 0;
        for (const r of this.rows) {
          if (r.project_id === shadow) {
            r.project_id = target;
            n += 1;
          }
        }
        return n;
      });
    }
    return Promise.resolve(0);
  }

  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const sql = strings.join("?");
    // #783 — the embedding column's real width, read from the catalog. Parameterised
    // (`to_regclass($1)`), so it arrives through the tagged-template form.
    if (sql.includes("atttypmod")) {
      const dim = this.columnDim;
      return Promise.resolve((dim === null ? [] : [{ dim }]) as unknown as T);
    }
    if (sql.includes("COUNT(*)") && sql.includes("GROUP BY")) {
      // modelCoverage: values = [projectId]
      const [projectId] = values as [string];
      const counts = new Map<string, number>();
      for (const r of this.rows.filter((x) => x.project_id === projectId)) {
        counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
      }
      return Promise.resolve(Array.from(counts, ([model, n]) => ({ model, n })) as unknown as T);
    }
    if (sql.includes("COUNT(*)")) {
      // count: values = [projectId]. #787's migration counts the WHOLE table, so
      // it binds nothing — that is the un-scoped form.
      if (values.length === 0) return Promise.resolve([{ n: this.rows.length }] as unknown as T);
      const [projectId] = values as [string];
      const n = this.rows.filter((r) => r.project_id === projectId).length;
      return Promise.resolve([{ n }] as unknown as T);
    }
    // #787 — listChunkRefs: the resume checkpoint. values = [projectId]
    if (sql.includes('"id", "model"')) {
      const [projectId] = values as [string];
      return Promise.resolve(
        this.rows
          .filter((r) => r.project_id === projectId)
          .map((r) => ({
            id: r.id,
            model: r.model,
            dimension: r.embedding.length,
          })) as unknown as T,
      );
    }
    return Promise.resolve([] as unknown as T);
  }

  /**
   * Both Prisma forms. Issue #798 switched `swapTable` to the INTERACTIVE form so the
   * reindex-lease fence can be re-checked inside the swap's own transaction; the array
   * form is still used elsewhere.
   *
   * The interactive form is modelled with its REAL, dangerous semantics, because they
   * are the whole point of the review finding it was written for:
   *
   *   - it enforces a client-side wall-clock `timeout`, DEFAULTING TO 5 s when the
   *     caller passes none (`PRISMA_DEFAULT_TX_TIMEOUT_MS`) — the batch form has no
   *     such deadline, so the switch to the interactive form silently added one;
   *   - blowing the deadline aborts with `P2028` and ROLLS THE TRANSACTION BACK.
   *
   * Statement cost is simulated (`msPerStatement`) rather than real, so a test can put a
   * multi-minute big-corpus cut-over through this in microseconds and still observe the
   * deadline that a 200k-chunk `DELETE` + `UPDATE` would hit in production.
   */
  $transaction(
    ops: Promise<unknown>[] | ((tx: FakeSharedPg) => Promise<unknown>),
    options?: { timeout?: number; maxWait?: number },
  ): Promise<unknown> {
    if (typeof ops !== "function") return Promise.all(ops);

    this.lastTxOptions = options;
    // `ignoreTxOptions` models the PRE-FIX call site (no options passed at all), so a
    // test can prove the default deadline really does kill a large swap.
    this.txBudgetMs =
      (this.ignoreTxOptions ? undefined : options?.timeout) ?? PRISMA_DEFAULT_TX_TIMEOUT_MS;
    this.txCostMs = 0;
    const snapshot = this.rows.map((r) => ({ ...r }));

    return ops(this).catch((err: unknown) => {
      this.rows = snapshot; // ROLLBACK — nothing the callback did survives.
      throw err;
    });
  }

  /**
   * Charge a statement against the open transaction's deadline. Prisma aborts the
   * transaction the moment the budget is exceeded; every later query on `tx` then fails.
   */
  private chargeTx(): void {
    if (this.txBudgetMs === undefined) return;
    this.txCostMs += this.msPerStatement;
    if (this.txCostMs > this.txBudgetMs) {
      this.txBudgetMs = undefined; // closed
      throw Object.assign(
        new Error(
          "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.",
        ),
        { code: "P2028" },
      );
    }
  }

  // ---- internals ----
  private applyInsert(params: unknown[]): number {
    const cols = 7;
    const tail = params.slice(params.length - 2) as [string, number];
    const [model, createdAt] = tail;
    const body = params.slice(0, params.length - 2);
    const count = body.length / cols;
    for (let i = 0; i < count; i += 1) {
      const b = i * cols;
      const row: StoredRow = {
        project_id: body[b] as string,
        id: body[b + 1] as string,
        embedding: parseVectorLiteral(body[b + 2]),
        text: body[b + 3] as string,
        document_id: body[b + 4] as string,
        chunk_index: Number(body[b + 5]),
        filename: body[b + 6] as string,
        model,
        created_at: createdAt,
      };
      const existing = this.rows.findIndex(
        (r) => r.project_id === row.project_id && r.id === row.id,
      );
      if (existing >= 0) this.rows[existing] = row;
      else this.rows.push(row);
    }
    return count;
  }

  private applySearch(sql: string, params: unknown[]): unknown[] {
    const projectId = params[0] as string;
    const query = parseVectorLiteral(params[1]);
    const k = params[params.length - 1] as number;
    // Reconstruct optional filters from the param list (after projectId+vector).
    const middle = params.slice(2, params.length - 1) as string[];
    let model: string | undefined;
    let docIds: string[] | undefined;
    if (sql.includes('"model" =')) {
      model = middle.shift();
    }
    if (sql.includes("document_id") && sql.includes("IN (")) {
      docIds = middle;
    }
    let candidates = this.rows.filter((r) => r.project_id === projectId);
    if (model) candidates = candidates.filter((r) => r.model === model);
    if (docIds && docIds.length)
      candidates = candidates.filter((r) => docIds!.includes(r.document_id));
    const scored = candidates.map((r) => ({
      row: r,
      distance: 1 - cosine(query, r.embedding),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k).map(({ row, distance }) => ({
      id: row.id,
      embedding: toVectorLiteral(row.embedding),
      text: row.text,
      document_id: row.document_id,
      chunk_index: row.chunk_index,
      filename: row.filename,
      model: row.model,
      distance,
    }));
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function makeStore(db: FakeSharedPg): PgVectorStore {
  return new PgVectorStore({ db: db as unknown as PrismaClient, dimension: DIM });
}

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
      embeddingModel: extra.embeddingModel ?? "metis-offline-hash-v1",
      ...extra,
    },
  };
}

describe("PgVectorStore.withProjectWrite — transaction-bound operations", () => {
  // Deliberately distinct clients: a fake that passes itself as tx cannot detect
  // accidental root-client fallback. Root DDL is permitted only for bootstrap.
  async function fixture() {
    const trace: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        trace.push(strings.join("?"));
        void values;
        return 1;
      }),
      $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
        trace.push(sql);
        void values;
        return 2;
      }),
      $queryRaw: vi.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
          trace.push(strings.join("?"));
          void values;
          return [];
        },
      ),
      $transaction: vi.fn(async () => {
        throw new Error("nested transaction forbidden");
      }),
    };
    const sql = tx as unknown as Prisma.TransactionClient;
    const db = {
      $executeRawUnsafe: vi.fn(async (statement: string) => {
        if (!statement.startsWith("DO $$")) throw new Error("root mutation forbidden");
        return 0;
      }),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        if (!strings.join("").includes("atttypmod")) throw new Error("root query forbidden");
        return [{ dim: DIM }];
      }),
      $executeRaw: vi.fn(async () => {
        throw new Error("root mutation forbidden");
      }),
      $queryRawUnsafe: vi.fn(async () => {
        throw new Error("root query forbidden");
      }),
      $transaction: vi.fn(
        async (
          fn: (client: Prisma.TransactionClient) => Promise<unknown>,
          options?: { timeout?: number; maxWait?: number },
        ) => {
          void options;
          return fn(sql);
        },
      ),
    };
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: DIM });
    await store.ensureTable("bootstrap");
    db.$executeRawUnsafe.mockClear();
    db.$queryRaw.mockClear();
    return { store, db, tx, sql, trace };
  }

  function expectNoFallback(
    db: Awaited<ReturnType<typeof fixture>>["db"],
    tx: Awaited<ReturnType<typeof fixture>>["tx"],
  ) {
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(db.$executeRawUnsafe.mock.calls[0][0]).toContain(
      "CREATE TABLE IF NOT EXISTS rag_vector_generations",
    );
  }

  afterEach(() => vi.unstubAllEnvs());

  it("takes a parameterized transaction-lifetime advisory lock before the callback and returns its result", async () => {
    const { store, db, tx, sql, trace } = await fixture();
    vi.stubEnv("REINDEX_SWAP_TIMEOUT_MS", "120000");
    vi.stubEnv("REINDEX_SWAP_MAX_WAIT_MS", "45000");
    const projectId = "tenant'); SELECT pg_sleep(99); --";
    const result = { published: true };
    const callback = vi.fn(async (write: ProjectVectorWrite) => {
      expect(write.sql).toBe(sql);
      expect(trace).toEqual(["SELECT pg_advisory_xact_lock(543000003, hashtext(?))"]);
      return result;
    });
    await expect(store.withProjectWrite(projectId, callback)).resolves.toBe(result);
    expect(callback).toHaveBeenCalledTimes(1);
    const [template, ...bindings] = tx.$executeRaw.mock.calls[0];
    expect(template.raw).toBeDefined();
    expect(template.join("?")).toBe("SELECT pg_advisory_xact_lock(543000003, hashtext(?))");
    expect(template.join("")).not.toContain(projectId);
    expect(bindings).toEqual([projectId]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 120000,
      maxWait: 45000,
    });
    expectNoFallback(db, tx);
  });

  it("awaits lock acquisition rather than merely issuing the advisory SQL", async () => {
    const { store, tx } = await fixture();
    let acquired!: () => void;
    let issued!: () => void;
    const lock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const lockIssued = new Promise<void>((resolve) => {
      issued = resolve;
    });
    tx.$executeRaw.mockImplementationOnce(async () => {
      issued();
      await lock;
      return 1;
    });
    const callback = vi.fn(async () => "done");
    const pending = store.withProjectWrite("p1", callback);
    try {
      await lockIssued;
      expect(callback).not.toHaveBeenCalled();
    } finally {
      acquired();
      await pending;
    }
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("binds upsert/delete/list/swap and SQL selection to the exact outer transaction", async () => {
    const { store, db, tx, sql, trace } = await fixture();
    const project = "project'; --";
    const shadow = "shadow'; --";
    const chunk = "chunk'); DELETE FROM rag_vectors; --";
    const model = "model'); --";
    const vector = row(chunk, [1, 0, 0, 0], {
      text: "text'; --",
      documentId: "doc'; --",
      filename: "file'; --",
      embeddingModel: model,
    });
    tx.$queryRaw.mockResolvedValueOnce([
      { id: chunk, model, dimension: 4 },
      { id: "legacy", model: null, dimension: 2 },
    ]);
    const guard = {
      assertHeld: vi.fn(async (client?: RawSqlExecutor) => {
        expect(client).toBe(sql);
        trace.push("guard");
      }),
    };
    await store.withProjectWrite(project, async (write) => {
      expect(write.sql).toBe(sql);
      await withVectorSql(write, async (client) => {
        expect(client).toBe(sql);
      });
      await write.upsert(project, [vector]);
      expect(await write.deleteByChunkIds(project, [chunk, "second"])).toBe(2);
      expect(await write.listChunkRefs(project)).toEqual([
        { chunkId: chunk, embeddingModel: model, dimension: 4 },
        { chunkId: "legacy", embeddingModel: "", dimension: 2 },
      ]);
      await write.swapTable(project, shadow, guard);
    });
    expect(guard.assertHeld).toHaveBeenCalledExactlyOnceWith(sql);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    const [insert, ...insertBindings] = tx.$executeRawUnsafe.mock.calls[0];
    expect(insert).toContain("VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8, $9)");
    expect(insertBindings).toEqual([
      project,
      chunk,
      "[1,0,0,0]",
      vector.metadata.text,
      vector.metadata.documentId,
      0,
      vector.metadata.filename,
      model,
      expect.any(Number),
    ]);
    for (const bound of [project, chunk, model, vector.metadata.text, vector.metadata.filename]) {
      expect(insert).not.toContain(bound);
    }
    expect(tx.$executeRawUnsafe.mock.calls[1]).toEqual([
      'DELETE FROM "rag_vectors" WHERE "project_id" = $1 AND "id" IN ($2, $3)',
      project,
      chunk,
      "second",
    ]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [list, ...listBindings] = tx.$queryRaw.mock.calls[0];
    expect(list.join("?").replace(/\s+/g, " ").trim()).toBe(
      'SELECT "id", "model", vector_dims("embedding") AS "dimension" FROM "rag_vectors" WHERE "project_id" = ?',
    );
    expect(listBindings).toEqual([project]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    const [remove, ...removeBindings] = tx.$executeRaw.mock.calls[1];
    const [relabel, ...relabelBindings] = tx.$executeRaw.mock.calls[2];
    expect(remove.join("?")).toBe('DELETE FROM "rag_vectors" WHERE "project_id" = ?');
    expect(removeBindings).toEqual([project]);
    expect(relabel.join("?")).toBe(
      'UPDATE "rag_vectors" SET "project_id" = ? WHERE "project_id" = ?',
    );
    expect(relabelBindings).toEqual([project, shadow]);
    expect(trace.slice(-3)).toEqual(["guard", remove.join("?"), relabel.join("?")]);
    expectNoFallback(db, tx);
  });

  it("keeps empty upsert/delete as no-ops and allows a swap without a guard in the same transaction", async () => {
    const { store, db, tx } = await fixture();
    await store.withProjectWrite("p1", async (write) => {
      await write.upsert("p1", []);
      expect(await write.deleteByChunkIds("p1", [])).toBe(0);
      await write.swapTable("p1", "shadow");
    });
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expectNoFallback(db, tx);
  });

  it.each([false, true])(
    "reads and writes parameterized durable generation with pending=%s",
    async (pending) => {
      const { store, db, tx } = await fixture();
      const project = "p'); --";
      const generation = { model: "model'); --", dimension: DIM, pending };
      tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([generation]);
      await store.withProjectWrite(project, async (write) => {
        expect(await write.readGeneration()).toBeNull();
        await write.writeGeneration(generation);
        expect(await write.readGeneration()).toEqual(generation);
      });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      for (const [template, ...bindings] of tx.$queryRaw.mock.calls) {
        expect(template.join("?")).toMatch(
          /SELECT model, dimension, pending FROM rag_vector_generations\s+WHERE project_id = \?/,
        );
        expect(bindings).toEqual([project]);
      }
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      const [template, ...bindings] = tx.$executeRaw.mock.calls[1];
      const statement = template.join("?");
      expect(statement).toContain("VALUES (?, ?, ?, ?)");
      expect(statement).toContain("ON CONFLICT (project_id) DO UPDATE");
      expect(statement).toContain("model = EXCLUDED.model");
      expect(statement).toContain("dimension = EXCLUDED.dimension");
      expect(statement).toContain("pending = EXCLUDED.pending");
      expect(statement).not.toContain(project);
      expect(statement).not.toContain(generation.model);
      expect(bindings).toEqual([project, generation.model, DIM, pending]);
      expectNoFallback(db, tx);
    },
  );

  it.each([
    null,
    {},
    { model: "", dimension: DIM, pending: false },
    { model: "m", dimension: 0, pending: false },
    { model: "m", dimension: 1.5, pending: false },
    { model: "m", dimension: DIM, pending: "false" },
  ])("rejects malformed generation %j on both read and write", async (generation) => {
    const { store, db, tx } = await fixture();
    tx.$queryRaw.mockResolvedValueOnce([generation]);
    await expect(store.withProjectWrite("p1", (write) => write.readGeneration())).rejects.toThrow(
      "Invalid durable vector generation descriptor",
    );
    expectNoFallback(db, tx);
    db.$transaction.mockClear();
    tx.$executeRaw.mockClear();
    await expect(
      store.withProjectWrite("p1", (write) =>
        write.writeGeneration(generation as VectorGeneration),
      ),
    ).rejects.toThrow("Invalid durable vector generation descriptor");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // Advisory lock only: no invalid INSERT.
    expectNoFallback(db, tx);
  });

  it.each(["", "p\0x"])(
    "rejects invalid project %j before bootstrap or transaction",
    async (project) => {
      const { store, db, tx } = await fixture();
      const callback = vi.fn();
      await expect(store.withProjectWrite(project, callback)).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it.each([
    "lock",
    "upsert",
    "delete",
    "list",
    "read-generation",
    "write-generation",
    "guard",
    "swap-delete",
    "swap-update",
    "callback",
  ] as const)(
    "propagates %s failure without nested transactions, root fallback, or callback retry",
    async (stage) => {
      const { store, db, tx, sql } = await fixture();
      const error = new Error(`${stage} failed`);
      const guard = {
        assertHeld: vi.fn(async () => {
          throw error;
        }),
      };
      if (stage === "lock") tx.$executeRaw.mockRejectedValueOnce(error);
      if (stage === "upsert" || stage === "delete")
        tx.$executeRawUnsafe.mockRejectedValueOnce(error);
      if (stage === "list" || stage === "read-generation")
        tx.$queryRaw.mockRejectedValueOnce(error);
      if (stage === "write-generation" || stage === "swap-delete") {
        tx.$executeRaw.mockResolvedValueOnce(1).mockRejectedValueOnce(error);
      }
      if (stage === "swap-update") {
        tx.$executeRaw
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(1)
          .mockRejectedValueOnce(error);
      }
      const callback = vi.fn(async (write: ProjectVectorWrite) => {
        expect(write.sql).toBe(sql);
        switch (stage) {
          case "upsert":
            return write.upsert("p1", [row("a", [1, 0, 0, 0])]);
          case "delete":
            return write.deleteByChunkIds("p1", ["a"]);
          case "list":
            return write.listChunkRefs("p1");
          case "read-generation":
            return write.readGeneration();
          case "write-generation":
            return write.writeGeneration({ model: "m", dimension: DIM, pending: true });
          case "guard":
            return write.swapTable("p1", "shadow", guard);
          case "swap-delete":
          case "swap-update":
            return write.swapTable("p1", "shadow");
          default:
            throw error;
        }
      });
      await expect(store.withProjectWrite("p1", callback)).rejects.toBe(error);
      expect(callback).toHaveBeenCalledTimes(stage === "lock" ? 0 : 1);
      if (stage === "guard") {
        expect(guard.assertHeld).toHaveBeenCalledExactlyOnceWith(sql);
        expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // Nothing destructive after a failed fence.
      }
      if (stage === "swap-delete") expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      if (stage === "swap-update") expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
      expectNoFallback(db, tx);
    },
  );

  it("propagates transaction acquisition failure without invoking the callback", async () => {
    const { store, db, tx } = await fixture();
    const error = new Error("pool unavailable");
    db.$transaction.mockRejectedValueOnce(error);
    const callback = vi.fn();
    await expect(store.withProjectWrite("p1", callback)).rejects.toBe(error);
    expect(callback).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expectNoFallback(db, tx);
  });

  it("retries failed generation bootstrap on the next call and memoizes successful DDL", async () => {
    const { store, db, tx } = await fixture();
    const error = new Error("generation DDL failed");
    db.$executeRawUnsafe.mockRejectedValueOnce(error);
    const callback = vi.fn(async () => "ok");
    await expect(store.withProjectWrite("p1", callback)).rejects.toBe(error);
    expect(callback).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    await expect(store.withProjectWrite("p1", callback)).resolves.toBe("ok");
    await expect(store.withProjectWrite("p2", callback)).resolves.toBe("ok");
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls.map(([, ...values]) => values)).toEqual([["p1"], ["p2"]]);
    expect(tx.$transaction).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("pgvector helpers", () => {
  it("toVectorLiteral renders a bracketed list", () => {
    expect(toVectorLiteral([1, 2, 3])).toBe("[1,2,3]");
  });
  it("parseVectorLiteral round-trips a literal", () => {
    expect(parseVectorLiteral("[1,2,3]")).toEqual([1, 2, 3]);
  });
  it("parseVectorLiteral passes arrays through", () => {
    expect(parseVectorLiteral([4, 5])).toEqual([4, 5]);
  });
  it("parseVectorLiteral handles empty / non-string", () => {
    expect(parseVectorLiteral("[]")).toEqual([]);
    expect(parseVectorLiteral(null)).toEqual([]);
    expect(parseVectorLiteral(42)).toEqual([]);
  });
});

describe("resolveEmbedDimension", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns a positive integer (the configured embedder dimension)", () => {
    const dim = resolveEmbedDimension();
    expect(Number.isInteger(dim)).toBe(true);
    expect(dim).toBeGreaterThan(0);
  });
});

describe("PgVectorStore — store/retrieve mechanics", () => {
  let db: FakeSharedPg;
  let store: PgVectorStore;

  beforeEach(() => {
    db = new FakeSharedPg();
    store = makeStore(db);
  });

  it("rejects an empty projectId", async () => {
    await expect(store.upsert("", [row("a", [1, 0, 0, 0])])).rejects.toThrow();
  });

  it("rejects a projectId with a null byte", async () => {
    await expect(store.ensureTable("p\0x")).rejects.toThrow(/null byte/);
  });

  it("bootstraps the schema exactly once across many calls", async () => {
    await store.ensureTable("p1");
    await store.upsert("p1", [row("a", [1, 0, 0, 0])]);
    await store.count("p1");
    expect(db.ddlCount).toBe(1);
  });

  it("upsert then count reflects stored rows", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0, 0]), row("b", [0, 1, 0, 0])]);
    expect(await store.count("p1")).toBe(2);
  });

  it("upsert is idempotent on (project_id, id) — re-upsert overwrites", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0, 0], { text: "v1" })]);
    await store.upsert("p1", [row("a", [0, 1, 0, 0], { text: "v2" })]);
    expect(await store.count("p1")).toBe(1);
    const hits = await store.search("p1", [0, 1, 0, 0], 1);
    expect(hits[0]?.row.metadata.text).toBe("v2");
  });

  it("rejects an empty vector", async () => {
    await expect(store.upsert("p1", [row("a", [])])).rejects.toThrow(/empty/);
  });

  it("rejects a vector whose dimension does not match the store", async () => {
    await expect(store.upsert("p1", [row("a", [1, 0, 0])])).rejects.toThrow(/dimension/);
  });

  it("empty upsert is a no-op", async () => {
    await store.upsert("p1", []);
    expect(await store.count("p1")).toBe(0);
  });

  it("search returns top-k ranked by cosine similarity (parity)", async () => {
    await store.upsert("p1", [
      row("near", [1, 0, 0, 0]),
      row("mid", [0.7, 0.7, 0, 0]),
      row("far", [0, 0, 0, 1]),
    ]);
    const hits = await store.search("p1", [1, 0, 0, 0], 2);
    expect(hits.map((h) => h.row.id)).toEqual(["near", "mid"]);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("search with k<=0 returns nothing", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0, 0])]);
    expect(await store.search("p1", [1, 0, 0, 0], 0)).toEqual([]);
  });

  it("search filters by embeddingModel", async () => {
    // model is per-batch, so the two models go in separate upserts.
    await store.upsert("p1", [row("a", [1, 0, 0, 0], { embeddingModel: "model-x" })]);
    await store.upsert("p1", [row("b", [1, 0, 0, 0], { embeddingModel: "model-y" })]);
    const hits = await store.search("p1", [1, 0, 0, 0], 5, { embeddingModel: "model-x" });
    expect(hits.map((h) => h.row.id)).toEqual(["a"]);
  });

  it("search filters by documentIds", async () => {
    await store.upsert("p1", [
      row("a", [1, 0, 0, 0], { documentId: "d1" }),
      row("b", [1, 0, 0, 0], { documentId: "d2" }),
    ]);
    const hits = await store.search("p1", [1, 0, 0, 0], 5, { documentIds: ["d2"] });
    expect(hits.map((h) => h.row.id)).toEqual(["b"]);
  });

  it("deleteByDocument removes matching rows and returns the count", async () => {
    await store.upsert("p1", [
      row("a", [1, 0, 0, 0], { documentId: "d1" }),
      row("b", [0, 1, 0, 0], { documentId: "d1" }),
      row("c", [0, 0, 1, 0], { documentId: "d2" }),
    ]);
    expect(await store.deleteByDocument("p1", "d1")).toBe(2);
    expect(await store.count("p1")).toBe(1);
  });

  it("deleteByChunkIds removes the given ids", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0, 0]), row("b", [0, 1, 0, 0])]);
    expect(await store.deleteByChunkIds("p1", ["a"])).toBe(1);
    expect(await store.deleteByChunkIds("p1", [])).toBe(0);
    expect(await store.count("p1")).toBe(1);
  });

  it("modelCoverage buckets per model", async () => {
    // model is bound per upsert batch (one embedding run = one model), matching
    // real usage — so we upsert the two models in separate batches.
    await store.upsert("p1", [
      row("a", [1, 0, 0, 0], { embeddingModel: "m1" }),
      row("b", [0, 1, 0, 0], { embeddingModel: "m1" }),
    ]);
    await store.upsert("p1", [row("c", [0, 0, 1, 0], { embeddingModel: "m2" })]);
    const cov = await store.modelCoverage("p1");
    expect(cov.totalChunks).toBe(3);
    expect(cov.modelCounts).toEqual({ m1: 2, m2: 1 });
  });

  it("dropTable clears only the given project's rows", async () => {
    await store.upsert("p1", [row("a", [1, 0, 0, 0])]);
    await store.upsert("p2", [row("b", [0, 1, 0, 0])]);
    await store.dropTable("p1");
    expect(await store.count("p1")).toBe(0);
    expect(await store.count("p2")).toBe(1);
  });
});

describe("PgVectorStore — construction + lifecycle", () => {
  it("derives the dimension from the configured embedder when not given", () => {
    // No explicit dimension -> resolveEmbedDimension() -> embedder.dimension.
    const db = new FakeSharedPg();
    const store = new PgVectorStore({ db: db as unknown as PrismaClient });
    expect(store).toBeInstanceOf(PgVectorStore);
  });

  it("rejects a non-positive / non-integer dimension", () => {
    const db = new FakeSharedPg();
    expect(() => new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 0 })).toThrow(
      /invalid embedding dimension/,
    );
    expect(() => new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 1.5 })).toThrow(
      /invalid embedding dimension/,
    );
  });

  it("reset truncates the table (best-effort)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.upsert("p1", [row("a", [1, 0, 0, 0])]);
    await store.reset();
    expect(await store.count("p1")).toBe(0);
  });

  it("re-bootstraps after a transient DDL failure (memo reset)", async () => {
    const db = new FakeSharedPg();
    const failOnce = vi
      .spyOn(db, "$executeRawUnsafe")
      .mockRejectedValueOnce(new Error("transient connection drop"));
    const store = makeStore(db);
    await expect(store.ensureTable("p1")).rejects.toThrow(/transient/);
    failOnce.mockRestore();
    // Second attempt rebuilds the memo and succeeds.
    await expect(store.ensureTable("p1")).resolves.toBeUndefined();
  });

  it("registerPgVectorStore wires the resolver to a PgVectorStore", () => {
    vi.stubEnv("AI_OFFLINE", "");
    vi.stubEnv("VECTOR_STORE", "pgvector");
    __clearPgVectorStoreFactory();
    __resetVectorStoreSingleton();
    registerPgVectorStore();
    expect(getVectorStore()).toBeInstanceOf(PgVectorStore);
    vi.unstubAllEnvs();
    __resetVectorStoreSingleton();
  });
});

describe("PgVectorStore — namespace isolation", () => {
  it("never returns another project's rows", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.upsert("alpha", [row("a", [1, 0, 0, 0], { text: "alpha-doc" })]);
    await store.upsert("beta", [row("b", [1, 0, 0, 0], { text: "beta-doc" })]);
    const hits = await store.search("alpha", [1, 0, 0, 0], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].row.metadata.text).toBe("alpha-doc");
  });
});

describe("PgVectorStore — swapTable (reindex)", () => {
  it("relabels shadow rows onto the live project and drops the shadow", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.upsert("live", [row("old", [1, 0, 0, 0], { text: "old" })]);
    await store.upsert("live__shadow", [row("new", [0, 1, 0, 0], { text: "new" })]);
    await store.swapTable("live", "live__shadow");
    expect(await store.count("live")).toBe(1);
    expect(await store.count("live__shadow")).toBe(0);
    const hits = await store.search("live", [0, 1, 0, 0], 1);
    expect(hits[0].row.metadata.text).toBe("new");
  });

  it("throws when both live and shadow are empty (nothing to swap)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await expect(store.swapTable("live", "missing__shadow")).rejects.toThrow(/nothing to swap/);
  });

  /**
   * Issue #798 — the swap's fence. A run whose reindex lease has been stolen must not
   * be able to cut its shadow over the live index, and the check has to happen INSIDE
   * the swap transaction (with the tx client), not before it — otherwise a lease steal
   * can land in the gap between the check and the cut-over.
   */
  it("REFUSES the swap when the guard rejects — and the live rows survive untouched", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.upsert("live", [row("old", [1, 0, 0, 0], { text: "old" })]);
    await store.upsert("live__shadow", [row("new", [0, 1, 0, 0], { text: "new" })]);

    const guard = {
      assertHeld: vi.fn().mockRejectedValue(new Error("fenced: the lease is no longer yours")),
    };
    await expect(store.swapTable("live", "live__shadow", guard)).rejects.toThrow(/fenced/);

    // The live index is EXACTLY as it was; the shadow is still there to retry from.
    expect(await store.count("live")).toBe(1);
    expect(await store.count("live__shadow")).toBe(1);
    const hits = await store.search("live", [1, 0, 0, 0], 1);
    expect(hits[0].row.metadata.text).toBe("old");
  });

  /**
   * PR #805 review — this test used to claim it proved the guard runs INSIDE the
   * transaction, by asserting `assertHeld` was called with the tx client. It proved no
   * such thing: `FakeSharedPg.$transaction(fn)` is `fn(this)`, so `tx === db` BY
   * CONSTRUCTION and the assertion held even if the guard were called outside the
   * transaction entirely. Renamed to what it can honestly show — the guard is handed a
   * live executor and runs BEFORE either mutation — and the real property (a concurrent
   * lease steal BLOCKS on the guard's `SELECT … FOR UPDATE` until the swap commits) is
   * now proved where it can be: against a real Postgres, in
   * `tests/reindex-lease-postgres.integration.test.ts` (c4/c5). A row lock cannot be
   * observed by a fake that has no rows to lock.
   */
  it("hands the guard an executor and fences BEFORE either mutation runs", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.upsert("live", [row("old", [1, 0, 0, 0], { text: "old" })]);
    await store.upsert("live__shadow", [row("new", [0, 1, 0, 0], { text: "new" })]);
    db.trace.length = 0;

    const guard = {
      assertHeld: vi.fn().mockImplementation(() => {
        db.trace.push("assertHeld");
        return Promise.resolve();
      }),
    };
    await store.swapTable("live", "live__shadow", guard);

    expect(guard.assertHeld).toHaveBeenCalledTimes(1);
    expect(guard.assertHeld.mock.calls[0][0]).toBeDefined();
    // Ordering is the honest assertion: the fence precedes the destructive DELETE.
    expect(db.trace).toEqual(["assertHeld", "DELETE", "UPDATE"]);
    expect(await store.count("live")).toBe(1);
    const hits = await store.search("live", [0, 1, 0, 0], 1);
    expect(hits[0].row.metadata.text).toBe("new");
  });

  /**
   * PR #805 review, BLOCKING #1 — the cut-over's deadline.
   *
   * #798 moved the swap from the BATCH `$transaction([...])` form (no client-side
   * deadline) to the INTERACTIVE form, which inherits Prisma's 5 s `timeout`. The swap's
   * `DELETE` + `UPDATE` rewrite an entire corpus and cannot finish in 5 s on a large
   * project — so the reindex would burn its whole embed loop and then die at the last
   * step with P2028, unclearably, on exactly the migration #787 exists to perform.
   *
   * The fake charges `msPerStatement` against the transaction's real deadline semantics,
   * so "a big-corpus swap" is expressible without a slow test.
   */
  describe("the cut-over's transaction deadline (#805 review)", () => {
    /** One DELETE/UPDATE over a large project: tens of seconds, not milliseconds. */
    const BIG_CORPUS_STATEMENT_MS = 45_000;

    function seed(db: FakeSharedPg) {
      const store = makeStore(db);
      db.msPerStatement = BIG_CORPUS_STATEMENT_MS;
      return store;
    }

    it("a LARGE-corpus swap COMPLETES — the explicit timeout is sized for the real work", async () => {
      const db = new FakeSharedPg();
      const store = seed(db);
      await store.upsert("live", [row("old", [1, 0, 0, 0], { text: "old" })]);
      await store.upsert("live__shadow", [row("new", [0, 1, 0, 0], { text: "new" })]);

      // 90 s of cut-over — 18× Prisma's default. Must not be a failure.
      await expect(store.swapTable("live", "live__shadow")).resolves.toBeUndefined();

      expect(await store.count("live")).toBe(1);
      const hits = await store.search("live", [0, 1, 0, 0], 1);
      expect(hits[0].row.metadata.text).toBe("new");

      // And it asked for the deadline explicitly rather than inheriting one.
      expect(db.lastTxOptions?.timeout).toBe(DEFAULT_REINDEX_SWAP_TIMEOUT_MS);
      expect(db.lastTxOptions?.maxWait).toBe(DEFAULT_REINDEX_SWAP_MAX_WAIT_MS);
      expect(db.lastTxOptions?.timeout).toBeGreaterThan(PRISMA_DEFAULT_TX_TIMEOUT_MS);
    });

    it("PROOF — the SAME swap under Prisma's DEFAULT 5s timeout dies with P2028 mid-cut-over", async () => {
      const db = new FakeSharedPg();
      // Discard the options the store passes: this is the pre-fix call site, byte for
      // byte. If `swapTable` ever stops passing an explicit timeout, the test above goes
      // red and this one keeps passing — that is the regression this pair guards.
      db.ignoreTxOptions = true;
      const store = seed(db);
      await store.upsert("live", [row("old", [1, 0, 0, 0], { text: "old" })]);
      await store.upsert("live__shadow", [row("new", [0, 1, 0, 0], { text: "new" })]);

      await expect(store.swapTable("live", "live__shadow")).rejects.toMatchObject({
        code: "P2028",
      });

      // The failure is safe (the transaction rolls back: live intact, shadow intact and
      // resumable) — but it is PERMANENT. Retrying re-runs the same doomed statements.
      expect(await store.count("live")).toBe(1);
      expect(await store.count("live__shadow")).toBe(1);
      const hits = await store.search("live", [1, 0, 0, 0], 1);
      expect(hits[0].row.metadata.text).toBe("old");
    });

    it("the deadline is operator-tunable, and falls back to the default when unset/garbage", () => {
      expect(reindexSwapTimeoutMs({ REINDEX_SWAP_TIMEOUT_MS: "900000" })).toBe(900_000);
      expect(reindexSwapMaxWaitMs({ REINDEX_SWAP_MAX_WAIT_MS: "45000" })).toBe(45_000);
      for (const bad of ["", "0", "-1", "abc"]) {
        expect(reindexSwapTimeoutMs({ REINDEX_SWAP_TIMEOUT_MS: bad })).toBe(
          DEFAULT_REINDEX_SWAP_TIMEOUT_MS,
        );
        expect(reindexSwapMaxWaitMs({ REINDEX_SWAP_MAX_WAIT_MS: bad })).toBe(
          DEFAULT_REINDEX_SWAP_MAX_WAIT_MS,
        );
      }
      expect(reindexSwapTimeoutMs({})).toBe(DEFAULT_REINDEX_SWAP_TIMEOUT_MS);
      expect(reindexSwapMaxWaitMs({})).toBe(DEFAULT_REINDEX_SWAP_MAX_WAIT_MS);
    });

    it("a UNIT SUFFIX is REFUSED, not silently truncated (`10min` must never mean 10 ms)", () => {
      // PR #805 review nit. `Number.parseInt` reads the longest numeric PREFIX and throws
      // the rest away, so the old parser turned the entirely reasonable-looking
      // `REINDEX_SWAP_TIMEOUT_MS=10min` into a TEN MILLISECOND cut-over deadline — a far
      // worse version of the P2028 bug this budget exists to fix, arrived at silently.
      // Every one of these is a plausible thing for an operator to type.
      for (const [value, wouldHaveBeen] of [
        ["10min", 10],
        ["600s", 600],
        ["10_000", 10],
        ["1e6", 1],
        ["600000ms", 600_000],
        [" 5 000", 5],
        ["+900000", 900_000],
      ] as const) {
        expect(Number.parseInt(value, 10)).toBe(wouldHaveBeen); // the trap, demonstrated
        // …and refused: we fall back to the documented default rather than reinterpret.
        expect(reindexSwapTimeoutMs({ REINDEX_SWAP_TIMEOUT_MS: value })).toBe(
          DEFAULT_REINDEX_SWAP_TIMEOUT_MS,
        );
      }
      // Digits only, with surrounding whitespace tolerated — that much is just a tidy env file.
      expect(reindexSwapTimeoutMs({ REINDEX_SWAP_TIMEOUT_MS: " 900000 " })).toBe(900_000);
    });

    it("the swap budget is CLAMPED — a backstop you can set to a day is not a backstop", () => {
      // For the whole transaction the swap holds row locks on the live corpus AND on the
      // lease row (blocking ingest, the heartbeat and any steal) and pins a pooled
      // connection. A fat-fingered trailing zero should be clamped, loudly, not honoured.
      expect(reindexSwapTimeoutMs({ REINDEX_SWAP_TIMEOUT_MS: "6000000" })).toBe(
        MAX_REINDEX_SWAP_TIMEOUT_MS,
      );
      expect(reindexSwapMaxWaitMs({ REINDEX_SWAP_MAX_WAIT_MS: "6000000" })).toBe(
        MAX_REINDEX_SWAP_MAX_WAIT_MS,
      );
      // At the ceiling exactly is fine.
      expect(
        reindexSwapTimeoutMs({ REINDEX_SWAP_TIMEOUT_MS: `${MAX_REINDEX_SWAP_TIMEOUT_MS}` }),
      ).toBe(MAX_REINDEX_SWAP_TIMEOUT_MS);
    });

    it("the lease extension COVERS the swap budget — the fence cannot outlive its own lease", () => {
      // The invariant that ties the two modules together. If the fence renewed the lease
      // for LESS time than the transaction is allowed to run, a long cut-over could still
      // reach COMMIT expired — which is the exact bug (c6) exists to prevent.
      for (const env of [
        {},
        { REINDEX_SWAP_TIMEOUT_MS: "900000" },
        { REINDEX_SWAP_TIMEOUT_MS: "1" },
      ]) {
        expect(reindexSwapLeaseExtensionMs(env)).toBeGreaterThan(reindexSwapTimeoutMs(env));
      }
    });
  });
});

describe("PgVectorStore — MULTI-REPLICA safety (the #543 keystone)", () => {
  it("two separate store instances on one Postgres both read AND write with no corruption", async () => {
    // ONE shared backend = one Postgres; two PgVectorStore instances = two pods.
    const shared = new FakeSharedPg();
    const replicaA = makeStore(shared);
    const replicaB = makeStore(shared);

    // Both replicas write concurrently to the SAME project — the LanceDB failure
    // mode (two writers corrupting one local dir) cannot happen: writes serialize
    // through Postgres and both land.
    await Promise.all([
      replicaA.upsert("proj", [row("a", [1, 0, 0, 0], { text: "from-A" })]),
      replicaB.upsert("proj", [row("b", [0, 1, 0, 0], { text: "from-B" })]),
    ]);

    // Either replica sees BOTH writes (shared state, not per-pod).
    expect(await replicaA.count("proj")).toBe(2);
    expect(await replicaB.count("proj")).toBe(2);

    // A write on A is immediately queryable on B (cross-replica read).
    const hitsOnB = await replicaB.search("proj", [1, 0, 0, 0], 1);
    expect(hitsOnB[0].row.metadata.text).toBe("from-A");

    // A delete on B is reflected on A.
    await replicaB.deleteByChunkIds("proj", ["a"]);
    expect(await replicaA.count("proj")).toBe(1);
  });
});

describe("getVectorStore — VECTOR_STORE=pgvector selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetVectorStoreSingleton();
  });

  it("getVectorStore returns the registered pgvector store when VECTOR_STORE=pgvector", () => {
    // The test harness sets AI_OFFLINE=1 (which forces the local store); clear it
    // so the pgvector branch is reachable.
    vi.stubEnv("AI_OFFLINE", "");
    vi.stubEnv("VECTOR_STORE", "pgvector");
    __resetVectorStoreSingleton();
    const shared = new FakeSharedPg();
    __setPgVectorStoreFactory(() => makeStore(shared));
    const store = getVectorStore();
    expect(store).toBeInstanceOf(PgVectorStore);
  });

  it("throws if VECTOR_STORE=pgvector but no factory is registered (fail loud, no silent LanceDB)", () => {
    vi.stubEnv("AI_OFFLINE", "");
    vi.stubEnv("VECTOR_STORE", "pgvector");
    __clearPgVectorStoreFactory();
    expect(() => getVectorStore()).toThrow(/factory was not registered/);
  });

  it("VECTOR_STORE=local always wins over pgvector (offline path)", () => {
    vi.stubEnv("VECTOR_STORE", "local");
    __clearPgVectorStoreFactory();
    __resetVectorStoreSingleton();
    expect(getVectorStore()).not.toBeInstanceOf(PgVectorStore);
  });
});

/**
 * Issue #783 — the 384 → 768 UPGRADE guard.
 *
 * This is the case that decides what happens to a REAL existing deployment the
 * moment the model default flips. `rag_vectors` is one shared table with a
 * `vector(384)` column; `CREATE TABLE IF NOT EXISTS … vector(768)` is a silent
 * no-op against it. Without a guard, the store boots clean and then rejects every
 * insert from inside an ingest with a Postgres error that names two integers and
 * nothing else. With it, the store refuses ONCE, at bootstrap, and says why.
 */
describe("PgVectorStore — embedding-model upgrade (#783)", () => {
  it("REFUSES to operate when the existing column is narrower than the active embedder", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 384; // the table an existing deployment already has
    const store = new PgVectorStore({
      db: db as unknown as PrismaClient,
      dimension: 768, // the model #783 flips to
    });

    await expect(store.ensureTable("p1")).rejects.toThrow(/Embedding dimension mismatch/);
    await expect(store.ensureTable("p1")).rejects.toThrow(/384-dim.*768-dim/s);
    // And it points at the fix rather than leaving the operator to infer it.
    await expect(store.ensureTable("p1")).rejects.toThrow(/Reindex every project/);
  });

  it("refuses the WRITE path too, not just the bootstrap call", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 384;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });

    await expect(store.upsert("p1", [row("a", new Array<number>(768).fill(0.1))])).rejects.toThrow(
      /Embedding dimension mismatch/,
    );
    // NOTHING was written. The whole point: no half-migrated vector space.
    expect(db.rows).toHaveLength(0);
  });

  it("proceeds normally when the column already matches the active embedder", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 768;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });
    await expect(store.ensureTable("p1")).resolves.toBeUndefined();
  });

  it("does not guess when the catalog says nothing (fresh DB, unconstrained column)", async () => {
    // A width we cannot establish is not a mismatch we can prove. Guessing here
    // would refuse writes on a perfectly good table — the guard must have no false
    // positives, or the first thing an operator learns is to disable it.
    const db = new FakeSharedPg();
    db.columnDim = null;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });
    await expect(store.ensureTable("p1")).resolves.toBeUndefined();

    db.columnDim = -1; // pgvector's "no dimension specified"
    const store2 = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });
    await expect(store2.ensureTable("p2")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #787 — resume checkpoint + the pgvector column-width migration.
// ---------------------------------------------------------------------------

describe("#787 — listChunkRefs (the shadow-reindex resume checkpoint)", () => {
  it("returns every stored row's id + model tag, scoped to the project", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.upsert("p1", [
      row("a", [1, 0, 0, 0], { embeddingModel: "m-new" }),
      row("b", [0, 1, 0, 0], { embeddingModel: "m-new" }),
    ]);
    await store.upsert("p2", [row("c", [0, 0, 1, 0], { embeddingModel: "m-old" })]);

    const refs = await store.listChunkRefs("p1");
    expect(refs).toEqual([
      { chunkId: "a", embeddingModel: "m-new", dimension: 4 },
      { chunkId: "b", embeddingModel: "m-new", dimension: 4 },
    ]);
    // Namespace isolation holds here too — p2's rows are invisible.
    expect(await store.listChunkRefs("p2")).toEqual([
      { chunkId: "c", embeddingModel: "m-old", dimension: 4 },
    ]);
  });

  it("returns [] for a project with no rows (nothing to resume)", async () => {
    const store = makeStore(new FakeSharedPg());
    expect(await store.listChunkRefs("never-indexed")).toEqual([]);
  });
});

describe("#787 — storedDimension", () => {
  it("reads the column's real width from the catalog", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 384;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });
    expect(await store.storedDimension()).toBe(384);
  });

  it("works even when ensureSchema() would REFUSE — the diagnostic must survive the failure it diagnoses", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 384;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });

    // The #783 guard refuses the store outright at 384-vs-768...
    await expect(store.ensureTable("p1")).rejects.toThrow(/VECTOR_DIMENSION_MISMATCH|dimension/i);
    // ...and yet the operator can still ask what width the column actually is.
    // A status command that dies on the problem it exists to report is useless.
    expect(await store.storedDimension()).toBe(384);
  });

  it("returns null for a table that does not exist yet, and for an unconstrained column", async () => {
    const db = new FakeSharedPg();
    db.columnDim = null;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });
    expect(await store.storedDimension()).toBeNull();

    db.columnDim = -1;
    expect(await store.storedDimension()).toBeNull();
  });
});

describe("#787 — migrateColumnDimension", () => {
  it("widens the shared column, dropping the old generation's vectors", async () => {
    const db = new FakeSharedPg();
    // An existing 384-dim deployment with vectors in it.
    db.columnDim = 384;
    db.rows = [
      {
        project_id: "p1",
        id: "a",
        embedding: [1, 2, 3],
        text: "t",
        document_id: "d",
        chunk_index: 0,
        filename: "f",
        model: "Xenova/bge-small-en-v1.5",
        created_at: 0,
      },
    ];
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });

    const result = await store.migrateColumnDimension();

    expect(result).toEqual({ from: 384, to: 768, migrated: true, droppedRows: 1 });
    expect(db.columnDim).toBe(768);
    expect(db.rows).toEqual([]);

    // The store is USABLE again — this is the whole point. Before the migration
    // ensureSchema() refused; now a 768-dim write lands.
    await expect(
      store.upsert("p1", [
        {
          id: "a",
          vector: new Array<number>(768).fill(0.1),
          metadata: {
            chunkId: "a",
            documentId: "d",
            filename: "f",
            position: 0,
            text: "t",
            embeddingModel: "Alibaba-NLP/gte-modernbert-base",
          },
        },
      ]),
    ).resolves.toBeUndefined();
    expect(db.rows).toHaveLength(1);
  });

  it("is a no-op when the width already matches — running it twice is safe", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 768;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });

    const result = await store.migrateColumnDimension();
    expect(result).toEqual({ from: 768, to: 768, migrated: false, droppedRows: 0 });
    expect(db.columnDim).toBe(768);
  });

  it("creates the table at the right width on a fresh DB", async () => {
    const db = new FakeSharedPg();
    db.columnDim = null;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });

    const result = await store.migrateColumnDimension();
    expect(result).toMatchObject({ from: null, migrated: true, to: 768, droppedRows: 0 });
    expect(db.columnDim).toBe(768);
  });
});

/** A row as it already sits in the shared table (the old generation's vectors). */
function storedRow(projectId: string, id: string): StoredRow {
  return {
    project_id: projectId,
    id,
    embedding: [1, 2, 3],
    text: "t",
    document_id: "d",
    chunk_index: 0,
    filename: "f",
    model: "Xenova/bge-small-en-v1.5",
    created_at: 0,
  };
}

/**
 * PR #796 review — the two data-loss paths in `migrateColumnDimension()`.
 *
 * Both of these are about the same thing: this is the ONE fleet-wide, destructive,
 * NON-resumable operation in the whole migration, so nothing in it may fail after it
 * has dropped something, and nothing degraded may be allowed to tell it how wide to
 * rebuild.
 */
describe("#796 review — migrateColumnDimension refuses to lose data", () => {
  afterEach(() => {
    fakeEmbedder.current = null;
    vi.unstubAllEnvs();
  });

  // ---- B1: a degraded embedder must never size a destructive migration --------

  it("B1: REFUSES when the embedder has fallen back to the hash stub — the stub's width never sizes the column", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 768; // a healthy gte-modernbert deployment
    db.rows = [storedRow("p1", "a")];
    // The real backend failed to warm and EMBED_ALLOW_HASH_FALLBACK let the stub take
    // over: `getEmbedder()` now reports the STUB's model and the STUB's width.
    fakeEmbedder.current = {
      model: "metis-offline-hash-v1",
      dimension: 384,
      fellBack: true,
      lastError: null,
    };
    // ...and `getVectorStore()` derives the store's width from it, which is how the
    // stub's 384 becomes the migration TARGET.
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 384 });

    await expect(store.migrateColumnDimension()).rejects.toThrow(/DEGRADED/);
    await expect(store.migrateColumnDimension()).rejects.toThrow(/hash stub/);

    // NOTHING happened. Not the drop, not the rebuild, not the row loss.
    expect(db.columnDim).toBe(768);
    expect(db.rows).toHaveLength(1);
    expect(db.ddlLog).toEqual([]);
  });

  it("B1: REFUSES when the embedder failed to load at all", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 768;
    fakeEmbedder.current = {
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 384,
      fellBack: false,
      lastError: "sidecar unreachable: ECONNREFUSED",
    };
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 384 });

    await expect(store.migrateColumnDimension()).rejects.toThrow(/DEGRADED/);
    await expect(store.migrateColumnDimension()).rejects.toThrow(/ECONNREFUSED/);
    expect(db.columnDim).toBe(768);
    expect(db.ddlLog).toEqual([]);
  });

  it("B1: proceeds for a HEALTHY embedder — the guard has no false positives", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 384;
    fakeEmbedder.current = {
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      fellBack: false,
      lastError: null,
    };
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });

    await expect(store.migrateColumnDimension()).resolves.toMatchObject({ migrated: true });
    expect(db.columnDim).toBe(768);
  });

  // ---- B2: never drop before the new schema is known to be creatable ----------

  it("B2: a stale EMBED_DIM is refused BEFORE the drop — the deployment is never left with no table", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 384;
    db.rows = [storedRow("p1", "a")];
    // The scenario `assertEmbedderDimension`'s docblock calls the single most likely
    // upgrade config there is: a leftover EMBED_DIM=384 from the pre-#783 default,
    // while the active embedder emits 768.
    vi.stubEnv("EMBED_DIM", "384");
    fakeEmbedder.current = {
      model: "Alibaba-NLP/gte-modernbert-base",
      dimension: 768,
      fellBack: false,
      lastError: null,
    };
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 384 });

    await expect(store.migrateColumnDimension()).rejects.toThrow(
      /Embedding dimension misconfiguration/,
    );

    // The OLD behaviour dropped the table and THEN let ensureSchema() throw on this
    // very assert, leaving the deployment with no `rag_vectors` at all. The table —
    // and its rows — must still be here.
    expect(db.columnDim).toBe(384);
    expect(db.rows).toHaveLength(1);
    expect(db.ddlLog).toEqual([]);
  });

  it("B2: a failing CREATE rolls the DROP back — the deployment is never left with NO rag_vectors table", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 384;
    db.rows = [storedRow("p1", "a")];
    db.failCreateDdl = true; // the rebuild refuses (out of disk, no `vector` extension, …)
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });

    await expect(store.migrateColumnDimension()).rejects.toThrow(
      /relation "vector" does not exist/,
    );

    // The whole point. While the DROP and the CREATE were two SEPARATE statements the
    // drop had already COMMITTED by the time the create failed, and this assertion
    // found `columnDim: null` — a live deployment with no vectors table at all, every
    // ingest and every search failing until someone noticed. One statement = one
    // transaction: the drop goes back with the failure.
    expect(db.columnDim).toBe(384);
    expect(db.rows).toHaveLength(1);
  });

  it("B2: ships the DROP and the CREATE as ONE statement, under the advisory lock", async () => {
    const db = new FakeSharedPg();
    db.columnDim = 384;
    const store = new PgVectorStore({ db: db as unknown as PrismaClient, dimension: 768 });

    await store.migrateColumnDimension();

    // This is the structural half of the guarantee above: if a future refactor splits
    // these back into two statements, the atomicity is gone — silently, because the
    // happy path looks identical. So assert on the SQL itself.
    const migrationDdl = db.ddlLog.filter((sql) => sql.includes("DROP TABLE"));
    expect(migrationDdl).toHaveLength(1);
    expect(migrationDdl[0]).toMatch(/pg_advisory_xact_lock/);
    expect(migrationDdl[0]).toMatch(/CREATE TABLE "rag_vectors"/);
    expect(migrationDdl[0]).toMatch(/vector\(768\)/);
    // ...and no statement anywhere drops the table on its own.
    expect(
      db.ddlLog.every((sql) => !sql.includes("DROP TABLE") || sql.includes("CREATE TABLE")),
    ).toBe(true);
  });
});
