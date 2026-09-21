/**
 * JPA/Hibernate query-lineage extractor — Epic #883 (#896).
 *
 * `orm-extractor.ts` (#850) maps JPA entity SHAPE (`@Entity`/`@Table`/
 * `@Column`) onto tables/columns, but a requirement that touches a table only
 * ever reaches code through that entity's OWN declaration — HQL/JPQL queries
 * and Spring Data derived query methods reference entities by NAME (never the
 * physical table name) and had no path into the schema graph at all. This
 * module closes that gap for Spring Data repository interfaces:
 *
 *   1. {@link parseSpringDataRepositories} finds `interface X extends
 *      JpaRepository<Entity, Id>` (also `CrudRepository`/
 *      `PagingAndSortingRepository`/`ListCrudRepository`/
 *      `ListPagingAndSortingRepository`) declarations and their generic
 *      entity type parameter — the DEFAULT entity for every method the
 *      interface declares.
 *   2. {@link extractJpaQueries} scans each repository's body for two query
 *      shapes:
 *        - `@Query("...")` — HQL/JPQL. The entity + optional alias is parsed
 *          out of its `FROM`/`UPDATE` clause; `nativeQuery = true` queries
 *          are SKIPPED here by design — they contain real SQL, not JPQL, and
 *          are meant to fall through to the dialect-aware SQL-lineage path
 *          (Java raw JDBC SQL is Epic #880 / #888-#889, not yet wired) rather
 *          than being misinterpreted as an entity reference.
 *        - Spring Data **derived query methods** (`findBy…`/`existsBy…`/
 *          `countBy…`/`deleteBy…`/`removeBy…`, no `@Query`) — the entity is
 *          the repository's declared generic type; the property expression
 *          after `By` is split on `And`/`Or` and each segment's trailing
 *          Spring Data operator keyword (`GreaterThan`, `IgnoreCase`, `Null`,
 *          …) is stripped to recover a best-effort field name.
 *   3. Both shapes resolve their entity/field references through the
 *      framework-agnostic {@link EntityTableResolver} (`entity-resolver.ts`,
 *      #896) — this module contains NO table/column mapping logic of its
 *      own — and persist `reads`/`writes` edges from a synthetic per-query
 *      origin symbol, mirroring the MyBatis statement-origin pattern (#170).
 *      {@link persistJpaQueryOriginEdges} then connects the REAL repository
 *      interface method (already persisted by the Java parser) to that
 *      origin via an `executes` edge — the SAME two-hop shape
 *      `mybatis-callsite-extractor.ts` uses (#887) — so
 *      `service → (calls) → repository method → (executes) → query origin →
 *      (reads/writes) → table` reaches the schema graph from application
 *      code.
 *
 * Deliberately detection-only and regex-based, like every other extractor in
 * this directory: no real Java/JPQL grammar, no type resolution beyond a
 * same-file `extends JpaRepository<Entity, Id>` scan. Read-only — no SQL or
 * JPQL is ever executed.
 */
import type { EntityTableResolver } from "./entity-resolver.js";
import { sliceBraces } from "./orm-extractor.js";
import type { SchemaGraphWriter } from "./schema-graph.js";
import { columnQualifiedName, tableQualifiedName } from "./schema-graph.js";

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
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

// ---- Spring Data repository discovery --------------------------------------

/** One Spring Data repository interface and the entity type it's declared over. */
export interface SpringDataRepository {
  interfaceName: string;
  /** The repository's generic entity type parameter, e.g. `Customer` in `JpaRepository<Customer, Long>`. */
  entityRef: string;
  /** The interface body text (between `{` and its matching `}`). */
  body: string;
  /** Absolute character offset into the source file where `body` starts. */
  bodyOffset: number;
}

const REPO_EXTENDS_RE = /\binterface\s+(\w+)\s+extends\s+([^{]+)\{/g;
const REPO_BASE_RE =
  /\b(?:Jpa|ListCrud|ListPagingAndSorting|Crud|PagingAndSorting)Repository\s*<\s*(\w+)\s*,/;

/**
 * Scan a `.java` source for Spring Data repository interface declarations,
 * capturing each one's generic entity type parameter. An interface that
 * doesn't extend one of the standard Spring Data base repositories (e.g. a
 * plain marker interface, or one extending only a custom base) is skipped —
 * this extractor never guesses the entity type.
 */
export function parseSpringDataRepositories(content: string): SpringDataRepository[] {
  const out: SpringDataRepository[] = [];
  REPO_EXTENDS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REPO_EXTENDS_RE.exec(content)) !== null) {
    const base = REPO_BASE_RE.exec(m[2]);
    if (!base) continue;
    const openBraceIdx = m.index + m[0].length - 1;
    const body = sliceBraces(content, openBraceIdx);
    out.push({
      interfaceName: m[1],
      entityRef: base[1],
      body,
      bodyOffset: openBraceIdx + 1,
    });
  }
  return out;
}

// ---- @Query (HQL/JPQL) parsing ----------------------------------------------

/** JPQL/HQL keywords that can immediately follow an aliasless entity reference — never a real alias. */
const JPQL_RESERVED = new Set([
  "where",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "group",
  "order",
  "set",
  "fetch",
]);

function jpqlStatementKind(jpql: string): "reads" | "writes" {
  const t = jpql.trim();
  return /^(update|delete)\b/i.test(t) ? "writes" : "reads";
}

/** Parse the entity reference (and optional alias) out of a JPQL `FROM`/`UPDATE` clause. */
function extractJpqlEntityRef(jpql: string): { entityRef: string; alias: string | null } | null {
  const t = jpql.trim();
  const m =
    /\bfrom\s+([A-Za-z_][\w.]*)\s*(?:as\s+)?([A-Za-z_]\w*)?/i.exec(t) ??
    /^\s*update\s+([A-Za-z_][\w.]*)\s*(?:as\s+)?([A-Za-z_]\w*)?/i.exec(t);
  if (!m) return null;
  let alias: string | null = m[2] ?? null;
  if (alias && JPQL_RESERVED.has(alias.toLowerCase())) alias = null;
  return { entityRef: m[1], alias };
}

/** Every distinct `<alias>.<field>` reference in the JPQL text, in first-seen order. */
function extractAliasFieldRefs(jpql: string, alias: string): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  const needle = `${alias}.`;
  let idx = 0;
  while ((idx = jpql.indexOf(needle, idx)) !== -1) {
    const before = idx > 0 ? jpql[idx - 1] : "";
    if (/\w/.test(before)) {
      idx += needle.length;
      continue;
    }
    const after = idx + needle.length;
    const fieldMatch = /^[A-Za-z_]\w*/.exec(jpql.slice(after));
    if (!fieldMatch) {
      idx += needle.length;
      continue;
    }
    const field = fieldMatch[0];
    if (!seen.has(field)) {
      seen.add(field);
      fields.push(field);
    }
    idx = after + field.length;
  }
  return fields;
}

/** Skip annotations immediately after an `@Query(...)` call and return the next method name + its parameter-list `(` index. */
function skipAnnotationsAndFindMethodName(
  body: string,
  fromIdx: number,
): { methodName: string; idx: number } | null {
  let i = fromIdx;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] === "@") {
      let j = i + 1;
      while (j < body.length && /\w/.test(body[j])) j++;
      if (body[j] === "(") {
        const close = findMatchingParen(body, j);
        if (close === -1) return null;
        i = close + 1;
        continue;
      }
      i = j;
      continue;
    }
    break;
  }
  const parenIdx = body.indexOf("(", i);
  if (parenIdx === -1) return null;
  const sig = body.slice(i, parenIdx);
  const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(sig);
  if (!nameMatch) return null;
  return { methodName: nameMatch[1], idx: parenIdx };
}

// ---- Spring Data derived query methods --------------------------------------

type DerivedQueryPrefix =
  | "findBy"
  | "readBy"
  | "getBy"
  | "queryBy"
  | "streamBy"
  | "existsBy"
  | "countBy"
  | "deleteBy"
  | "removeBy";

const DERIVED_METHOD_RE =
  /\b(findBy|readBy|getBy|queryBy|streamBy|existsBy|countBy|deleteBy|removeBy)([A-Z]\w*)\s*\(/g;

const AND_OR_BOUNDARY = /(?<=[a-z0-9])(?:And|Or)(?=[A-Z])/;

// Longest-first so a compound suffix (`IsNotNull`) strips whole before a
// shorter one that's also technically a suffix of it (`NotNull`, `Null`).
const OPERATOR_SUFFIXES = [
  "IsNotNull",
  "NotNull",
  "IsNull",
  "Null",
  "GreaterThanEqual",
  "GreaterThan",
  "LessThanEqual",
  "LessThan",
  "IsNotIn",
  "NotIn",
  "In",
  "StartingWith",
  "EndingWith",
  "IgnoreCase",
  "Containing",
  "NotLike",
  "Like",
  "IsNot",
  "Not",
  "Between",
  "After",
  "Before",
  "True",
  "False",
] as const;

function stripOperatorSuffixes(segment: string): string {
  let s = segment;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of OPERATOR_SUFFIXES) {
      if (s.length > suffix.length && s.endsWith(suffix)) {
        s = s.slice(0, s.length - suffix.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}

// ---- Combined extraction -----------------------------------------------------

/** One resolvable query statement found on a Spring Data repository interface. */
export interface JpaQueryStatement {
  methodName: string;
  kind: "reads" | "writes";
  entityRef: string;
  /** Best-effort field names referenced by the statement (may be empty). */
  fields: string[];
  line: number;
}

/**
 * Extract every resolvable `@Query`/derived-query statement from a `.java`
 * source's Spring Data repository interfaces. `nativeQuery = true` `@Query`
 * methods are intentionally excluded from the result (see module doc) — they
 * never produce a {@link JpaQueryStatement}.
 */
export function extractJpaQueries(content: string): JpaQueryStatement[] {
  const repos = parseSpringDataRepositories(content);
  const out: JpaQueryStatement[] = [];
  for (const repo of repos) {
    const claimed = new Set<string>();

    // Pass 1 — @Query-annotated methods.
    let searchFrom = 0;
    for (;;) {
      const at = repo.body.indexOf("@Query", searchFrom);
      if (at === -1) break;
      const openParen = repo.body.indexOf("(", at);
      if (openParen === -1) {
        searchFrom = at + "@Query".length;
        continue;
      }
      const closeParen = findMatchingParen(repo.body, openParen);
      if (closeParen === -1) {
        searchFrom = at + "@Query".length;
        continue;
      }
      searchFrom = closeParen + 1;
      const sig = skipAnnotationsAndFindMethodName(repo.body, closeParen + 1);
      if (!sig) continue;
      claimed.add(sig.methodName);

      const argsText = repo.body.slice(openParen + 1, closeParen);
      if (/nativeQuery\s*=\s*true/.test(argsText)) continue; // falls through to the SQL path
      const stringMatch = /["']((?:[^"'\\]|\\.)*)["']/.exec(argsText);
      if (!stringMatch) continue;
      const jpql = stringMatch[1];
      const ref = extractJpqlEntityRef(jpql);
      if (!ref) continue;

      out.push({
        methodName: sig.methodName,
        kind: jpqlStatementKind(jpql),
        entityRef: ref.entityRef,
        fields: ref.alias ? extractAliasFieldRefs(jpql, ref.alias) : [],
        line: lineOf(content, repo.bodyOffset + at),
      });
    }

    // Pass 2 — Spring Data derived-query methods (no @Query annotation).
    DERIVED_METHOD_RE.lastIndex = 0;
    let d: RegExpExecArray | null;
    while ((d = DERIVED_METHOD_RE.exec(repo.body)) !== null) {
      const prefix = d[1] as DerivedQueryPrefix;
      const rest = d[2];
      const methodName = `${prefix}${rest}`;
      if (claimed.has(methodName)) continue;
      const kind: "reads" | "writes" =
        prefix === "deleteBy" || prefix === "removeBy" ? "writes" : "reads";
      const fields = rest
        .split(AND_OR_BOUNDARY)
        .map((seg) => stripOperatorSuffixes(seg))
        .filter((seg) => seg.length > 0)
        .map(lowerFirst);
      out.push({
        methodName,
        kind,
        entityRef: repo.entityRef,
        fields,
        line: lineOf(content, repo.bodyOffset + d.index),
      });
    }
  }
  return out;
}

// ---- Persistence -------------------------------------------------------------

/** One JPA query's synthetic origin symbol, as created by {@link persistJpaQueryFile}. */
export interface JpaQueryOrigin {
  symbolId: string;
  filePath: string;
  methodName: string;
  qualifiedName: string;
  line: number;
}

/**
 * Persist `reads`/`writes` edges for one file's JPA query statements, each
 * anchored to its OWN synthetic origin symbol (mirroring the MyBatis
 * statement-origin shape, #170) rather than the real repository method — the
 * real method is connected to that origin separately, by
 * {@link persistJpaQueryOriginEdges}. A statement whose entity reference
 * doesn't resolve via `resolver` (unknown entity, or one the resolver
 * couldn't disambiguate) is skipped: no edge is fabricated. Field references
 * that don't resolve to a column are silently dropped — the statement still
 * gets its table-level edge. Returns the number of edges written.
 */
export async function persistJpaQueryFile(
  writer: SchemaGraphWriter,
  resolver: EntityTableResolver,
  filePath: string,
  content: string,
  origins: JpaQueryOrigin[],
): Promise<number> {
  const statements = extractJpaQueries(content);
  if (statements.length === 0) return 0;
  let edges = 0;
  for (const stmt of statements) {
    const target = resolver.resolveEntity(stmt.entityRef);
    if (!target) continue;
    const qualifiedName = `${filePath}::${stmt.methodName}#jpa-query`;
    const originId = await writer.createOriginSymbol(
      "method",
      stmt.methodName,
      qualifiedName,
      filePath,
      stmt.line,
    );
    origins.push({
      symbolId: originId,
      filePath,
      methodName: stmt.methodName,
      qualifiedName,
      line: stmt.line,
    });

    const tableId = await writer.ensureTable(target.table, "orm", {
      schema: target.schema,
      filePath,
      line: stmt.line,
    });
    await writer.addEdge(originId, stmt.kind, tableId, "orm", {
      toQualifiedName: tableQualifiedName(target.schema, target.table),
      filePath,
      line: stmt.line,
    });
    edges++;

    for (const field of stmt.fields) {
      const col = resolver.resolveField(stmt.entityRef, field);
      if (!col) continue;
      const colId = await writer.ensureColumn(col.table, col.column, "orm", {
        schema: col.schema,
        filePath,
        line: stmt.line,
      });
      await writer.addEdge(originId, stmt.kind, colId, "orm", {
        toQualifiedName: columnQualifiedName(col.schema, col.table, col.column),
        filePath,
        line: stmt.line,
      });
      edges++;
    }
  }
  return edges;
}

/**
 * Connect each JPA query's synthetic origin symbol to the REAL repository
 * interface method it belongs to, via an `executes` edge (the same kind used
 * for MyBatis statement origins, #887, and code→routine crossings, #301) —
 * so a requirement crossing into application code reaches the query's
 * table/column edges. A query whose repository file has no matching real
 * `method` symbol (name mismatch, unparsed file) is silently skipped.
 */
export async function persistJpaQueryOriginEdges(
  writer: SchemaGraphWriter,
  origins: readonly JpaQueryOrigin[],
  methodSymbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
): Promise<number> {
  let edges = 0;
  for (const origin of origins) {
    const methodSymbolId = methodSymbolsByFile.get(origin.filePath)?.get(origin.methodName);
    if (!methodSymbolId) continue;
    await writer.addEdge(methodSymbolId, "executes", origin.symbolId, "orm", {
      toQualifiedName: origin.qualifiedName,
      filePath: origin.filePath,
      line: origin.line,
    });
    edges++;
  }
  return edges;
}
