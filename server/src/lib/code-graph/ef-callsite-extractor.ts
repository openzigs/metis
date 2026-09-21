/**
 * EF Core DbSet/LINQ call-site extractor — Issue #900 (Epic #883).
 *
 * The EF entity resolver (`entity-resolver.ts`'s {@link buildEfCoreEntityResolver})
 * knows what physical table an entity CLASS maps onto, but application code
 * reaches a table through a `DbSet<T>` property on the `DbContext`
 * (`context.Customers.Where(...)`, `context.Customers.Add(...)`). This module
 * scans parsed `.cs` source for those call sites and emits a `reads`/`writes`
 * edge FROM the enclosing REAL persisted code symbol (the method a requirement
 * mapper can hit) TO the DbSet's resolved table — the direct .NET analogue of
 * the Prisma (#872) and jOOQ (#897) call-site scanners.
 *
 * Table resolution goes THROUGH the shared {@link EntityTableResolver}: a
 * `DbSet<Customer> Customers` declaration links the property `Customers` to the
 * entity `Customer`, and the resolver maps `Customer` to its table. So this
 * extractor contains no table-mapping logic of its own, and an edge is emitted
 * only for a DbSet whose entity the resolver could resolve (unknown/ambiguous
 * entities are skipped, never guessed). Both the property AND the operation must
 * match, so an unrelated `foo.Where(...)` never produces an edge unless `foo` is
 * also a known DbSet property. Edges carry `source = "orm"` (the EF mapping is a
 * user-authored persistence declaration, same provenance tier as JPA).
 *
 * Deliberately detection-only and static, like every sibling extractor: the
 * receiver is ignored (`context.Customers` / `_db.Customers` / `this.Db.Customers`
 * all match) and no types are resolved beyond the same-project DbSet scan.
 * Read-only — no SQL is executed.
 */
import type { EntityTableResolver } from "./entity-resolver.js";
import { parseEfDbSets } from "./ef-extractor.js";
import { enclosingSymbolFor, type EnclosingSymbol } from "./orm-callsite-extractor.js";
import type { SchemaGraphWriter } from "./schema-graph.js";
import { tableQualifiedName } from "./schema-graph.js";

/** EF/LINQ terminal + query operators that READ table data through a DbSet. */
export const EF_READ_OPS = new Set([
  "Where",
  "Find",
  "FindAsync",
  "First",
  "FirstOrDefault",
  "FirstAsync",
  "FirstOrDefaultAsync",
  "Single",
  "SingleOrDefault",
  "SingleAsync",
  "SingleOrDefaultAsync",
  "Last",
  "LastOrDefault",
  "Any",
  "AnyAsync",
  "All",
  "Count",
  "CountAsync",
  "LongCount",
  "ToList",
  "ToListAsync",
  "ToArray",
  "ToArrayAsync",
  "ToDictionary",
  "AsEnumerable",
  "AsQueryable",
  "AsNoTracking",
  "Select",
  "SelectMany",
  "OrderBy",
  "OrderByDescending",
  "GroupBy",
  "Include",
  "Sum",
  "Min",
  "Max",
  "Average",
  "Contains",
]);

/** EF change-tracking operations that WRITE table data through a DbSet. */
export const EF_WRITE_OPS = new Set([
  "Add",
  "AddAsync",
  "AddRange",
  "AddRangeAsync",
  "Remove",
  "RemoveRange",
  "Update",
  "UpdateRange",
  "Attach",
  "AttachRange",
]);

/** The physical table a resolved DbSet property maps onto. */
export interface EfDbSetTarget {
  table: string;
  schema?: string;
}

/**
 * Build the `DbSetProperty -> physical table` map from ALL captured `.cs`
 * sources, resolving each DbSet's entity type THROUGH the shared resolver. A
 * DbSet whose entity the resolver cannot resolve is omitted (no table guessed).
 */
export function buildEfDbSetTableMap(
  csSources: ReadonlyMap<string, string>,
  resolver: EntityTableResolver,
): Map<string, EfDbSetTarget> {
  const map = new Map<string, EfDbSetTarget>();
  for (const content of csSources.values()) {
    for (const ds of parseEfDbSets(content)) {
      if (map.has(ds.property)) continue;
      const target = resolver.resolveEntity(ds.entity);
      if (!target) continue;
      map.set(ds.property, { table: target.table, schema: target.schema });
    }
  }
  return map;
}

export interface EfCallSite {
  line: number;
  /** The matched DbSet property name. */
  property: string;
  op: string;
  kind: "reads" | "writes";
  target: EfDbSetTarget;
}

// `<DbSetProp>.<op>(` — both parts validated against the map + op sets. The
// DbSet property is NOT required to have a leading receiver dot: EF code both
// qualifies it (`context.Customers.Where(...)`, `_db.Customers.Add(...)`) AND
// accesses it bare via implicit `this` inside the DbContext itself
// (`Customers.Add(c)`), so the property is matched at a word boundary. Only the
// property name (validated against the DbSet map) anchors the match, so a
// leading receiver segment can never be mistaken for the property. Line-based
// like the ORM/jOOQ scanners (a call whose arguments span multiple lines is not
// detected — a shared, documented limitation).
const CALL_RE = /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

/** Scan one `.cs` source for EF DbSet call sites against known DbSet properties. */
export function findEfCallSites(
  source: string,
  dbSets: ReadonlyMap<string, EfDbSetTarget>,
): EfCallSite[] {
  if (dbSets.size === 0) return [];
  const out: EfCallSite[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(lines[i])) !== null) {
      const [, property, op] = m;
      const target = dbSets.get(property);
      if (!target) continue;
      const kind = EF_WRITE_OPS.has(op) ? "writes" : EF_READ_OPS.has(op) ? "reads" : null;
      if (!kind) continue;
      out.push({ line: i + 1, property, op, kind, target });
    }
  }
  return out;
}

/**
 * Persist `reads`/`writes` edges for one file's EF DbSet call sites, anchored to
 * the REAL enclosing persisted code symbol — mirrors `persistOrmCallSiteEdges`
 * (#872) and `persistJooqCallSiteEdges` (#897). Call sites with no enclosing
 * function/method symbol are skipped; this extractor never fabricates origin
 * symbols. Returns the number of edges written; duplicate `(from, table, kind)`
 * pairs within the file are deduped.
 */
export async function persistEfCallSiteEdges(
  writer: SchemaGraphWriter,
  filePath: string,
  source: string,
  dbSets: ReadonlyMap<string, EfDbSetTarget>,
  symbols: readonly EnclosingSymbol[],
): Promise<number> {
  const sites = findEfCallSites(source, dbSets);
  if (sites.length === 0 || symbols.length === 0) return 0;
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
