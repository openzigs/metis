/**
 * ORM call-site extractor — Issue #872 (Epic #820 follow-up).
 *
 * The ORM schema extractor (#171/#850) maps model definitions onto `table`/
 * `column` symbols, but those symbols were reachable only from SYNTHETIC
 * per-model origin symbols — application code had no edge into the schema
 * graph, so the requirement→schema crossing (`crossToSchema`) only fired when a
 * requirement coincidentally BM25-mapped onto an origin symbol (observed live:
 * a requirement explicitly targeting the `requirements` table crossed 0/7).
 *
 * This module closes that gap for Prisma client call sites: it scans parsed
 * application source for `<receiver>.<modelProp>.<op>(...)` calls whose
 * `<modelProp>` matches a known model (the camelCased Prisma client property
 * for `model X`) and whose `<op>` is a known Prisma delegate operation, and
 * emits a `reads`/`writes` edge FROM the enclosing **persisted code symbol**
 * (the real function/method the requirement mapper can hit) TO the model's
 * table symbol. Both the model name AND the operation must match, so an
 * unrelated `foo.count(...)` never produces an edge unless `foo` is also a
 * model property — and even then only table-level (no column claims).
 *
 * Deliberately detection-only and static: no imports are resolved, no types are
 * consulted. `this.prisma.requirement.create(...)`, `tx.requirement.create(...)`
 * and `prisma.requirement.create(...)` all match — the receiver is ignored.
 */
import type { SchemaGraphWriter } from "./schema-graph.js";
import { tableQualifiedName } from "./schema-graph.js";
import { extractOrm } from "./orm-extractor.js";

/** Prisma delegate operations that READ table data. */
export const PRISMA_READ_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** Prisma delegate operations that WRITE table data. */
export const PRISMA_WRITE_OPS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

/** camelCase a Prisma model name the way the generated client names its delegate. */
function clientPropertyOf(modelName: string): string {
  return modelName.length > 0 ? modelName[0].toLowerCase() + modelName.slice(1) : modelName;
}

export interface OrmModelTarget {
  table: string;
  schema?: string;
}

/**
 * Build the `clientProperty -> physical table` map from the captured ORM model
 * sources (the same inputs the schema pass persists), reusing `extractOrm`'s
 * model→table resolution (`@@map` etc.) so the two passes cannot drift.
 */
export function buildOrmModelTableMap(
  ormSources: ReadonlyMap<string, string>,
): Map<string, OrmModelTarget> {
  const map = new Map<string, OrmModelTarget>();
  for (const [filePath, content] of ormSources) {
    for (const entity of extractOrm(filePath, content)) {
      // Prisma model names are the last path segment of the entity name.
      const model = entity.entityName.split(".").pop() ?? entity.entityName;
      map.set(clientPropertyOf(model), { table: entity.table, schema: entity.schema });
    }
  }
  return map;
}

export interface OrmCallSite {
  line: number;
  /** The matched client property (camelCased model name). */
  model: string;
  op: string;
  kind: "reads" | "writes";
  target: OrmModelTarget;
}

// `.<modelProp>.<op>(` — receiver-agnostic; both parts validated against the maps.
const CALL_RE = /\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

/** Scan one source file for ORM delegate call sites against known models. */
export function findOrmCallSites(
  source: string,
  models: ReadonlyMap<string, OrmModelTarget>,
): OrmCallSite[] {
  if (models.size === 0) return [];
  const out: OrmCallSite[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(lines[i])) !== null) {
      const [, model, op] = m;
      const target = models.get(model);
      if (!target) continue;
      const kind = PRISMA_WRITE_OPS.has(op) ? "writes" : PRISMA_READ_OPS.has(op) ? "reads" : null;
      if (!kind) continue;
      out.push({ line: i + 1, model, op, kind, target });
    }
  }
  return out;
}

/** A persisted code symbol span the call site can anchor to. */
export interface EnclosingSymbol {
  id: string;
  startLine: number;
  endLine: number;
}

/** Narrowest persisted symbol span containing `line`, or null (no synthetic origins). */
export function enclosingSymbolFor(
  symbols: readonly EnclosingSymbol[],
  line: number,
): EnclosingSymbol | null {
  let best: EnclosingSymbol | null = null;
  for (const s of symbols) {
    if (line < s.startLine || line > s.endLine) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
  }
  return best;
}

/**
 * Persist `reads`/`writes` edges for one file's ORM call sites, anchored to the
 * REAL enclosing persisted code symbols. Call sites with no enclosing
 * function/method symbol are skipped — this extractor never fabricates origin
 * symbols (that disconnection is exactly what #872 fixes). Returns the number
 * of edges written; duplicate `(from, table, kind)` pairs within the file are
 * deduped.
 */
export async function persistOrmCallSiteEdges(
  writer: SchemaGraphWriter,
  filePath: string,
  source: string,
  models: ReadonlyMap<string, OrmModelTarget>,
  symbols: readonly EnclosingSymbol[],
): Promise<number> {
  const sites = findOrmCallSites(source, models);
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
