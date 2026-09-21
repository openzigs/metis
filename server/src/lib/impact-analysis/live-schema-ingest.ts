/**
 * Live schema ingestion & reconciliation — Epic #168 (#172).
 *
 * Turns authoritative database metadata into the schema graph and provides the
 * ground-truth index the engine (#173) reconciles inferred MyBatis/ORM
 * references against.
 *
 * Sources of ground truth:
 *   - a live {@link DbSchemaSnapshot} produced by the read-only connector
 *     introspection path (`POST /dbs/:id/inspect`), persisted with
 *     `source = "live-db"` and carrying real column types + foreign keys; and
 *   - `.sql` DDL files in the repo (`CREATE TABLE …`), persisted with
 *     `source = "ddl-file"`.
 *
 * Introspection is **read-only** — it is performed by the connector drivers
 * behind `validateSelectOnly`; this module never issues SQL and never logs
 * connection secrets.
 */
import type { DbRoutineInfo, DbSchemaSnapshot, SchemaReconciliation } from "@metis/shared";
import {
  columnQualifiedName,
  routineQualifiedName,
  tableQualifiedName,
  type SchemaGraphWriter,
} from "../code-graph/schema-graph.js";

/** Authoritative column metadata. */
export interface LiveColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

/** Authoritative table metadata, columns keyed by normalized name. */
export interface LiveTable {
  schema: string;
  name: string;
  columns: Map<string, LiveColumn>;
}

/** A schema reference (from a mapper/entity) to reconcile against live truth. */
export interface SchemaRefLookup {
  table: string;
  schema?: string;
  column?: string | null;
}

function norm(s: string): string {
  return s
    .trim()
    .replace(/[`"[\]]/g, "")
    .toLowerCase();
}

/**
 * In-memory index of the authoritative schema. Tables are addressable both by
 * `schema.name` and by bare `name` (mappers frequently omit the schema), with
 * the schema-qualified form winning on collision.
 */
export class LiveSchemaIndex {
  private readonly byQualified = new Map<string, LiveTable>();
  private readonly byBare = new Map<string, LiveTable>();

  /** Build an index from a list of live tables. */
  constructor(tables: LiveTable[] = []) {
    for (const t of tables) this.add(t);
  }

  private add(table: LiveTable): void {
    const schema = norm(table.schema);
    const name = norm(table.name);
    this.byQualified.set(`${schema}.${name}`, table);
    // First writer wins for bare names so a deterministic table is returned.
    if (!this.byBare.has(name)) this.byBare.set(name, table);
  }

  /** Build an index from a live DB snapshot. */
  static fromSnapshot(snapshot: DbSchemaSnapshot): LiveSchemaIndex {
    const tables: LiveTable[] = snapshot.tables.map((t) => ({
      schema: t.schema,
      name: t.name,
      columns: new Map(
        t.columns.map((c) => [
          norm(c.name),
          {
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
            isPrimaryKey: c.isPrimaryKey,
          },
        ]),
      ),
    }));
    return new LiveSchemaIndex(tables);
  }

  /** Resolve a table by schema-qualified name, falling back to a bare name. */
  getTable(table: string, schema?: string): LiveTable | null {
    const name = norm(table);
    if (schema) {
      const q = this.byQualified.get(`${norm(schema)}.${name}`);
      if (q) return q;
    }
    return this.byQualified.get(name) ?? this.byBare.get(name) ?? null;
  }

  /** Resolve a column on a table, or null if either is missing. */
  getColumn(table: string, column: string, schema?: string): LiveColumn | null {
    return this.getTable(table, schema)?.columns.get(norm(column)) ?? null;
  }

  /**
   * Reconcile an inferred reference against live truth:
   *   - `table-not-found`  — the table is absent from the live schema,
   *   - `column-not-found` — the table exists but the column does not,
   *   - `matched`          — table (and column, if given) line up.
   */
  reconcile(ref: SchemaRefLookup): SchemaReconciliation {
    const table = this.getTable(ref.table, ref.schema);
    if (!table) return "table-not-found";
    if (ref.column && !table.columns.has(norm(ref.column))) return "column-not-found";
    return "matched";
  }

  /** Total number of indexed tables (schema-qualified). */
  get size(): number {
    return this.byQualified.size;
  }
}

/**
 * Persist the live schema as `table`/`column` symbols (`source = "live-db"`).
 * Real column types are carried on the symbol as `columnType` for later DDL
 * suggestions. Returns the counts written.
 */
export async function persistLiveSchema(
  writer: SchemaGraphWriter,
  tables: LiveTable[],
): Promise<{ tables: number; columns: number }> {
  let tableCount = 0;
  let columnCount = 0;
  for (const table of tables) {
    await writer.ensureTable(table.name, "live-db", { schema: table.schema });
    tableCount++;
    for (const col of table.columns.values()) {
      await writer.ensureColumn(table.name, col.name, "live-db", {
        schema: table.schema,
        columnType: col.dataType,
      });
      columnCount++;
    }
  }
  return { tables: tableCount, columns: columnCount };
}

/**
 * Persist live-introspected routines (procedures & functions) as
 * `procedure`/`function` symbols (`source = "live-db"`) — Epic #293 Phase 2
 * (#301). READ-ONLY provenance: these come from {@link DbRoutineInfo}, which
 * carries identity + signature only — the routine body is never read or stored.
 *
 * Phase 3 seam (#294): the body-derived `calls` edges (routine → table/column it
 * touches) are NOT created here — that requires parsing the routine body, which
 * is explicitly out of scope for Phase 2. This function only materializes the
 * routine SYMBOLS so #302 can classify them and so Phase 3 has a stable
 * `fromSymbolId` to attach `calls` edges onto. Returns the count written.
 */
export async function persistLiveRoutines(
  writer: SchemaGraphWriter,
  routines: DbRoutineInfo[],
): Promise<{ routines: number }> {
  let count = 0;
  for (const r of routines) {
    await writer.ensureRoutine(r.name, r.type, "live-db", { schema: r.schema });
    count++;
  }
  return { routines: count };
}

/** Injectable read-only introspection function (wraps the connector drivers). */
export type SchemaIntrospector = (connectorId: string) => Promise<DbSchemaSnapshot>;

/**
 * Load the live schema for a connector, returning a reconciliation index, or
 * `null` when no connector is configured or introspection fails (the engine
 * then proceeds with inferred mappings only — never blocking the run).
 */
export async function loadLiveSchema(
  introspect: SchemaIntrospector | null | undefined,
  connectorId: string | null | undefined,
): Promise<LiveSchemaIndex | null> {
  if (!introspect || !connectorId) return null;
  try {
    const snapshot = await introspect(connectorId);
    return LiveSchemaIndex.fromSnapshot(snapshot);
  } catch {
    return null;
  }
}

// ---- DDL file parsing (source = "ddl-file") --------------------------------

/** Parse `CREATE TABLE` statements out of a `.sql` DDL file. */
export function parseDdlFile(content: string): LiveTable[] {
  const tables: LiveTable[] = [];
  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."`[\]]+)\s*\(([\s\S]*?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(content)) !== null) {
    const rawName = m[1].replace(/[`"[\]]/g, "");
    const [schemaPart, namePart] = rawName.includes(".") ? rawName.split(".") : ["public", rawName];
    const columns = new Map<string, LiveColumn>();
    const pkCols = new Set<string>();
    for (const rawCol of splitTopLevel(m[2])) {
      const col = rawCol.trim();
      if (!col) continue;
      const pkInline = /^primary\s+key\s*\(([^)]*)\)/i.exec(col);
      if (pkInline) {
        for (const c of pkInline[1].split(",")) pkCols.add(norm(c));
        continue;
      }
      if (/^(constraint|primary|foreign|unique|key|index|check)\b/i.test(col)) continue;
      const colMatch = /^([A-Za-z0-9_"`[\]]+)\s+([A-Za-z0-9_]+(?:\s*\([^)]*\))?)/.exec(col);
      if (!colMatch) continue;
      const name = norm(colMatch[1]);
      columns.set(name, {
        name,
        dataType: colMatch[2].replace(/\s+/g, "").toLowerCase(),
        nullable: !/\bnot\s+null\b/i.test(col),
        isPrimaryKey: /\bprimary\s+key\b/i.test(col),
      });
      if (/\bprimary\s+key\b/i.test(col)) pkCols.add(name);
    }
    for (const pk of pkCols) {
      const c = columns.get(pk);
      if (c) c.isPrimaryKey = true;
    }
    tables.push({ schema: norm(schemaPart), name: norm(namePart), columns });
  }
  return tables;
}

/** Split a parenthesised column list on top-level commas (ignores nested `()`). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * Persist a `.sql` DDL file as `table`/`column` symbols (`source = "ddl-file"`).
 * Returns the counts written.
 */
export async function persistDdlFile(
  writer: SchemaGraphWriter,
  filePath: string,
  content: string,
): Promise<{ tables: number; columns: number }> {
  const tables = parseDdlFile(content);
  let tableCount = 0;
  let columnCount = 0;
  for (const table of tables) {
    await writer.ensureTable(table.name, "ddl-file", { schema: table.schema, filePath });
    tableCount++;
    for (const col of table.columns.values()) {
      await writer.ensureColumn(table.name, col.name, "ddl-file", {
        schema: table.schema,
        columnType: col.dataType,
        filePath,
      });
      columnCount++;
    }
  }
  return { tables: tableCount, columns: columnCount };
}

/** Convenience: the qualified-name helpers re-exported for engine reconciliation. */
export { columnQualifiedName, routineQualifiedName, tableQualifiedName };
