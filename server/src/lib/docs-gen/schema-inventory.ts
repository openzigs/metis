/**
 * The schema inventory the architecture document's Data Architecture section is
 * grounded in (#1061).
 *
 * Run 7 of the walkthrough wrote that section from prose facts alone and named
 * tables and columns that do not exist (`jobs`, `ENTRY_TAGS`,
 * `feeds.error_counter`, `certificate_cache` for `acme_cache`). The database
 * document never had that problem, because it is rendered from introspection.
 * This module gives the architecture document the same sources, read through
 * the same readers, and adds no schema reader of its own:
 *
 *   1. **live schema** — `inspectDbConnector`, the call the database document
 *      makes, for every database connector of the project;
 *   2. **schema graph** — the `SchemaGraph` a database document persisted, for
 *      a connector that cannot be read now;
 *   3. **repository SQL** — the `table` / `column` symbols the code graph holds
 *      from migrations, queries and ORM mappings. Names only, no types, and it
 *      can include objects a later migration dropped.
 *
 * ## "Read live" does not mean "read completely"
 *
 * A live introspection is NOT a complete list of a database's tables and
 * columns, and no driver here gives a per-table proof that it is:
 *
 *  - it reads ONE schema per database: the driver's default (`public` on
 *    Postgres, `dbo` on SQL Server, the connected database on MySQL, the
 *    connected user's on Oracle), which is also all the database document reads;
 *  - it can return no tables without an error, which is what a role without
 *    grants gets;
 *  - on PostgreSQL, MySQL and SQL Server the `information_schema` column
 *    queries list only the columns the connecting role has a privilege on, so
 *    with column-level grants (or a column-level DENY) a real column is absent
 *    from a table that was returned;
 *  - on Oracle the introspection is cut at `maxRows: 10_000`, one row per
 *    column, without an error (`connectors/db/drivers/oracle.ts`): the last
 *    table returned has a prefix of its columns and every later table is
 *    missing.
 *
 * So the inventory carries no "current" or "complete" flag. It records, per
 * database connector, HOW it was read, WHICH schemas returned tables and
 * whether the read may have been cut short ({@link SchemaInventoryRead}); that
 * record is what the prompt's coverage statement and the section's note say.
 * A connector that returned nothing is `unread`.
 *
 * It is also why the claim check (`schema-claim-check.ts`) only MARKS: nothing
 * in a section is removed or rewritten on the strength of a name being absent
 * from this inventory.
 *
 * This file is the pure half: the inventory's shape, the conversions into it
 * and what is rendered from it. Reading the sources is
 * `schema-inventory-loader.ts`, kept apart so the synthesizer does not load the
 * connector stack.
 */
import type { DbTableInfo, SchemaGraph } from "@metis/shared";
import { DYNAMIC_PLACEHOLDER_PREFIX } from "../code-graph/schema-graph.js";
import {
  breakAutolinks,
  buildErDiagram,
  MAX_TABLES_ER,
  renderColumnTable,
} from "./schema-render.js";

export type SchemaInventorySource = "live-schema" | "schema-graph" | "repository-sql" | "none";

export interface SchemaInventoryColumn {
  name: string;
  /** Empty for `repository-sql`, which carries no types. */
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  defaultValue?: string | null;
}

export interface SchemaInventoryForeignKey {
  name: string;
  columns: string[];
  refTable: string;
}

export interface SchemaInventoryTable {
  schema: string;
  name: string;
  columns: SchemaInventoryColumn[];
  foreignKeys: SchemaInventoryForeignKey[];
  /** Index into {@link SchemaInventory.reads}; absent for repository SQL. */
  read?: number;
}

/**
 * What was read of ONE database connector in this run.
 *
 *  - `live` — introspected now, and it returned at least one table;
 *  - `stored` — not readable now; a database document's stored graph is used;
 *  - `unread` — nothing is known about it: the introspection failed, ran out
 *    of time, had no user to run as, or returned no tables, and no graph is
 *    stored.
 */
export interface SchemaInventoryRead {
  /** The connector's label, safe to write into a prompt or a document. */
  connector: string;
  how: "live" | "stored" | "unread";
  /**
   * The schemas that returned at least one table. A schema that is not listed
   * was NOT read: nothing may be concluded about a name qualified with it.
   */
  schemas: string[];
  /** For `stored`: the day the graph was generated, when known. */
  storedOn?: string;
  /**
   * For `live`: the read reached the driver's row limit, so it may have been
   * cut short (Oracle; see `ORACLE_INTROSPECTION_ROW_CAP` in the loader).
   * Tables and columns can then be missing from it.
   */
  possiblyTruncated?: boolean;
}

/**
 * Plain data only (no Map, no Date): the Data Architecture section group
 * carries it, and the group is hashed into the section's reuse inputs, so a
 * schema change rewrites the section and an unchanged schema does not.
 */
export interface SchemaInventory {
  source: SchemaInventorySource;
  /** Where it came from, in words a reader of the document understands. */
  label: string;
  /** One entry per database connector; empty for repository SQL and `none`. */
  reads: SchemaInventoryRead[];
  tables: SchemaInventoryTable[];
}

export const NO_SCHEMA_INVENTORY: SchemaInventory = {
  source: "none",
  label: "no schema source",
  reads: [],
  tables: [],
};

/** Whether the inventory carries column types and keys (live or stored graph). */
export function isTypedInventory(inventory: SchemaInventory): boolean {
  return (
    inventory.tables.length > 0 &&
    (inventory.source === "live-schema" || inventory.source === "schema-graph")
  );
}

/** The distinct, non-empty schema names of `tables`, sorted. */
export function schemaNamesOf(tables: readonly Pick<SchemaInventoryTable, "schema">[]): string[] {
  return [...new Set(tables.map((table) => table.schema).filter(Boolean))].sort();
}

export function byQualifiedName(a: SchemaInventoryTable, b: SchemaInventoryTable): number {
  const left = `${a.schema}.${a.name}`;
  const right = `${b.schema}.${b.name}`;
  if (left !== right) return left < right ? -1 : 1;
  return (a.read ?? -1) - (b.read ?? -1);
}

/** Introspected tables, reduced to what the section reads (no row counts). */
export function tablesFromIntrospection(
  tables: readonly DbTableInfo[],
  read?: number,
): SchemaInventoryTable[] {
  return tables.map((table) => ({
    schema: table.schema ?? "",
    name: table.name,
    columns: table.columns.map((col) => ({
      name: col.name,
      dataType: col.dataType,
      nullable: col.nullable,
      isPrimaryKey: col.isPrimaryKey,
      isForeignKey: col.isForeignKey,
      ...(col.defaultValue != null ? { defaultValue: col.defaultValue } : {}),
    })),
    foreignKeys: (table.foreignKeys ?? []).map((fk) => ({
      name: fk.name,
      columns: [...fk.columns],
      refTable: fk.refTable,
    })),
    ...(read == null ? {} : { read }),
  }));
}

/** A persisted {@link SchemaGraph}, or `[]` when the stored JSON is not one. */
export function tablesFromSchemaGraph(graph: unknown, read?: number): SchemaInventoryTable[] {
  const candidate = graph as Partial<SchemaGraph> | null;
  if (!candidate || !Array.isArray(candidate.tables)) return [];
  const edges = Array.isArray(candidate.edges) ? candidate.edges : [];
  const nameOf = new Map<string, string>();
  for (const table of candidate.tables) {
    if (table && typeof table.name === "string") nameOf.set(table.id, table.name);
  }
  const out: SchemaInventoryTable[] = [];
  for (const table of candidate.tables) {
    if (!table || typeof table.name !== "string" || !Array.isArray(table.columns)) continue;
    out.push({
      schema: typeof table.schema === "string" ? table.schema : "",
      name: table.name,
      columns: table.columns
        .filter((col) => col && typeof col.name === "string")
        .map((col) => ({
          name: col.name,
          dataType: typeof col.dataType === "string" ? col.dataType : "",
          nullable: col.nullable !== false,
          isPrimaryKey: col.isPrimaryKey === true,
          isForeignKey: col.isForeignKey === true,
        })),
      foreignKeys: edges
        .filter((edge) => edge && edge.source === table.id && Array.isArray(edge.columns))
        .map((edge) => {
          const target = String(edge.target);
          const refTable = nameOf.get(target) ?? target.slice(target.lastIndexOf(".") + 1);
          return {
            name: `${table.name}_${edge.columns.join("_")}_fkey`,
            columns: [...edge.columns],
            refTable,
          };
        }),
      ...(read == null ? {} : { read }),
    });
  }
  return out;
}

/** Schemas that describe the database engine, not the application. */
const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog", "sys", "mysql"]);

export interface RepositorySqlSymbol {
  kind: string;
  name: string;
  qualifiedName: string;
}

/** The code graph's `table` / `column` symbols as untyped tables. */
export function tablesFromRepositorySql(
  symbols: readonly RepositorySqlSymbol[],
): SchemaInventoryTable[] {
  const tables = new Map<string, SchemaInventoryTable>();
  // Column names seen per table: one membership test per symbol, not a scan of
  // the table's columns, which was quadratic on one wide table (#1061 review).
  const seen = new Map<SchemaInventoryTable, Set<string>>();
  const tableFor = (qualified: string): SchemaInventoryTable | null => {
    if (!qualified || qualified.startsWith(DYNAMIC_PLACEHOLDER_PREFIX)) return null;
    const dot = qualified.lastIndexOf(".");
    const schema = dot >= 0 ? qualified.slice(0, dot) : "";
    if (SYSTEM_SCHEMAS.has(schema.toLowerCase())) return null;
    let table = tables.get(qualified);
    if (!table) {
      table = { schema, name: qualified.slice(dot + 1), columns: [], foreignKeys: [] };
      tables.set(qualified, table);
      seen.set(table, new Set());
    }
    return table;
  };
  for (const symbol of symbols) {
    if (symbol.kind === "table") tableFor(symbol.qualifiedName);
  }
  for (const symbol of symbols) {
    if (symbol.kind !== "column") continue;
    const suffix = `.${symbol.name}`;
    if (!symbol.qualifiedName.endsWith(suffix)) continue;
    const table = tableFor(symbol.qualifiedName.slice(0, -suffix.length));
    if (!table || symbol.name.startsWith(DYNAMIC_PLACEHOLDER_PREFIX)) continue;
    const names = seen.get(table)!;
    if (names.has(symbol.name)) continue;
    names.add(symbol.name);
    table.columns.push({
      name: symbol.name,
      dataType: "",
      nullable: true,
      isPrimaryKey: false,
      isForeignKey: false,
    });
  }
  for (const table of tables.values()) {
    table.columns.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return [...tables.values()];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Characters of schema the section prompt may carry (about 6k tokens). */
export const SCHEMA_PROMPT_MAX_CHARS = 24_000;
/** Characters of column tables the rendered reference may add to the section. */
export const SCHEMA_REFERENCE_MAX_CHARS = 30_000;
/** Longest connector label written into a prompt or a document. */
const LABEL_MAX = 80;

/** Identifiers and types come from a database; keep them inside their cell. */
export function plainSchemaText(value: string): string {
  return value.replace(/[`|\r\n]/g, " ").trim();
}

/**
 * A connector's label as it is written into the prompt heading, the section's
 * notes and the document's warning. It is typed by whoever attached the
 * connector, so it is reduced to one line of plain text: no line break (a new
 * prompt line, a new Markdown block), no Markdown, HTML or math syntax, no
 * quote that would end the quotation it is written in, and a URL or address in
 * it does not become a link ({@link breakAutolinks}).
 */
export function plainConnectorLabel(value: string): string {
  const flat = value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[`|*[\]<>"\\#=$]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  const cut = flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1).trimEnd()}…` : flat;
  return breakAutolinks(cut);
}

function readSummary(read: SchemaInventoryRead): string {
  const schemas = read.schemas.map(plainSchemaText).filter(Boolean);
  const which =
    schemas.length === 0
      ? "its tables"
      : `schema${schemas.length === 1 ? "" : "s"} ${schemas.join(", ")}`;
  if (read.how === "live") {
    return (
      `"${read.connector}": ${which}, read from the database now.` +
      (read.possiblyTruncated
        ? " This read reached the driver's row limit and may have been cut short: tables and columns can be missing from it."
        : "")
    );
  }
  if (read.how === "stored") {
    return (
      `"${read.connector}": ${which}, from a schema graph stored` +
      `${read.storedOn ? ` on ${read.storedOn}` : " earlier"}; it may be out of date.`
    );
  }
  return `"${read.connector}": NOT read.`;
}

/**
 * What the schema in the prompt covers, said to the model in so many words: the
 * list is the DEFAULT schema of each database that answered, never the whole
 * database, so "not in the list" does not mean "does not exist". Empty when no
 * database was involved (repository SQL, or no source).
 */
export function renderSchemaCoverage(inventory: SchemaInventory): string {
  if (inventory.reads.length === 0) return "";
  return [
    "WHAT THE SCHEMA BELOW COVERS:",
    ...inventory.reads.map((read) => `- ${readSummary(read)}`),
    "Only each database's default schema is read, and a read lists only what the connecting " +
      "role may see. A table in any other schema, or in a database marked NOT read, is absent " +
      "from the list below and may still exist.",
  ].join("\n");
}

function promptName(table: SchemaInventoryTable, qualify: boolean): string {
  const name = plainSchemaText(table.name);
  return qualify && table.schema ? `${plainSchemaText(table.schema)}.${name}` : name;
}

function promptLine(table: SchemaInventoryTable, typed: boolean, qualify: boolean): string {
  const columns = table.columns.map((col) => {
    const name = plainSchemaText(col.name);
    if (!typed) return name;
    const key = col.isPrimaryKey ? " PK" : col.isForeignKey ? " FK" : "";
    return `${name} ${plainSchemaText(col.dataType)}${key}`;
  });
  return `- ${promptName(table, qualify)}: ${columns.join(", ")}`;
}

/**
 * The schema as the model reads it: one line per table, columns with their
 * types. Past `maxChars` the remaining tables are listed by name only, and the
 * block says so, so a partial list is never read as the whole schema. Tables
 * are written `schema.table` when more than one schema is in the list.
 */
export function renderSchemaPromptBlock(
  inventory: SchemaInventory,
  maxChars = SCHEMA_PROMPT_MAX_CHARS,
): string {
  if (inventory.tables.length === 0) return "";
  const typed = isTypedInventory(inventory);
  const qualify = schemaNamesOf(inventory.tables).length > 1;
  const lines: string[] = [];
  const namesOnly: string[] = [];
  let used = 0;
  for (const table of inventory.tables) {
    const line = promptLine(table, typed, qualify);
    if (namesOnly.length === 0 && used + line.length + 1 <= maxChars) {
      lines.push(line);
      used += line.length + 1;
    } else {
      namesOnly.push(promptName(table, qualify));
    }
  }
  if (namesOnly.length > 0) {
    const shown: string[] = [];
    let room = Math.max(0, Math.floor(maxChars / 4));
    for (const name of namesOnly) {
      if (name.length + 2 > room) break;
      shown.push(name);
      room -= name.length + 2;
    }
    const rest = namesOnly.length - shown.length;
    lines.push(
      `Further tables (columns not listed here): ${shown.join(", ")}` +
        (rest > 0 ? ` and ${rest} more` : ""),
    );
  }
  const heading = typed
    ? `DATABASE SCHEMA — from ${inventory.label}. Format: table: column type [PK|FK], ...`
    : `TABLE AND COLUMN NAMES — from ${inventory.label}. Types are not known, and the list can include objects a later migration dropped.`;
  return `=== ${heading} ===\n${lines.join("\n")}\n=== END SCHEMA ===`;
}

function asDbTable(table: SchemaInventoryTable): DbTableInfo {
  return {
    schema: table.schema,
    name: table.name,
    columns: table.columns,
    foreignKeys: table.foreignKeys.map((fk) => ({ ...fk, refColumns: [] })),
    indexes: [],
  };
}

/**
 * The schema reference inserted into the section: the ER diagram and one column
 * table per table, rendered by the database document's own renderers. Empty for
 * an inventory without types. Tables past `maxChars` are named, not dropped
 * silently.
 *
 * Size: the reference is added AFTER the section has been fitted to
 * `DOCS_GEN_SECTION_MAX_CHARS`, so it is not counted against that cap and is
 * never what the cap cuts. It is bounded on its own: `maxChars` of column
 * tables ({@link SCHEMA_REFERENCE_MAX_CHARS}) plus a diagram of at most
 * `MAX_TABLES_ER` tables showing key columns only. The document-level cap
 * still applies to the assembled document.
 */
export function renderSchemaReference(
  inventory: SchemaInventory,
  maxChars = SCHEMA_REFERENCE_MAX_CHARS,
): string {
  if (!isTypedInventory(inventory)) return "";
  // A table name held by more than one table (a database and its copy, two
  // schemas) is written with where it is from, in its heading and as its
  // diagram entity, so the reader can tell the two apart and the diagram does
  // not merge them into one entity.
  const timesNamed = new Map<string, number>();
  for (const table of inventory.tables) {
    timesNamed.set(table.name, (timesNamed.get(table.name) ?? 0) + 1);
  }
  const shared = (name: string): boolean => (timesNamed.get(name) ?? 0) > 1;
  // A read's connector label is already plain text (`plainConnectorLabel`).
  const connectorOf = (table: SchemaInventoryTable): string =>
    (table.read == null ? undefined : inventory.reads[table.read]?.connector) ?? "";
  const heading = (table: SchemaInventoryTable): string => {
    const name = `\`${plainSchemaText(table.name)}\``;
    if (!shared(table.name)) return name;
    const connector = connectorOf(table);
    const where = [
      connector ? `"${connector}"` : "",
      table.schema ? `schema \`${plainSchemaText(table.schema)}\`` : "",
    ].filter(Boolean);
    return where.length > 0 ? `${name} in ${where.join(", ")}` : name;
  };
  const entityId = (table: SchemaInventoryTable): string =>
    shared(table.name)
      ? [connectorOf(table), table.schema, table.name].filter(Boolean).join("_")
      : table.name;
  const tables = inventory.tables.map(asDbTable);
  const out: string[] = [
    "### Schema Reference",
    "",
    `> Rendered from ${inventory.label}, not written by the model.`,
    "",
  ];
  // Keys and relationships only: every column is in the tables that follow.
  const keyed = tables.slice(0, MAX_TABLES_ER).map((table, at) => {
    const source = inventory.tables[at];
    // A foreign key points at a table of the same read.
    const target = (refTable: string): string => {
      const referenced = inventory.tables.find(
        (other) => other.name === refTable && other.read === source.read,
      );
      return referenced ? entityId(referenced) : refTable;
    };
    return {
      ...table,
      name: entityId(source),
      columns: table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey),
      foreignKeys: table.foreignKeys.map((fk) => ({ ...fk, refTable: target(fk.refTable) })),
    };
  });
  // A schema with no primary or foreign key has nothing to draw, and a block
  // holding only `erDiagram` does not render, so none is written.
  if (keyed.some((table) => table.columns.length > 0 || table.foreignKeys.length > 0)) {
    if (tables.length > MAX_TABLES_ER) {
      out.push(`> The diagram shows the first ${MAX_TABLES_ER} of ${tables.length} tables.`, "");
    }
    out.push("```mermaid", buildErDiagram(keyed), "```", "");
  }
  let used = 0;
  const left: string[] = [];
  for (const [at, table] of tables.entries()) {
    const block = [`#### ${heading(inventory.tables[at])}`, "", ...renderColumnTable(table), ""];
    const size = block.reduce((sum, line) => sum + line.length + 1, 0);
    if (left.length === 0 && used + size <= maxChars) {
      out.push(...block);
      used += size;
    } else {
      left.push(plainSchemaText(table.name));
    }
  }
  if (left.length > 0) {
    const shown = left.slice(0, 40).map((name) => `\`${name}\``);
    const rest = left.length - shown.length;
    out.push(
      `> ${left.length} further table(s) are not listed column by column here, to keep this ` +
        `section readable: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}. ` +
        `The database document lists every column.`,
      "",
    );
  }
  return out.join("\n").trimEnd();
}
