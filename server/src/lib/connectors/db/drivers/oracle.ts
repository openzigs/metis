/**
 * Oracle driver adapter — issue #62.
 *
 * Loaded via dynamic `import("oracledb")` so the package is OPTIONAL — the
 * server boots fine without it (and tests inject a fake adapter via the
 * driver registry). When present, the adapter forces THIN-MODE so we don't
 * require the Oracle Instant Client. Connect strings (`SERVICE_NAME`,
 * `SID`, TNS aliases) are passed through `options` and NEVER logged.
 *
 * Read-only enforcement:
 *   - SQL validator gates every query (single SELECT, ≤QUERY_DB_MAX_ROWS).
 *   - Connection pool wraps queries in `SET TRANSACTION READ ONLY`.
 *   - `callTimeout` aborts long-running calls at the OCI layer.
 */
import {
  DEFAULT_DB_POOL_MAX,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  type DbColumnInfo,
  type DbDependencyInfo,
  type DbForeignKeyInfo,
  type DbIndexInfo,
  type DbPackageInfo,
  type DbRoutineInfo,
  type DbTableInfo,
} from "@metis/shared";
import { createChildLogger } from "../../../logger.js";
import { ConnectorError } from "../../types.js";
import type {
  DbConnectionConfig,
  DbDriverAdapter,
  DbQueryRequest,
  DbQueryResponse,
} from "../driver.js";

const log = createChildLogger("db-oracle");

export interface OracleConnectionLike {
  execute<T = unknown>(
    sql: string,
    params?: unknown[],
    opts?: { maxRows?: number; resultSet?: boolean },
  ): Promise<{ rows?: T[]; metaData?: { name: string }[] }>;
  close(): Promise<void>;
  callTimeout?: number;
}

export interface OraclePoolLike {
  getConnection(): Promise<OracleConnectionLike>;
  close(timeout?: number): Promise<void>;
}

export interface OraclePoolFactoryArgs {
  user: string;
  password?: string;
  connectString: string;
  poolMin: number;
  poolMax: number;
  callTimeout: number;
}

export type OraclePoolFactory = (args: OraclePoolFactoryArgs) => Promise<OraclePoolLike>;

let factoryOverride: OraclePoolFactory | null = null;

export function __setOraclePoolFactory(factory: OraclePoolFactory | null): void {
  factoryOverride = factory;
}

async function defaultFactory(args: OraclePoolFactoryArgs): Promise<OraclePoolLike> {
  let oracledb: {
    createPool: (cfg: unknown) => Promise<OraclePoolLike>;
    THIN_MODE?: number;
    initOracleClient?: (opts: unknown) => void;
    OUT_FORMAT_OBJECT?: number;
    outFormat?: number;
  };
  try {
    // Optional dependency — string-typed import keeps tsc green when not installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ "oracledb" as string);
    oracledb = (mod?.default ?? mod) as typeof oracledb;
  } catch (err) {
    throw new ConnectorError(
      501,
      "ORACLE_DRIVER_MISSING",
      `oracledb module is not installed (${(err as Error).message}). ` +
        `Install with: pnpm add oracledb`,
    );
  }
  if (oracledb.OUT_FORMAT_OBJECT) oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
  // Try thick mode if Oracle Instant Client is available — needed for
  // databases whose password verifiers predate 12c (NJS-116).
  const clientDir = process.env.ORACLE_CLIENT_DIR;
  if (clientDir && oracledb.initOracleClient) {
    try {
      oracledb.initOracleClient({ libDir: clientDir });
      log.info("Oracle thick mode enabled", { libDir: clientDir });
    } catch (e) {
      const reason = (e as Error).message;
      if (!reason.includes("already")) {
        log.warn("initOracleClient failed — falling back to thin mode", { reason });
      }
    }
  }
  return oracledb.createPool({
    user: args.user,
    password: args.password ?? "",
    connectString: args.connectString,
    poolMin: args.poolMin,
    poolMax: args.poolMax,
    poolIncrement: 1,
    poolPingInterval: 60,
    poolTimeout: 30,
    queueTimeout: args.callTimeout,
  });
}

export class OracleDriverAdapter implements DbDriverAdapter {
  private pool: OraclePoolLike | null = null;
  private statementTimeoutMs = DEFAULT_DB_STATEMENT_TIMEOUT_MS;
  private introspectTimeoutMs = DEFAULT_DB_STATEMENT_TIMEOUT_MS;
  private connectString = "";

  async init(config: DbConnectionConfig): Promise<void> {
    if (this.pool) return;
    this.statementTimeoutMs = config.statementTimeoutMs;
    this.introspectTimeoutMs = config.introspectTimeoutMs ?? config.statementTimeoutMs;
    const opts = config.options ?? {};
    const tnsAlias = typeof opts.tnsAlias === "string" ? opts.tnsAlias : undefined;
    const serviceName =
      typeof opts.serviceName === "string"
        ? opts.serviceName
        : typeof config.database === "string"
          ? config.database
          : "";
    const host = config.host ?? "";
    const port = config.port ?? 1521;
    this.connectString = tnsAlias ?? `${host}:${port}/${serviceName}`;
    const factory = factoryOverride ?? defaultFactory;
    this.pool = await factory({
      user: config.username ?? "",
      password: config.password ?? undefined,
      connectString: this.connectString,
      poolMin: 0,
      poolMax: Math.max(1, Math.min(config.poolMax, DEFAULT_DB_POOL_MAX)),
      callTimeout: config.statementTimeoutMs,
    });
  }

  async ping(): Promise<number> {
    const pool = this.requirePool();
    const start = Date.now();
    let conn: OracleConnectionLike | null = null;
    try {
      conn = await pool.getConnection();
      conn.callTimeout = this.statementTimeoutMs;
      await conn.execute("SELECT 1 FROM DUAL");
    } catch (err) {
      throw connectionError(err);
    } finally {
      if (conn) await conn.close().catch(() => undefined);
    }
    return Date.now() - start;
  }

  async query(req: DbQueryRequest): Promise<DbQueryResponse> {
    const pool = this.requirePool();
    const start = Date.now();
    let conn: OracleConnectionLike | null = null;
    try {
      conn = await pool.getConnection();
      conn.callTimeout = req.statementTimeoutMs;
      await conn.execute("SET TRANSACTION READ ONLY").catch(() => undefined);
      const result = await conn.execute<Record<string, unknown>>(req.sql, [], {
        maxRows: req.maxRows + 1,
      });
      const rawRows = (result.rows ?? []) as Record<string, unknown>[];
      const truncated = rawRows.length > req.maxRows;
      const rows = truncated ? rawRows.slice(0, req.maxRows) : rawRows;
      const columns = (result.metaData ?? []).map((m) => m.name);
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
      if (conn) await conn.close().catch(() => undefined);
    }
  }

  async introspect(opts: { schema?: string } = {}): Promise<DbTableInfo[]> {
    const pool = this.requirePool();
    let conn: OracleConnectionLike | null = null;
    try {
      conn = await pool.getConnection();
      conn.callTimeout = this.introspectTimeoutMs;
      const owner = (opts.schema ?? "").toUpperCase();
      const sql = owner ? ORACLE_INTROSPECT_SQL : ORACLE_INTROSPECT_USER_SQL;
      const params = owner ? [owner] : [];
      const result = await conn.execute<OracleIntrospectRow>(sql, params, { maxRows: 10_000 });
      return groupOracleIntrospection((result.rows ?? []) as OracleIntrospectRow[]);
    } finally {
      if (conn) await conn.close().catch(() => undefined);
    }
  }

  async introspectRoutines(opts: { schema?: string } = {}): Promise<DbRoutineInfo[]> {
    const pool = this.requirePool();
    let conn: OracleConnectionLike | null = null;
    try {
      conn = await pool.getConnection();
      conn.callTimeout = this.introspectTimeoutMs;
      const owner = (opts.schema ?? "").toUpperCase();
      const sql = owner ? ORACLE_ROUTINES_SQL : ORACLE_ROUTINES_USER_SQL;
      const params = owner ? [owner] : [];
      const result = await conn.execute<OracleRoutineRow>(sql, params, { maxRows: 10_000 });
      return mapOracleRoutines((result.rows ?? []) as OracleRoutineRow[]);
    } finally {
      if (conn) await conn.close().catch(() => undefined);
    }
  }

  /**
   * Read coarse object→referenced-object dependency rows — **Tier-1** lineage,
   * Epic #881 Phase 1 (#890). READ-ONLY, zero-parse: a single SELECT of
   * `ALL_DEPENDENCIES` (owner bound as `:1`, never string-concatenated), scoped
   * to PL/SQL package/procedure/function referencing rows. When `opts.allowDba`
   * is set AND a schema is given, first attempts the equivalent
   * `DBA_DEPENDENCIES` query (a more complete view, "when permitted") — any
   * failure (e.g. `ORA-00942` insufficient privilege) is swallowed and the
   * method cleanly degrades to the `ALL_DEPENDENCIES` catalog SELECT below. NO
   * PL/SQL is ever executed. This is intentionally always-on and independent of
   * Tier-2 routine-body parsing (#891-#893) — it works even when that sidecar
   * path is unavailable.
   */
  async introspectDependencies(
    opts: { schema?: string; allowDba?: boolean } = {},
  ): Promise<DbDependencyInfo[]> {
    const pool = this.requirePool();
    let conn: OracleConnectionLike | null = null;
    try {
      conn = await pool.getConnection();
      conn.callTimeout = this.statementTimeoutMs;
      const owner = (opts.schema ?? "").toUpperCase();
      const sql = owner ? ORACLE_DEPENDENCIES_SQL : ORACLE_DEPENDENCIES_USER_SQL;
      const params = owner ? [owner] : [];

      if (opts.allowDba && owner) {
        try {
          const dbaResult = await conn.execute<OracleDependencyRow>(
            ORACLE_DEPENDENCIES_DBA_SQL,
            params,
            { maxRows: 10_000 },
          );
          return mapOracleDependencies((dbaResult.rows ?? []) as OracleDependencyRow[]);
        } catch {
          // Insufficient privilege (ORA-00942) or DBA_DEPENDENCIES unreachable —
          // degrade to the always-permitted ALL_DEPENDENCIES/USER_DEPENDENCIES
          // catalog view below. Never throws from this attempt.
        }
      }

      const result = await conn.execute<OracleDependencyRow>(sql, params, { maxRows: 10_000 });
      return mapOracleDependencies((result.rows ?? []) as OracleDependencyRow[]);
    } finally {
      if (conn) await conn.close().catch(() => undefined);
    }
  }

  /**
   * Read a routine body — Epic #294 Phase 3 (#316). READ-ONLY: a single SELECT of
   * `ALL_SOURCE` (the routine source catalog) with owner + name bound as `:1`/`:2`
   * (no string concatenation, no injection surface), assembled in `LINE` order.
   * The assembled `CREATE ... PROCEDURE/FUNCTION` text is returned VERBATIM for the
   * sidecar to PARSE; it is never executed. `DBMS_METADATA.GET_DDL` would also work
   * but `ALL_SOURCE` needs only catalog SELECT, matching the read-only posture.
   */
  async fetchRoutineBody(routine: DbRoutineInfo): Promise<string | null> {
    const pool = this.requirePool();
    let conn: OracleConnectionLike | null = null;
    try {
      conn = await pool.getConnection();
      conn.callTimeout = this.statementTimeoutMs;
      const owner = (routine.schema || "").toUpperCase();
      const sql = owner ? ORACLE_ROUTINE_BODY_SQL : ORACLE_ROUTINE_BODY_USER_SQL;
      const params = owner ? [owner, routine.name.toUpperCase()] : [routine.name.toUpperCase()];
      const result = await conn.execute<OracleSourceRow>(sql, params, { maxRows: 100_000 });
      const rows = (result.rows ?? []) as OracleSourceRow[];
      if (rows.length === 0) return null;
      const text = rows.map((r) => r.TEXT ?? "").join("");
      const trimmed = text.trim();
      // `ALL_SOURCE` text starts at the routine name (no CREATE prefix); prepend a
      // CREATE so the sidecar parses it as a routine definition (→ `calls` edges).
      return trimmed ? `CREATE ${trimmed}` : null;
    } finally {
      if (conn) await conn.close().catch(() => undefined);
    }
  }

  /**
   * PL/SQL PACKAGE enumeration — Epic #881 Phase 2 (#891). READ-ONLY: a SELECT
   * against `ALL_OBJECTS`/`USER_OBJECTS` (owner-qualified, `:1`) scoped to
   * `OBJECT_TYPE IN ('PACKAGE', 'PACKAGE BODY')` locates every package and
   * records which half(s) exist (`hasSpec`/`hasBody`); a second SELECT against
   * `ALL_PROCEDURES`/`USER_PROCEDURES` scoped to `OBJECT_TYPE = 'PACKAGE'`
   * lists each package's PROCEDURE/FUNCTION member names. This is a SEPARATE
   * method (and separate SQL constants) from {@link introspectRoutines} —
   * standalone-routine output is intentionally left byte-identical; packages
   * are additive, not a broadened filter on the existing method. Owner is
   * bound as a parameter so it cannot inject SQL.
   */
  async introspectPackages(opts: { schema?: string } = {}): Promise<DbPackageInfo[]> {
    const pool = this.requirePool();
    let conn: OracleConnectionLike | null = null;
    try {
      conn = await pool.getConnection();
      conn.callTimeout = this.statementTimeoutMs;
      const owner = (opts.schema ?? "").toUpperCase();
      const objectSql = owner ? ORACLE_PACKAGES_SQL : ORACLE_PACKAGES_USER_SQL;
      const memberSql = owner ? ORACLE_PACKAGE_MEMBERS_SQL : ORACLE_PACKAGE_MEMBERS_USER_SQL;
      const params = owner ? [owner] : [];
      const objectResult = await conn.execute<OraclePackageObjectRow>(objectSql, params, {
        maxRows: 10_000,
      });
      const memberResult = await conn.execute<OraclePackageMemberRow>(memberSql, params, {
        maxRows: 50_000,
      });
      return mapOraclePackages(
        (objectResult.rows ?? []) as OraclePackageObjectRow[],
        (memberResult.rows ?? []) as OraclePackageMemberRow[],
      );
    } finally {
      if (conn) await conn.close().catch(() => undefined);
    }
  }

  /**
   * PL/SQL PACKAGE BODY source fetch — Epic #881 Phase 2 (#891). READ-ONLY: a
   * single SELECT of `ALL_SOURCE`/`USER_SOURCE` with owner + name bound as
   * `:1`/`:2`, filtered to `TYPE = 'PACKAGE BODY'`, assembled in `LINE` order —
   * mirrors {@link fetchRoutineBody}'s pattern exactly (same CREATE-prefix
   * convention, same param binding), but standalone `fetchRoutineBody` is left
   * UNCHANGED (still `TYPE IN ('PROCEDURE', 'FUNCTION')` only). The assembled
   * text is returned VERBATIM for #892's parser to consume; it is never
   * executed. Two cases degrade gracefully to `null` rather than throwing:
   * no matching rows (package has no body, or doesn't exist), and a WRAPPED
   * (obfuscated) body — Oracle's wrap format carries a literal `wrapped`
   * marker on the object-declaration line and the remaining lines are
   * ciphertext, not parseable PL/SQL.
   */
  async fetchPackageBody(pkg: { schema: string; name: string }): Promise<string | null> {
    const pool = this.requirePool();
    let conn: OracleConnectionLike | null = null;
    try {
      conn = await pool.getConnection();
      conn.callTimeout = this.statementTimeoutMs;
      const owner = (pkg.schema || "").toUpperCase();
      const sql = owner ? ORACLE_PACKAGE_BODY_SQL : ORACLE_PACKAGE_BODY_USER_SQL;
      const params = owner ? [owner, pkg.name.toUpperCase()] : [pkg.name.toUpperCase()];
      const result = await conn.execute<OracleSourceRow>(sql, params, { maxRows: 100_000 });
      const rows = (result.rows ?? []) as OracleSourceRow[];
      if (rows.length === 0) return null;
      const text = rows.map((r) => r.TEXT ?? "").join("");
      const trimmed = text.trim();
      if (!trimmed) return null;
      const firstLine = trimmed.split("\n", 1)[0] ?? "";
      if (/\bwrapped\b/i.test(firstLine)) {
        log.info("Oracle package body is wrapped — skipping (unparseable)", {
          schema: owner || undefined,
          name: pkg.name,
        });
        return null;
      }
      // Same convention as fetchRoutineBody: ALL_SOURCE text starts at the
      // object declaration (no CREATE prefix); prepend CREATE so a PL/SQL
      // parser accepts it as a standalone DDL statement
      // (`CREATE PACKAGE BODY ... AS ... END;`) — the minimal wrapping #892
      // needs, matching how standalone routine bodies are already wrapped.
      return `CREATE ${trimmed}`;
    } finally {
      if (conn) await conn.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.close(0);
    } catch (err) {
      log.warn("Oracle pool close failed", { err: (err as Error).message });
    }
    this.pool = null;
  }

  private requirePool(): OraclePoolLike {
    if (!this.pool) throw new ConnectorError(500, "DRIVER_UNINITIALIZED", "driver not initialised");
    return this.pool;
  }
}

const ORACLE_INTROSPECT_USER_SQL = `
  SELECT
    USER AS OWNER,
    c.TABLE_NAME AS TABLE_NAME,
    c.COLUMN_NAME AS COLUMN_NAME,
    c.DATA_TYPE AS DATA_TYPE,
    c.NULLABLE AS NULLABLE,
    c.DATA_DEFAULT AS DATA_DEFAULT,
    pk.CONSTRAINT_NAME AS PK_NAME,
    fk.CONSTRAINT_NAME AS FK_NAME,
    fk.R_TABLE_NAME AS FK_FOREIGN_TABLE,
    fk.R_COLUMN_NAME AS FK_FOREIGN_COLUMN
  FROM USER_TAB_COLUMNS c
  LEFT JOIN (
    SELECT col.TABLE_NAME, col.COLUMN_NAME, col.CONSTRAINT_NAME
    FROM USER_CONS_COLUMNS col
    JOIN USER_CONSTRAINTS cons
      ON cons.CONSTRAINT_NAME = col.CONSTRAINT_NAME AND cons.CONSTRAINT_TYPE = 'P'
  ) pk ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
  LEFT JOIN (
    SELECT col.TABLE_NAME, col.COLUMN_NAME, col.CONSTRAINT_NAME,
           rcol.TABLE_NAME AS R_TABLE_NAME, rcol.COLUMN_NAME AS R_COLUMN_NAME
    FROM USER_CONS_COLUMNS col
    JOIN USER_CONSTRAINTS cons
      ON cons.CONSTRAINT_NAME = col.CONSTRAINT_NAME AND cons.CONSTRAINT_TYPE = 'R'
    JOIN USER_CONS_COLUMNS rcol
      ON rcol.CONSTRAINT_NAME = cons.R_CONSTRAINT_NAME
  ) fk ON fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME
  ORDER BY c.TABLE_NAME, c.COLUMN_ID
`;

/**
 * Owner-scoped variant of {@link ORACLE_INTROSPECT_USER_SQL}.
 *
 * Written out in full rather than derived from the `USER_*` query by string
 * replacement: splicing a `WHERE` onto the `FROM` clause placed it *before* the
 * two `LEFT JOIN`s and Oracle rejected the statement with ORA-00933. The
 * constraint sub-selects must also read the `ALL_*` catalog views scoped to the
 * requested owner — the `USER_*` views only ever expose the connected user's
 * own objects, so a cross-schema introspection silently returned no PKs or FKs.
 */
const ORACLE_INTROSPECT_SQL = `
  SELECT
    :1 AS OWNER,
    c.TABLE_NAME AS TABLE_NAME,
    c.COLUMN_NAME AS COLUMN_NAME,
    c.DATA_TYPE AS DATA_TYPE,
    c.NULLABLE AS NULLABLE,
    c.DATA_DEFAULT AS DATA_DEFAULT,
    pk.CONSTRAINT_NAME AS PK_NAME,
    fk.CONSTRAINT_NAME AS FK_NAME,
    fk.R_TABLE_NAME AS FK_FOREIGN_TABLE,
    fk.R_COLUMN_NAME AS FK_FOREIGN_COLUMN
  FROM ALL_TAB_COLUMNS c
  LEFT JOIN (
    SELECT col.OWNER, col.TABLE_NAME, col.COLUMN_NAME, col.CONSTRAINT_NAME
    FROM ALL_CONS_COLUMNS col
    JOIN ALL_CONSTRAINTS cons
      ON cons.OWNER = col.OWNER
     AND cons.CONSTRAINT_NAME = col.CONSTRAINT_NAME
     AND cons.CONSTRAINT_TYPE = 'P'
    WHERE col.OWNER = :1
  ) pk ON pk.OWNER = c.OWNER
      AND pk.TABLE_NAME = c.TABLE_NAME
      AND pk.COLUMN_NAME = c.COLUMN_NAME
  LEFT JOIN (
    SELECT col.OWNER, col.TABLE_NAME, col.COLUMN_NAME, col.CONSTRAINT_NAME,
           rcol.TABLE_NAME AS R_TABLE_NAME, rcol.COLUMN_NAME AS R_COLUMN_NAME
    FROM ALL_CONS_COLUMNS col
    JOIN ALL_CONSTRAINTS cons
      ON cons.OWNER = col.OWNER
     AND cons.CONSTRAINT_NAME = col.CONSTRAINT_NAME
     AND cons.CONSTRAINT_TYPE = 'R'
    JOIN ALL_CONS_COLUMNS rcol
      ON rcol.OWNER = cons.R_OWNER
     AND rcol.CONSTRAINT_NAME = cons.R_CONSTRAINT_NAME
     AND rcol.POSITION = col.POSITION
    WHERE col.OWNER = :1
  ) fk ON fk.OWNER = c.OWNER
      AND fk.TABLE_NAME = c.TABLE_NAME
      AND fk.COLUMN_NAME = c.COLUMN_NAME
  WHERE c.OWNER = :1
  ORDER BY c.TABLE_NAME, c.COLUMN_ID
`;

interface OracleIntrospectRow {
  OWNER: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  NULLABLE: string;
  DATA_DEFAULT: string | null;
  PK_NAME: string | null;
  FK_NAME: string | null;
  FK_FOREIGN_TABLE: string | null;
  FK_FOREIGN_COLUMN: string | null;
}

export function groupOracleIntrospection(rows: OracleIntrospectRow[]): DbTableInfo[] {
  const tables = new Map<string, DbTableInfo>();
  for (const r of rows) {
    const key = `${r.OWNER}.${r.TABLE_NAME}`;
    let t = tables.get(key);
    if (!t) {
      t = {
        schema: r.OWNER,
        name: r.TABLE_NAME,
        columns: [],
        primaryKey: undefined,
        foreignKeys: [],
        indexes: [] as DbIndexInfo[],
      };
      tables.set(key, t);
    }
    if (!t.columns.find((c) => c.name === r.COLUMN_NAME)) {
      const col: DbColumnInfo = {
        name: r.COLUMN_NAME,
        dataType: r.DATA_TYPE,
        nullable: r.NULLABLE === "Y",
        defaultValue: r.DATA_DEFAULT,
        isPrimaryKey: Boolean(r.PK_NAME),
        isForeignKey: Boolean(r.FK_NAME),
      };
      t.columns.push(col);
      if (r.PK_NAME) t.primaryKey = (t.primaryKey ?? []).concat([r.COLUMN_NAME]);
    }
    if (r.FK_NAME && r.FK_FOREIGN_TABLE && r.FK_FOREIGN_COLUMN) {
      let fk = t.foreignKeys.find((f) => f.name === r.FK_NAME);
      if (!fk) {
        fk = {
          name: r.FK_NAME,
          columns: [],
          refTable: r.FK_FOREIGN_TABLE,
          refColumns: [],
        } as DbForeignKeyInfo;
        t.foreignKeys.push(fk);
      }
      if (!fk.columns.includes(r.COLUMN_NAME)) fk.columns.push(r.COLUMN_NAME);
      if (!fk.refColumns.includes(r.FK_FOREIGN_COLUMN)) fk.refColumns.push(r.FK_FOREIGN_COLUMN);
    }
  }
  return [...tables.values()];
}

/**
 * Routines (procedures & functions) introspection — Epic #293 Phase 2 (#300).
 *
 * READ-ONLY: a single SELECT against `ALL_OBJECTS` (owner-qualified, `:1`) or
 * `USER_OBJECTS` (current schema). Standalone procedures & functions are the
 * `OBJECT_TYPE IN ('PROCEDURE','FUNCTION')` rows. Owner is bound as a parameter
 * so it cannot inject SQL. Oracle does not expose a cheap one-row signature
 * (that needs `ALL_ARGUMENTS`), so the signature is left empty for Phase 2 —
 * routine identity is sufficient for graph wiring. The routine SOURCE (body) in
 * `ALL_SOURCE` is deliberately NOT read; deep body extraction is Phase 3 (#294).
 */
const ORACLE_ROUTINES_USER_SQL = `
  SELECT USER AS OWNER, o.OBJECT_NAME AS OBJECT_NAME, o.OBJECT_TYPE AS OBJECT_TYPE
  FROM USER_OBJECTS o
  WHERE o.OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')
  ORDER BY o.OBJECT_NAME
`;

const ORACLE_ROUTINES_SQL = `
  SELECT o.OWNER AS OWNER, o.OBJECT_NAME AS OBJECT_NAME, o.OBJECT_TYPE AS OBJECT_TYPE
  FROM ALL_OBJECTS o
  WHERE o.OWNER = :1
    AND o.OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')
  ORDER BY o.OBJECT_NAME
`;

interface OracleRoutineRow {
  OWNER: string;
  OBJECT_NAME: string;
  OBJECT_TYPE: string;
}

/**
 * PL/SQL PACKAGE enumeration — Epic #881 Phase 2 (#891).
 *
 * READ-ONLY: a SELECT against `ALL_OBJECTS`/`USER_OBJECTS` scoped to
 * `OBJECT_TYPE IN ('PACKAGE', 'PACKAGE BODY')` — the two catalog objects
 * Oracle stores per package (spec and body are separate rows sharing a
 * name). A SEPARATE query/constant pair from {@link ORACLE_ROUTINES_SQL} so
 * standalone-routine output is never broadened or changed by this addition.
 */
const ORACLE_PACKAGES_USER_SQL = `
  SELECT USER AS OWNER, o.OBJECT_NAME AS OBJECT_NAME, o.OBJECT_TYPE AS OBJECT_TYPE
  FROM USER_OBJECTS o
  WHERE o.OBJECT_TYPE IN ('PACKAGE', 'PACKAGE BODY')
  ORDER BY o.OBJECT_NAME, o.OBJECT_TYPE
`;

const ORACLE_PACKAGES_SQL = `
  SELECT o.OWNER AS OWNER, o.OBJECT_NAME AS OBJECT_NAME, o.OBJECT_TYPE AS OBJECT_TYPE
  FROM ALL_OBJECTS o
  WHERE o.OWNER = :1
    AND o.OBJECT_TYPE IN ('PACKAGE', 'PACKAGE BODY')
  ORDER BY o.OBJECT_NAME, o.OBJECT_TYPE
`;

interface OraclePackageObjectRow {
  OWNER: string;
  OBJECT_NAME: string;
  OBJECT_TYPE: string;
}

/**
 * PL/SQL PACKAGE member enumeration — Epic #881 Phase 2 (#891).
 *
 * READ-ONLY: a SELECT against `ALL_PROCEDURES`/`USER_PROCEDURES` scoped to
 * `OBJECT_TYPE = 'PACKAGE'`; for those rows Oracle carries the package name
 * in `OBJECT_NAME` and the member's PROCEDURE/FUNCTION name in
 * `PROCEDURE_NAME`. `ALL_PROCEDURES` does not cheaply distinguish procedure
 * vs. function members (that needs `ALL_ARGUMENTS`), so only the member name
 * is captured — matching the Phase 2 routine-signature precedent of leaving
 * finer detail for a later pass.
 */
const ORACLE_PACKAGE_MEMBERS_USER_SQL = `
  SELECT USER AS OWNER, p.OBJECT_NAME AS OBJECT_NAME, p.PROCEDURE_NAME AS PROCEDURE_NAME
  FROM USER_PROCEDURES p
  WHERE p.OBJECT_TYPE = 'PACKAGE'
  ORDER BY p.OBJECT_NAME, p.PROCEDURE_NAME
`;

const ORACLE_PACKAGE_MEMBERS_SQL = `
  SELECT p.OWNER AS OWNER, p.OBJECT_NAME AS OBJECT_NAME, p.PROCEDURE_NAME AS PROCEDURE_NAME
  FROM ALL_PROCEDURES p
  WHERE p.OWNER = :1
    AND p.OBJECT_TYPE = 'PACKAGE'
  ORDER BY p.OBJECT_NAME, p.PROCEDURE_NAME
`;

interface OraclePackageMemberRow {
  OWNER: string;
  OBJECT_NAME: string;
  PROCEDURE_NAME: string | null;
}

/**
 * Turn raw `ALL_OBJECTS`/`USER_OBJECTS` package rows + `ALL_PROCEDURES`/
 * `USER_PROCEDURES` member rows into {@link DbPackageInfo}. Pure function.
 * Merges spec/body existence by `OWNER.OBJECT_NAME`; drops member rows with
 * a null `PROCEDURE_NAME` (packages with no public members expose none) and
 * member rows whose package isn't present in the object rows (should not
 * happen against a consistent catalog snapshot, but keeps the merge total);
 * dedupes repeated member names (overloads share one name in `ALL_PROCEDURES`).
 */
export function mapOraclePackages(
  objectRows: OraclePackageObjectRow[],
  memberRows: OraclePackageMemberRow[],
): DbPackageInfo[] {
  const packages = new Map<string, DbPackageInfo>();
  for (const r of objectRows) {
    const key = `${r.OWNER}.${r.OBJECT_NAME}`;
    let p = packages.get(key);
    if (!p) {
      p = { schema: r.OWNER, name: r.OBJECT_NAME, hasSpec: false, hasBody: false, members: [] };
      packages.set(key, p);
    }
    if (r.OBJECT_TYPE === "PACKAGE") p.hasSpec = true;
    else if (r.OBJECT_TYPE === "PACKAGE BODY") p.hasBody = true;
  }
  for (const r of memberRows) {
    if (!r.PROCEDURE_NAME) continue;
    const key = `${r.OWNER}.${r.OBJECT_NAME}`;
    const p = packages.get(key);
    if (!p) continue;
    if (!p.members.includes(r.PROCEDURE_NAME)) p.members.push(r.PROCEDURE_NAME);
  }
  return [...packages.values()];
}

/**
 * Tier-1 dependency introspection — Epic #881 Phase 1 (#890).
 *
 * READ-ONLY, zero-parse: a single SELECT against `ALL_DEPENDENCIES`
 * (owner-qualified, `:1`) or `USER_DEPENDENCIES` (current schema), scoped to
 * `TYPE IN ('PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION')` — the PL/SQL
 * object kinds this Tier covers. `REFERENCED_OWNER`/`REFERENCED_NAME`/
 * `REFERENCED_TYPE` name the object the row's owner-object references; Oracle
 * records NO read/write direction and NO information about which statement
 * makes the reference (that granularity is Tier-2 body parsing, #891-#893).
 * Owner is bound as a parameter so it cannot inject SQL.
 */
const ORACLE_DEPENDENCIES_USER_SQL = `
  SELECT
    USER AS OWNER,
    d.NAME AS NAME,
    d.TYPE AS TYPE,
    d.REFERENCED_OWNER AS REFERENCED_OWNER,
    d.REFERENCED_NAME AS REFERENCED_NAME,
    d.REFERENCED_TYPE AS REFERENCED_TYPE
  FROM USER_DEPENDENCIES d
  WHERE d.TYPE IN ('PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION')
  ORDER BY d.NAME
`;

const ORACLE_DEPENDENCIES_SQL = `
  SELECT
    d.OWNER AS OWNER,
    d.NAME AS NAME,
    d.TYPE AS TYPE,
    d.REFERENCED_OWNER AS REFERENCED_OWNER,
    d.REFERENCED_NAME AS REFERENCED_NAME,
    d.REFERENCED_TYPE AS REFERENCED_TYPE
  FROM ALL_DEPENDENCIES d
  WHERE d.OWNER = :1
    AND d.TYPE IN ('PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION')
  ORDER BY d.NAME
`;

/**
 * `DBA_DEPENDENCIES` variant — same shape as {@link ORACLE_DEPENDENCIES_SQL},
 * requires the `SELECT_CATALOG_ROLE`/DBA-granted view. Only attempted when the
 * caller opts in via `allowDba` ("when permitted"); a privilege failure
 * (`ORA-00942`) degrades cleanly to {@link ORACLE_DEPENDENCIES_SQL}.
 */
const ORACLE_DEPENDENCIES_DBA_SQL = ORACLE_DEPENDENCIES_SQL.replace(
  "FROM ALL_DEPENDENCIES d",
  "FROM DBA_DEPENDENCIES d",
);

interface OracleDependencyRow {
  OWNER: string;
  NAME: string;
  TYPE: string;
  REFERENCED_OWNER: string | null;
  REFERENCED_NAME: string | null;
  REFERENCED_TYPE: string | null;
}

/**
 * Turn raw `ALL_DEPENDENCIES`/`DBA_DEPENDENCIES` rows into {@link DbDependencyInfo}.
 * Pure function. Drops rows Oracle flags as `NON-EXISTENT` (a dangling/invalid
 * reference, not a real object) and rows missing a referenced name.
 */
export function mapOracleDependencies(rows: OracleDependencyRow[]): DbDependencyInfo[] {
  return rows
    .filter((r) => r.REFERENCED_NAME && r.REFERENCED_TYPE !== "NON-EXISTENT")
    .map((r) => ({
      schema: r.OWNER,
      name: r.NAME,
      type: r.TYPE,
      referencedSchema: r.REFERENCED_OWNER ?? "",
      referencedName: r.REFERENCED_NAME as string,
      referencedType: r.REFERENCED_TYPE ?? "",
    }));
}

/**
 * Routine BODY fetch — Epic #294 Phase 3 (#316). READ-ONLY: owner + name bound as
 * `:1`/`:2`, source lines assembled in order. Returns the routine source for
 * STATIC PARSING ONLY (never executed). PACKAGE bodies are excluded — we read
 * standalone PROCEDURE/FUNCTION source only (TYPE = the routine type).
 */
const ORACLE_ROUTINE_BODY_SQL = `
  SELECT s.TEXT AS TEXT
  FROM ALL_SOURCE s
  WHERE s.OWNER = :1
    AND s.NAME = :2
    AND s.TYPE IN ('PROCEDURE', 'FUNCTION')
  ORDER BY s.LINE
`;

const ORACLE_ROUTINE_BODY_USER_SQL = `
  SELECT s.TEXT AS TEXT
  FROM USER_SOURCE s
  WHERE s.NAME = :1
    AND s.TYPE IN ('PROCEDURE', 'FUNCTION')
  ORDER BY s.LINE
`;

interface OracleSourceRow {
  TEXT: string | null;
}

/**
 * PACKAGE BODY fetch — Epic #881 Phase 2 (#891). READ-ONLY: owner + name bound
 * as `:1`/`:2`, source lines assembled in order. A SEPARATE query/constant
 * pair from {@link ORACLE_ROUTINE_BODY_SQL} — standalone `fetchRoutineBody`
 * stays `TYPE IN ('PROCEDURE', 'FUNCTION')` only, unchanged.
 */
const ORACLE_PACKAGE_BODY_SQL = `
  SELECT s.TEXT AS TEXT
  FROM ALL_SOURCE s
  WHERE s.OWNER = :1
    AND s.NAME = :2
    AND s.TYPE = 'PACKAGE BODY'
  ORDER BY s.LINE
`;

const ORACLE_PACKAGE_BODY_USER_SQL = `
  SELECT s.TEXT AS TEXT
  FROM USER_SOURCE s
  WHERE s.NAME = :1
    AND s.TYPE = 'PACKAGE BODY'
  ORDER BY s.LINE
`;

export function mapOracleRoutines(rows: OracleRoutineRow[]): DbRoutineInfo[] {
  return rows.map((r) => ({
    schema: r.OWNER,
    name: r.OBJECT_NAME,
    type: r.OBJECT_TYPE?.toUpperCase() === "FUNCTION" ? "function" : "procedure",
    signature: "",
  }));
}

function connectionError(err: unknown): ConnectorError {
  const msg = (err as Error).message ?? "connection failed";
  if (/ORA-01017|invalid username\/password/i.test(msg)) {
    return new ConnectorError(401, "DB_AUTH_FAILED", `authentication failed`);
  }
  if (/ORA-12541|TNS|listener|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
    return new ConnectorError(502, "DB_CONNECT_FAILED", `database unreachable`);
  }
  return new ConnectorError(500, "DB_ERROR", msg);
}

function queryError(err: unknown): ConnectorError {
  const msg = (err as Error).message ?? "query failed";
  if (/ORA-01013|user requested cancel|callTimeout|timeout/i.test(msg)) {
    return new ConnectorError(504, "QUERY_TIMEOUT", `query exceeded statement timeout`);
  }
  return new ConnectorError(500, "QUERY_FAILED", msg);
}
