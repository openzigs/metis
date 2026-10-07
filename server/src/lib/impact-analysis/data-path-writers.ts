/**
 * #791 — name the functions that write the data a requirement changes.
 *
 * The requirement→code seed set is lexical: "add `read_at` to entries; set it
 * when an entry turns read" seeds `GetReadTime` and a brotli `Read`, while the
 * code that must change — every function that flips an entry's `status` — shares
 * no word with the requirement. That code is found through the DATA instead: the
 * SQL-lineage edges (`writes` / `persists-to`, which since #807 start at the
 * enclosing function) say which functions write which columns.
 *
 * The columns whose writers matter, all inside a table the crossing already put
 * in the PRIMARY set:
 *   1. a column the requirement names verbatim (`status`, `checked_at`);
 *   2. a column the mapper seeded directly (`entries.changed_at`);
 *   3. a column the seeded code itself writes, through the same downstream
 *      walk the crossing uses (#928) — how a "mark all as read" UI handler
 *      leads to `entries.status` and so to `MarkAllAsReadBeforeDate`.
 * Scoring: a writer earns 2 points per named column it UPDATEs and 1 per named
 * column it INSERTs (a mapper-seeded column counts half, UPDATEs only), plus up
 * to 4 points for how closely its UPDATE set matches one the seeded code reaches
 * (Jaccard). Writers under a quarter of the best score are dropped, the rest
 * capped. A synthetic `sql@<line>` origin (a pre-#807 graph) is never named.
 *
 * Read-only and best-effort: a data source without the optional hooks yields [].
 */
import type { ImpactAffectedRelation, SchemaEdgeKind } from "@metis/shared";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import { isTestFilePath } from "../code-graph/call-resolution.js";
import { blastRadius } from "./blast-radius.js";
import {
  DEFAULT_MAX_DOWNSTREAM_DEPTH,
  resolveDownstreamDataLayer,
  type AffectedTableInput,
  type SchemaImpactDataSource,
} from "./schema-impact.js";

/**
 * The schema data source. This stage needs its optional #791 hooks
 * (`getColumnsOfTables`, `getWriterEdgesTo`, `getCodeSymbolDetails`).
 */
export type DataPathDataSource = SchemaImpactDataSource;

export interface DataPathWriter {
  id: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** 0.4–0.8, by the writer's share of the best writer's points. */
  confidence: number;
  /** The target columns it writes, `table.column`, sorted. */
  columns: string[];
}

export interface ResolveDataPathWritersInput {
  requirementText: string;
  /** The direct seed ids (code and schema). */
  seedIds: string[];
  /** The crossing's primary affected rows. */
  primaryTables: AffectedTableInput[];
  dataSource: DataPathDataSource;
  /** Symbols already in the result — never repeated as writers. */
  excludeIds: ReadonlySet<string>;
  /** Default {@link DEFAULT_MAX_WRITERS}. */
  maxWriters?: number;
}

/** Writers named per requirement. Enough for every status path in Miniflux (8). */
export const DEFAULT_MAX_WRITERS = 12;

const WRITE_POINTS: Partial<Record<SchemaEdgeKind, number>> = { writes: 2, "persists-to": 1 };
/** Weight of a column the mapper seeded by a word match, rather than one named. */
const SEEDED_COLUMN_WEIGHT = 0.5;
/** A writer with the same UPDATE set as one the seeded code reaches scores this. */
const SIBLING_POINTS = 4;

/** Per code symbol, the primary-table columns it `writes` (UPDATE … SET). */
function writeSets(
  edges: ReadonlyArray<{ fromSymbolId: string; toSymbolId: string; kind: SchemaEdgeKind }>,
  columnById: ReadonlyMap<string, unknown>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.kind !== "writes" || !columnById.has(e.toSymbolId)) continue;
    const set = out.get(e.fromSymbolId) ?? new Set<string>();
    set.add(e.toSymbolId);
    out.set(e.fromSymbolId, set);
  }
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
/** A writer scoring under this share of the best one is not named. */
const MIN_SHARE_OF_BEST = 0.25;
const MIN_CONFIDENCE = 0.4;
const CONFIDENCE_SPAN = 0.4;

/** Column names too generic to count as "named by the requirement". */
const UNNAMEABLE_COLUMNS: ReadonlySet<string> = new Set(["id"]);

/**
 * The ids of the columns whose name appears as a whole word in the requirement
 * (`status`, `checked_at`). Exact and case-insensitive: no stemming, no split.
 */
export function requirementNamedColumns(
  requirementText: string,
  columns: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  const words = new Set(requirementText.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  return columns
    .filter((c) => {
      const name = c.name.toLowerCase();
      return !UNNAMEABLE_COLUMNS.has(name) && words.has(name);
    })
    .map((c) => c.id);
}

export async function resolveDataPathWriters(
  input: ResolveDataPathWritersInput,
): Promise<DataPathWriter[]> {
  const ds = input.dataSource;
  if (!ds.getColumnsOfTables || !ds.getWriterEdgesTo || !ds.getCodeSymbolDetails) return [];
  const tableNames = [
    ...new Set(
      input.primaryTables
        .filter((t) => t.objectKind === "table" || t.objectKind === "column")
        .map((t) => t.tableName),
    ),
  ];
  if (tableNames.length === 0) return [];

  const columns = await ds.getColumnsOfTables(tableNames);
  if (columns.length === 0) return [];
  const columnById = new Map(columns.map((c) => [c.id, c]));

  // 1 + 2 — named columns. A column the requirement names counts in full, and so
  // does its INSERT path; a column the mapper seeded (word-matched, often
  // loosely) counts half, UPDATE writers only.
  const named = new Map<string, number>();
  for (const id of input.seedIds) if (columnById.has(id)) named.set(id, SEEDED_COLUMN_WEIGHT);
  for (const id of requirementNamedColumns(input.requirementText, columns)) named.set(id, 1);

  // 3 — what the seeded code itself writes: each reached writer's UPDATE set.
  const reached = await resolveDownstreamDataLayer(input.seedIds, ds, DEFAULT_MAX_DOWNSTREAM_DEPTH);
  const reachedSets = [
    ...writeSets(await ds.getSchemaEdgesFrom([...reached.keys()]), columnById).values(),
  ];

  const lookup = new Set<string>(named.keys());
  for (const set of reachedSets) for (const id of set) lookup.add(id);
  if (lookup.size === 0) return [];

  const points = new Map<string, number>();
  const written = new Map<string, Set<string>>();
  const candidates = new Set<string>();
  for (const e of await ds.getWriterEdgesTo([...lookup])) {
    candidates.add(e.fromSymbolId);
    const weight = named.get(e.toSymbolId);
    const p = WRITE_POINTS[e.kind];
    if (weight === undefined || p === undefined) continue;
    if (weight < 1 && e.kind !== "writes") continue;
    const cols = written.get(e.fromSymbolId) ?? new Set<string>();
    if (cols.has(e.toSymbolId)) continue;
    cols.add(e.toSymbolId);
    written.set(e.fromSymbolId, cols);
    points.set(e.fromSymbolId, (points.get(e.fromSymbolId) ?? 0) + weight * p);
  }
  for (const id of input.excludeIds) candidates.delete(id);
  if (candidates.size === 0) return [];

  // A writer whose UPDATE set matches one the seeded code reaches is a sibling
  // path of the same state change: `MarkAllAsReadBeforeDate` beside
  // `MarkAllAsRead`, both `SET status, changed_at`.
  if (reachedSets.length > 0) {
    const candidateSets = writeSets(await ds.getSchemaEdgesFrom([...candidates]), columnById);
    for (const [id, set] of candidateSets) {
      const sim = Math.max(...reachedSets.map((r) => jaccard(set, r)));
      if (sim <= 0) continue;
      points.set(id, (points.get(id) ?? 0) + SIBLING_POINTS * sim);
      const cols = written.get(id) ?? new Set<string>();
      for (const c of set) if (lookup.has(c)) cols.add(c);
      written.set(id, cols);
    }
  }
  for (const id of input.excludeIds) points.delete(id);
  if (points.size === 0) return [];

  const details = (await ds.getCodeSymbolDetails([...points.keys()])).filter(
    (d) => d.language !== "sql" && (d.kind === "function" || d.kind === "method"),
  );
  const scored = details.map((d) => ({ d, p: points.get(d.id) ?? 0 }));
  const top = Math.max(0, ...scored.map((s) => s.p));
  const ranked = scored
    .filter((s) => s.p >= top * MIN_SHARE_OF_BEST)
    .sort((a, b) => b.p - a.p || a.d.qualifiedName.localeCompare(b.d.qualifiedName))
    .slice(0, input.maxWriters ?? DEFAULT_MAX_WRITERS);
  const best = ranked[0]?.p ?? 0;
  return ranked.map(({ d, p }) => ({
    id: d.id,
    qualifiedName: d.qualifiedName,
    filePath: d.filePath,
    startLine: d.startLine,
    endLine: d.endLine,
    confidence: MIN_CONFIDENCE + CONFIDENCE_SPAN * (best > 0 ? p / best : 0),
    columns: [...(written.get(d.id) ?? [])]
      .map((id) => columnById.get(id)?.qualifiedName ?? id)
      .sort(),
  }));
}

/** An affected-symbol row, as the engine builds it. */
export interface DataPathAffectedSymbol {
  codeSymbolId: string | null;
  filePath: string;
  qualifiedName: string;
  startLine: number | null;
  endLine: number | null;
  relation: ImpactAffectedRelation;
  depth: number;
  confidence: number;
}

export interface AddDataPathWritersInput {
  requirementText: string;
  seedIds: string[];
  primaryTables: AffectedTableInput[];
  dataSource: DataPathDataSource;
  /** The code graph the blast radius walks, for the writers' callers. */
  graph: CodeGraphDataSource;
  maxWriters?: number;
  maxCallers?: number;
}

/** Callers of the writers named per requirement. */
export const DEFAULT_MAX_WRITER_CALLERS = 20;
/** A writer's caller is one hop further out: its confidence times this. */
const WRITER_CALLER_FACTOR = 0.75;
/** A test that calls a writer is listed after the production callers. */
const TEST_CALLER_FACTOR = 0.5;

/**
 * Append the data-path writers (relation `data-writer`, depth 1) and their
 * direct callers (relation `caller`, depth 2) to the engine's affected symbols,
 * skipping anything already listed. Returns the merged list, sorted the way the
 * engine sorts (depth, then confidence).
 */
export async function addDataPathWriters<T extends DataPathAffectedSymbol>(
  symbols: T[],
  input: AddDataPathWritersInput,
): Promise<Array<T | DataPathAffectedSymbol>> {
  const present = new Set(symbols.map((s) => s.codeSymbolId).filter(Boolean) as string[]);
  const writers = await resolveDataPathWriters({
    requirementText: input.requirementText,
    seedIds: input.seedIds,
    primaryTables: input.primaryTables,
    dataSource: input.dataSource,
    excludeIds: present,
    maxWriters: input.maxWriters,
  });
  if (writers.length === 0) return symbols;

  const added: DataPathAffectedSymbol[] = writers.map((w) => ({
    codeSymbolId: w.id,
    filePath: w.filePath,
    qualifiedName: w.qualifiedName,
    startLine: w.startLine,
    endLine: w.endLine,
    relation: "data-writer",
    depth: 1,
    confidence: w.confidence,
  }));
  for (const w of writers) present.add(w.id);

  // Per writer, so a caller inherits the confidence of the writer it calls.
  const callerById = new Map<string, DataPathAffectedSymbol>();
  for (const w of writers) {
    const radius = await blastRadius(input.graph, [w.id], {
      maxDepth: 1,
      seedConfidence: w.confidence * WRITER_CALLER_FACTOR,
      minConfidence: 0,
    });
    for (const r of radius) {
      // A file's `defines` edge makes the module a "caller"; it names no code.
      if (r.relation !== "caller" || r.qualifiedName === r.filePath) continue;
      if (present.has(r.codeSymbolId)) continue;
      const confidence = isTestFilePath(r.filePath)
        ? r.confidence * TEST_CALLER_FACTOR
        : r.confidence;
      const prev = callerById.get(r.codeSymbolId);
      if (!prev || confidence > prev.confidence) {
        callerById.set(r.codeSymbolId, { ...r, depth: 2, confidence });
      }
    }
  }
  const callers = [...callerById.values()]
    .sort((a, b) => b.confidence - a.confidence || a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, input.maxCallers ?? DEFAULT_MAX_WRITER_CALLERS);
  added.push(...callers);

  return [...symbols, ...added].sort((a, b) => a.depth - b.depth || b.confidence - a.confidence);
}

/**
 * Drop the direct schema seeds (a `table` / `column` the mapper matched by
 * name) whose table the relevance filter put only in the secondary bucket. Code
 * seeds and every non-direct row are kept.
 */
export async function pruneTangentialSchemaSeeds<T extends DataPathAffectedSymbol>(
  symbols: T[],
  primary: AffectedTableInput[],
  secondary: AffectedTableInput[],
  dataSource: Pick<DataPathDataSource, "getSchemaSymbolsByIds">,
): Promise<T[]> {
  const kept = new Set(primary.map((t) => t.tableName));
  const tangential = new Set(secondary.map((t) => t.tableName).filter((t) => !kept.has(t)));
  if (tangential.size === 0) return symbols;
  const directIds = symbols
    .filter((s) => s.relation === "direct" && s.codeSymbolId)
    .map((s) => s.codeSymbolId as string);
  const drop = new Set<string>();
  for (const sym of await dataSource.getSchemaSymbolsByIds(directIds)) {
    if (sym.kind !== "table" && sym.kind !== "column") continue;
    const table =
      sym.kind === "column"
        ? sym.qualifiedName.slice(0, -(sym.name.length + 1))
        : sym.qualifiedName;
    if (tangential.has(table)) drop.add(sym.id);
  }
  return drop.size === 0
    ? symbols
    : symbols.filter(
        (s) => !(s.relation === "direct" && s.codeSymbolId && drop.has(s.codeSymbolId)),
      );
}
