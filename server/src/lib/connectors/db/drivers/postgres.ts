/**
 * PostgreSQL driver adapter — issue #61.
 *
 * Uses node-postgres (`pg`) Pool. Read-only enforcement is layered:
 *
 *   1. Every query is parsed by the SQL validator BEFORE arrival here.
 *   2. The pool sets `default_transaction_read_only=on` at connect time so
 *      even a parser bypass cannot mutate data.
 *   3. `statement_timeout` is set per session to bound runaway queries.
 *
 * The pool is sized via DEFAULT_DB_POOL_MAX (5) and idle connections release
 * after `idleTimeoutMillis`. Connection failures surface as ConnectorError
 * with stable codes the route layer maps onto HTTP status codes.
 */
import {
  DEFAULT_DB_POOL_MAX,
  type DbColumnInfo,
  type DbForeignKeyInfo,
  type DbIndexInfo,
  type DbRoutineInfo,
  type DbTableInfo,
} from "@metis/shared";
import type { Pool, QueryResult } from "pg";
import { createChildLogger } from "../../../logger.js";
import { makePinnedLookup } from "../../network-allowlist.js";
import { ConnectorError } from "../../types.js";
import type {
  DbConnectionConfig,
  DbDriverAdapter,
  DbQueryRequest,
  DbQueryResponse,
} from "../driver.js";

const log = createChildLogger("db-postgres");

/**
 * Minimal subset of pg.Pool we depend on — declared here so tests can supply
 * a pure JS fake without importing the real module.
 */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
}
export interface PgClientLike {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  release: () => void;
}

export type PgPoolFactory = (config: PgPoolFactoryArgs) => PgPoolLike;
export interface PgPoolFactoryArgs {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  options?: Record<string, unknown>;
  /** DNS-pinning lookup (M1 — DNS rebinding TOCTOU defence). */
  lookup?: (
    hostname: string,
    options: unknown,
    cb: (err: Error | null, address: string, family: number) => void,
  ) => void;
}

let factoryOverride: PgPoolFactory | null = null;

/** Inject a fake pg.Pool factory (tests only). */
export function __setPostgresPoolFactory(factory: PgPoolFactory | null): void {
  factoryOverride = factory;
}

async function defaultFactory(args: PgPoolFactoryArgs): Promise<PgPoolLike> {
  const { Pool } = (await import("pg")) as unknown as { Pool: new (cfg: unknown) => Pool };
  return new Pool({
    host: args.host,
    port: args.port,
    database: args.database,
    user: args.user,
    password: args.password,
    max: args.max,
    idleTimeoutMillis: args.idleTimeoutMillis,
    connectionTimeoutMillis: args.connectionTimeoutMillis,
    statement_timeout: args.statement_timeout,
    options: "-c default_transaction_read_only=on",
    lookup: args.lookup,
  }) as unknown as PgPoolLike;
}

export class PostgresDriverAdapter implements DbDriverAdapter {
  private pool: PgPoolLike | null = null;

  async init(config: DbConnectionConfig): Promise<void> {
    if (this.pool) return;
    const host = config.host ?? "localhost";
    const port = config.port ?? 5432;
    const database = config.database ?? "postgres";
    const user = config.username ?? "postgres";
    const max = Math.max(1, Math.min(config.poolMax, DEFAULT_DB_POOL_MAX));
    const args: PgPoolFactoryArgs = {
      host,
      port,
      database,
      user,
      password: config.password ?? undefined,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: config.statementTimeoutMs,
      options: config.options,
      lookup: makePinnedLookup(config.pinnedAddress, config.pinnedFamily),
    };
    if (factoryOverride) {
      this.pool = factoryOverride(args);
    } else {
      this.pool = await defaultFactory(args);
    }
  }

  async ping(): Promise<number> {
    const pool = this.requirePool();
    const start = Date.now();
    let client: PgClientLike | null = null;
    try {
      client = await pool.connect();
      await client.query("SELECT 1");
    } catch (err) {
      throw connectionError(err);
    } finally {
      client?.release();
    }
    return Date.now() - start;
  }

  async query(req: DbQueryRequest): Promise<DbQueryResponse> {
    const pool = this.requirePool();
    const start = Date.now();
    let client: PgClientLike | null = null;
    try {
      client = await pool.connect();
      // Per-session enforcement (defence-in-depth alongside Pool option).
      await client.query("SET TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Number(req.statementTimeoutMs) | 0}`);
      const result = await client.query(req.sql);
      const rawRows: Record<string, unknown>[] = (result.rows ?? []) as Record<string, unknown>[];
      const truncated = rawRows.length > req.maxRows;
      const rows = truncated ? rawRows.slice(0, req.maxRows) : rawRows;
      const columns =
        (result.fields ?? []).map((f: { name: string }) => f.name) ||
        (rows[0] ? Object.keys(rows[0]) : []);
      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      throw queryError(err);
    } finally {
      client?.release();
    }
  }

  async introspect(opts: { schema?: string } = {}): Promise<DbTableInfo[]> {
    const pool = this.requirePool();
    const schema = opts.schema ?? "public";
    const result = await pool.query(POSTGRES_INTROSPECT_SQL, [schema]);
    return groupPostgresIntrospection(result.rows as PostgresIntrospectRow[]);
  }

  async introspectRoutines(opts: { schema?: string } = {}): Promise<DbRoutineInfo[]> {
    const pool = this.requirePool();
    const schema = opts.schema ?? "public";
    const result = await pool.query(POSTGRES_ROUTINES_SQL, [schema]);
    return mapPostgresRoutines(result.rows as PostgresRoutineRow[]);
  }

  /**
   * Read a routine body — Epic #294 Phase 3 (#316). READ-ONLY: a single SELECT of
   * `information_schema.routines.routine_definition` with the schema + name bound
   * as `$1`/`$2` (no string concatenation, no injection surface). The body is
   * returned VERBATIM for the sidecar to PARSE; it is never executed.
   */
  async fetchRoutineBody(routine: DbRoutineInfo): Promise<string | null> {
    const pool = this.requirePool();
    const result = await pool.query(POSTGRES_ROUTINE_BODY_SQL, [routine.schema, routine.name]);
    const rows = (result.rows ?? []) as { routine_definition: string | null }[];
    return rows[0]?.routine_definition ?? null;
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.end();
    } catch (err) {
      log.warn("Postgres pool close failed", { err: (err as Error).message });
    }
    this.pool = null;
  }

  private requirePool(): PgPoolLike {
    if (!this.pool) throw new ConnectorError(500, "DRIVER_UNINITIALIZED", "driver not initialised");
    return this.pool;
  }
}

const POSTGRES_INTROSPECT_SQL = `
  SELECT
    c.table_schema     AS schema_name,
    c.table_name       AS table_name,
    c.column_name      AS column_name,
    c.data_type        AS data_type,
    c.is_nullable      AS is_nullable,
    c.column_default   AS column_default,
    pk.constraint_name AS pk_name,
    fk.constraint_name AS fk_name,
    fk.foreign_table   AS fk_foreign_table,
    fk.foreign_column  AS fk_foreign_column,
    idx.index_name     AS index_name,
    idx.index_columns  AS index_columns,
    idx.is_unique      AS index_unique
  FROM information_schema.columns c
  LEFT JOIN (
    SELECT kcu.table_schema, kcu.table_name, kcu.column_name, tc.constraint_name
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.table_constraints tc
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
  ) pk
    ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
  LEFT JOIN (
    SELECT
      kcu.table_schema, kcu.table_name, kcu.column_name, tc.constraint_name,
      ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
    FROM information_schema.key_column_usage kcu
    JOIN information_schema.table_constraints tc
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
  ) fk
    ON fk.table_schema = c.table_schema AND fk.table_name = c.table_name AND fk.column_name = c.column_name
  LEFT JOIN LATERAL (
    SELECT i.indexname AS index_name, i.indexdef AS index_columns,
           CASE WHEN position('UNIQUE' IN i.indexdef) > 0 THEN 'YES' ELSE 'NO' END AS is_unique
    FROM pg_indexes i WHERE i.schemaname = c.table_schema AND i.tablename = c.table_name
  ) idx ON TRUE
  WHERE c.table_schema = $1
  ORDER BY c.table_name, c.ordinal_position
`;

interface PostgresIntrospectRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  pk_name: string | null;
  fk_name: string | null;
  fk_foreign_table: string | null;
  fk_foreign_column: string | null;
  index_name: string | null;
  index_columns: string | null;
  index_unique: string | null;
}

export function groupPostgresIntrospection(rows: PostgresIntrospectRow[]): DbTableInfo[] {
  const tables = new Map<string, DbTableInfo>();
  for (const r of rows) {
    const key = `${r.schema_name}.${r.table_name}`;
    let t = tables.get(key);
    if (!t) {
      t = {
        schema: r.schema_name,
        name: r.table_name,
        columns: [],
        primaryKey: undefined,
        foreignKeys: [],
        indexes: [],
      };
      tables.set(key, t);
    }
    if (!t.columns.find((c) => c.name === r.column_name)) {
      const col: DbColumnInfo = {
        name: r.column_name,
        dataType: r.data_type,
        nullable: r.is_nullable === "YES",
        defaultValue: r.column_default,
        isPrimaryKey: Boolean(r.pk_name),
        isForeignKey: Boolean(r.fk_name),
      };
      t.columns.push(col);
      if (r.pk_name) {
        t.primaryKey = (t.primaryKey ?? []).concat([r.column_name]);
      }
    }
    if (r.fk_name && r.fk_foreign_table && r.fk_foreign_column) {
      let fk = t.foreignKeys.find((f) => f.name === r.fk_name);
      if (!fk) {
        fk = {
          name: r.fk_name,
          columns: [],
          refTable: r.fk_foreign_table,
          refColumns: [],
        } as DbForeignKeyInfo;
        t.foreignKeys.push(fk);
      }
      if (!fk.columns.includes(r.column_name)) fk.columns.push(r.column_name);
      if (!fk.refColumns.includes(r.fk_foreign_column)) fk.refColumns.push(r.fk_foreign_column);
    }
    if (r.index_name) {
      let idx = t.indexes.find((i) => i.name === r.index_name);
      if (!idx) {
        idx = {
          name: r.index_name,
          columns: extractIndexColumns(r.index_columns ?? ""),
          isUnique: r.index_unique === "YES",
        } as DbIndexInfo;
        t.indexes.push(idx);
      }
    }
  }
  return [...tables.values()];
}

/**
 * Routines (procedures & functions) introspection — Epic #293 Phase 2 (#300).
 *
 * READ-ONLY: a single parameterized SELECT against `information_schema.routines`
 * (the SQL-standard catalog). `pg_get_function_arguments`/`_result` are joined
 * on `pg_proc` to assemble a best-effort signature WITHOUT fetching the routine
 * body. The schema is bound as `$1` so a hostile schema name cannot inject SQL.
 */
const POSTGRES_ROUTINES_SQL = `
  SELECT
    r.routine_schema AS schema_name,
    r.routine_name   AS routine_name,
    r.routine_type   AS routine_type,
    pg_get_function_arguments(p.oid) AS args,
    pg_get_function_result(p.oid)    AS result
  FROM information_schema.routines r
  LEFT JOIN pg_namespace n ON n.nspname = r.routine_schema
  LEFT JOIN pg_proc p
    ON p.proname = r.routine_name AND p.pronamespace = n.oid
  WHERE r.routine_schema = $1
    AND r.routine_type IN ('PROCEDURE', 'FUNCTION')
  ORDER BY r.routine_name
`;

interface PostgresRoutineRow {
  schema_name: string;
  routine_name: string;
  routine_type: string;
  args: string | null;
  result: string | null;
}

/**
 * Routine BODY fetch — Epic #294 Phase 3 (#316). READ-ONLY: schema + name bound
 * as parameters. Returns the routine source for STATIC PARSING ONLY (never run).
 */
const POSTGRES_ROUTINE_BODY_SQL = `
  SELECT r.routine_definition AS routine_definition
  FROM information_schema.routines r
  WHERE r.routine_schema = $1 AND r.routine_name = $2
  LIMIT 1
`;

export function mapPostgresRoutines(rows: PostgresRoutineRow[]): DbRoutineInfo[] {
  return rows.map((r) => {
    const type: DbRoutineInfo["type"] =
      r.routine_type?.toUpperCase() === "PROCEDURE" ? "procedure" : "function";
    const args = r.args ? `(${r.args})` : "()";
    const result = type === "function" && r.result ? ` RETURNS ${r.result}` : "";
    return {
      schema: r.schema_name,
      name: r.routine_name,
      type,
      signature: `${args}${result}`.trim(),
    };
  });
}

function extractIndexColumns(indexDef: string): string[] {
  const m = /\(([^)]*)\)/.exec(indexDef);
  if (!m) return [];
  return m[1].split(",").map((c) => c.trim().replace(/"/g, ""));
}

function connectionError(err: unknown): ConnectorError {
  const msg = (err as Error).message ?? "connection failed";
  const code = (err as { code?: string }).code ?? "";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return new ConnectorError(502, "DB_CONNECT_FAILED", `database unreachable: ${msg}`);
  }
  if (/password|authentication|auth/i.test(msg)) {
    return new ConnectorError(401, "DB_AUTH_FAILED", `authentication failed: ${msg}`);
  }
  return new ConnectorError(500, "DB_ERROR", msg);
}

function queryError(err: unknown): ConnectorError {
  const msg = (err as Error).message ?? "query failed";
  if (/timeout|canceling statement|statement timeout/i.test(msg)) {
    return new ConnectorError(504, "QUERY_TIMEOUT", `query exceeded statement timeout: ${msg}`);
  }
  return new ConnectorError(500, "QUERY_FAILED", msg);
}
