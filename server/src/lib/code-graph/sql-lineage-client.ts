/**
 * HTTP client for the `metis-sql-lineage` sidecar — Epic #294 (#304).
 *
 * Modeled on {@link ../rag/embeddings-client.ts}: shared-secret bearer auth, a
 * per-request timeout, bounded retry on transient errors, and a base-URL env.
 * This is the only module in the server that knows how to call the sidecar; the
 * embedded-SQL scanner (#305) and the SAS PROC SQL miner (#306) route through it.
 *
 * Graceful degradation (mirrors how embeddings failures are tolerated): when the
 * sidecar is disabled (`SQL_LINEAGE_MODE != sidecar`) or unreachable, callers use
 * {@link extractUsageSafe}, which returns `null` instead of throwing so doc/impact
 * generation proceeds without the sidecar. The SQL we could not resolve is then
 * classified `uncertain` upstream — never dropped.
 *
 * The introspected schema is passed through on EVERY call — it is the documented
 * ~20%->~90% column-accuracy lever (SELECT * expansion needs the schema).
 */
import { request as undiciRequest } from "undici";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("sql-lineage-client");

/** Access kind the sidecar reports per table/column (maps to schema-edge kinds). */
export type SqlLineageAccess = "read" | "write" | "persist";

/** A table the sidecar resolved out of a SQL string. */
export interface SqlLineageTable {
  schema: string;
  name: string;
  qualifiedName: string;
  access: SqlLineageAccess;
}

/** A column the sidecar resolved (attributed to its table). */
export interface SqlLineageColumn {
  table: string;
  column: string;
  qualifiedName: string;
  access: SqlLineageAccess;
}

/** An OpenLineage column-lineage edge (`source = "sqlglot"`). */
export interface SqlLineageEdge {
  namespace: string;
  inputField: { table: string; column: string };
  outputField: { column: string };
  transformation: string;
  source: "sqlglot";
}

/**
 * An unresolved reference. A non-empty `uncertain` list means the caller MUST
 * classify the affected refs `uncertain` (never drop them). `reason` mirrors
 * `UsageUncertainReason` in shared (`dynamic-reference` | `routine-body-unanalyzed`).
 */
export interface SqlLineageUncertain {
  reason: string;
  detail: string;
}

/**
 * A routine (procedure/function) INVOCATION the sidecar resolved out of a SQL
 * string — Epic #294 (#316). Produced for `CALL`/`EXEC`/`EXECUTE <proc>` and
 * user-defined `SELECT fn(...)` calls (built-ins are excluded). The caller turns
 * each into a code→routine `executes` edge, or — when the SQL is a routine body —
 * a routine→routine `calls` edge.
 */
export interface SqlLineageRoutineRef {
  schema: string;
  name: string;
  qualifiedName: string;
}

export interface ExtractUsageResult {
  tables: SqlLineageTable[];
  columns: SqlLineageColumn[];
  lineage_edges: SqlLineageEdge[];
  uncertain: SqlLineageUncertain[];
  /**
   * Routine invocations referenced by the SQL (#316). Defaulted by
   * {@link normalizeExtractUsageResult} so responses from an older sidecar that
   * omits the field are treated as "no routines" rather than `undefined`.
   */
  routines: SqlLineageRoutineRef[];
}

/** Introspected schema fed to sqlglot: `{ db: { table: { column: type } } }`. */
export type IntrospectedSchema = Record<string, Record<string, Record<string, string>>>;

/** Minimal shape of an introspected table needed to build an {@link IntrospectedSchema}. */
export interface IntrospectedTableLike {
  schema?: string | null;
  name: string;
  columns: { name: string; dataType?: string | null }[];
}

/**
 * Map introspected tables (`driver.introspect()` output) into the
 * {@link IntrospectedSchema} shape sqlglot consumes — Epic #294 (#317). This is
 * the ~20%→~90% column-accuracy lever: with the schema, sqlglot expands
 * `SELECT *` into per-column references and qualifies bare columns across joins.
 *
 * The top-level key is the table's schema (falling back to `"public"` when a
 * table carries no schema, matching sqlglot's default-namespace expectation).
 * Returns `null` when there are no tables, so callers can pass `null` and behave
 * exactly as before (no regression when no DB schema is available).
 */
export function buildIntrospectedSchema(
  tables: IntrospectedTableLike[],
): IntrospectedSchema | null {
  if (tables.length === 0) return null;
  const out: IntrospectedSchema = {};
  for (const t of tables) {
    const db = (t.schema && t.schema.trim()) || "public";
    const tableName = t.name;
    if (!tableName) continue;
    const dbBucket = (out[db] ??= {});
    const colBucket = (dbBucket[tableName] ??= {});
    for (const c of t.columns) {
      if (!c.name) continue;
      colBucket[c.name] = c.dataType ?? "unknown";
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Minimal shape of a persisted schema-graph `CodeSymbol` row needed to
 * reconstruct an {@link IntrospectedSchema} — Epic #883 (#901). Only the `kind`
 * (`table`/`column`) and `qualifiedName` are required; the qualified name
 * already encodes the object identity produced by the schema-graph writer
 * (`<schema>.<table>` for tables, `<schema>.<table>.<column>` for columns).
 */
export interface SchemaGraphSymbolLike {
  kind: string;
  qualifiedName: string;
  /**
   * Live column type when known. Graph-derived symbols (mybatis/orm/ddl-file)
   * carry no type, so this is optional and defaults to `"unknown"` — sqlglot's
   * `qualify` only needs table→column membership to resolve unqualified columns,
   * not the concrete type.
   */
  columnType?: string | null;
}

/**
 * Assemble the sqlglot {@link IntrospectedSchema} from the INGESTED schema
 * graph's persisted `table`/`column` `CodeSymbol` rows — Epic #883 (#901),
 * the deferred column-level-lineage foundation.
 *
 * This is the ALL_TAB_COLUMNS-equivalent lever for projects that have an
 * ingested schema graph (MyBatis #884 / ORM #849 / DDL-file / prior `sqlglot`
 * columns) but NO reachable live DB connection: {@link buildIntrospectedSchema}
 * needs `driver.introspect()` output, whereas this rebuilds the same
 * `{ db: { table: { column: type } } }` shape directly from the qualified names
 * already stored in the graph. Feeding that schema back into
 * {@link SqlLineageClient.extractUsage} lets sqlglot expand `SELECT *` and
 * resolve unqualified columns to their owning table — column-level lineage
 * WITHOUT a live database.
 *
 * Identity parsing mirrors the schema-graph writer's qualified-name scheme
 * (`tableQualifiedName`/`columnQualifiedName` in `schema-graph.ts`), disambiguated
 * by `kind`:
 *   - `table`  → `schema.table` (2 parts) or bare `table` (1 part).
 *   - `column` → `schema.table.column` (3 parts) or `table.column` (2 parts).
 *
 * A table with no schema lands in the `"public"` bucket, matching
 * {@link buildIntrospectedSchema} and sqlglot's default namespace. Synthetic
 * dynamic-placeholder names (`?dynamic:…`, #886) and malformed identities are
 * skipped. Returns `null` when nothing usable was found so callers pass `null`
 * and behave exactly as before (no regression).
 */
export function buildIntrospectedSchemaFromSymbols(
  symbols: readonly SchemaGraphSymbolLike[],
): IntrospectedSchema | null {
  const out: IntrospectedSchema = {};

  const bucketFor = (db: string, table: string): Record<string, string> => {
    const dbBucket = (out[db] ??= {});
    return (dbBucket[table] ??= {});
  };

  for (const sym of symbols) {
    const qn = (sym.qualifiedName ?? "").trim();
    // Never let a synthetic dynamic placeholder leak into the sqlglot schema —
    // it is not a real table/column and would poison column resolution.
    if (!qn || qn.startsWith("?")) continue;
    const parts = qn.split(".");
    if (sym.kind === "table") {
      if (parts.length === 2) {
        bucketFor(parts[0], parts[1]);
      } else if (parts.length === 1) {
        bucketFor("public", parts[0]);
      }
    } else if (sym.kind === "column") {
      if (parts.length === 3) {
        bucketFor(parts[0], parts[1])[parts[2]] = sym.columnType ?? "unknown";
      } else if (parts.length === 2) {
        bucketFor("public", parts[0])[parts[1]] = sym.columnType ?? "unknown";
      }
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

export interface ExtractUsageParams {
  sql: string;
  dialect?: string;
  schema?: IntrospectedSchema | null;
}

export interface SqlLineageClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class SqlLineageClientError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "SqlLineageClientError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class SqlLineageClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(opts: SqlLineageClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.SQL_LINEAGE_URL ?? "http://sql-lineage:5070";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const token = opts.token ?? process.env.SQL_LINEAGE_TOKEN ?? "";
    if (!token) {
      throw new Error(
        "SQL_LINEAGE_TOKEN is required when SQL_LINEAGE_MODE=sidecar — refusing to start the client without a shared secret.",
      );
    }
    this.token = token;
    this.timeoutMs = Math.max(
      1_000,
      opts.timeoutMs ?? (Number(process.env.SQL_LINEAGE_TIMEOUT_MS) || 15_000),
    );
    this.maxAttempts = Math.max(
      1,
      opts.maxAttempts ?? (Number(process.env.SQL_LINEAGE_MAX_ATTEMPTS) || 3),
    );
  }

  /**
   * Extract usage for one SQL string. The schema (when supplied) is forwarded so
   * sqlglot can expand `SELECT *` and qualify bare columns. Throws
   * {@link SqlLineageClientError} on a non-2xx/unreachable sidecar — most callers
   * should prefer {@link extractUsageSafe}.
   */
  async extractUsage(params: ExtractUsageParams): Promise<ExtractUsageResult> {
    const body: Record<string, unknown> = { sql: params.sql };
    if (params.dialect) body.dialect = params.dialect;
    if (params.schema) body.schema = params.schema;
    const raw = await this.post<Partial<ExtractUsageResult>>("/extract_usage", body);
    return normalizeExtractUsageResult(raw);
  }

  async healthz(): Promise<{ status: string; tokenConfigured: boolean }> {
    const url = `${this.baseUrl}/healthz`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      const res = await undiciRequest(url, { method: "GET", signal: ac.signal });
      return (await res.body.json()) as { status: string; tokenConfigured: boolean };
    } finally {
      clearTimeout(t);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await undiciRequest(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        clearTimeout(t);
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          return (await res.body.json()) as T;
        }
        const text = await res.body.text();
        const retryable = status >= 500 && status !== 501;
        if (retryable && attempt < this.maxAttempts) {
          log.warn("sql-lineage sidecar returned retryable status", {
            status,
            attempt,
            path,
            preview: text.slice(0, 200),
          });
          await delay(backoffMs(attempt));
          continue;
        }
        throw new SqlLineageClientError(
          `sql-lineage sidecar ${path} returned ${status}: ${text.slice(0, 200)}`,
          status,
          retryable,
        );
      } catch (err) {
        clearTimeout(t);
        if (err instanceof SqlLineageClientError) throw err;
        lastError = err;
        if (attempt < this.maxAttempts) {
          log.warn("sql-lineage sidecar request failed, retrying", {
            attempt,
            path,
            error: (err as Error).message,
          });
          await delay(backoffMs(attempt));
          continue;
        }
      }
    }
    throw new SqlLineageClientError(
      `sql-lineage sidecar ${path} failed after ${this.maxAttempts} attempts: ${(lastError as Error)?.message ?? "unknown"}`,
      0,
      true,
    );
  }
}

/**
 * Coerce a (possibly partial) sidecar response into a fully-populated
 * {@link ExtractUsageResult}. Defaults every list to `[]` so a response from an
 * older sidecar that omits the `routines` field (added in #316) — or any missing
 * key — never surfaces as `undefined` to callers. Pure; never throws.
 */
export function normalizeExtractUsageResult(raw: Partial<ExtractUsageResult>): ExtractUsageResult {
  return {
    tables: raw.tables ?? [],
    columns: raw.columns ?? [],
    lineage_edges: raw.lineage_edges ?? [],
    uncertain: raw.uncertain ?? [],
    routines: raw.routines ?? [],
  };
}

function backoffMs(attempt: number): number {
  return Math.min(2_000, 200 * 2 ** (attempt - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let singleton: SqlLineageClient | null = null;

export function getSqlLineageClient(): SqlLineageClient {
  if (!singleton) singleton = new SqlLineageClient();
  return singleton;
}

export function __resetSqlLineageClientSingleton(): void {
  singleton = null;
}

/**
 * Mode selection helper. Returns `"sidecar"` when the server should call the
 * remote service, `"in-process"` otherwise.
 *
 * Defaults (mirror the embeddings mode resolver):
 *   - tests (`NODE_ENV=test` / `VITEST`) → in-process
 *   - offline mode (`AI_OFFLINE=1`)       → in-process
 *   - production (`NODE_ENV=production`)   → sidecar
 *   - everything else                     → in-process
 *
 * Explicit `SQL_LINEAGE_MODE=sidecar | in-process` always wins.
 */
export function resolveSqlLineageMode(): "sidecar" | "in-process" {
  const explicit = process.env.SQL_LINEAGE_MODE?.trim().toLowerCase();
  if (explicit === "sidecar" || explicit === "in-process") return explicit;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return "in-process";
  if (process.env.AI_OFFLINE === "1" || process.env.AI_OFFLINE === "true") return "in-process";
  if (process.env.NODE_ENV === "production") return "sidecar";
  return "in-process";
}

/**
 * True when the SQL-lineage sidecar integration is enabled (feature gate).
 *
 * `projectOverride` — Epic #882 (#894): the ALREADY-RESOLVED per-project
 * decision (`resolveProjectSqlLineage` in `sql-lineage-resolver.ts`), when the
 * caller has one. `true`/`false` short-circuits straight to that value
 * (the project's explicit `on`/`off` override, always reachable regardless of
 * the platform env flag); `undefined`/`null` (the default — every pre-#894
 * call site) falls back to the platform-only check exactly as before, so
 * global behavior is unchanged for callers that never resolved a per-project
 * decision.
 */
export function isSqlLineageEnabled(projectOverride?: boolean | null): boolean {
  if (projectOverride === true || projectOverride === false) return projectOverride;
  return resolveSqlLineageMode() === "sidecar";
}

/**
 * Best-effort static signal that the sidecar's shared secret is configured —
 * Epic #882 (#894). Used ONLY to surface "enabled but the sidecar looks
 * unconfigured" state to the UI/API (never a silent no-op); it does NOT probe
 * connectivity (no network call) so it stays cheap enough for a settings GET.
 */
export function isSqlLineageSidecarConfigured(): boolean {
  return Boolean(process.env.SQL_LINEAGE_TOKEN?.trim());
}

/**
 * Graceful-degradation wrapper. Returns the extraction result, or `null` when:
 *   - the sidecar is disabled (`SQL_LINEAGE_MODE != sidecar`, or the resolved
 *     per-project decision says disabled), or
 *   - the client cannot be constructed (no token), or
 *   - the sidecar is unreachable / errored.
 *
 * Callers treat `null` as "the sidecar could not help" and fall back to their
 * existing behavior; any SQL they then can't resolve is classified `uncertain`.
 * This NEVER throws — doc/impact generation must not fail because the sidecar is
 * down (the #294 graceful-degradation requirement).
 *
 * `enabledOverride` (#894) — threaded down from the ingest-time resolved
 * per-project decision; see {@link isSqlLineageEnabled}.
 */
export async function extractUsageSafe(
  params: ExtractUsageParams,
  client?: SqlLineageClient,
  enabledOverride?: boolean | null,
): Promise<ExtractUsageResult | null> {
  if (!isSqlLineageEnabled(enabledOverride)) return null;
  let c = client;
  if (!c) {
    try {
      c = getSqlLineageClient();
    } catch (err) {
      log.warn("sql-lineage client unavailable; skipping extraction", {
        error: (err as Error).message,
      });
      return null;
    }
  }
  try {
    return await c.extractUsage(params);
  } catch (err) {
    log.warn("sql-lineage extraction failed; degrading gracefully", {
      error: (err as Error).message,
    });
    return null;
  }
}
