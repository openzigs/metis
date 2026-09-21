/**
 * MyBatis mapper call-site extractor — Issue #887 (Epic #879 follow-up).
 *
 * The MyBatis extractor (#170/#884) maps each `<select|insert|update|delete>`
 * statement (or `@Select`/`@Insert`/`@Update`/`@Delete` annotated interface
 * method) onto a SYNTHETIC per-statement origin symbol
 * ({@link SchemaGraphWriter.createOriginSymbol}), with `reads`/`writes`/
 * `persists-to` edges pointing from that origin to the tables/columns the
 * statement touches. That origin symbol has no connection to the REAL Java
 * mapper interface method it belongs to, so a requirement crossing into
 * Java service code could never reach the statement (and therefore never
 * reach the tables) — the same disconnection #872 closed for Prisma ORM
 * call sites.
 *
 * This module closes the gap in two hops, mirroring `orm-callsite-extractor.ts`:
 *
 *   1. **Statement → interface method** (`persistMyBatisStatementOriginEdges`).
 *      A MyBatis statement's `namespace` is the mapper interface's FQCN
 *      (`<mapper namespace="com.acme.FooMapper">`, or the annotated
 *      interface's own `package.Interface`); `statementId` is the method
 *      name (`<select id="findAccount">` ⇔ `FooMapper.findAccount`). Once
 *      the FQCN is resolved to the REAL Java interface's file
 *      ({@link buildJavaMapperIndex}) and the method name resolved to the
 *      REAL persisted `method` {@link CodeSymbol} in that file, an
 *      `executes` edge (the same kind already used for code→routine
 *      crossings, Epic #293 Phase 2) is written from that real method
 *      symbol to the statement's synthetic origin — so a BFS starting at
 *      the Java method symbol reaches the statement's `reads`/`writes`/
 *      `persists-to` edges for free via {@link SCHEMA_IMPACT_EDGE_KINDS}.
 *
 *   2. **Java caller → interface method** (`persistMapperCallerEdges`).
 *      Scans parsed `.java` source for `<var>.<method>(...)` invocations
 *      whose `<var>` was declared (field, constructor param, or local) with
 *      a KNOWN mapper interface type, and emits an ordinary `calls` edge
 *      (an everyday code-graph edge, `source: null` — NOT a schema edge)
 *      from the enclosing caller symbol to the mapper interface's real
 *      method symbol. This is more precise than the generic project-wide
 *      by-name resolver in `ingest.ts`'s `persistParsed` (which only binds
 *      a bare `method_invocation` callee when the name is GLOBALLY unique)
 *      because it is type-aware: two different mapper interfaces with a
 *      same-named method (`findById` is common) are disambiguated by the
 *      receiver's declared type.
 *
 * Together: `service → (calls) → FooMapper.findAccount → (executes) →
 * statement origin → (reads) → accounts table`.
 *
 * Deliberately detection-only and static, like its ORM counterpart: no Java
 * type resolution beyond a same-file field/param/local declaration scan, no
 * inheritance/generics handling. A mapper field declared in one file and
 * assigned in another (unusual for MyBatis DI patterns) is not detected.
 */
import type { EnclosingSymbol } from "./orm-callsite-extractor.js";
import { enclosingSymbolFor } from "./orm-callsite-extractor.js";
import type { SchemaGraphWriter } from "./schema-graph.js";

/** A Java mapper interface discovered from a captured `.java` source file. */
export interface JavaMapperInterface {
  /** `package.InterfaceName`, or just `InterfaceName` when no `package` statement is present. */
  fqcn: string;
  /** The repo-relative path of the `.java` file declaring the interface. */
  filePath: string;
  /** The bare interface name (e.g. `FooMapper`). */
  simpleName: string;
}

const PACKAGE_RE = /\bpackage\s+([A-Za-z_][\w.]*)\s*;/;
const INTERFACE_RE = /\binterface\s+([A-Za-z_]\w*)/;

/**
 * Scan captured `.java` sources for interface declarations and index them by
 * FQCN (`package.Interface`) — the same identity MyBatis statement
 * `namespace`s use. Non-`.java` files (XML mappers) and `.java` files with no
 * `interface` declaration (plain classes) are skipped. When more than one
 * `.java` file declares the same FQCN (should not happen in a well-formed
 * project) the LAST one scanned wins — callers pass a `Map` so iteration
 * order is insertion order, which is deterministic per ingest.
 */
export function buildJavaMapperIndex(
  javaSources: ReadonlyMap<string, string>,
): Map<string, JavaMapperInterface> {
  const index = new Map<string, JavaMapperInterface>();
  for (const [filePath, content] of javaSources) {
    if (!/\.java$/i.test(filePath)) continue;
    const iface = INTERFACE_RE.exec(content);
    if (!iface) continue;
    const simpleName = iface[1];
    const pkg = PACKAGE_RE.exec(content);
    const fqcn = pkg ? `${pkg[1]}.${simpleName}` : simpleName;
    index.set(fqcn, { fqcn, filePath, simpleName });
  }
  return index;
}

/** Minimal Prisma surface needed to resolve real `method` symbols by file. */
export interface MapperSymbolLookupPrisma {
  codeSymbol: {
    findMany(args: {
      where: { codeGraphId: string; filePath: { in: string[] }; kind: { in: string[] } };
      select: { id: true; filePath: true; name: true };
    }): Promise<Array<{ id: string; filePath: string; name: string }>>;
  };
}

/**
 * Bulk-resolve the real persisted `method` symbols declared in the given
 * mapper interface files, indexed by `filePath -> methodName -> symbolId`.
 * One query for however many mapper files were discovered (mirrors the ORM
 * call-site pass's single bulk `codeSymbol.findMany`). Overloaded method
 * names within one file collapse onto the first-seen id — MyBatis mapper
 * interfaces cannot have overloaded methods (statement ids must be unique
 * per namespace), so this is not expected to matter in practice.
 */
export async function buildMapperMethodSymbolIndex(
  prisma: MapperSymbolLookupPrisma,
  codeGraphId: string,
  mapperFilePaths: readonly string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (mapperFilePaths.length === 0) return out;
  const rows = await prisma.codeSymbol.findMany({
    where: {
      codeGraphId,
      filePath: { in: [...new Set(mapperFilePaths)] },
      kind: { in: ["method"] },
    },
    select: { id: true, filePath: true, name: true },
  });
  for (const row of rows) {
    const byName = out.get(row.filePath) ?? new Map<string, string>();
    if (!byName.has(row.name)) byName.set(row.name, row.id);
    out.set(row.filePath, byName);
  }
  return out;
}

/** One MyBatis statement's synthetic origin symbol, as created by `persistMyBatisFile`. */
export interface MyBatisStatementOrigin {
  /** The id of the synthetic `method`-kind origin symbol `persistMyBatisFile` created. */
  symbolId: string;
  namespace: string | null;
  statementId: string;
  qualifiedName: string;
  line: number;
}

/**
 * Hop 1 — connect each MyBatis statement's synthetic origin symbol to the
 * REAL Java interface method symbol it belongs to, via an `executes` edge
 * (code invokes statement, same semantic already used for code→routine
 * crossings). A statement with no `namespace`, an unresolvable mapper FQCN,
 * or no matching method symbol in that mapper's file is silently skipped —
 * this pass is purely additive and never removes the statement's existing
 * table/column edges.
 */
export async function persistMyBatisStatementOriginEdges(
  writer: SchemaGraphWriter,
  origins: readonly MyBatisStatementOrigin[],
  javaMapperIndex: ReadonlyMap<string, JavaMapperInterface>,
  methodSymbolsByFile: ReadonlyMap<string, Map<string, string>>,
): Promise<number> {
  let edges = 0;
  for (const origin of origins) {
    if (!origin.namespace) continue;
    const mapper = javaMapperIndex.get(origin.namespace);
    if (!mapper) continue;
    const methodSymbolId = methodSymbolsByFile.get(mapper.filePath)?.get(origin.statementId);
    if (!methodSymbolId) continue;
    await writer.addEdge(methodSymbolId, "executes", origin.symbolId, "mybatis", {
      toQualifiedName: origin.qualifiedName,
      filePath: mapper.filePath,
      line: origin.line,
    });
    edges++;
  }
  return edges;
}

/**
 * Combine the mapper FQCN index with the resolved method-symbol index into a
 * single `mapperSimpleName -> methodName -> symbolId` lookup — what a Java
 * call-site scan needs, since a call site only knows the receiver's declared
 * TYPE NAME (`FooMapper`), not its FQCN.
 */
export function buildMapperMethodsBySimpleName(
  javaMapperIndex: ReadonlyMap<string, JavaMapperInterface>,
  methodSymbolsByFile: ReadonlyMap<string, Map<string, string>>,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const mapper of javaMapperIndex.values()) {
    const methods = methodSymbolsByFile.get(mapper.filePath);
    if (methods && methods.size > 0) out.set(mapper.simpleName, methods);
  }
  return out;
}

// Field / constructor-param / local-variable declaration of a capitalized
// type immediately followed by `;`, `=`, or `)` — e.g. `private FooMapper
// fooMapper;`, `FooMapper fooMapper = ...`, `(FooMapper fooMapper)`. A
// method signature (`Account findAccount(long id)`) is never matched: the
// identifier following the type is immediately followed by `(`, which is
// deliberately excluded from the delimiter class.
const FIELD_DECL_RE = /\b([A-Z][\w]*)\s+([a-zA-Z_]\w*)\s*[;=)]/g;

/** Scan one Java source for variable declarations typed as a known mapper interface. */
export function findMapperFieldTypes(
  source: string,
  mapperNames: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (mapperNames.size === 0) return out;
  FIELD_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIELD_DECL_RE.exec(source)) !== null) {
    const [, typeName, varName] = m;
    if (mapperNames.has(typeName)) out.set(varName, typeName);
  }
  return out;
}

/** A `<mapperVar>.<method>(...)` invocation site against a variable of known mapper type. */
export interface MapperCallSite {
  line: number;
  varName: string;
  methodName: string;
  mapperSimpleName: string;
}

// `<receiver>.<method>(` — single dot, receiver-agnostic; filtered against the
// per-file field-type map so only known-mapper receivers survive.
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Find every mapper method invocation in one Java source, i.e. every
 * `<var>.<method>(...)` call site whose `<var>` was declared with a type in
 * `mapperNames`. Two-pass: first collect the file's mapper-typed variable
 * declarations, then scan call sites against that map.
 */
export function findMapperCallSites(
  source: string,
  mapperNames: ReadonlySet<string>,
): MapperCallSite[] {
  const fieldTypes = findMapperFieldTypes(source, mapperNames);
  if (fieldTypes.size === 0) return [];
  const out: MapperCallSite[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(lines[i])) !== null) {
      const [, varName, methodName] = m;
      const mapperSimpleName = fieldTypes.get(varName);
      if (!mapperSimpleName) continue;
      out.push({ line: i + 1, varName, methodName, mapperSimpleName });
    }
  }
  return out;
}

/** Minimal Prisma surface needed to persist an ordinary (non-schema) `calls` edge. */
export interface CallEdgePrisma {
  codeEdge: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Hop 2 — persist ordinary `calls` edges (source: null, an everyday
 * code-graph edge — NOT a schema edge) from the enclosing Java caller symbol
 * to the mapper interface's REAL method symbol, anchored to the narrowest
 * persisted `function`/`method` symbol containing the call site (mirrors
 * `persistOrmCallSiteEdges`'s `enclosingSymbolFor`). A call site with no
 * enclosing symbol, or whose mapper/method isn't in `methodsBySimpleName`, is
 * skipped. Returns the number of edges written; duplicate `(from, to)` pairs
 * within the file are deduped.
 */
export async function persistMapperCallerEdges(
  prisma: CallEdgePrisma,
  codeGraphId: string,
  projectId: string,
  filePath: string,
  source: string,
  methodsBySimpleName: ReadonlyMap<string, ReadonlyMap<string, string>>,
  symbols: readonly EnclosingSymbol[],
): Promise<number> {
  const mapperNames = new Set(methodsBySimpleName.keys());
  const sites = findMapperCallSites(source, mapperNames);
  if (sites.length === 0 || symbols.length === 0) return 0;
  const seen = new Set<string>();
  let edges = 0;
  for (const site of sites) {
    const targetId = methodsBySimpleName.get(site.mapperSimpleName)?.get(site.methodName);
    if (!targetId) continue;
    const from = enclosingSymbolFor(symbols, site.line);
    if (!from) continue;
    const dedupe = `${from.id}|${targetId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    await prisma.codeEdge.create({
      data: {
        codeGraphId,
        projectId,
        kind: "calls",
        fromSymbolId: from.id,
        toSymbolId: targetId,
        toQualifiedName: `${site.mapperSimpleName}.${site.methodName}`,
        filePath,
        line: site.line,
        source: null,
      },
    });
    edges++;
  }
  return edges;
}
