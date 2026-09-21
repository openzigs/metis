/**
 * jOOQ generated table-class lineage extractor — Issue #897 (Epic #883).
 *
 * jOOQ code generation emits a Java class PER TABLE (`class Book extends
 * TableImpl<BookRecord>`) carrying a self-registering singleton constant
 * (`public static final Book BOOK = new Book();`) that application code then
 * references fluently through `DSLContext` (`.select(...).from(BOOK)`,
 * `.insertInto(BOOK)...`). There is no SQL string to parse — mapping a query
 * to a physical table is pure SYMBOL RESOLUTION: resolve the referenced
 * constant back to the physical table name the generated class carries (from
 * an explicit `getName()` override, its self-registration `DSL.name(...)`
 * call, a legacy `super(...)` string literal, or — failing all three — the
 * UPPER_SNAKE_CASE convention jOOQ's generator applies to the class name
 * itself), then anchor a `reads`/`writes` edge from the REAL enclosing code
 * symbol to that table. Mirrors the #872 ORM call-site pattern.
 *
 * Deliberately its OWN module, independent of the #896 entity->physical-table
 * resolver: jOOQ table classes are GENERATED query-builder handles, not
 * user-authored persistence declarations (unlike a JPA `@Entity` or a
 * MyBatis mapper statement). So — unlike the ORM/MyBatis schema passes —
 * this extractor never emits an edge for a generated class that no
 * application code actually queries: table nodes materialize lazily, exactly
 * where a DSL call site resolves against them.
 *
 * Scope note — jOOQ runtime schema render-mapping: jOOQ can remap a generated
 * class's compile-time schema to a different physical schema at RUNTIME via
 * `Settings.withRenderMapping(...)`. That mapping lives in a runtime
 * `Configuration`, not in the generated source, so it is NOT statically
 * resolvable and is explicitly OUT OF SCOPE here. Tables are recorded
 * schema-less (canonical identity = the bare table name); live-DB
 * reconciliation (`source = "live-db"`, ranked above `jooq` in
 * `SCHEMA_SOURCE_PRECEDENCE`) is the intended source of truth once a
 * schema-qualified identity is needed.
 *
 * Known limitation shared with the #872 ORM call-site scanner: matching is
 * line-based, so a DSL call whose arguments span multiple lines
 * (`.from(\n  BOOK\n)`) is not detected.
 */
import type { SchemaGraphWriter } from "./schema-graph.js";
import { tableQualifiedName } from "./schema-graph.js";
import { enclosingSymbolFor, type EnclosingSymbol } from "./orm-callsite-extractor.js";

export interface JooqTableTarget {
  table: string;
  /** Always undefined — see the runtime render-mapping scope note above. */
  schema?: string;
}

/** One generated jOOQ table-class constant resolved to its physical table. */
export interface JooqTableClass {
  className: string;
  constantName: string;
  target: JooqTableTarget;
  line: number;
}

/** Convert a PascalCase/camelCase identifier to jOOQ's UPPER_SNAKE_CASE convention. */
export function toUpperSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Return the `{...}` block starting at `openBraceIndex` (balanced). */
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

/**
 * Resolve one generated table class's physical table name from its body, in
 * the priority order the issue calls out: an explicit `getName()` override
 * (unambiguous — the class asserting its own name directly), the generator's
 * self-registration `DSL.name("...")`**, null)** delegating-constructor call
 * — the unaliased/no-parameters signature current jOOQ codegen emits for the
 * zero-arg public constructor, distinguishing it from the many other
 * `DSL.name(...)` calls a generated class carries for its `TableField`
 * column definitions — a legacy `super("...", ...)` string literal (older
 * jOOQ major versions passed the table name directly to `super`), and —
 * failing all three — the UPPER_SNAKE_CASE convention jOOQ applies to the
 * class name itself (e.g. `AuthorBook` -> `AUTHOR_BOOK`).
 */
function resolvePhysicalTableName(className: string, body: string): string {
  const getName = /\bgetName\s*\([^)]*\)\s*\{[^}]*\breturn\s+"([^"]+)"/.exec(body);
  if (getName) return getName[1];
  const selfRegister = /DSL\s*\.\s*name\s*\(\s*"([^"]+)"\s*\)\s*,\s*null\s*\)/.exec(body);
  if (selfRegister) return selfRegister[1];
  const legacySuper = /\bsuper\s*\(\s*"([^"]+)"/.exec(body);
  if (legacySuper) return legacySuper[1];
  return toUpperSnakeCase(className);
}

const TABLE_CLASS_RE = /\bclass\s+(\w+)\s+extends\s+TableImpl\s*<[^>]*>\s*\{/g;
// Self-registering singleton constant declared inside the table class itself,
// e.g. `public static final Book BOOK = new Book();`.
const SELF_CONST_RE = /\bpublic\s+static\s+final\s+(\w+)\s+(\w+)\s*=\s*new\s+\1\s*\(\s*\)\s*;/;

/** Parse ONE Java source file for jOOQ generated table-class definitions. */
export function extractJooqTableClasses(content: string): JooqTableClass[] {
  if (!/\bextends\s+TableImpl\b/.test(content)) return [];
  const out: JooqTableClass[] = [];
  TABLE_CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_CLASS_RE.exec(content)) !== null) {
    const className = m[1];
    const bodyStart = m.index + m[0].length - 1;
    const body = sliceBraces(content, bodyStart);
    const table = resolvePhysicalTableName(className, body).toLowerCase();
    const selfConst = SELF_CONST_RE.exec(body);
    const constantName =
      selfConst && selfConst[1] === className ? selfConst[2] : toUpperSnakeCase(className);
    out.push({
      className,
      constantName,
      target: { table },
      line: lineOf(content, m.index),
    });
  }
  return out;
}

/**
 * Build the `constantName -> physical table` map from ALL captured generated
 * table-class files. First registration wins so an aggregator file (jOOQ's
 * `Tables.java`, which re-exports each per-table class's constant and does
 * NOT itself extend `TableImpl`) never overrides the per-class definition —
 * in practice both resolve to the same identifier anyway.
 */
export function buildJooqTableMap(
  jooqSources: ReadonlyMap<string, string>,
): Map<string, JooqTableTarget> {
  const map = new Map<string, JooqTableTarget>();
  for (const content of jooqSources.values()) {
    for (const cls of extractJooqTableClasses(content)) {
      if (!map.has(cls.constantName)) map.set(cls.constantName, cls.target);
    }
  }
  return map;
}

/** jOOQ DSL verbs that READ table data via a positional `Table` argument. */
export const JOOQ_READ_OPS = new Set([
  "from",
  "join",
  "innerJoin",
  "leftJoin",
  "leftOuterJoin",
  "leftSemiJoin",
  "leftAntiJoin",
  "rightJoin",
  "rightOuterJoin",
  "fullJoin",
  "fullOuterJoin",
  "crossJoin",
  "naturalJoin",
  "naturalLeftOuterJoin",
  "naturalRightOuterJoin",
  "naturalFullOuterJoin",
]);

/** jOOQ DSL verbs that WRITE table data via a positional `Table` argument. */
export const JOOQ_WRITE_OPS = new Set(["insertInto", "update", "deleteFrom", "mergeInto"]);

export interface JooqCallSite {
  line: number;
  /** The matched table constant identifier (last segment of a qualified reference). */
  constant: string;
  op: string;
  kind: "reads" | "writes";
  target: JooqTableTarget;
}

const CALL_RE = /\.\s*(\w+)\s*\(([^)]*)\)/g;
// A bare or dot-qualified identifier — `BOOK`, `Tables.BOOK`, `Book.BOOK` — and
// nothing else (rejects string literals, nested calls, expressions).
const IDENT_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Scan one source file for jOOQ DSL call sites against known generated table constants. */
export function findJooqCallSites(
  source: string,
  tables: ReadonlyMap<string, JooqTableTarget>,
): JooqCallSite[] {
  if (tables.size === 0) return [];
  const out: JooqCallSite[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(lines[i])) !== null) {
      const [, op, argsRaw] = m;
      const kind = JOOQ_WRITE_OPS.has(op) ? "writes" : JOOQ_READ_OPS.has(op) ? "reads" : null;
      if (!kind) continue;
      for (const rawArg of argsRaw.split(",")) {
        const arg = rawArg.trim();
        if (!arg || !IDENT_RE.test(arg)) continue;
        const constant = arg.split(".").pop() as string;
        const target = tables.get(constant);
        if (!target) continue;
        out.push({ line: i + 1, constant, op, kind, target });
      }
    }
  }
  return out;
}

/**
 * Persist `reads`/`writes` edges for one file's jOOQ DSL call sites, anchored
 * to the REAL enclosing persisted code symbol — mirrors
 * `persistOrmCallSiteEdges` (#872). Call sites with no enclosing
 * function/method symbol are skipped; this extractor never fabricates origin
 * symbols. Returns the number of edges written; duplicate `(from, table,
 * kind)` pairs within the file are deduped.
 */
export async function persistJooqCallSiteEdges(
  writer: SchemaGraphWriter,
  filePath: string,
  source: string,
  tables: ReadonlyMap<string, JooqTableTarget>,
  symbols: readonly EnclosingSymbol[],
): Promise<number> {
  const sites = findJooqCallSites(source, tables);
  if (sites.length === 0 || symbols.length === 0) return 0;
  const seen = new Set<string>();
  let edges = 0;
  for (const site of sites) {
    const from = enclosingSymbolFor(symbols, site.line);
    if (!from) continue;
    const qn = tableQualifiedName(site.target.schema, site.target.table);
    const dedupe = `${from.id}\u0000${qn}\u0000${site.kind}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const tableId = await writer.ensureTable(site.target.table, "jooq", {
      schema: site.target.schema,
      filePath,
      line: site.line,
    });
    await writer.addEdge(from.id, site.kind, tableId, "jooq", {
      toQualifiedName: qn,
      filePath,
      line: site.line,
    });
    edges++;
  }
  return edges;
}
