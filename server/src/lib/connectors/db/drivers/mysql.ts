/**
 * MySQL driver adapter — Phase 8.
 *
 * Uses `mysql2/promise` Pool. Read-only enforcement layered the same way as
 * Postgres: SQL validator gates every query; the per-connection session sets
 * `transaction_read_only=ON`; statement-level timeout is applied as a hint
 * (`MAX_EXECUTION_TIME`).
 */
import {
  DEFAULT_DB_POOL_MAX,
  type DbColumnInfo,
  type DbForeignKeyInfo,
  type DbIndexInfo,
  type DbRoutineInfo,
  type DbTableInfo,
} from "@metis/shared";
import { ConnectorError } from "../../types.js";
import { makePinnedLookup } from "../../network-allowlist.js";
import type {
  DbConnectionConfig,
  DbDriverAdapter,
  DbQueryRequest,
  DbQueryResponse,
} from "../driver.js";

export interface MySqlPoolLike {
  getConnection(): Promise<MySqlConnLike>;
  query(sql: string, params?: unknown[]): Promise<[Record<string, unknown>[], { name: string }[]]>;
  end(): Promise<void>;
}

export interface MySqlConnLike {
  query(sql: string, params?: unknown[]): Promise<[Record<string, unknown>[], { name: string }[]]>;
  release(): void;
}

export interface MySqlPoolFactoryArgs {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  connectionLimit: number;
  options?: Record<string, unknown>;
  /** DNS-pinning lookup (M1). */
  lookup?: (
    hostname: string,
    options: unknown,
    cb: (err: Error | null, address: string, family: number) => void,
  ) => void;
}

export type MySqlPoolFactory = (args: MySqlPoolFactoryArgs) => MySqlPoolLike;

let factoryOverride: MySqlPoolFactory | null = null;

export function __setMysqlPoolFactory(factory: MySqlPoolFactory | null): void {
  factoryOverride = factory;
}

async function defaultFactory(args: MySqlPoolFactoryArgs): Promise<MySqlPoolLike> {
  // mysql2/promise has its own .createPool — typed loosely to avoid the import
  // type being part of our compiled surface (devs without mysql installed).
  const mod = (await import("mysql2/promise")) as unknown as {
    createPool: (cfg: unknown) => MySqlPoolLike;
  };
  return mod.createPool({
    host: args.host,
    port: args.port,
    database: args.database,
    user: args.user,
    password: args.password,
    connectionLimit: args.connectionLimit,
    ...(args.lookup ? { lookup: args.lookup } : {}),
    ...(args.options ?? {}),
  });
}

export class MySqlDriverAdapter implements DbDriverAdapter {
  private pool: MySqlPoolLike | null = null;

  async init(config: DbConnectionConfig): Promise<void> {
    if (this.pool) return;
    const args: MySqlPoolFactoryArgs = {
      host: config.host ?? "localhost",
      port: config.port ?? 3306,
      database: config.database ?? "",
      user: config.username ?? "",
      password: config.password ?? undefined,
      connectionLimit: Math.max(1, Math.min(config.poolMax, DEFAULT_DB_POOL_MAX)),
      options: config.options,
      lookup: makePinnedLookup(config.pinnedAddress, config.pinnedFamily),
    };
    this.pool = factoryOverride ? factoryOverride(args) : await defaultFactory(args);
  }

  async ping(): Promise<number> {
    const pool = this.requirePool();
    const start = Date.now();
    let conn: MySqlConnLike | null = null;
    try {
      conn = await pool.getConnection();
      await conn.query("SELECT 1");
    } catch (err) {
      throw connectionError(err);
    } finally {
      conn?.release();
    }
    return Date.now() - start;
  }

  async query(req: DbQueryRequest): Promise<DbQueryResponse> {
    const pool = this.requirePool();
    const start = Date.now();
    let conn: MySqlConnLike | null = null;
    try {
      conn = await pool.getConnection();
      await conn.query("SET SESSION TRANSACTION READ ONLY");
      // MAX_EXECUTION_TIME is a SELECT-only hint; safer than killing the conn.
      const hinted = req.sql.replace(
        /^(\s*)select\b/i,
        `$1SELECT /*+ MAX_EXECUTION_TIME(${Number(req.statementTimeoutMs) | 0}) */`,
      );
      const [rowsRaw, fields] = await conn.query(hinted);
      const truncated = rowsRaw.length > req.maxRows;
      const rows = truncated ? rowsRaw.slice(0, req.maxRows) : rowsRaw;
      const columns = (fields ?? []).map((f) => f.name) || (rows[0] ? Object.keys(rows[0]) : []);
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
      conn?.release();
    }
  }

  async introspect(opts: { schema?: string } = {}): Promise<DbTableInfo[]> {
    const pool = this.requirePool();
    const schema = opts.schema ?? "DATABASE()";
    const sql = MYSQL_INTROSPECT_SQL.replace(
      "__SCHEMA__",
      schema === "DATABASE()" ? "DATABASE()" : "?",
    );
    const [rows] = await pool.query(sql, schema === "DATABASE()" ? [] : [schema]);
    return groupMysqlIntrospection(rows as unknown as MysqlIntrospectRow[]);
  }

  async introspectRoutines(opts: { schema?: string } = {}): Promise<DbRoutineInfo[]> {
    const pool = this.requirePool();
    const schema = opts.schema ?? "DATABASE()";
    const sql = MYSQL_ROUTINES_SQL.replace(
      "__SCHEMA__",
      schema === "DATABASE()" ? "DATABASE()" : "?",
    );
    const [rows] = await pool.query(sql, schema === "DATABASE()" ? [] : [schema]);
    return mapMysqlRoutines(rows as unknown as MysqlRoutineRow[]);
  }

  /**
   * Read a routine body — Epic #294 Phase 3 (#316). READ-ONLY: a single SELECT of
   * `information_schema.routines.ROUTINE_DEFINITION` with schema + name bound as
   * `?` placeholders (mysql2 parameterization — no injection surface). The body is
   * returned VERBATIM for the sidecar to PARSE; it is never executed. (We avoid
   * `SHOW CREATE PROCEDURE` because its object name cannot be parameter-bound.)
   */
  async fetchRoutineBody(routine: DbRoutineInfo): Promise<string | null> {
    const pool = this.requirePool();
    const [rows] = await pool.query(MYSQL_ROUTINE_BODY_SQL, [routine.schema, routine.name]);
    const list = rows as unknown as { routine_definition: string | null }[];
    return list[0]?.routine_definition ?? null;
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
  }

  private requirePool(): MySqlPoolLike {
    if (!this.pool) throw new ConnectorError(500, "DRIVER_UNINITIALIZED", "driver not initialised");
    return this.pool;
  }
}

const MYSQL_INTROSPECT_SQL = `
  SELECT
    c.table_schema     AS schema_name,
    c.table_name       AS table_name,
    c.column_name      AS column_name,
    c.column_type      AS data_type,
    c.is_nullable      AS is_nullable,
    c.column_default   AS column_default,
    c.column_key       AS column_key,
    kcu.constraint_name AS fk_name,
    kcu.referenced_table_name AS fk_foreign_table,
    kcu.referenced_column_name AS fk_foreign_column,
    s.index_name        AS index_name,
    s.column_name       AS index_column,
    s.non_unique        AS index_non_unique
  FROM information_schema.columns c
  LEFT JOIN information_schema.key_column_usage kcu
    ON kcu.table_schema = c.table_schema
    AND kcu.table_name = c.table_name
    AND kcu.column_name = c.column_name
    AND kcu.referenced_table_name IS NOT NULL
  LEFT JOIN information_schema.statistics s
    ON s.table_schema = c.table_schema
    AND s.table_name = c.table_name
    AND s.column_name = c.column_name
  WHERE c.table_schema = __SCHEMA__
  ORDER BY c.table_name, c.ordinal_position
`;

interface MysqlIntrospectRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  column_key: string;
  fk_name: string | null;
  fk_foreign_table: string | null;
  fk_foreign_column: string | null;
  index_name: string | null;
  index_column: string | null;
  index_non_unique: number | null;
}

export function groupMysqlIntrospection(rows: MysqlIntrospectRow[]): DbTableInfo[] {
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
        isPrimaryKey: r.column_key === "PRI",
        isForeignKey: Boolean(r.fk_name),
      };
      t.columns.push(col);
      if (r.column_key === "PRI") {
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
          columns: [],
          isUnique: r.index_non_unique === 0,
        } as DbIndexInfo;
        t.indexes.push(idx);
      }
      if (r.index_column && !idx.columns.includes(r.index_column)) {
        idx.columns.push(r.index_column);
      }
    }
  }
  return [...tables.values()];
}

/**
 * Routines (procedures & functions) introspection — Epic #293 Phase 2 (#300).
 *
 * READ-ONLY: a single SELECT against `information_schema.routines`. The schema
 * filter is bound as a `?` parameter (or `DATABASE()` when unset) so a hostile
 * schema name cannot inject SQL. `dtd_identifier` gives the function return type
 * for the signature; the parameter list is NOT expanded (would need a second
 * catalog read of `information_schema.parameters`) — routine identity + return
 * type is sufficient for Phase 2 graph wiring. The routine body is never read.
 */
const MYSQL_ROUTINES_SQL = `
  SELECT
    r.routine_schema AS schema_name,
    r.routine_name   AS routine_name,
    r.routine_type   AS routine_type,
    r.dtd_identifier AS return_type
  FROM information_schema.routines r
  WHERE r.routine_schema = __SCHEMA__
    AND r.routine_type IN ('PROCEDURE', 'FUNCTION')
  ORDER BY r.routine_name
`;

interface MysqlRoutineRow {
  schema_name: string;
  routine_name: string;
  routine_type: string;
  return_type: string | null;
}

/**
 * Routine BODY fetch — Epic #294 Phase 3 (#316). READ-ONLY: schema + name bound
 * as `?` parameters. Returns the routine source for STATIC PARSING ONLY.
 */
const MYSQL_ROUTINE_BODY_SQL = `
  SELECT r.routine_definition AS routine_definition
  FROM information_schema.routines r
  WHERE r.routine_schema = ? AND r.routine_name = ?
  LIMIT 1
`;

export function mapMysqlRoutines(rows: MysqlRoutineRow[]): DbRoutineInfo[] {
  return rows.map((r) => {
    const type: DbRoutineInfo["type"] =
      r.routine_type?.toUpperCase() === "PROCEDURE" ? "procedure" : "function";
    const result = type === "function" && r.return_type ? `() RETURNS ${r.return_type}` : "()";
    return {
      schema: r.schema_name,
      name: r.routine_name,
      type,
      signature: result,
    };
  });
}

function connectionError(err: unknown): ConnectorError {
  const msg = (err as Error).message ?? "connection failed";
  const code = (err as { code?: string }).code ?? "";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return new ConnectorError(502, "DB_CONNECT_FAILED", `database unreachable: ${msg}`);
  }
  if (/access denied|authentication/i.test(msg)) {
    return new ConnectorError(401, "DB_AUTH_FAILED", `authentication failed: ${msg}`);
  }
  return new ConnectorError(500, "DB_ERROR", msg);
}

function queryError(err: unknown): ConnectorError {
  const msg = (err as Error).message ?? "query failed";
  if (/exceeded.*max_execution_time|query execution was interrupted/i.test(msg)) {
    return new ConnectorError(504, "QUERY_TIMEOUT", `query exceeded statement timeout: ${msg}`);
  }
  return new ConnectorError(500, "QUERY_FAILED", msg);
}
