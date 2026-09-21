/**
 * SQL Server driver adapter — Phase 8 (issue #59 / sqlserver registry entry).
 *
 * Uses `mssql` (tedious under the hood) via dynamic `import("mssql")` so the
 * package is OPTIONAL — the server boots fine without it (the driver
 * registry simply rejects `sqlserver` connectors at create time with
 * SQLSERVER_DRIVER_MISSING). Read-only enforcement layered the same way as
 * other drivers:
 *
 *   - Every query is parsed by the SQL validator BEFORE arrival here.
 *   - A read-only transaction wraps each query (`BEGIN TRANSACTION` +
 *     `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` is NOT used; we
 *     instead set `XACT_ABORT ON` and rely on the principal having only
 *     SELECT grants in the connection string's database). The validator is
 *     the primary safety net.
 *   - `requestTimeout` aborts long-running queries.
 */
import {
  DEFAULT_DB_POOL_MAX,
  type DbColumnInfo,
  type DbForeignKeyInfo,
  type DbIndexInfo,
  type DbRoutineInfo,
  type DbTableInfo,
} from "@metis/shared";
import { createChildLogger } from "../../../logger.js";
import { makePinnedLookup } from "../../network-allowlist.js";
import { ConnectorError } from "../../types.js";
import type {
  DbConnectionConfig,
  DbDriverAdapter,
  DbQueryRequest,
  DbQueryResponse,
} from "../driver.js";

const log = createChildLogger("db-sqlserver");

export interface MssqlRequestLike {
  query<T = unknown>(
    sql: string,
  ): Promise<{ recordset?: T[]; recordsets?: T[][]; rowsAffected?: number[] }>;
}
export interface MssqlPoolLike {
  request(): MssqlRequestLike;
  close(): Promise<void>;
  connected?: boolean;
}

export interface MssqlPoolFactoryArgs {
  user: string;
  password?: string;
  server: string;
  port: number;
  database: string;
  poolMax: number;
  requestTimeout: number;
  options?: Record<string, unknown>;
  /** DNS-pinning lookup (M1). */
  lookup?: (
    hostname: string,
    options: unknown,
    cb: (err: Error | null, address: string, family: number) => void,
  ) => void;
}

export type MssqlPoolFactory = (args: MssqlPoolFactoryArgs) => Promise<MssqlPoolLike>;

let factoryOverride: MssqlPoolFactory | null = null;

/** Inject a fake mssql pool factory (tests only). */
export function __setMssqlPoolFactory(factory: MssqlPoolFactory | null): void {
  factoryOverride = factory;
}

async function defaultFactory(args: MssqlPoolFactoryArgs): Promise<MssqlPoolLike> {
  let mssql: {
    ConnectionPool: new (cfg: unknown) => { connect(): Promise<MssqlPoolLike> };
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ "mssql" as string);
    mssql = (mod?.default ?? mod) as typeof mssql;
  } catch (err) {
    throw new ConnectorError(
      501,
      "SQLSERVER_DRIVER_MISSING",
      `mssql module is not installed (${(err as Error).message}). Install with: pnpm add mssql`,
    );
  }
  const pool = new mssql.ConnectionPool({
    user: args.user,
    password: args.password ?? "",
    server: args.server,
    port: args.port,
    database: args.database,
    requestTimeout: args.requestTimeout,
    pool: { max: args.poolMax, min: 1, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: true,
      trustServerCertificate: false,
      // Pin DNS to the pre-validated IP — tedious accepts a `lookup` callback
      // on its socket-level options.
      ...(args.lookup ? { lookup: args.lookup } : {}),
      ...(args.options ?? {}),
    },
  });
  return pool.connect();
}

export class SqlServerDriverAdapter implements DbDriverAdapter {
  private pool: MssqlPoolLike | null = null;

  async init(config: DbConnectionConfig): Promise<void> {
    if (this.pool) return;
    const args: MssqlPoolFactoryArgs = {
      user: config.username ?? "",
      password: config.password ?? undefined,
      server: config.host ?? "localhost",
      port: config.port ?? 1433,
      database: config.database ?? "",
      poolMax: Math.max(1, Math.min(config.poolMax, DEFAULT_DB_POOL_MAX)),
      requestTimeout: config.statementTimeoutMs,
      options: config.options,
      lookup: makePinnedLookup(config.pinnedAddress, config.pinnedFamily),
    };
    this.pool = factoryOverride ? await factoryOverride(args) : await defaultFactory(args);
  }

  async ping(): Promise<number> {
    const pool = this.requirePool();
    const start = Date.now();
    try {
      await pool.request().query("SELECT 1 AS one");
    } catch (err) {
      throw connectionError(err);
    }
    return Date.now() - start;
  }

  async query(req: DbQueryRequest): Promise<DbQueryResponse> {
    const pool = this.requirePool();
    const start = Date.now();
    try {
      const result = await pool.request().query<Record<string, unknown>>(req.sql);
      const rawRows = (result.recordset ?? []) as Record<string, unknown>[];
      const truncated = rawRows.length > req.maxRows;
      const rows = truncated ? rawRows.slice(0, req.maxRows) : rawRows;
      const columns = rows[0] ? Object.keys(rows[0]) : [];
      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      throw queryError(err);
    }
  }

  async introspect(opts: { schema?: string } = {}): Promise<DbTableInfo[]> {
    const pool = this.requirePool();
    const schema = opts.schema ?? "dbo";
    const sql = MSSQL_INTROSPECT_SQL.replace(/__SCHEMA__/g, escapeMssqlString(schema));
    const result = await pool.request().query<MssqlIntrospectRow>(sql);
    return groupMssqlIntrospection((result.recordset ?? []) as MssqlIntrospectRow[]);
  }

  async introspectRoutines(opts: { schema?: string } = {}): Promise<DbRoutineInfo[]> {
    const pool = this.requirePool();
    const schema = opts.schema ?? "dbo";
    const sql = MSSQL_ROUTINES_SQL.replace(/__SCHEMA__/g, escapeMssqlString(schema));
    const result = await pool.request().query<MssqlRoutineRow>(sql);
    return mapMssqlRoutines((result.recordset ?? []) as MssqlRoutineRow[]);
  }

  /**
   * Read a routine body — Epic #294 Phase 3 (#316). READ-ONLY: a single SELECT of
   * `OBJECT_DEFINITION(OBJECT_ID(...))`. The `mssql` request surface here takes no
   * bind params, so — matching the existing `introspect()` posture — the schema +
   * name are first passed through {@link escapeMssqlString} (which REJECTS any
   * quote/backslash/control char), making a quoting-bypass injection impossible
   * before they are interpolated. The body is returned VERBATIM for the sidecar to
   * PARSE; it is never executed. Encrypted modules return NULL.
   */
  async fetchRoutineBody(routine: DbRoutineInfo): Promise<string | null> {
    const pool = this.requirePool();
    const schema = escapeMssqlString(routine.schema || "dbo");
    const name = escapeMssqlString(routine.name);
    const sql = `SELECT OBJECT_DEFINITION(OBJECT_ID('[${schema}].[${name}]')) AS routine_definition`;
    const result = await pool.request().query<{ routine_definition: string | null }>(sql);
    const rows = (result.recordset ?? []) as { routine_definition: string | null }[];
    return rows[0]?.routine_definition ?? null;
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.close();
    } catch (err) {
      log.warn("SQL Server pool close failed", { err: (err as Error).message });
    }
    this.pool = null;
  }

  private requirePool(): MssqlPoolLike {
    if (!this.pool) throw new ConnectorError(500, "DRIVER_UNINITIALIZED", "driver not initialised");
    return this.pool;
  }
}

const MSSQL_INTROSPECT_SQL = `
  SELECT
    c.TABLE_SCHEMA   AS schema_name,
    c.TABLE_NAME     AS table_name,
    c.COLUMN_NAME    AS column_name,
    c.DATA_TYPE      AS data_type,
    c.IS_NULLABLE    AS is_nullable,
    c.COLUMN_DEFAULT AS column_default,
    pk.CONSTRAINT_NAME AS pk_name,
    fk.CONSTRAINT_NAME AS fk_name,
    fk.REF_TABLE       AS fk_foreign_table,
    fk.REF_COLUMN      AS fk_foreign_column
  FROM INFORMATION_SCHEMA.COLUMNS c
  LEFT JOIN (
    SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
    JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
     AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
  ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
  LEFT JOIN (
    SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME, rc.CONSTRAINT_NAME,
           rk.TABLE_NAME AS REF_TABLE, rk.COLUMN_NAME AS REF_COLUMN
    FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE rk
      ON rk.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME AND rk.ORDINAL_POSITION = kcu.ORDINAL_POSITION
  ) fk ON fk.TABLE_SCHEMA = c.TABLE_SCHEMA AND fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME
  WHERE c.TABLE_SCHEMA = '__SCHEMA__'
  ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
`;

interface MssqlIntrospectRow {
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
}

export function groupMssqlIntrospection(rows: MssqlIntrospectRow[]): DbTableInfo[] {
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
        indexes: [] as DbIndexInfo[],
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
  }
  return [...tables.values()];
}

/**
 * Routines (procedures & functions) introspection — Epic #293 Phase 2 (#300).
 *
 * READ-ONLY: a single SELECT against `INFORMATION_SCHEMA.ROUTINES`. The schema
 * is validated by {@link escapeMssqlString} (rejecting any quote/control char)
 * before interpolation, matching the existing introspect() posture — no quoting
 * bypass is possible. `DATA_TYPE` is the function return type. The routine body
 * (`ROUTINE_DEFINITION`) is deliberately NOT selected — Phase 2 records routine
 * identity + signature only; deep body call extraction is Phase 3 (#294).
 */
const MSSQL_ROUTINES_SQL = `
  SELECT
    r.ROUTINE_SCHEMA AS schema_name,
    r.ROUTINE_NAME   AS routine_name,
    r.ROUTINE_TYPE   AS routine_type,
    r.DATA_TYPE      AS return_type
  FROM INFORMATION_SCHEMA.ROUTINES r
  WHERE r.ROUTINE_SCHEMA = '__SCHEMA__'
    AND r.ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION')
  ORDER BY r.ROUTINE_NAME
`;

interface MssqlRoutineRow {
  schema_name: string;
  routine_name: string;
  routine_type: string;
  return_type: string | null;
}

export function mapMssqlRoutines(rows: MssqlRoutineRow[]): DbRoutineInfo[] {
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

/** Reject any single-quote in a schema name to keep our string-interpolated WHERE safe. */
function escapeMssqlString(value: string): string {
  if (/['\\\u0000\n\r]/.test(value)) {
    throw new ConnectorError(400, "INVALID_SCHEMA_NAME", "schema name contains invalid characters");
  }
  return value;
}

function connectionError(err: unknown): ConnectorError {
  const msg = (err as Error).message ?? "connection failed";
  const code = (err as { code?: string }).code ?? "";
  if (/login failed|authentication|password/i.test(msg)) {
    return new ConnectorError(401, "DB_AUTH_FAILED", `authentication failed: ${msg}`);
  }
  if (
    code === "ESOCKET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    /ENOTFOUND|EAI_AGAIN/i.test(msg)
  ) {
    return new ConnectorError(502, "DB_CONNECT_FAILED", `database unreachable: ${msg}`);
  }
  return new ConnectorError(500, "DB_ERROR", msg);
}

function queryError(err: unknown): ConnectorError {
  const msg = (err as Error).message ?? "query failed";
  if (/timeout|request failed.*timeout/i.test(msg)) {
    return new ConnectorError(504, "QUERY_TIMEOUT", `query exceeded statement timeout: ${msg}`);
  }
  return new ConnectorError(500, "QUERY_FAILED", msg);
}
