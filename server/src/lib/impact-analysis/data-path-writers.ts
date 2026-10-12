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
 * capped. A synthetic `sql@<line>` origin (a pre-#807 graph) is never named; a
 * MyBatis mapper statement (kind `method`, language `sql`) is.
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
  /**
   * #1036 — true when it writes a column the requirement names as an identifier
   * ({@link requirementIdentifierColumns}): the request is about this data, so
   * the writer is code to edit and not only code to review.
   */
  namesRequirementColumn: boolean;
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

/**
 * #1036 — the subset of {@link requirementNamedColumns} the requirement names AS
 * AN IDENTIFIER: a compound name (`changed_at`, `read_at`), or any name inside a
 * code span (\`status\`). A bare English word that happens to be a column
 * (`title`, `description`, `status` in "status changes") still scores a writer,
 * but is not evidence that the request is about that column — and "this request
 * is about this data" is what makes a writer an edit candidate.
 */
export function requirementIdentifierColumns(
  requirementText: string,
  columns: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  const spans = (requirementText.match(/`[^`\n]+`/g) ?? []).join(" ").toLowerCase();
  const inSpans = new Set(spans.match(/[a-z0-9_]+/g) ?? []);
  const named = new Set(requirementNamedColumns(requirementText, columns));
  return columns
    .filter((c) => named.has(c.id))
    .filter((c) => c.name.includes("_") || inSpans.has(c.name.toLowerCase()))
    .map((c) => c.id);
}

/**
 * True for a synthetic statement origin — `path::sql@412`, `path::exec@7`,
 * `path::procsql@30` — which a pre-#807 graph (or SQL outside any function)
 * records in place of the enclosing function. It names a line, not code, so it
 * is never listed as a writer.
 *
 * This used to be `language !== "sql"`, which also dropped every MyBatis mapper
 * statement: those are stored as kind `method`, language `sql`, under their own
 * statement id in the mapper XML, and they ARE the code that writes the data.
 */
export function isSyntheticSqlOrigin(qualifiedName: string): boolean {
  return /(?:^|::)[a-z]{2,12}@\d{1,9}$/.test(qualifiedName);
}

/**
 * True for an ORM MAPPING edge: the `persists-to` edge `orm-extractor.ts` records
 * from a Prisma `model` or a JPA `@Entity` to its table and to each mapped
 * column. The declaration says where a field is stored; it writes nothing, so
 * the symbol it starts at is not a write path.
 *
 * That symbol is stored exactly like a MyBatis statement or a JPA `@Query`
 * method (`createOriginSymbol`: kind `method`, language `sql`), so the symbol
 * cannot tell them apart and the edge has to: a MyBatis `<insert>` also
 * `persists-to`, from source `mybatis`; a JPA `@Query` is source `orm` too, and
 * only ever `reads` or `writes`. With the old `language !== "sql"` filter gone,
 * every requirement naming a column of a Prisma or JPA project listed the
 * entity itself as a lineage writer (PR #1090 review 2).
 */
export function isOrmMappingEdge(edge: { kind: string; source?: string | null }): boolean {
  return edge.kind === "persists-to" && edge.source === "orm";
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
  const identifierNamed = new Set(requirementIdentifierColumns(input.requirementText, columns));

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
  const writesNamedColumn = new Set<string>();
  const candidates = new Set<string>();
  for (const e of await ds.getWriterEdgesTo([...lookup])) {
    if (isOrmMappingEdge(e)) continue;
    candidates.add(e.fromSymbolId);
    const weight = named.get(e.toSymbolId);
    const p = WRITE_POINTS[e.kind];
    if (weight === undefined || p === undefined) continue;
    if (weight < 1 && e.kind !== "writes") continue;
    if (identifierNamed.has(e.toSymbolId)) writesNamedColumn.add(e.fromSymbolId);
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
    (d) => (d.kind === "function" || d.kind === "method") && !isSyntheticSqlOrigin(d.qualifiedName),
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
    namesRequirementColumn: writesNamedColumn.has(d.id),
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
  return (await expandDataPathWriters(symbols, input)).symbols;
}

/**
 * {@link addDataPathWriters}, also returning EVERY writer the data names — the
 * ones already in `symbols` included. A writer the seeding found first is still a
 * writer: #1036 needs it to decide which writers are edit candidates, and #791
 * needs it to decide which proposed columns an existing write path covers.
 */
export async function expandDataPathWriters<T extends DataPathAffectedSymbol>(
  symbols: T[],
  input: AddDataPathWritersInput,
): Promise<{ symbols: Array<T | DataPathAffectedSymbol>; writers: DataPathWriter[] }> {
  const present = new Set(symbols.map((s) => s.codeSymbolId).filter(Boolean) as string[]);
  const allWriters = await resolveDataPathWriters({
    requirementText: input.requirementText,
    seedIds: input.seedIds,
    primaryTables: input.primaryTables,
    dataSource: input.dataSource,
    excludeIds: new Set(),
    maxWriters: input.maxWriters,
  });
  const writers = allWriters.filter((w) => !present.has(w.id));
  if (writers.length === 0) return { symbols, writers: allWriters };

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

  return {
    symbols: [...symbols, ...added].sort(
      (a, b) => a.depth - b.depth || b.confidence - a.confidence,
    ),
    writers: allWriters,
  };
}

/**
 * Drop the schema seeds (a `table` / `column` the mapper matched by name, or —
 * since #1036 — one the hybrid seeding returned among its best hits, listed as
 * `related`) whose table the relevance filter put only in the secondary bucket.
 * Code symbols and every graph-walk row are kept.
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
  const isSeed = (s: DataPathAffectedSymbol) => s.relation === "direct" || s.relation === "related";
  const directIds = symbols
    .filter((s) => isSeed(s) && s.codeSymbolId)
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
    : symbols.filter((s) => !(isSeed(s) && s.codeSymbolId && drop.has(s.codeSymbolId)));
}

// ── #791 — what each writer DOES: its SQL, its parameters, the columns it filters on ──

/**
 * A lineage writer described well enough to decide what it already covers. The
 * #1045 check compared a proposed column NAME with the writer NAME, and regressed
 * 3 runs in 3 as soon as the model named its column `mark_read_delay` instead of
 * `mark_read_older_than_days`. What a writer covers is what it does: it writes
 * these tables, it filters on these columns, it takes these arguments.
 */
export interface DataPathWriterProfile extends DataPathWriter {
  /** Every table it UPDATEs or INSERTs into, sorted. */
  writeTables: string[];
  /**
   * The columns it READS on a table it also writes — the WHERE of an UPDATE or a
   * DELETE (`published_at` in `UPDATE entries … WHERE published_at < $4`). The
   * lineage records them as plain `reads`; a read of the written table is the
   * predicate. `table.column`, sorted.
   */
  predicateColumns: string[];
  /** The columns it reads on tables it does not write. `table.column`, sorted. */
  readColumns: string[];
  /** The declaration line, when the symbol's text is stored; else null. */
  signature: string | null;
  /** The declared parameters, as written (`before time.Time`). Empty when unknown. */
  parameters: string[];
  /** The first SQL statement in its body, whitespace-collapsed and capped; else null. */
  sql: string | null;
}

/** Longest SQL excerpt kept per writer (it is shown to a model and to a reader). */
export const MAX_WRITER_SQL_CHARS = 400;

/** `function X in path` — the header line the embedding text opens with. */
const SYMBOL_TEXT_HEADER =
  /^(function|method|class|interface|type|struct|module)\s+\S+\s+in\s+\S+$/;
const SQL_START = /\b(UPDATE\s+\S|INSERT\s+INTO\b|DELETE\s+FROM\b|MERGE\s+INTO\b|SELECT\s)/i;

/** Split `a int, b map[string]int, c func(x, y)` on its top-level commas. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The text between `open` at `from` and its matching close; null when unbalanced. */
function balancedGroup(text: string, from: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return { inner: text.slice(from + 1, i), end: i };
    }
  }
  return null;
}

/**
 * Read a declaration, its parameters and its first SQL statement out of a
 * symbol's stored text (`CodeSymbolEmbedding.text`: a header line, the
 * declaration, the body). Best-effort and language-light: a Go receiver
 * (`func (s *Storage) Name(…)`) is skipped, a `self` / `this` parameter is
 * dropped, and anything it cannot read comes back empty rather than guessed.
 */
export function parseWriterText(text: string): {
  signature: string | null;
  parameters: string[];
  sql: string | null;
} {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = SYMBOL_TEXT_HEADER.test((lines[0] ?? "").trim()) ? 1 : 0;
  const declAt = lines.findIndex((l, i) => i >= start && l.trim() !== "");
  if (declAt === -1) return { signature: null, parameters: [], sql: null };
  // Trimmed first: `\s*[{:]\s*$` on the untrimmed line retries a run of
  // spaces from each of its positions.
  const signature = lines[declAt]!.trim().replace(/\s{0,8}[{:]$/, "");

  let from = signature.indexOf("(");
  // `func (s *Storage) Name(` — the first group is the receiver.
  if (/^func\s*\(/.test(signature) && from !== -1) {
    const receiver = balancedGroup(signature, from);
    from = receiver ? signature.indexOf("(", receiver.end + 1) : -1;
  }
  const group = from === -1 ? null : balancedGroup(signature, from);
  const parameters = group
    ? splitTopLevel(group.inner).filter((param) => !/^(self|this|cls)\b/.test(param))
    : [];

  const body = lines.slice(declAt + 1).join("\n");
  const sqlAt = body.search(SQL_START);
  let sql: string | null = null;
  if (sqlAt !== -1) {
    const rest = body.slice(sqlAt);
    // A statement in a string literal ends at the closing backtick or quote.
    const close = rest.search(/[`"']/);
    sql = (close === -1 ? rest : rest.slice(0, close)).replace(/\s+/g, " ").trim();
    if (sql.length > MAX_WRITER_SQL_CHARS) sql = `${sql.slice(0, MAX_WRITER_SQL_CHARS - 1)}…`;
  }
  return { signature, parameters, sql: sql && sql.length > 0 ? sql : null };
}

function tableOf(qualifiedColumn: string): string {
  const dot = qualifiedColumn.lastIndexOf(".");
  return dot === -1 ? qualifiedColumn : qualifiedColumn.slice(0, dot);
}

/**
 * Describe each writer by what it does. One pass over the lineage edges that
 * start at the writers, plus the stored symbol text when the data source has
 * it. A writer with no stored text still gets its tables and predicates.
 */
export async function profileDataPathWriters(
  writers: readonly DataPathWriter[],
  dataSource: DataPathDataSource,
): Promise<DataPathWriterProfile[]> {
  if (writers.length === 0) return [];
  const ids = writers.map((w) => w.id);
  const edges = await dataSource.getSchemaEdgesFrom(ids);
  const targets = await dataSource.getSchemaSymbolsByIds([
    ...new Set(edges.map((e) => e.toSymbolId)),
  ]);
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const textById = new Map(
    dataSource.getCodeSymbolTexts
      ? (await dataSource.getCodeSymbolTexts(ids)).map((t) => [t.id, t.text] as const)
      : [],
  );

  return writers.map((w) => {
    const writeTables = new Set<string>();
    const reads = new Set<string>();
    for (const e of edges) {
      if (e.fromSymbolId !== w.id) continue;
      const target = targetById.get(e.toSymbolId);
      if (!target || (target.kind !== "table" && target.kind !== "column")) continue;
      const table = target.kind === "column" ? tableOf(target.qualifiedName) : target.qualifiedName;
      if (e.kind === "writes" || e.kind === "persists-to") writeTables.add(table);
      else if (e.kind === "reads" && target.kind === "column") reads.add(target.qualifiedName);
    }
    const parsed = parseWriterText(textById.get(w.id) ?? "");
    return {
      ...w,
      writeTables: [...writeTables].sort(),
      predicateColumns: [...reads].filter((c) => writeTables.has(tableOf(c))).sort(),
      readColumns: [...reads].filter((c) => !writeTables.has(tableOf(c))).sort(),
      ...parsed,
    };
  });
}
