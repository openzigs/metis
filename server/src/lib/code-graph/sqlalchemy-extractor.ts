/**
 * SQLAlchemy Core & ORM query-lineage extractor — Issue #898 (Epic #883).
 *
 * Python's raw psycopg string SQL (`cursor.execute("SELECT ... FROM users")`)
 * already reaches the schema graph through the sqlglot sidecar path in
 * `embedded-sql-extractor.ts` (#305) — a `cursor.execute(...)` argument is just
 * an ordinary Python string literal, so no bespoke psycopg handling is needed.
 * What that path CANNOT see is SQLAlchemy, where the physical table is never
 * spelled as a SQL string in the query:
 *
 *   - **SQLAlchemy Core** builds statements programmatically against a `Table`
 *     object bound to a module variable
 *     (`users = Table("users", metadata, Column("id", ...), ...)`), then queries
 *     it fluently (`select(users)`, `users.insert()`).
 *   - **SQLAlchemy ORM** maps a declarative class onto a table via
 *     `__tablename__` and per-attribute `Column`/`mapped_column`, then queries
 *     the CLASS (`session.query(User)`, `select(User.email)`).
 *
 * Mapping either query shape to a physical table is pure SYMBOL RESOLUTION, not
 * SQL parsing — resolve the referenced class/variable name back to the physical
 * table it declares, then anchor a `reads`/`writes` edge from the REAL enclosing
 * Python function symbol to that table. This mirrors the jOOQ (#897) call-site
 * pattern exactly, and — per #896's design — the class/variable → table lookup
 * goes through the framework-agnostic {@link EntityTableResolver}
 * (`buildSqlAlchemyEntityResolver` in `entity-resolver.ts`) rather than
 * duplicating resolution logic here.
 *
 * Deliberately detection-only and regex-based, like every other extractor in
 * this directory: no real Python grammar, no import/type resolution. Read-only —
 * no SQL is ever executed. Edges carry `source = "orm"` (the same provenance
 * tier the JPA/ORM passes use); the physical table is recorded schema-less
 * unless an explicit `schema=` / `__table_args__` schema is declared in source.
 */
import type { SchemaGraphWriter } from "./schema-graph.js";
import { columnQualifiedName, tableQualifiedName } from "./schema-graph.js";
import { enclosingSymbolFor, type EnclosingSymbol } from "./orm-callsite-extractor.js";
import type { EntityTableResolver } from "./entity-resolver.js";

/** A field on a SQLAlchemy entity/table and the physical column it maps to. */
export interface SqlAlchemyFieldRef {
  /** The attribute name used in code (`User.email` → `email`). For Core tables the field IS the column name. */
  field: string;
  column: string;
}

/** One SQLAlchemy ORM class or Core `Table` variable mapped onto a physical table. */
export interface SqlAlchemyEntity {
  /** The resolvable name: the ORM class name or the Core `Table` variable name. */
  entityName: string;
  table: string;
  schema?: string;
  fields: SqlAlchemyFieldRef[];
  line: number;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Leading-whitespace width of a line (spaces + tabs counted equally). */
function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

/** Return the index of the `)` matching the `(` at `openIdx` (balanced), or -1. */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---- ORM declarative-class parsing -----------------------------------------

const CLASS_RE = /^([ \t]*)class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/;
const TABLENAME_RE = /__tablename__\s*=\s*["']([^"']+)["']/;
// `schema` inside `__table_args__ = {"schema": "sales"}` (also `'schema'`).
const TABLE_ARGS_SCHEMA_RE = /__table_args__[\s\S]*?["']schema["']\s*:\s*["']([^"']+)["']/;
// `attr = Column(...)` / `attr: Mapped[...] = mapped_column(...)` — captures the
// attribute name and the argument text on the same line.
const COLUMN_ASSIGN_RE =
  /^[ \t]*([A-Za-z_]\w*)\s*(?::\s*[^=\n]+?)?=\s*(?:Column|mapped_column)\s*\(([^\n]*)/gm;
// A leading positional string literal is SQLAlchemy's explicit column-name override.
const EXPLICIT_COLUMN_NAME_RE = /^\s*["']([^"']+)["']/;

/** Parse one declarative-class body into an entity, or null when it declares no table. */
function parseOrmClass(className: string, body: string, line: number): SqlAlchemyEntity | null {
  const tableMatch = TABLENAME_RE.exec(body);
  // Classic SQLAlchemy declarative REQUIRES __tablename__; a class without one is
  // a mixin/abstract base, not a physical table — never guess a name for it.
  if (!tableMatch) return null;
  const table = tableMatch[1].toLowerCase();
  const schemaMatch = TABLE_ARGS_SCHEMA_RE.exec(body);
  const schema = schemaMatch ? schemaMatch[1].toLowerCase() : undefined;

  const fields: SqlAlchemyFieldRef[] = [];
  COLUMN_ASSIGN_RE.lastIndex = 0;
  let c: RegExpExecArray | null;
  while ((c = COLUMN_ASSIGN_RE.exec(body)) !== null) {
    const attr = c[1];
    if (attr.startsWith("__")) continue; // dunder, never a column
    const explicit = EXPLICIT_COLUMN_NAME_RE.exec(c[2]);
    const column = (explicit ? explicit[1] : attr).toLowerCase();
    fields.push({ field: attr, column });
  }
  return { entityName: className, table, schema, fields, line };
}

/** Parse SQLAlchemy ORM declarative classes out of a `.py` source file. */
export function parseSqlAlchemyOrmEntities(content: string): SqlAlchemyEntity[] {
  const lines = content.split("\n");
  const out: SqlAlchemyEntity[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cm = CLASS_RE.exec(lines[i]);
    if (!cm) continue;
    const classIndent = cm[1].length;
    const className = cm[2];
    // Gather the class body: every following line indented deeper than the
    // `class` header, up to the first line that dedents back to <= header.
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (indentOf(lines[j]) <= classIndent) break;
    }
    const body = lines.slice(i + 1, j).join("\n");
    const entity = parseOrmClass(className, body, i + 1);
    if (entity) out.push(entity);
    // Do NOT skip to j: a nested class re-matches on its own line harmlessly,
    // and stepping by one keeps the scan simple and total.
  }
  return out;
}

// ---- Core Table(...) parsing ------------------------------------------------

const CORE_TABLE_RE = /\b([A-Za-z_]\w*)\s*=\s*Table\s*\(/g;
const CORE_COLUMN_RE = /\bColumn\s*\(\s*["']([^"']+)["']/g;
const CORE_SCHEMA_RE = /\bschema\s*=\s*["']([^"']+)["']/;

/** Parse SQLAlchemy Core `Table("name", metadata, ...)` variable bindings. */
export function parseSqlAlchemyCoreTables(content: string): SqlAlchemyEntity[] {
  const out: SqlAlchemyEntity[] = [];
  CORE_TABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CORE_TABLE_RE.exec(content)) !== null) {
    const varName = m[1];
    const openIdx = content.indexOf("(", m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    const close = findMatchingParen(content, openIdx);
    if (close === -1) continue;
    const inner = content.slice(openIdx + 1, close);
    const nameMatch = EXPLICIT_COLUMN_NAME_RE.exec(inner);
    if (!nameMatch) continue; // first positional arg is not the table-name string
    const table = nameMatch[1].toLowerCase();
    const schemaMatch = CORE_SCHEMA_RE.exec(inner);
    const schema = schemaMatch ? schemaMatch[1].toLowerCase() : undefined;
    // Core columns are referenced as `table.c.<name>`, so the field IS the
    // physical column name — register it as its own identity.
    const fields: SqlAlchemyFieldRef[] = [];
    const seen = new Set<string>();
    CORE_COLUMN_RE.lastIndex = 0;
    let col: RegExpExecArray | null;
    while ((col = CORE_COLUMN_RE.exec(inner)) !== null) {
      const name = col[1].toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      fields.push({ field: name, column: name });
    }
    out.push({ entityName: varName, table, schema, fields, line: lineOf(content, m.index) });
  }
  return out;
}

/**
 * Parse every SQLAlchemy ORM declarative class AND Core `Table` variable in one
 * `.py` source into a unified entity list. Both feed the same
 * {@link EntityTableResolver} so a single call-site scan can resolve a
 * referenced class OR Core-table name to its physical table.
 */
export function parseSqlAlchemyEntities(content: string): SqlAlchemyEntity[] {
  return [...parseSqlAlchemyOrmEntities(content), ...parseSqlAlchemyCoreTables(content)];
}

// ---- Query call-site scanning ----------------------------------------------

/** SQLAlchemy query verbs that READ table data (function form `select(X)`/`query(X)`). */
const READ_VERBS = new Set(["select", "query"]);
/** SQLAlchemy query verbs that WRITE table data (`insert(X)`, `update(X)`, `delete(X)`). */
const WRITE_VERBS = new Set(["insert", "update", "delete"]);
/** Verbs valid in the method form `X.<verb>()` on a Core table / mapped class. */
const METHOD_VERBS = new Set(["select", "insert", "update", "delete"]);

// Function form: `select(User)`, `query(User.email)`, `insert(orders)`, ... The
// verb may be bare (`select(...)`) or the tail of a receiver (`session.query(...)`),
// so no anchor before the verb — the resolver membership check gates false hits.
const FN_CALL_RE = /\b(select|query|insert|update|delete)\s*\(([^)]*)\)/g;
// Method form: `orders.insert()`, `users.select()` — a table/class variable
// followed by a mutating/reading verb. `query` is intentionally excluded (it is
// only ever a Session method taking the entity as an ARGUMENT, handled above).
const METHOD_CALL_RE = /\b([A-Za-z_]\w*)\s*\.\s*(select|insert|update|delete)\s*\(/g;
// One `Base` or `Base.field` reference argument.
const ARG_REF_RE = /^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/;

/** One resolvable SQLAlchemy query reference located in a source file. */
export interface SqlAlchemyCallSite {
  line: number;
  kind: "reads" | "writes";
  /** The referenced class / Core-table variable name. */
  entityRef: string;
  /** A referenced attribute (`User.email` → `email`), or null for a whole-table reference. */
  field: string | null;
}

/**
 * Scan one `.py` source for SQLAlchemy Core/ORM query call sites. Pure syntax —
 * every `select`/`query`/`insert`/`update`/`delete` reference is returned; it is
 * the caller's job to keep only those whose `entityRef` resolves to a known
 * table (via the shared resolver), exactly as jOOQ filters against its table
 * map. Multi-line call arguments are not assembled (line-based, like the jOOQ
 * scanner) — a reference split across lines is missed.
 */
export function findSqlAlchemyCallSites(source: string): SqlAlchemyCallSite[] {
  const out: SqlAlchemyCallSite[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    FN_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FN_CALL_RE.exec(line)) !== null) {
      const verb = m[1];
      const kind = WRITE_VERBS.has(verb) ? "writes" : READ_VERBS.has(verb) ? "reads" : null;
      if (!kind) continue;
      for (const rawArg of m[2].split(",")) {
        const arg = ARG_REF_RE.exec(rawArg.trim());
        if (!arg) continue;
        out.push({ line: i + 1, kind, entityRef: arg[1], field: arg[2] ?? null });
      }
    }

    METHOD_CALL_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = METHOD_CALL_RE.exec(line)) !== null) {
      const verb = mm[2];
      if (!METHOD_VERBS.has(verb)) continue;
      const kind = WRITE_VERBS.has(verb) ? "writes" : "reads";
      out.push({ line: i + 1, kind, entityRef: mm[1], field: null });
    }
  }
  return out;
}

/**
 * Persist `reads`/`writes` edges for one file's SQLAlchemy query call sites,
 * anchored to the REAL enclosing persisted Python function symbol — mirrors
 * `persistJooqCallSiteEdges` (#897) and `persistOrmCallSiteEdges` (#872). Call
 * sites whose `entityRef` doesn't resolve to a known table (unknown/ambiguous
 * name) OR that have no enclosing function symbol are skipped; this extractor
 * never fabricates origin symbols. Field references that don't resolve to a
 * column are dropped — the statement still gets its table-level edge. Returns
 * the number of edges written; duplicate `(from, target, kind)` pairs within
 * the file are deduped. Edges carry `source = "orm"`.
 */
export async function persistSqlAlchemyCallSiteEdges(
  writer: SchemaGraphWriter,
  resolver: EntityTableResolver,
  filePath: string,
  source: string,
  symbols: readonly EnclosingSymbol[],
): Promise<number> {
  const sites = findSqlAlchemyCallSites(source);
  if (sites.length === 0 || symbols.length === 0) return 0;
  const seen = new Set<string>();
  let edges = 0;
  for (const site of sites) {
    const target = resolver.resolveEntity(site.entityRef);
    if (!target) continue;
    const from = enclosingSymbolFor(symbols, site.line);
    if (!from) continue;

    const tableQn = tableQualifiedName(target.schema, target.table);
    const tableKey = `${from.id}|${tableQn}|${site.kind}`;
    if (!seen.has(tableKey)) {
      seen.add(tableKey);
      const tableId = await writer.ensureTable(target.table, "orm", {
        schema: target.schema,
        filePath,
        line: site.line,
      });
      await writer.addEdge(from.id, site.kind, tableId, "orm", {
        toQualifiedName: tableQn,
        filePath,
        line: site.line,
      });
      edges++;
    }

    if (site.field) {
      const col = resolver.resolveField(site.entityRef, site.field);
      if (col) {
        const colQn = columnQualifiedName(col.schema, col.table, col.column);
        const colKey = `${from.id}|${colQn}|${site.kind}`;
        if (!seen.has(colKey)) {
          seen.add(colKey);
          const colId = await writer.ensureColumn(col.table, col.column, "orm", {
            schema: col.schema,
            filePath,
            line: site.line,
          });
          await writer.addEdge(from.id, site.kind, colId, "orm", {
            toQualifiedName: colQn,
            filePath,
            line: site.line,
          });
          edges++;
        }
      }
    }
  }
  return edges;
}
