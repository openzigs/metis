/**
 * Database driver abstraction — Phase 8.
 *
 * Each supported driver (pg, mysql2, optional oracledb, sqlite) is wrapped in
 * a small adapter implementing this interface. Higher-level code (services,
 * tools) NEVER touches a driver directly — that keeps:
 *
 *   - the SQL validator the only path to query execution,
 *   - read-only enforcement uniform across vendors,
 *   - and the test surface mockable without spinning a real DB.
 */
import type {
  DbColumnInfo,
  DbDependencyInfo,
  DbForeignKeyInfo,
  DbIndexInfo,
  DbPackageInfo,
  DbRoutineInfo,
  DbTableInfo,
} from "@metis/shared";

export interface DbConnectionConfig {
  driver: string;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string | null;
  /** Driver-specific options (TNS, options, ssl, etc). */
  options?: Record<string, unknown>;
  statementTimeoutMs: number;
  /**
   * Timeout for catalog *introspection* calls, which are far heavier than an
   * ad-hoc user query — an enterprise Oracle data dictionary can take tens of
   * seconds to join `ALL_TAB_COLUMNS` against the constraint views. Falls back
   * to `statementTimeoutMs` when unset.
   */
  introspectTimeoutMs?: number;
  poolMax: number;
  /**
   * Pre-resolved IP address for `host`, set by the service layer after
   * `resolveAndAssertConnectorHost`. Drivers MUST configure their socket-level
   * `lookup` callback to return this address so the post-validation DNS
   * resolution can't be hijacked (DNS-rebinding TOCTOU defence).
   */
  pinnedAddress?: string;
  pinnedFamily?: 4 | 6;
}

export interface DbQueryRequest {
  sql: string;
  /** Validated max row cap to enforce on the result set. */
  maxRows: number;
  statementTimeoutMs: number;
}

export interface DbQueryResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export interface DbDriverAdapter {
  /** Open a pool / handle. Idempotent. */
  init(config: DbConnectionConfig): Promise<void>;
  /** Test that the connection works. Returns latency in ms. */
  ping(): Promise<number>;
  /** Execute a single SELECT — already validated by the caller. */
  query(req: DbQueryRequest): Promise<DbQueryResponse>;
  /** Read schema metadata (tables/cols/FKs/indexes). */
  introspect(opts?: { schema?: string }): Promise<DbTableInfo[]>;
  /**
   * Read stored-routine metadata — procedures & functions — for the given
   * schema (Epic #293 Phase 2, #300). READ-ONLY: every driver issues a single
   * parameterized SELECT against the dialect's routine catalog and returns only
   * the routine identity + a best-effort signature. It NEVER fetches the routine
   * body and NEVER executes a routine. Optional on the interface so a driver may
   * be upgraded incrementally; callers MUST treat a missing method as "no
   * routines" rather than an error. Deep body-level call extraction is Phase 3
   * (#294).
   */
  introspectRoutines?(opts?: { schema?: string }): Promise<DbRoutineInfo[]>;
  /**
   * Read a single stored routine's BODY/source text — Epic #294 Phase 3 (#316).
   * READ-ONLY and PARSE-ONLY: every driver issues a single parameterized (or
   * strictly-validated) SELECT against the dialect's metadata catalog (Oracle
   * `ALL_SOURCE`/`DBMS_METADATA`, Postgres `pg_get_functiondef`, MySQL
   * `SHOW CREATE`/`information_schema.routines`, SQL Server
   * `OBJECT_DEFINITION`/`sys.sql_modules`) and returns the body text VERBATIM. It
   * NEVER executes the routine and NEVER runs DDL — the body is handed to the
   * `metis-sql-lineage` sidecar for static parsing only. Returns `null` when the
   * body is unavailable (insufficient catalog grants, routine dropped, encrypted
   * module). Optional on the interface so a driver may be upgraded incrementally;
   * callers MUST treat a missing method as "no body available".
   */
  fetchRoutineBody?(routine: DbRoutineInfo): Promise<string | null>;
  /**
   * Read coarse object→referenced-object dependency rows from the dialect's
   * dependency catalog — **Tier-1** lineage (Epic #881 Phase 1, #890). READ-ONLY
   * and zero-parse: a single parameterized SELECT against the catalog (Oracle
   * `ALL_DEPENDENCIES`, optionally `DBA_DEPENDENCIES` when permitted). It NEVER
   * executes anything and is blind to read/write direction and dynamic SQL —
   * it exists as an always-on fallback usable even when Tier-2 routine-BODY
   * parsing (#891-#893) is unavailable. Optional on the interface so a driver
   * may be upgraded incrementally; callers MUST treat a missing method as "no
   * dependency rows".
   */
  introspectDependencies?(opts?: { schema?: string }): Promise<DbDependencyInfo[]>;
  /**
   * Read PL/SQL PACKAGE metadata — every package plus its PROCEDURE/FUNCTION
   * member names and which half(s) (`hasSpec`/`hasBody`) exist — Epic #881
   * Phase 2 (#891). READ-ONLY: a single parameterized SELECT against the
   * dialect's object catalog (Oracle `ALL_OBJECTS`/`ALL_PROCEDURES`). It NEVER
   * fetches the body and NEVER executes anything. Optional so a driver may be
   * upgraded incrementally; callers MUST treat a missing method as "no
   * packages". Only Oracle implements this today; other dialects have no
   * package construct.
   */
  introspectPackages?(opts?: { schema?: string }): Promise<DbPackageInfo[]>;
  /**
   * Read a single PL/SQL PACKAGE BODY's source text — Epic #881 Phase 2 (#891).
   * READ-ONLY and PARSE-ONLY: a single parameterized SELECT against the source
   * catalog (Oracle `ALL_SOURCE`/`USER_SOURCE`), returned VERBATIM (with a
   * `CREATE` prefix) for #892's text-only pre-processor to consume. It NEVER
   * executes the body and NEVER runs DDL. Returns `null` when the body is
   * unavailable (no body, wrapped/obfuscated source, missing grants). Optional
   * on the interface; callers MUST treat a missing method as "no body available".
   */
  fetchPackageBody?(pkg: { schema: string; name: string }): Promise<string | null>;
  /** Release pool resources. */
  close(): Promise<void>;
}

export type DbDriverFactory = () => DbDriverAdapter;

const registry = new Map<string, DbDriverFactory>();

export function registerDriver(driver: string, factory: DbDriverFactory): void {
  registry.set(driver, factory);
}

export function getDriverFactory(driver: string): DbDriverFactory {
  const f = registry.get(driver);
  if (!f) throw new Error(`No driver registered for '${driver}'`);
  return f;
}

export function hasDriver(driver: string): boolean {
  return registry.has(driver);
}

/** Test helper — clear the registry between suites. */
export function __resetDriverRegistry(): void {
  registry.clear();
}

// Re-export for ergonomic single-import for tools.
export type { DbColumnInfo, DbForeignKeyInfo, DbIndexInfo, DbRoutineInfo, DbTableInfo };
