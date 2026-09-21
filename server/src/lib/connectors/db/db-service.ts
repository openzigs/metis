/**
 * Database connector service — Phase 8 (issues #61–#64).
 *
 * Public surface:
 *
 *   - listDbConnectors / getDbConnector / createDbConnector / updateDbConnector / deleteDbConnector
 *   - testDbConnector              → opens a pooled connection, runs SELECT 1
 *   - inspectDbConnector           → schema introspection (low-risk, schema-only)
 *   - queryDbConnector             → SELECT-only, ≤QUERY_DB_MAX_ROWS (audit-logged)
 *
 * The service owns:
 *   - Per-connection driver pool reuse (one DbDriverAdapter per connector id).
 *   - Vault reference resolution (plaintext NEVER persists).
 *   - Network allow-list enforcement before opening a socket.
 *   - SQL validation pipeline before query execution.
 *   - PII redaction of returned rows.
 *   - Audit log entries for every test / inspect / query / ingest.
 */
import {
  DEFAULT_DB_INTROSPECT_TIMEOUT_MS,
  DEFAULT_DB_POOL_MAX,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  QUERY_DB_MAX_ROWS,
  parseDbConnectorAllowList,
  type CreateDatabaseConnectorInput,
  type DbDependencyInfo,
  type DbDriver,
  type DbPackageInfo,
  type DbQueryResult,
  type DbRoutineInfo,
  type DbSchemaSnapshot,
  type DbTableInfo,
  type UpdateDatabaseConnectorInput,
} from "@metis/shared";
import { resolveProjectSqlLineage } from "../../code-graph/sql-lineage-resolver.js";
import { audit } from "../../audit/audit-service.js";
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import { getVaultService } from "../../vault/vault-service.js";
import { resolveAndAssertConnectorHost } from "../network-allowlist.js";
import { isDriverDetailCode, sanitizeDriverError } from "../driver-error.js";
import { redactRows } from "../pii-redactor.js";
import { ConnectorError, NOOP_EMITTER, type ConnectorEmitter } from "../types.js";
import { resolveVaultRef } from "../vault-resolver.js";
import { getDriverFactory, hasDriver, type DbDriverAdapter } from "./driver.js";
import { registerBuiltInDrivers } from "./register-drivers.js";
import { validateSelectOnly } from "./sql-validator.js";
import {
  buildIntrospectedSchema,
  type IntrospectedSchema,
} from "../../code-graph/sql-lineage-client.js";
import type { RoutineBodyFetcher } from "../../code-graph/routine-body-extractor.js";
import type { PackageBodyFetcher } from "../../code-graph/plsql-package-lineage.js";
import { linkConnectionToResource } from "../../cross-project/database-resource-service.js";

const log = createChildLogger("db-service");

registerBuiltInDrivers();

interface PooledAdapter {
  adapter: DbDriverAdapter;
  fingerprint: string;
}

const adapterPool = new Map<string, PooledAdapter>();

export interface DbServiceDeps {
  emitter?: ConnectorEmitter;
}

let depsRef: DbServiceDeps = {};

export function configureDbConnectorService(deps: DbServiceDeps): void {
  depsRef = deps;
}

function emitter(): ConnectorEmitter {
  return depsRef.emitter ?? NOOP_EMITTER;
}

// ---- CRUD ------------------------------------------------------------------

export async function listDbConnectors(projectId: string) {
  const rows = await prisma.databaseConnection.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toApi);
}

export async function getDbConnector(projectId: string, id: string) {
  const row = await prisma.databaseConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!row) throw new ConnectorError(404, "DB_CONNECTOR_NOT_FOUND", "database connector not found");
  return toApi(row);
}

export async function createDbConnector(
  projectId: string,
  input: CreateDatabaseConnectorInput,
  actorId: string | null,
) {
  if (!hasDriver(input.driver as DbDriver)) {
    throw new ConnectorError(
      400,
      "DRIVER_UNSUPPORTED",
      `driver '${input.driver}' is not supported`,
    );
  }
  const exists = await prisma.databaseConnection.findFirst({
    where: { projectId, label: input.label, deletedAt: null },
  });
  if (exists) {
    throw new ConnectorError(409, "DB_LABEL_TAKEN", `label '${input.label}' already exists`);
  }
  const secretId = input.secretRef ? extractRefBody(input.secretRef) : null;
  const row = await prisma.databaseConnection.create({
    data: {
      projectId,
      label: input.label,
      driver: input.driver,
      host: input.host ?? null,
      port: input.port ?? null,
      databaseName: input.databaseName ?? null,
      username: input.username ?? null,
      secretId,
      // `options` is already a JSON-encoded string per the shared
      // `createDatabaseConnectorSchema` contract — store it as-is. Re-encoding
      // here double-stringifies the blob, which `parseDbConnectorAllowList`
      // then reads back as a string (not an object) and silently discards,
      // defeating the per-connector allow-list (#880 / #882).
      options: input.options || null,
      status: "pending",
      createdById: actorId,
    },
  });
  audit({
    actor: { id: actorId },
    action: "connector.db.create",
    target: { type: "db_connector", id: row.id },
    metadata: { projectId, driver: row.driver, host: row.host ?? "" },
  });

  // Epic #295 Phase 4 (#307) — best-effort link to the workspace-scoped
  // DatabaseResource registry so the same physical DB across projects dedupes to
  // one resource. NEVER blocks create: a project without a workspace, a
  // connection lacking host/db identity, or any registry error leaves the
  // connection unlinked (the FK is nullable).
  const resourceId = await linkConnectionToResource(row.id, {
    projectId,
    driver: row.driver,
    host: row.host,
    port: row.port,
    databaseName: row.databaseName,
  });
  return toApi(resourceId ? { ...row, databaseResourceId: resourceId } : row);
}

export async function updateDbConnector(
  projectId: string,
  id: string,
  patch: Omit<UpdateDatabaseConnectorInput, "id">,
  actorId: string | null,
) {
  const existing = await prisma.databaseConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) throw new ConnectorError(404, "DB_CONNECTOR_NOT_FOUND", "not found");
  const data: Record<string, unknown> = {};
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.driver !== undefined) {
    if (!hasDriver(patch.driver as DbDriver)) {
      throw new ConnectorError(
        400,
        "DRIVER_UNSUPPORTED",
        `driver '${patch.driver}' is not supported`,
      );
    }
    data.driver = patch.driver;
  }
  if (patch.host !== undefined) data.host = patch.host ?? null;
  if (patch.port !== undefined) data.port = patch.port ?? null;
  if (patch.databaseName !== undefined) data.databaseName = patch.databaseName ?? null;
  if (patch.username !== undefined) data.username = patch.username ?? null;
  if (patch.secretRef !== undefined) {
    data.secretId = patch.secretRef ? extractRefBody(patch.secretRef) : null;
  }
  if (patch.options !== undefined) {
    // Already a JSON-encoded string — see createDbConnector for why we must
    // not re-stringify it.
    data.options = patch.options || null;
  }
  // Mutating connection params invalidates the cached adapter.
  await closeAdapter(id);
  const row = await prisma.databaseConnection.update({ where: { id }, data });
  audit({
    actor: { id: actorId },
    action: "connector.db.update",
    target: { type: "db_connector", id },
    metadata: { projectId, fields: Object.keys(data) },
  });
  return toApi(row);
}

export async function deleteDbConnector(projectId: string, id: string, actorId: string | null) {
  const existing = await prisma.databaseConnection.findFirst({
    where: { id, projectId, deletedAt: null },
  });
  if (!existing) throw new ConnectorError(404, "DB_CONNECTOR_NOT_FOUND", "not found");
  await closeAdapter(id);
  await prisma.databaseConnection.update({
    where: { id },
    data: { deletedAt: new Date(), status: "disabled" },
  });
  audit({
    actor: { id: actorId },
    action: "connector.db.delete",
    target: { type: "db_connector", id },
    metadata: { projectId },
  });
}

// ---- Operations ------------------------------------------------------------

/**
 * Epic #701 / Issue #704 — credential-explicit liveness probe.
 *
 * Opens a one-shot adapter using caller-supplied credentials (host, port,
 * database, username, password) without requiring a saved DatabaseConnection
 * row. Used by the suggested-connector "Test" wizard step so a user can
 * validate a discovery before provisioning a real connector.
 *
 * Enforces the same network allow-list as `acquireAdapter` and always
 * shuts the adapter down before returning.
 */
export async function testDbWithExplicitCredentials(input: {
  driver: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  password: string | null;
  options?: Record<string, unknown>;
}): Promise<{ ok: true; latencyMs: number }> {
  if (!hasDriver(input.driver as DbDriver)) {
    throw new ConnectorError(
      400,
      "DRIVER_UNSUPPORTED",
      `driver '${input.driver}' is not supported`,
    );
  }
  let pinnedAddress: string | undefined;
  let pinnedFamily: 4 | 6 | undefined;
  if (input.host) {
    const pinned = await resolveAndAssertConnectorHost(input.host, "db");
    pinnedAddress = pinned.address;
    pinnedFamily = pinned.family;
  }
  const factory = getDriverFactory(input.driver as DbDriver);
  const adapter = factory();
  await adapter.init({
    driver: input.driver,
    host: input.host,
    port: input.port,
    database: input.database,
    username: input.username,
    password: input.password,
    options: input.options,
    statementTimeoutMs: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    poolMax: DEFAULT_DB_POOL_MAX,
    pinnedAddress,
    pinnedFamily,
  });
  try {
    const latencyMs = await adapter.ping();
    return { ok: true, latencyMs };
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

export async function testDbConnector(projectId: string, id: string, actorId: string) {
  const adapter = await acquireAdapter(projectId, id);
  try {
    emitter().progress({ connectorId: id, projectId, kind: "db", phase: "test", step: "ping" });
    const latencyMs = await adapter.ping();
    await prisma.databaseConnection.update({
      where: { id },
      data: { status: "connected", lastTestedAt: new Date(), errorMessage: null },
    });
    emitter().status({ connectorId: id, kind: "db", status: "connected" });
    audit({
      actor: { id: actorId },
      action: "connector.db.test",
      target: { type: "db_connector", id },
      metadata: { projectId, latencyMs, status: "connected" },
    });
    return { ok: true, latencyMs };
  } catch (err) {
    const ce = toConnectorError(err);
    // #1084 — `errorMessage` is persisted and served by `GET /dbs/:id`, and
    // the same string rides the socket status event. A driver message names
    // the resolved host, port and database, so sanitizing only the HTTP error
    // response would leave the identical leak readable from the connector row.
    const safeMessage = safeDriverMessage(ce);
    await markError(id, safeMessage);
    emitter().status({ connectorId: id, kind: "db", status: "error", errorMessage: safeMessage });
    audit({
      actor: { id: actorId },
      action: "connector.db.test",
      target: { type: "db_connector", id },
      metadata: { projectId, status: "error", code: ce.code },
    });
    throw ce;
  }
}

export async function inspectDbConnector(
  projectId: string,
  id: string,
  actorId: string,
  opts: { schema?: string } = {},
): Promise<DbSchemaSnapshot> {
  const adapter = await acquireAdapter(projectId, id);
  const conn = await getDbConnector(projectId, id);
  const start = Date.now();
  try {
    emitter().progress({
      connectorId: id,
      projectId,
      kind: "db",
      phase: "introspect",
      step: "tables",
    });
    const tables: DbTableInfo[] = await adapter.introspect(opts);

    // Epic #293 Phase 2 (#300) — best-effort routines (procedures & functions)
    // introspection. READ-ONLY: a single parameterized catalog SELECT per
    // dialect; the routine body is never fetched or executed. A routines failure
    // (e.g. a principal lacking catalog grants, or a driver not yet upgraded)
    // must NEVER sink the table introspection, so it is caught and logged.
    let routines: DbRoutineInfo[] = [];
    if (typeof adapter.introspectRoutines === "function") {
      emitter().progress({
        connectorId: id,
        projectId,
        kind: "db",
        phase: "introspect",
        step: "routines",
      });
      try {
        routines = await adapter.introspectRoutines(opts);
      } catch (err) {
        log.warn("routines introspection failed; continuing with tables only", {
          projectId,
          connectorId: id,
          err: (err as Error).message,
        });
      }
    }

    const snapshot: DbSchemaSnapshot = {
      connectorId: id,
      driver: conn.driver,
      schema: opts.schema,
      tables,
      routines,
      extractedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    };
    audit({
      actor: { id: actorId },
      action: "connector.db.inspect",
      target: { type: "db_connector", id },
      metadata: {
        projectId,
        tableCount: tables.length,
        routineCount: routines.length,
        schema: opts.schema ?? "(default)",
      },
    });
    return snapshot;
  } catch (err) {
    const ce = toConnectorError(err);
    audit({
      actor: { id: actorId },
      action: "connector.db.inspect.failed",
      target: { type: "db_connector", id },
      metadata: { projectId, code: ce.code },
    });
    throw ce;
  }
}

/**
 * Wiring fed into {@link ingestCodeGraph} so the SQL-lineage extractors can use a
 * project's live DB schema (#317) and parse routine bodies (#316B).
 */
export interface CodeGraphSchemaWiring {
  /** Introspected schema in the sqlglot shape, or null when none is available. */
  introspectedSchema: IntrospectedSchema | null;
  /** Live routines (procedures & functions) to parse for `calls` edges. */
  routines: DbRoutineInfo[];
  /** READ-ONLY routine-body fetcher bound to the project's DB connector. */
  fetchRoutineBody?: RoutineBodyFetcher;
  /** Dialect hint for routine-body parsing. */
  routineDialect?: string;
  /** Live PL/SQL packages to parse for Tier-2 member-level edges (#893, #953). */
  packages: DbPackageInfo[];
  /** READ-ONLY PL/SQL package-body fetcher bound to the project's DB connector (#953). */
  fetchPackageBody?: PackageBodyFetcher;
  /** Coarse Tier-1 object-dependency rows (Epic #881 Phase 1, #890). */
  dependencies: DbDependencyInfo[];
  /**
   * Epic #882 (#894) — the resolved per-project SQL-lineage decision
   * (`resolveProjectSqlLineage`), threaded straight into `ingestCodeGraph`'s
   * `sqlLineageOverride` so the WHOLE extraction step (per-file SQL/routines
   * AND the Tier-1 dependencies below) shares one gate.
   */
  sqlLineageOverride: boolean;
}

/**
 * Best-effort: build the SQL-lineage wiring for a project's code-graph ingest
 * from its FIRST database connector — Epic #294 (#316/#317), Tier-1
 * dependencies (#890/#894). Introspects the schema + routines + coarse
 * dependency rows (READ-ONLY, reusing {@link inspectDbConnector}) and binds a
 * READ-ONLY routine-body fetcher to that connector's pooled adapter. Also
 * resolves the project's `sqlLineage` setting (#894) — computed BEFORE the
 * "no connector" early-out because the per-project override still gates
 * embedded-SQL/SAS extraction in application code, which needs no DB
 * connector at all.
 *
 * NEVER throws and NEVER blocks ingest: any failure (no DB connector, unreachable
 * DB, missing grants) yields empty wiring so code-graph ingest proceeds exactly as
 * before. The returned `fetchRoutineBody` is itself wrapped to return null on any
 * driver error. Routine bodies are only PARSED downstream — never executed; the
 * dependency catalog rows are only READ, never parsed or executed.
 */
export async function buildCodeGraphSchemaWiring(
  projectId: string,
  actorId: string,
): Promise<CodeGraphSchemaWiring> {
  const sqlLineageOverride = (await resolveProjectSqlLineage(projectId, prisma)).enabled;
  const empty: CodeGraphSchemaWiring = {
    introspectedSchema: null,
    routines: [],
    packages: [],
    dependencies: [],
    sqlLineageOverride,
  };
  try {
    const connectors = await listDbConnectors(projectId);
    if (connectors.length === 0) return empty;
    const connectorId = connectors[0].id;
    const driver = connectors[0].driver;

    const snapshot = await inspectDbConnector(projectId, connectorId, actorId);
    const introspectedSchema = buildIntrospectedSchema(
      snapshot.tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        columns: t.columns.map((c) => ({ name: c.name, dataType: c.dataType })),
      })),
    );
    const routines = snapshot.routines ?? [];

    // Bind a READ-ONLY body fetcher to the same connector. Each call re-acquires
    // the cached adapter and asks the driver for the routine source (parse-only).
    const fetchRoutineBody: RoutineBodyFetcher = async (routine) => {
      try {
        const adapter = await acquireAdapter(projectId, connectorId);
        if (typeof adapter.fetchRoutineBody !== "function") return null;
        return await adapter.fetchRoutineBody(routine);
      } catch {
        return null;
      }
    };

    // Live PL/SQL packages (#891) whose bodies feed Tier-2 member-level lineage
    // (#893, wired into ingest by #953). READ-ONLY: `introspectPackages` is a
    // catalog SELECT only (Oracle-only today). A driver without the method — or
    // a catalog-grant failure — simply yields no packages; never sinks the rest
    // of the wiring. The body fetcher below adapts a `DbPackageInfo` to the
    // driver's `{ schema, name }` shape and is itself wrapped to return null on
    // any error; the body is only PARSED downstream, never executed.
    let packages: DbPackageInfo[] = [];
    try {
      const adapter = await acquireAdapter(projectId, connectorId);
      if (typeof adapter.introspectPackages === "function") {
        packages = await adapter.introspectPackages();
      }
    } catch (err) {
      log.warn("package introspection failed; continuing without Tier-2 package lineage", {
        projectId,
        connectorId,
        err: (err as Error).message,
      });
    }
    const fetchPackageBody: PackageBodyFetcher = async (pkg) => {
      try {
        const adapter = await acquireAdapter(projectId, connectorId);
        if (typeof adapter.fetchPackageBody !== "function") return null;
        return await adapter.fetchPackageBody({ schema: pkg.schema, name: pkg.name });
      } catch {
        return null;
      }
    };

    // Tier-1 coarse object-dependency rows (#890/#894) — READ-ONLY, zero-parse.
    // A driver without `introspectDependencies` (or a catalog-grant failure)
    // simply yields no dependency edges; never sinks the rest of the wiring.
    let dependencies: DbDependencyInfo[] = [];
    try {
      const adapter = await acquireAdapter(projectId, connectorId);
      if (typeof adapter.introspectDependencies === "function") {
        dependencies = await adapter.introspectDependencies();
      }
    } catch (err) {
      log.warn("dependency introspection failed; continuing without Tier-1 lineage edges", {
        projectId,
        connectorId,
        err: (err as Error).message,
      });
    }

    return {
      introspectedSchema,
      routines,
      fetchRoutineBody,
      routineDialect: driver,
      packages,
      fetchPackageBody,
      dependencies,
      sqlLineageOverride,
    };
  } catch {
    return empty;
  }
}

export async function queryDbConnector(
  projectId: string,
  id: string,
  actorId: string,
  rawSql: string,
): Promise<DbQueryResult> {
  const conn = await getDbConnector(projectId, id);
  // Per-connector allow-list (issue #882) narrows the blast radius beyond the
  // read-only guarantee. Absent allow-list ⇒ allow-all; an explicit empty list
  // ⇒ fail-closed (see parseDbConnectorAllowList).
  const allowList = parseDbConnectorAllowList(conn.options);
  const validated = validateSelectOnly(rawSql, conn.driver, allowList ? { allowList } : {});
  const adapter = await acquireAdapter(projectId, id);
  try {
    const response = await adapter.query({
      sql: validated.sql,
      maxRows: QUERY_DB_MAX_ROWS,
      statementTimeoutMs: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    });
    const safeRows = redactRows(response.rows as Record<string, unknown>[]);
    audit({
      actor: { id: actorId },
      action: "connector.db.query",
      target: { type: "db_connector", id },
      metadata: {
        projectId,
        sqlPreview: rawSql.slice(0, 120),
        rowCount: response.rowCount,
        truncated: response.truncated,
        appliedLimit: validated.appliedLimit,
        durationMs: response.durationMs,
      },
    });
    return {
      columns: response.columns,
      rows: safeRows,
      rowCount: response.rowCount,
      truncated: response.truncated,
      durationMs: response.durationMs,
    };
  } catch (err) {
    const ce = toConnectorError(err);
    audit({
      actor: { id: actorId },
      action: "connector.db.query.failed",
      target: { type: "db_connector", id },
      metadata: {
        projectId,
        sqlPreview: rawSql.slice(0, 120),
        code: ce.code,
      },
    });
    throw ce;
  }
}

// ---- Pool management -------------------------------------------------------

export async function closeAdapter(id: string): Promise<void> {
  const entry = adapterPool.get(id);
  if (!entry) return;
  await entry.adapter.close().catch(() => undefined);
  adapterPool.delete(id);
}

export async function closeAllAdapters(): Promise<void> {
  for (const id of [...adapterPool.keys()]) {
    await closeAdapter(id);
  }
}

async function acquireAdapter(projectId: string, id: string): Promise<DbDriverAdapter> {
  const conn = await getDbConnector(projectId, id);
  const password = await resolveSecret(conn.secretRef);
  const fingerprint = JSON.stringify({
    d: conn.driver,
    h: conn.host,
    p: conn.port,
    db: conn.databaseName,
    u: conn.username,
    pw: password ? hashCheck(password) : "",
    o: conn.options,
  });
  const cached = adapterPool.get(id);
  if (cached && cached.fingerprint === fingerprint) return cached.adapter;
  if (cached) await closeAdapter(id);

  let pinnedAddress: string | undefined;
  let pinnedFamily: 4 | 6 | undefined;
  if (conn.host) {
    const pinned = await resolveAndAssertConnectorHost(conn.host, "db");
    pinnedAddress = pinned.address;
    pinnedFamily = pinned.family;
  }
  const factory = getDriverFactory(conn.driver as DbDriver);
  const adapter = factory();
  await adapter.init({
    driver: conn.driver,
    host: conn.host,
    port: conn.port,
    database: conn.databaseName,
    username: conn.username,
    password,
    options: conn.options ? safeJsonParse(conn.options) : undefined,
    statementTimeoutMs: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    introspectTimeoutMs: DEFAULT_DB_INTROSPECT_TIMEOUT_MS,
    poolMax: DEFAULT_DB_POOL_MAX,
    pinnedAddress,
    pinnedFamily,
  });
  adapterPool.set(id, { adapter, fingerprint });
  return adapter;
}

async function resolveSecret(secretRef: string): Promise<string | null> {
  if (!secretRef) return null;
  const vault = getVaultService();
  return resolveVaultRef(secretRef, vault);
}

/**
 * Issue #1084 — client-safe replacement for a driver / allow-list message.
 * The raw string stays in the server log; anything not driver-derived (a
 * validation or not-found message) is passed through untouched.
 */
function safeDriverMessage(err: ConnectorError): string {
  if (!isDriverDetailCode(err.code)) return err.message;
  log.warn("db connector driver error sanitized before persistence", {
    code: err.code,
    rawError: err.message,
  });
  return sanitizeDriverError(err.code, err.message).errorMessage;
}

async function markError(id: string, errorMessage: string): Promise<void> {
  await prisma.databaseConnection.update({
    where: { id },
    data: { status: "error", errorMessage, lastTestedAt: new Date() },
  });
}

function toApi(row: {
  id: string;
  projectId: string;
  label: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  username: string | null;
  secretId: string | null;
  options: string | null;
  status: string;
  errorMessage: string | null;
  lastTestedAt: Date | null;
  lastIngestAt: Date | null;
  createdById: string | null;
  // Epic #295 Phase 4 (#307) — link to the workspace-scoped DatabaseResource.
  databaseResourceId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    driver: row.driver,
    host: row.host,
    port: row.port,
    databaseName: row.databaseName,
    username: row.username,
    // Plaintext NEVER crosses the API. Surface only the vault ref pattern.
    secretRef: row.secretId ? `\${vault:${row.secretId}}` : "",
    options: row.options,
    status: row.status,
    errorMessage: row.errorMessage,
    lastTestedAt: row.lastTestedAt,
    lastIngestAt: row.lastIngestAt,
    createdById: row.createdById,
    databaseResourceId: row.databaseResourceId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function extractRefBody(ref: string): string | null {
  const m = /^\$\{vault:([^}]+)\}$/.exec(ref);
  if (!m) {
    throw new ConnectorError(
      400,
      "VAULT_REF_INVALID",
      "secretRef must be `${vault:label}` or empty",
    );
  }
  return m[1];
}

function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  return new ConnectorError(500, "INTERNAL", (err as Error).message ?? "internal error");
}

function safeJsonParse(s: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (err) {
    log.warn("connector options JSON parse failed", { err: (err as Error).message });
    return undefined;
  }
}

/** Constant-time-ish hash to detect password changes without storing it. */
function hashCheck(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

/** Test helper — drop pool + service deps. */
export function __resetDbConnectorService(): void {
  adapterPool.clear();
  depsRef = {};
}
