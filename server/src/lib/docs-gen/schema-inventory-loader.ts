/**
 * Reads the schema inventory for a project (#1061): live introspection of every
 * database connector, then the schema graph a database document stored, then
 * the code graph's SQL symbols. See `schema-inventory.ts` for what each tier is
 * trusted for, and for why a live read is recorded per connector and schema
 * instead of as one "current" flag.
 *
 * Nothing here throws. A source that fails is logged and the next one is tried;
 * with none, the inventory is `none` and the section says so.
 *
 * ## Time, and what happens to a read that is given up on
 *
 * Connectors are introspected concurrently, at most
 * {@link LIVE_INTROSPECTION_CONCURRENCY} at a time. Each has
 * {@link LIVE_INTROSPECTION_TIMEOUT_MS}, and all of them together have
 * {@link SCHEMA_LOAD_DEADLINE_MS}: past it, a connector that has not answered
 * (or not been started) is treated as not readable now. The generation's
 * `AbortSignal` ends the wait at once, and the loader then returns the empty
 * inventory for the caller to discard.
 *
 * An introspection that is given up on is NOT cancelled, because
 * `inspectDbConnector` takes no signal. The driver's catalog query keeps its
 * pooled connection until it returns or reaches the driver's own introspection
 * timeout (`DEFAULT_DB_INTROSPECT_TIMEOUT_MS`), it still writes its
 * `connector.db.inspect` audit row, and its result is dropped. One generation
 * leaves at most {@link LIVE_INTROSPECTION_CONCURRENCY} of those behind: a
 * worker that gives up on a read, at its own limit or at the deadline, starts
 * no other, so each worker abandons one at most. The connectors it would have
 * read next count as not read now.
 *
 * ## What a live read does not prove
 *
 * See `schema-inventory.ts`: one schema, only what the role may see, and on
 * Oracle at most {@link ORACLE_INTROSPECTION_ROW_CAP} rows. A read that
 * reached that cap is recorded as `possiblyTruncated`.
 */
import type { DbTableInfo } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { inspectDbConnector, listDbConnectors } from "../connectors/db/db-service.js";
import {
  byQualifiedName,
  NO_SCHEMA_INVENTORY,
  plainConnectorLabel,
  schemaNamesOf,
  tablesFromIntrospection,
  tablesFromRepositorySql,
  tablesFromSchemaGraph,
  type RepositorySqlSymbol,
  type SchemaInventory,
  type SchemaInventoryRead,
  type SchemaInventoryTable,
} from "./schema-inventory.js";

const log = createChildLogger("docs-gen:schema-inventory");

export interface SchemaInventoryDeps {
  listConnectors: (
    projectId: string,
  ) => Promise<Array<{ id: string; label?: string | null; driver?: string | null }>>;
  /**
   * One connector's tables. Called without a schema, so the driver reads its
   * default schema only — exactly what the database document reads.
   */
  introspect: (projectId: string, connectorId: string, actorId: string) => Promise<DbTableInfo[]>;
  /** Stored schema graphs of the project's database documents, newest first. */
  readSchemaGraphs: (
    projectId: string,
  ) => Promise<Array<{ dbConnectorId: string | null; graph: unknown; generatedAt: Date | null }>>;
  readRepositorySql: (projectId: string, codeGraphId?: string) => Promise<RepositorySqlSymbol[]>;
}

/** How long one live introspection may take before the stored graph is used. */
export const LIVE_INTROSPECTION_TIMEOUT_MS = 30_000;
/** How long ALL live introspections of one load may take together. */
export const SCHEMA_LOAD_DEADLINE_MS = 45_000;
/** How many connectors are introspected at once. */
export const LIVE_INTROSPECTION_CONCURRENCY = 4;
/**
 * The Oracle driver's introspection limit: `maxRows: 10_000` in
 * `connectors/db/drivers/oracle.ts`, one row per column (more when a column is
 * in several foreign keys), applied without an error. Kept in step with the
 * driver by a test that reads the driver's source.
 */
export const ORACLE_INTROSPECTION_ROW_CAP = 10_000;

/**
 * A lower bound on the rows an introspection returned for `tables`: one per
 * column, and one more for each further foreign key a column is in. The driver
 * does not report its row count, so this is the nearest the loader can get; a
 * read that was cut can still fall under it.
 */
export function introspectionRowsAtLeast(tables: readonly DbTableInfo[]): number {
  let rows = 0;
  for (const table of tables) {
    const keysPerColumn = new Map<string, number>();
    for (const fk of table.foreignKeys ?? []) {
      for (const column of fk.columns) {
        keysPerColumn.set(column, (keysPerColumn.get(column) ?? 0) + 1);
      }
    }
    for (const column of table.columns) rows += Math.max(1, keysPerColumn.get(column.name) ?? 0);
  }
  return rows;
}

/** Upper bound on code-graph schema symbols read for the repository-SQL tier. */
const MAX_REPOSITORY_SQL_SYMBOLS = 50_000;

const defaultDeps: SchemaInventoryDeps = {
  listConnectors: (projectId) => listDbConnectors(projectId),
  introspect: async (projectId, connectorId, actorId) =>
    (await inspectDbConnector(projectId, connectorId, actorId)).tables,
  readSchemaGraphs: async (projectId) => {
    const docs = await prisma.generatedDocument.findMany({
      where: { projectId, scope: "database", deletedAt: null, schemaGraph: { not: null } },
      orderBy: { generatedAt: "desc" },
      select: { scopeFilter: true, schemaGraph: true, generatedAt: true },
    });
    return docs.map((doc) => {
      let dbConnectorId: string | null = null;
      let graph: unknown = null;
      try {
        const filter = JSON.parse(doc.scopeFilter) as { dbConnectorId?: unknown };
        if (typeof filter.dbConnectorId === "string") dbConnectorId = filter.dbConnectorId;
        graph = JSON.parse(doc.schemaGraph ?? "null");
      } catch {
        // A row that does not parse contributes nothing.
      }
      return { dbConnectorId, graph, generatedAt: doc.generatedAt };
    });
  },
  readRepositorySql: (projectId, codeGraphId) =>
    prisma.codeSymbol.findMany({
      where: {
        projectId,
        kind: { in: ["table", "column"] },
        ...(codeGraphId ? { codeGraphId } : {}),
      },
      select: { kind: true, name: true, qualifiedName: true },
      orderBy: { qualifiedName: "asc" },
      take: MAX_REPOSITORY_SQL_SYMBOLS,
    }),
};

/** Named, so the log (which records the class only) says what happened. */
class IntrospectionTimeout extends Error {
  override name = "IntrospectionTimeout";
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IntrospectionTimeout(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Marks a wait that was ended by the deadline or by the generation's signal. */
const GIVEN_UP = Symbol("given-up");
/** Marks a read that ran past its own limit. */
const TIMED_OUT = Symbol("timed-out");

export interface LoadSchemaInventoryInput {
  projectId: string;
  /** The user the introspection is audited to; without one the live tier is skipped. */
  actorId?: string;
  /** Narrows the repository-SQL tier to one repository's code graph. */
  codeGraphId?: string;
  /** Per-connector limit. Default {@link LIVE_INTROSPECTION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Limit for all live introspections together. Default {@link SCHEMA_LOAD_DEADLINE_MS}. */
  deadlineMs?: number;
  /** Connectors read at once. Default {@link LIVE_INTROSPECTION_CONCURRENCY}. */
  concurrency?: number;
  /** The generation's signal: aborting it ends the load at once. */
  signal?: AbortSignal;
}

/**
 * Resolve the schema inventory for one project. Never throws; when `signal` is
 * aborted it returns the empty inventory without waiting for anything.
 */
export async function loadSchemaInventory(
  input: LoadSchemaInventoryInput,
  deps: SchemaInventoryDeps = defaultDeps,
): Promise<SchemaInventory> {
  const { projectId, actorId, codeGraphId, signal } = input;
  const timeoutMs = input.timeoutMs ?? LIVE_INTROSPECTION_TIMEOUT_MS;
  const deadlineMs = input.deadlineMs ?? SCHEMA_LOAD_DEADLINE_MS;
  const concurrency = Math.max(1, input.concurrency ?? LIVE_INTROSPECTION_CONCURRENCY);

  const safely = async <T>(what: string, work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      // The class only: a driver message names the host, port and database.
      log.warn(`Schema inventory: ${what} failed`, {
        projectId,
        error: err instanceof Error ? err.name : "unknown",
      });
      return fallback;
    }
  };

  // Two ways a wait ends early. `aborted` ends every wait; `expired` ends the
  // live introspections only (the other reads are this server's own database).
  let release: (value: typeof GIVEN_UP) => void = () => undefined;
  const aborted = new Promise<typeof GIVEN_UP>((resolve) => (release = resolve));
  const onAbort = (): void => release(GIVEN_UP);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let expire: (value: typeof GIVEN_UP) => void = () => undefined;
  const expired = new Promise<typeof GIVEN_UP>((resolve) => (expire = resolve));
  let pastDeadline = false;
  const deadline = setTimeout(() => {
    pastDeadline = true;
    expire(GIVEN_UP);
  }, deadlineMs);
  const unlessAborted = <T>(work: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([work, aborted.then(() => fallback)]);

  try {
    const [connectors, graphs] = await Promise.all([
      unlessAborted(
        safely("listing connectors", () => deps.listConnectors(projectId), []),
        [],
      ),
      unlessAborted(
        safely("reading schema graphs", () => deps.readSchemaGraphs(projectId), []),
        [],
      ),
    ]);
    if (signal?.aborted) return NO_SCHEMA_INVENTORY;

    // Live tier: a bounded pool, in connector order. `null` is "not read now".
    const live: Array<DbTableInfo[] | null> = connectors.map(() => null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (actorId && next < connectors.length && !pastDeadline && !signal?.aborted) {
        const at = next++;
        const answer = await safely<DbTableInfo[] | typeof GIVEN_UP | typeof TIMED_OUT | null>(
          "live introspection",
          () =>
            Promise.race([
              withTimeout(deps.introspect(projectId, connectors[at].id, actorId), timeoutMs).catch(
                (err: unknown) => {
                  if (err instanceof IntrospectionTimeout) return TIMED_OUT;
                  throw err;
                },
              ),
              expired,
              aborted,
            ]),
          null,
        );
        // Given up on, and still running in the driver: this worker starts no
        // other read, which is what bounds the abandoned ones to one per worker.
        if (answer === GIVEN_UP || answer === TIMED_OUT) {
          if (!signal?.aborted) {
            log.warn("Schema inventory: live introspection abandoned", {
              projectId,
              at: answer === TIMED_OUT ? "its own limit" : "the load deadline",
            });
          }
          return;
        }
        live[at] = answer;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, connectors.length) }, worker));
    if (signal?.aborted) return NO_SCHEMA_INVENTORY;

    const tables: SchemaInventoryTable[] = [];
    const reads: SchemaInventoryRead[] = [];
    connectors.forEach((connector, at) => {
      const name = plainConnectorLabel(connector.label?.trim() || connector.id) || "database";
      const read = reads.length;
      // A read that returned no tables proves nothing: it is what a role
      // without grants gets. It is not "live", whatever came back beside it.
      const liveTables = tablesFromIntrospection(live[at] ?? [], read);
      if (liveTables.length > 0) {
        tables.push(...liveTables);
        const atCap =
          connector.driver === "oracle" &&
          introspectionRowsAtLeast(live[at] ?? []) >= ORACLE_INTROSPECTION_ROW_CAP;
        reads.push({
          connector: name,
          how: "live",
          schemas: schemaNamesOf(liveTables),
          ...(atCap ? { possiblyTruncated: true } : {}),
        });
        return;
      }
      const stored = graphs.find((entry) => entry.dbConnectorId === connector.id);
      const storedTables = stored ? tablesFromSchemaGraph(stored.graph, read) : [];
      if (stored && storedTables.length > 0) {
        tables.push(...storedTables);
        reads.push(storedRead(name, storedTables, stored.generatedAt));
        return;
      }
      reads.push({ connector: name, how: "unread", schemas: [] });
    });
    // No connector left, but a database document's graph was kept.
    if (connectors.length === 0) {
      const seen = new Set<string>();
      for (const entry of graphs) {
        const key = entry.dbConnectorId ?? "";
        if (seen.has(key)) continue;
        const storedTables = tablesFromSchemaGraph(entry.graph, reads.length);
        if (storedTables.length === 0) continue;
        seen.add(key);
        tables.push(...storedTables);
        reads.push(storedRead("a database document", storedTables, entry.generatedAt));
      }
    }

    if (tables.length > 0) {
      return {
        source: reads.some((read) => read.how === "stored") ? "schema-graph" : "live-schema",
        label: inventoryLabel(reads),
        reads,
        tables: tables.sort(byQualifiedName),
      };
    }

    const symbols = await unlessAborted(
      safely("reading repository SQL", () => deps.readRepositorySql(projectId, codeGraphId), []),
      [],
    );
    if (signal?.aborted) return NO_SCHEMA_INVENTORY;
    const repositoryTables = tablesFromRepositorySql(symbols);
    if (repositoryTables.length > 0) {
      // The databases that could not be read stay on the record, so the prompt
      // and the section still say that the project has some.
      return {
        source: "repository-sql",
        label:
          "the SQL found in the repository (migrations, queries and mappings)" +
          (reads.length > 0 ? `; ${reads.length} database(s) could not be read` : ""),
        reads,
        tables: repositoryTables.sort(byQualifiedName),
      };
    }
    return NO_SCHEMA_INVENTORY;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  }
}

function storedRead(
  connector: string,
  tables: readonly SchemaInventoryTable[],
  generatedAt: Date | null,
): SchemaInventoryRead {
  return {
    connector,
    how: "stored",
    schemas: schemaNamesOf(tables),
    ...(generatedAt ? { storedOn: generatedAt.toISOString().slice(0, 10) } : {}),
  };
}

/** `"miniflux-pg" (public)`: the connector and the schemas that were read of it. */
function named(read: SchemaInventoryRead): string {
  const quoted = read.connector === "a database document" ? read.connector : `"${read.connector}"`;
  const schemas = read.schemas.map(plainConnectorLabel).filter(Boolean);
  return schemas.length > 0 ? `${quoted} (${schemas.join(", ")})` : quoted;
}

/**
 * Where the inventory came from, in the words the section and its notes use.
 * It names the schemas, because "the live schema of X" would otherwise read as
 * the whole database when only its default schema was read.
 */
function inventoryLabel(reads: readonly SchemaInventoryRead[]): string {
  const live = reads.filter((read) => read.how === "live");
  const stored = reads.filter((read) => read.how === "stored");
  const unread = reads.filter((read) => read.how === "unread").length;
  const parts: string[] = [];
  if (live.length > 0) parts.push(`the live schema of ${live.map(named).join(", ")}`);
  if (stored.length > 0) {
    parts.push(
      `the stored schema graph of ${stored
        .map((read) => `${named(read)}${read.storedOn ? ` generated ${read.storedOn}` : ""}`)
        .join(", ")}`,
    );
  }
  if (unread > 0) parts.push(`${unread} further database(s) could not be read`);
  return parts.join("; ");
}
