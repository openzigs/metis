/**
 * Reads the schema inventory for a project (#1061): live introspection of every
 * database connector, then the schema graph a database document stored, then
 * the code graph's SQL symbols. See `schema-inventory.ts` for what each tier is
 * trusted for.
 *
 * Nothing here throws. A source that fails is logged and the next one is tried;
 * with none, the inventory is `none` and the section says so.
 */
import type { DbTableInfo } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { inspectDbConnector, listDbConnectors } from "../connectors/db/db-service.js";
import {
  byQualifiedName,
  NO_SCHEMA_INVENTORY,
  tablesFromIntrospection,
  tablesFromRepositorySql,
  tablesFromSchemaGraph,
  type RepositorySqlSymbol,
  type SchemaInventory,
  type SchemaInventoryTable,
} from "./schema-inventory.js";

const log = createChildLogger("docs-gen:schema-inventory");

export interface SchemaInventoryDeps {
  listConnectors: (projectId: string) => Promise<Array<{ id: string; label?: string | null }>>;
  introspect: (projectId: string, connectorId: string, actorId: string) => Promise<DbTableInfo[]>;
  /** Stored schema graphs of the project's database documents, newest first. */
  readSchemaGraphs: (
    projectId: string,
  ) => Promise<Array<{ dbConnectorId: string | null; graph: unknown; generatedAt: Date | null }>>;
  readRepositorySql: (projectId: string, codeGraphId?: string) => Promise<RepositorySqlSymbol[]>;
}

/** How long one live introspection may take before the stored graph is used. */
export const LIVE_INTROSPECTION_TIMEOUT_MS = 30_000;
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

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function dateLabel(date: Date | null): string {
  return date ? ` generated ${date.toISOString().slice(0, 10)}` : "";
}

/**
 * Resolve the schema inventory for one project. `actorId` is the user the
 * generation runs as (the introspection is audited to them); without one the
 * live tier is skipped. `codeGraphId` narrows the repository-SQL tier to one
 * repository for a repository-scoped document.
 */
export async function loadSchemaInventory(
  input: { projectId: string; actorId?: string; codeGraphId?: string; timeoutMs?: number },
  deps: SchemaInventoryDeps = defaultDeps,
): Promise<SchemaInventory> {
  const { projectId, actorId, codeGraphId } = input;
  const timeoutMs = input.timeoutMs ?? LIVE_INTROSPECTION_TIMEOUT_MS;
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

  const connectors = await safely("listing connectors", () => deps.listConnectors(projectId), []);
  const graphs = await safely("reading schema graphs", () => deps.readSchemaGraphs(projectId), []);

  const tables: SchemaInventoryTable[] = [];
  const liveLabels: string[] = [];
  const storedLabels: string[] = [];
  let unread = 0;
  for (const connector of connectors) {
    const name = connector.label?.trim() || connector.id;
    const live = actorId
      ? await safely<DbTableInfo[] | null>(
          "live introspection",
          () => withTimeout(deps.introspect(projectId, connector.id, actorId), timeoutMs),
          null,
        )
      : null;
    if (live) {
      tables.push(...tablesFromIntrospection(live));
      liveLabels.push(`"${name}"`);
      continue;
    }
    const stored = graphs.find((entry) => entry.dbConnectorId === connector.id);
    const storedTables = stored ? tablesFromSchemaGraph(stored.graph) : [];
    if (stored && storedTables.length > 0) {
      tables.push(...storedTables);
      storedLabels.push(`"${name}"${dateLabel(stored.generatedAt)}`);
    } else {
      unread += 1;
    }
  }
  // No connector left, but a database document's graph was kept.
  if (connectors.length === 0) {
    const seen = new Set<string>();
    for (const entry of graphs) {
      const key = entry.dbConnectorId ?? "";
      if (seen.has(key)) continue;
      const storedTables = tablesFromSchemaGraph(entry.graph);
      if (storedTables.length === 0) continue;
      seen.add(key);
      tables.push(...storedTables);
      storedLabels.push(`a database document${dateLabel(entry.generatedAt)}`);
    }
  }

  if (tables.length > 0) {
    const parts: string[] = [];
    if (liveLabels.length > 0) parts.push(`the live schema of ${liveLabels.join(", ")}`);
    if (storedLabels.length > 0) {
      parts.push(`the stored schema graph of ${storedLabels.join(", ")}`);
    }
    if (unread > 0) parts.push(`${unread} further database(s) could not be read`);
    return {
      source: storedLabels.length > 0 ? "schema-graph" : "live-schema",
      label: parts.join("; "),
      current: storedLabels.length === 0 && unread === 0,
      tables: tables.sort(byQualifiedName),
    };
  }

  const symbols = await safely(
    "reading repository SQL",
    () => deps.readRepositorySql(projectId, codeGraphId),
    [],
  );
  const repositoryTables = tablesFromRepositorySql(symbols);
  if (repositoryTables.length > 0) {
    return {
      source: "repository-sql",
      label: "the SQL found in the repository (migrations, queries and mappings)",
      current: false,
      tables: repositoryTables.sort(byQualifiedName),
    };
  }
  return NO_SCHEMA_INVENTORY;
}
