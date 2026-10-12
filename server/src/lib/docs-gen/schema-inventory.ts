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
 * `current` is true only when every connector was read live in this run. It is
 * the one condition under which the claim check (`schema-claim-check.ts`) may
 * REMOVE anything: a stored graph can be out of date and repository SQL is
 * incomplete, so against those a name is only ever marked.
 *
 * This file is the pure half: the inventory's shape, the conversions into it
 * and what is rendered from it. Reading the sources is
 * `schema-inventory-loader.ts`, kept apart so the synthesizer does not load the
 * connector stack.
 */
import type { DbTableInfo, SchemaGraph } from "@metis/shared";
import { DYNAMIC_PLACEHOLDER_PREFIX } from "../code-graph/schema-graph.js";
import { buildErDiagram, MAX_TABLES_ER, renderColumnTable } from "./schema-render.js";

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
  /** True only when every database connector was introspected in this run. */
  current: boolean;
  tables: SchemaInventoryTable[];
}

export const NO_SCHEMA_INVENTORY: SchemaInventory = {
  source: "none",
  label: "no schema source",
  current: false,
  tables: [],
};

/** Whether the inventory carries column types and keys (live or stored graph). */
export function isTypedInventory(inventory: SchemaInventory): boolean {
  return (
    inventory.tables.length > 0 &&
    (inventory.source === "live-schema" || inventory.source === "schema-graph")
  );
}

export function byQualifiedName(a: SchemaInventoryTable, b: SchemaInventoryTable): number {
  const left = `${a.schema}.${a.name}`;
  const right = `${b.schema}.${b.name}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Introspected tables, reduced to what the section reads (no row counts). */
export function tablesFromIntrospection(tables: readonly DbTableInfo[]): SchemaInventoryTable[] {
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
  }));
}

/** A persisted {@link SchemaGraph}, or `[]` when the stored JSON is not one. */
export function tablesFromSchemaGraph(graph: unknown): SchemaInventoryTable[] {
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
  const tableFor = (qualified: string): SchemaInventoryTable | null => {
    if (!qualified || qualified.startsWith(DYNAMIC_PLACEHOLDER_PREFIX)) return null;
    const dot = qualified.lastIndexOf(".");
    const schema = dot >= 0 ? qualified.slice(0, dot) : "";
    if (SYSTEM_SCHEMAS.has(schema.toLowerCase())) return null;
    let table = tables.get(qualified);
    if (!table) {
      table = { schema, name: qualified.slice(dot + 1), columns: [], foreignKeys: [] };
      tables.set(qualified, table);
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
    if (table.columns.some((col) => col.name === symbol.name)) continue;
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

/** Identifiers and types come from a database; keep them inside their cell. */
export function plainSchemaText(value: string): string {
  return value.replace(/[`|\r\n]/g, " ").trim();
}

function promptLine(table: SchemaInventoryTable, typed: boolean): string {
  const columns = table.columns.map((col) => {
    const name = plainSchemaText(col.name);
    if (!typed) return name;
    const key = col.isPrimaryKey ? " PK" : col.isForeignKey ? " FK" : "";
    return `${name} ${plainSchemaText(col.dataType)}${key}`;
  });
  return `- ${plainSchemaText(table.name)}: ${columns.join(", ")}`;
}

/**
 * The schema as the model reads it: one line per table, columns with their
 * types. Past `maxChars` the remaining tables are listed by name only, and the
 * block says so, so a partial list is never read as the whole schema.
 */
export function renderSchemaPromptBlock(
  inventory: SchemaInventory,
  maxChars = SCHEMA_PROMPT_MAX_CHARS,
): string {
  if (inventory.tables.length === 0) return "";
  const typed = isTypedInventory(inventory);
  const lines: string[] = [];
  const namesOnly: string[] = [];
  let used = 0;
  for (const table of inventory.tables) {
    const line = promptLine(table, typed);
    if (namesOnly.length === 0 && used + line.length + 1 <= maxChars) {
      lines.push(line);
      used += line.length + 1;
    } else {
      namesOnly.push(plainSchemaText(table.name));
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
 */
export function renderSchemaReference(
  inventory: SchemaInventory,
  maxChars = SCHEMA_REFERENCE_MAX_CHARS,
): string {
  if (!isTypedInventory(inventory)) return "";
  const tables = inventory.tables.map(asDbTable);
  const out: string[] = [
    "### Schema Reference",
    "",
    `> Rendered from ${inventory.label}, not written by the model.`,
    "",
  ];
  if (tables.length > MAX_TABLES_ER) {
    out.push(`> The diagram shows the first ${MAX_TABLES_ER} of ${tables.length} tables.`, "");
  }
  // Keys and relationships only: every column is in the tables that follow.
  const keyed = tables.slice(0, MAX_TABLES_ER).map((table) => ({
    ...table,
    columns: table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey),
  }));
  out.push("```mermaid", buildErDiagram(keyed), "```", "");
  let used = 0;
  const left: string[] = [];
  for (const table of tables) {
    const block = [`#### \`${plainSchemaText(table.name)}\``, "", ...renderColumnTable(table), ""];
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
