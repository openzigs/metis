/**
 * Go GORM model → physical-table lineage extractor — Issue #899 (Epic #883).
 *
 * Go SQL coverage came in two shapes before this module:
 *
 *   - **Raw SQL strings** (`database/sql`, `jmoiron/sqlx`:
 *     `db.Query("SELECT …")`, `db.Get(&d, "SELECT …")`, `db.Select(…)`,
 *     `db.Exec("UPDATE …")`) are already covered — `.go` is a supported
 *     `LANGUAGE_DIALECT` in `embedded-sql-extractor.ts` (#305), so any Go
 *     string literal that `looksLikeSql` is handed to the `metis-sql-lineage`
 *     sqlglot sidecar and its tables/columns are persisted with
 *     `source = "sqlglot"`. That path is unchanged here; #899 only VERIFIES it
 *     (see `gorm-extractor.test.ts` / `ingest-go-wiring.test.ts`).
 *
 *   - **GORM** (`gorm.io/gorm`, legacy `jinzhu/gorm`) is an ORM: application
 *     code references a Go STRUCT (`db.Model(&User{}).Find(&users)`,
 *     `db.Create(&user)`), never a physical table name — so there is no SQL
 *     string to parse. Mapping a GORM query to a table is entity resolution,
 *     exactly like the JPA/Hibernate query side (#896). This module reuses the
 *     framework-agnostic {@link EntityTableResolver} interface
 *     (`entity-resolver.ts`, shipped by #896) via a new
 *     {@link buildGormEntityResolver} factory rather than duplicating the
 *     lookup logic, then scans application `.go` source for GORM call sites and
 *     emits `reads`/`writes` edges FROM the REAL enclosing Go function symbol
 *     TO the resolved table — the SAME call-site anchoring the #872 ORM /
 *     #897 jOOQ passes use. Resolved edges carry `source = "orm"`.
 *
 * GORM table-name resolution follows GORM's own conventions:
 *   1. an explicit `func (User) TableName() string { return "profiles" }`
 *      override (either receiver form: `(User)` or `(u User)`) wins;
 *   2. otherwise the default — snake_case of the struct name, pluralized
 *      (`User` → `users`, `CreditCard` → `credit_cards`). GORM's inflector has
 *      irregular plurals (`person` → `people`) this best-effort pluralizer does
 *      NOT model; those need an explicit `TableName()` to resolve, matching the
 *      "detection-only, no type resolution" posture of every extractor here.
 * Columns follow the field's `gorm:"column:…"` tag, else snake_case of the
 * field name; an embedded `gorm.Model` contributes the standard
 * id/created_at/updated_at/deleted_at columns; a `gorm:"-"` field is ignored.
 *
 * `sqlvet` evaluation (the issue's "evaluate sqlvet" ask): NOT adopted. sqlvet
 * validates raw SQL strings from `database/sql`/`sqlx`/`gorp`/legacy-gorm query
 * functions against a schema — it does NOT resolve GORM struct→table mapping
 * (the actual gap #899 fills) — and it operates over `go/packages`, i.e. it
 * needs the target repo to be a compilable Go module with its dependencies
 * present. Metis ingests arbitrary, possibly non-compiling repositories in a
 * toolchain-free worker, so adopting sqlvet would mean a new Go sidecar + a
 * hard `go build` precondition for zero coverage sqlglot doesn't already give
 * us on the raw-SQL half. Decision: reuse the existing sqlglot path for raw SQL
 * and build this native, regex-based GORM resolver for the ORM half — no new
 * external dependency, no new sidecar.
 *
 * Read-only, no SQL executed: this module only parses Go source text into an
 * in-memory index and matches call sites against it.
 */
import { MapEntityTableResolver, type EntityTableResolver } from "./entity-resolver.js";
import { toSnakeCase } from "./orm-extractor.js";
import type { EnclosingSymbol } from "./orm-callsite-extractor.js";
import { enclosingSymbolFor } from "./orm-callsite-extractor.js";
import type { SchemaGraphWriter } from "./schema-graph.js";
import { tableQualifiedName } from "./schema-graph.js";

/**
 * Best-effort English pluralizer matching GORM's DEFAULT naming for the common
 * regular cases (GORM pluralizes the snake_cased struct name). Irregular
 * plurals are out of scope — a struct needing one declares `TableName()`.
 */
export function pluralize(word: string): string {
  if (word.length === 0) return word;
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** GORM's default table name for a struct: snake_case, then pluralized. */
export function defaultGormTableName(structName: string): string {
  return pluralize(toSnakeCase(structName));
}

/** The physical columns an embedded `gorm.Model` contributes. */
const GORM_MODEL_FIELDS: ReadonlyArray<{ field: string; column: string }> = [
  { field: "ID", column: "id" },
  { field: "CreatedAt", column: "created_at" },
  { field: "UpdatedAt", column: "updated_at" },
  { field: "DeletedAt", column: "deleted_at" },
];

/** One parsed GORM model struct mapped onto a physical table. */
export interface GormModel {
  structName: string;
  table: string;
  fields: Map<string, string>;
}

function sliceBraces(content: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return content.slice(openBraceIndex + 1, i);
    }
  }
  return content.slice(openBraceIndex + 1);
}

// `func (User) TableName() string { return "profiles" }` — either receiver form
// (`(User)` or `(u User)`); captures the struct name and the returned literal.
const TABLE_NAME_OVERRIDE_RE =
  /\bfunc\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)\s*\)\s*TableName\s*\(\s*\)\s*string\s*\{[^}]*\breturn\s+["`]([^"`]+)["`]/g;

/** Map `structName -> explicit TableName() override`, scanned once per file. */
function tableNameOverrides(content: string): Map<string, string> {
  const out = new Map<string, string>();
  TABLE_NAME_OVERRIDE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_NAME_OVERRIDE_RE.exec(content)) !== null) {
    out.set(m[1], m[2]);
  }
  return out;
}

// Extracts the `column:<name>` directive out of a `gorm:"..."` struct tag.
const GORM_COLUMN_TAG_RE = /gorm:"[^"]*\bcolumn:([A-Za-z_]\w*)/;
// A struct field line: `Name Type `tags`` — exported (capitalized) name +
// a type token. Anonymous/embedded fields (a bare type, no name) are handled
// separately below.
const FIELD_RE = /^\s*([A-Z]\w*)\s+[\w.*[\]]+(.*)$/;

/** Parse one GORM struct body into its `field -> column` map. */
function parseGormFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    // Embedded `gorm.Model` (a bare type reference, no field name) expands to
    // the standard soft-delete/timestamp columns.
    if (/^gorm\.Model\b/.test(line)) {
      for (const f of GORM_MODEL_FIELDS) fields.set(f.field.toLowerCase(), f.column);
      continue;
    }
    const m = FIELD_RE.exec(line);
    if (!m) continue;
    const fieldName = m[1];
    const attrs = m[2] ?? "";
    if (/gorm:"-"/.test(attrs)) continue; // explicitly ignored field
    const tagCol = GORM_COLUMN_TAG_RE.exec(attrs);
    const column = tagCol ? tagCol[1].toLowerCase() : toSnakeCase(fieldName);
    fields.set(fieldName.toLowerCase(), column);
  }
  return fields;
}

const STRUCT_RE = /\btype\s+([A-Za-z_]\w*)\s+struct\s*\{/g;

/** Parse every GORM model struct out of one `.go` source file. */
export function parseGormModels(content: string): GormModel[] {
  const overrides = tableNameOverrides(content);
  const out: GormModel[] = [];
  STRUCT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRUCT_RE.exec(content)) !== null) {
    const structName = m[1];
    const bodyStart = m.index + m[0].length - 1;
    const body = sliceBraces(content, bodyStart);
    const table = (overrides.get(structName) ?? defaultGormTableName(structName)).toLowerCase();
    out.push({ structName, table, fields: parseGormFields(body) });
  }
  return out;
}

/**
 * Build a framework-agnostic {@link EntityTableResolver} for GORM from captured
 * `.go` sources, reusing the SAME {@link MapEntityTableResolver} the JPA
 * resolver (#896) feeds — GORM is registered by its struct name (the identifier
 * application code references as `&User{}`). No GORM-specific branching leaks
 * past this factory.
 */
export function buildGormEntityResolver(
  goSources: ReadonlyMap<string, string>,
): MapEntityTableResolver {
  const resolver = new MapEntityTableResolver();
  for (const content of goSources.values()) {
    if (!/\bstruct\s*\{/.test(content)) continue;
    for (const model of parseGormModels(content)) {
      resolver.register(model.structName, {
        table: model.table,
        fields: model.fields,
      });
    }
  }
  return resolver;
}

/** GORM finisher methods that READ table data. */
export const GORM_READ_OPS = new Set([
  "First",
  "Take",
  "Last",
  "Find",
  "FindInBatches",
  "Scan",
  "Count",
  "Pluck",
  "Row",
  "Rows",
]);

/** GORM finisher methods that WRITE table data. */
export const GORM_WRITE_OPS = new Set([
  "Create",
  "CreateInBatches",
  "Save",
  "Update",
  "Updates",
  "UpdateColumn",
  "UpdateColumns",
  "Delete",
  "FirstOrCreate",
]);

export interface GormTableTarget {
  table: string;
  schema?: string;
}

export interface GormCallSite {
  line: number;
  op: string;
  kind: "reads" | "writes";
  target: GormTableTarget;
}

// A GORM finisher call `.<Op>(` on a line.
const OP_CALL_RE = /\.\s*([A-Z]\w*)\s*\(/g;
// A composite-literal / slice type reference in a chain: `&User{`, `User{`,
// `[]User`, `&[]User`, `*User`. Captures the type identifier.
const MODEL_TYPE_RE = /(?:&|\[\]|\*)?\s*([A-Z]\w*)\s*\{|\[\]\s*([A-Z]\w*)\b/g;
// An explicit `.Table("physical_name")` override — a direct physical table.
const TABLE_LITERAL_RE = /\.\s*Table\s*\(\s*["`]([^"`]+)["`]\s*\)/;

/**
 * Resolve the physical table a GORM call chain (one source line) targets:
 * an explicit `.Table("…")` literal wins, else the first composite-literal
 * struct type on the line that resolves via `resolver`. Returns null when
 * neither is present/resolvable — a `db.Find(&users)` whose model type only
 * appears in a separate `var users []User` declaration is NOT statically
 * resolvable (documented limitation, mirrors the jOOQ multi-line one).
 */
function resolveLineTarget(line: string, resolver: EntityTableResolver): GormTableTarget | null {
  const literal = TABLE_LITERAL_RE.exec(line);
  if (literal) return { table: literal[1].toLowerCase() };
  MODEL_TYPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODEL_TYPE_RE.exec(line)) !== null) {
    const typeName = m[1] ?? m[2];
    if (!typeName) continue;
    const resolved = resolver.resolveEntity(typeName);
    if (resolved) return { table: resolved.table, schema: resolved.schema };
  }
  return null;
}

/**
 * Scan one `.go` source for GORM call sites resolvable to a physical table.
 * A line carrying a GORM finisher verb (`Find`/`Create`/…) AND a resolvable
 * model type / `.Table("…")` literal yields one {@link GormCallSite}; a write
 * verb anywhere on the line makes the whole line a `writes` (GORM chains put
 * the destructive verb last), else it is a `reads`.
 */
export function findGormCallSites(source: string, resolver: EntityTableResolver): GormCallSite[] {
  const out: GormCallSite[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    OP_CALL_RE.lastIndex = 0;
    let write: string | null = null;
    let read: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = OP_CALL_RE.exec(line)) !== null) {
      const op = m[1];
      if (GORM_WRITE_OPS.has(op)) write = op;
      else if (GORM_READ_OPS.has(op) && !read) read = op;
    }
    const op = write ?? read;
    if (!op) continue;
    const target = resolveLineTarget(line, resolver);
    if (!target) continue;
    out.push({ line: i + 1, op, kind: write ? "writes" : "reads", target });
  }
  return out;
}

/**
 * Persist `reads`/`writes` edges for one file's GORM call sites, anchored to
 * the REAL enclosing persisted Go function symbol — mirrors
 * `persistJooqCallSiteEdges` (#897) / `persistOrmCallSiteEdges` (#872). Call
 * sites with no enclosing symbol are skipped; this extractor never fabricates
 * origin symbols. Duplicate `(from, table, kind)` triples within the file are
 * deduped. Resolved edges carry `source = "orm"`. Returns the edge count.
 */
export async function persistGormCallSiteEdges(
  writer: SchemaGraphWriter,
  filePath: string,
  source: string,
  resolver: EntityTableResolver,
  symbols: readonly EnclosingSymbol[],
): Promise<number> {
  if (symbols.length === 0) return 0;
  const sites = findGormCallSites(source, resolver);
  if (sites.length === 0) return 0;
  const seen = new Set<string>();
  let edges = 0;
  for (const site of sites) {
    const from = enclosingSymbolFor(symbols, site.line);
    if (!from) continue;
    const qn = tableQualifiedName(site.target.schema, site.target.table);
    const dedupe = `${from.id}|${qn}|${site.kind}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const tableId = await writer.ensureTable(site.target.table, "orm", {
      schema: site.target.schema,
      filePath,
      line: site.line,
    });
    await writer.addEdge(from.id, site.kind, tableId, "orm", {
      toQualifiedName: qn,
      filePath,
      line: site.line,
    });
    edges++;
  }
  return edges;
}
