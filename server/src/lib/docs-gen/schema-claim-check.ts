/**
 * The deterministic check on the architecture document's Data Architecture
 * section (#1061): the table and column names the section CLAIMS are compared
 * with the schema inventory (`schema-inventory.ts`), with no model call.
 *
 * ## It marks. It never removes, rewrites or corrects.
 *
 * This is a text heuristic over model output, compared with a schema read that
 * is not provably complete: an introspection covers one schema per database,
 * returns only the columns the connecting role may see (column-level
 * privileges on PostgreSQL, MySQL and SQL Server), and is silently cut at
 * 10,000 rows on Oracle (`drivers/oracle.ts`). Neither the parse nor the read
 * can prove that a name is absent from a database, so a wrong judgment must
 * cost no more than a mark. The check's ONLY edits to the section are:
 *
 *   1. a marker appended after a name it could not match: ` *(not in schema)*`,
 *      or ` *(not in schema; the schema has \`x\`)*` for a near miss;
 *   2. one note for the section (`renderSchemaCheckNotice`), placed under its
 *      heading by `applySchemaGrounding`.
 *
 * No row, line, cell, name or type that the model wrote is deleted or changed,
 * and a diagram is left byte for byte as written (a marker inside a Mermaid
 * block could stop it rendering), so what the check finds in a diagram is said
 * in the note only. Remove every marker and the note and the section is the
 * model's text again; `schema-claim-check.test.ts` holds that as a property.
 *
 * What keeps invented names out of the section is the grounding: the schema in
 * the prompt, and the Schema Reference rendered from the schema. This is the
 * detector behind it.
 *
 * ## What is judged
 *
 *   1. a Mermaid `erDiagram`: its entity names (an entity's quoted alias when
 *      it has one, `USERS["audit.users"]`), and the attribute lines of an
 *      entity that resolved. Mermaid's order is `type name`, and models also
 *      write `name type`: the name is whichever of the first two tokens is a
 *      column of the entity, else whichever is NOT a known type word. A line
 *      where that does not single one out is not judged.
 *   2. an `Entity:` / `Entities:` / `Table:` / `Tables:` heading that has a
 *      field table (first header cell Field, Column or Attribute) as the first
 *      table under it: the table names in the heading;
 *   3. the rows of that field table: each backticked name in the FIRST cell,
 *      as a column of the heading's table. Prose between the heading and the
 *      table changes nothing. A dotted name is judged only when its qualifier
 *      is one of the heading's own tables (`feed_icons.icon_id` under
 *      `Entities: icons and feed_icons`);
 *   4. a table whose first header cell is `Table`: each backticked name in a
 *      row's first cell, as a table.
 *
 * ## What is not judged, and is left exactly as written
 *
 *   - every cell of a row other than the first (a Description cell holds
 *     `users.Len`, `settings.theme`, `feeds.go`);
 *   - a field-table row whose Type cell says index, constraint, key, trigger,
 *     sequence or relation, or whose name has the shape of an index or key
 *     (`idx_…`, `…_pkey`, `index_users_on_email`), or whose name is dotted with
 *     a qualifier that is not the heading's table;
 *   - any field table that is not the first table under such a heading (a
 *     struct, a message), and everything under any other heading;
 *   - a name its own heading or row calls a view, when it does not resolve;
 *   - free prose.
 *
 * ## Not checked: a name the read cannot speak for
 *
 *   - A name written with a schema (`audit.users`, `` `audit`.`users` ``,
 *     `audit.` before the code span, `(audit schema)` after it) is looked for
 *     in that schema only. The prefix is never dropped to make it resolve.
 *   - A TABLE name that does not resolve is **not checked**, instead of marked,
 *     when the read cannot speak for where it would be: it is qualified with a
 *     schema no read returned or with a database (`db.schema.table`), or some
 *     database of the project went unread or was possibly cut short.
 *   - An unqualified name that resolves is judged against what it resolved to.
 *
 * Everything not judged that looked like a claim is LISTED in the section note
 * with the reason, so a clean note is not read as a clean section. It raises no
 * warning.
 *
 * ## Matching
 *
 *   - A table-level name ignores case and underscores (`FeedIcon` is
 *     `feed_icons`), and a singular or plural is resolved only by a
 *     conventional transformation with one result: add or drop `s`, `y` and
 *     `ies`, `es` only after s, x, z, ch or sh. `Stat` is not `states`.
 *   - A column is a near miss when it equals exactly one column of the table
 *     once case and underscores are ignored. It is marked, with the schema's
 *     spelling in the marker; nothing is corrected.
 *   - A type that cannot describe the schema's column is reported in the note.
 *
 * With an empty inventory nothing is checked and nothing is marked. The same
 * holds per table: a table whose column list is not known (the code graph has
 * it by name only, from an ORM call site) has none of its columns judged, and
 * is listed once as "columns not checked". And on the repository-SQL tier,
 * whose prompt asks for an entity per SAS dataset, a name that is no table and
 * IS a dataset of the code's data lineage is listed as not checked: a dataset
 * is not a table, and marking each one would be wrong every time.
 *
 * ## A marker never goes into code
 *
 * A marker is written only where the check can tell the text is not code, as
 * BOTH of the document's renderers read it (the viewer's remark, the export's
 * `marked`). Where it cannot tell, it does not mark:
 *
 *   - a fenced block is delimited as CommonMark does: three or more backticks
 *     or tildes, closed by the same character at least as many times, so a
 *     four-backtick fence holding a three-backtick line is one block; a fence
 *     the two renderers close differently is code to its later end;
 *   - a line indented four columns or more (an indented code block, or a list
 *     item's content) and a raw HTML block are copied as written;
 *   - a code span is a run of N backticks to the next run of exactly N, so the
 *     marker goes after the whole closing run, and a span that holds a backtick
 *     is one span; an escaped or unpaired backtick opens nothing;
 *   - a table is judged only when its header and delimiter rows have the same
 *     number of cells, which is when a renderer draws one.
 *
 * `schema-claim-check.test.ts` holds this against `marked` itself, over
 * generated documents.
 *
 * ## Twice is once
 *
 * A name directly followed by ` *(not in schema` is taken as already marked,
 * whether an earlier pass or the model wrote it, and nothing is added there;
 * a heading is read the same with its marker in it. So checking a checked
 * section again changes nothing.
 *
 * Every scan here walks model output, so it is linear: lines are split once,
 * cells and code spans are found by index in a single pass, names resolve
 * through maps, and there is no backtracking pattern.
 */
import {
  describeTablesRead,
  isTypedInventory,
  plainSchemaText,
  renderSchemaReference,
  type SchemaInventory,
  type SchemaInventoryColumn,
  type SchemaInventoryTable,
} from "./schema-inventory.js";

/**
 * Why a name that looked like a claim was not judged:
 *
 *  - `unread` — outside what was read: an unread schema or database;
 *  - `not-a-column` — a row that describes an index, constraint, key or
 *    relation, or a first-cell name that is not a plain column name;
 *  - `view` — its own heading or row calls it a view;
 *  - `diagram-line` — a diagram line whose name could not be told from its type;
 *  - `no-columns` — a TABLE whose column list is not known (the name stands for
 *    the table, listed once): none of its columns is judged;
 *  - `dataset` — a name the code's data lineage knows as a dataset, which the
 *    repository-SQL prompt asks to be written as an entity. Not a table.
 */
export type NotCheckedReason =
  "unread" | "not-a-column" | "view" | "diagram-line" | "no-columns" | "dataset";

export interface SchemaCheckReport {
  /** False when there was no inventory to check against. */
  checked: boolean;
  /** Names claimed as tables that the schema that was read does not hold. */
  unresolvedTables: string[];
  /** `table.column` names the table does not have, near misses included. */
  flaggedColumns: string[];
  /** For a flagged column that is a near miss: the schema's spelling. */
  suggestions: Array<{ column: string; schema: string }>;
  /** Types that disagree with the schema. Said in the note, not in the cell. */
  typeMismatches: Array<{ column: string; written: string; schema: string }>;
  /** Names that looked like claims and were not judged. Listed in the note. */
  notChecked: Array<{ name: string; why: NotCheckedReason }>;
  /**
   * The unmatched names that stand in a diagram. A diagram is never edited, so
   * these carry no marker where they stand and are said in the note only.
   */
  inDiagram: string[];
}

/** How many things the check has to say about the section. */
export function schemaCheckFindings(report: SchemaCheckReport): number {
  return (
    schemaCheckUnmatched(report).length + report.typeMismatches.length + report.notChecked.length
  );
}

/**
 * The names that were judged and not matched to the schema: each is marked
 * where it stands (or, in a diagram, listed in the note). They are what the
 * document's informational `schema-unverified` line counts.
 */
export function schemaCheckUnmatched(report: SchemaCheckReport): string[] {
  return [...report.unresolvedTables, ...report.flaggedColumns];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const IDENTIFIER_MAX = 200;

function isIdentifierChar(c: number, first: boolean): boolean {
  const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const digit = c >= 48 && c <= 57;
  return letter || (!first && (digit || c === 36));
}

function isIdentifier(text: string): boolean {
  if (text.length === 0 || text.length > IDENTIFIER_MAX) return false;
  for (let i = 0; i < text.length; i++) {
    if (!isIdentifierChar(text.charCodeAt(i), i === 0)) return false;
  }
  return true;
}

/** `a`, `a.b` or `a.b.c`, each part an identifier. */
function isQualifiedIdentifier(text: string): boolean {
  if (text.length === 0 || text.length > IDENTIFIER_MAX) return false;
  const parts = text.split(".");
  return parts.length <= 3 && parts.every(isIdentifier);
}

function squash(name: string): string {
  return name.toLowerCase().split("_").join("");
}

type ColumnMatch =
  | { kind: "exact"; table: SchemaInventoryTable; column: SchemaInventoryColumn }
  | { kind: "near"; table: SchemaInventoryTable; column: SchemaInventoryColumn }
  | { kind: "none" };

interface ColumnLookup {
  exact: Map<string, SchemaInventoryColumn>;
  /** Columns by name with case and underscores removed. */
  squashed: Map<string, SchemaInventoryColumn[]>;
}

/**
 * What the inventory says about a name at table level:
 *
 *  - `found` — the tables it can mean (two when a same-named table is in two
 *    connectors or schemas);
 *  - `absent` — looked for where it would be, and not there: marked;
 *  - `unread` — the read cannot speak for where it would be: not checked;
 *  - `dataset` — no table, and the code's data lineage has a dataset of that
 *    name: not checked.
 */
type TableVerdict =
  | { kind: "found"; tables: SchemaInventoryTable[] }
  | { kind: "absent" }
  | { kind: "unread" }
  | { kind: "dataset" };

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

const ES_STEMS = ["s", "x", "z", "ch", "sh"];

function takesEs(stem: string): boolean {
  return ES_STEMS.some((ending) => stem.endsWith(ending));
}

/**
 * The other grammatical number of `key`, by the conventional transformations
 * only. `stat` gives `stats`, never `states`: `es` is added only after s, x, z,
 * ch and sh, and dropped only from such a stem.
 */
export function numberVariants(key: string): string[] {
  const out = [`${key}s`];
  if (key.endsWith("s")) out.push(key.slice(0, -1));
  if (key.endsWith("y")) out.push(`${key.slice(0, -1)}ies`);
  if (key.endsWith("ies")) out.push(`${key.slice(0, -3)}y`);
  if (takesEs(key)) out.push(`${key}es`);
  if (key.endsWith("es") && takesEs(key.slice(0, -2))) out.push(key.slice(0, -2));
  return out.filter((variant) => variant.length > 0);
}

/** Lookups built once, so resolving a name does not walk the schema. */
class InventoryIndex {
  /** Tables by name with case and underscores removed. */
  private readonly bySquashedName = new Map<string, SchemaInventoryTable[]>();
  /** The schemas (lower case) some read returned tables of. */
  private readonly schemasRead = new Set<string>();
  /** True when a database of the project is unread, or its read may be cut short. */
  private readonly partlyUnread: boolean;
  private readonly columns = new Map<SchemaInventoryTable, ColumnLookup>();
  /** Dataset names (lower case), whole and by their last part. */
  private readonly datasets = new Set<string>();

  constructor(inventory: SchemaInventory) {
    for (const dataset of inventory.datasets ?? []) {
      const name = dataset.trim().toLowerCase();
      this.datasets.add(name);
      this.datasets.add(name.slice(name.lastIndexOf(".") + 1));
    }
    this.partlyUnread = inventory.reads.some(
      (read) => read.how === "unread" || read.truncation !== undefined,
    );
    for (const read of inventory.reads) {
      for (const schema of read.schemas) this.schemasRead.add(schema.toLowerCase());
    }
    for (const table of inventory.tables) {
      push(this.bySquashedName, squash(table.name), table);
      if (table.schema) this.schemasRead.add(table.schema.toLowerCase());
      const lookup: ColumnLookup = { exact: new Map(), squashed: new Map() };
      for (const column of table.columns) {
        lookup.exact.set(column.name.toLowerCase(), column);
        push(lookup.squashed, squash(column.name), column);
      }
      this.columns.set(table, lookup);
    }
  }

  /**
   * The tables a table-level name refers to (a diagram entity, an `Entity:`
   * heading, a roster row).
   *
   * **A schema prefix is never dropped.** `audit.users` is looked for among the
   * tables of schema `audit` only. A table whose schema is not known (repository
   * SQL) can be in any. An unqualified name is looked for among everything that
   * was read, and EVERY table it can mean is returned.
   *
   * Case and underscores are ignored, and a singular also means its plural (and
   * the reverse) when {@link numberVariants} gives exactly one table name.
   *
   * A name that is not found is `unread`, not `absent`, when the read cannot
   * speak for where it would be: see the module header.
   */
  resolveTable(raw: string): TableVerdict {
    const whole = raw.trim().toLowerCase();
    const parts = whole.split(".");
    const bare = parts[parts.length - 1];
    if (!bare) return { kind: "absent" };
    // `database.schema.table`: no read identifies a database by name.
    if (parts.length > 2) return { kind: "unread" };
    const schema = parts.length === 2 ? parts[0] : null;
    const inSchema = (
      tables: readonly SchemaInventoryTable[] | undefined,
    ): SchemaInventoryTable[] =>
      (tables ?? []).filter(
        (table) => schema == null || !table.schema || table.schema.toLowerCase() === schema,
      );
    const key = squash(bare);
    let found = inSchema(this.bySquashedName.get(key));
    if (found.length === 0) {
      const byNumber = numberVariants(key).flatMap((variant) =>
        inSchema(this.bySquashedName.get(variant)),
      );
      // One table name, or the transformation did not single one out.
      if (new Set(byNumber.map((table) => squash(table.name))).size === 1) found = byNumber;
    }
    if (found.length > 0) return { kind: "found", tables: [...new Set(found)] };
    // `sales` or `work.sales`, for a dataset the lineage calls either.
    if (this.datasets.has(whole) || this.datasets.has(bare)) return { kind: "dataset" };
    if (schema != null && !this.schemasRead.has(schema)) return { kind: "unread" };
    return this.partlyUnread ? { kind: "unread" } : { kind: "absent" };
  }

  /**
   * A column of one of `tables`: by name, else by the one near-miss rule — equal
   * once case and underscores are ignored, with exactly one such column.
   */
  resolveColumn(tables: readonly SchemaInventoryTable[], raw: string): ColumnMatch {
    const name = raw.toLowerCase();
    for (const table of tables) {
      const column = this.columns.get(table)?.exact.get(name);
      if (column) return { kind: "exact", table, column };
    }
    const key = squash(raw);
    let near: { table: SchemaInventoryTable; column: SchemaInventoryColumn } | null = null;
    for (const table of tables) {
      for (const column of this.columns.get(table)?.squashed.get(key) ?? []) {
        if (near && near.column.name !== column.name) return { kind: "none" };
        near = { table, column };
      }
    }
    return near ? { kind: "near", ...near } : { kind: "none" };
  }

  /**
   * Those of `tables` whose columns are not known: a table the code graph has
   * by name only (an ORM call site names the table and no column), or one a
   * read returned without columns. Nothing can be said about a column of it.
   */
  withoutColumns(tables: readonly SchemaInventoryTable[]): SchemaInventoryTable[] {
    return tables.filter((table) => table.columns.length === 0);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TypeFamily = "boolean" | "number" | "text" | "temporal" | "binary" | "json";

const NUMBER_TYPES = new Set([
  "int",
  "integer",
  "bigint",
  "smallint",
  "serial",
  "bigserial",
  "smallserial",
  "numeric",
  "decimal",
  "number",
  "float",
  "double",
  "real",
  "money",
  "long",
  "short",
]);
const TEXT_TYPES = new Set([
  "text",
  "string",
  "varchar",
  "nvarchar",
  "varchar2",
  "char",
  "nchar",
  "character",
  "citext",
  "clob",
  "uuid",
]);
const BINARY_TYPES = new Set(["bytea", "blob", "binary", "varbinary", "bytes", "[]byte"]);
const BOOLEAN_TYPES = new Set(["bool", "boolean"]);
const TEMPORAL_TYPES = new Set([
  "timestamp",
  "timestamptz",
  "datetime",
  "date",
  "time",
  "timetz",
  "interval",
]);
/** Words that make a type a collection or an enum, whose family is not known. */
const UNKNOWN_SHAPE_WORDS = new Set(["list", "array", "slice", "set", "map", "enum"]);

/**
 * The broad family of a type as written by a model (`int64`, `*string`,
 * `[]byte`) or reported by a database (`character varying(255)`), or `null`
 * when it cannot be told: arrays, enums, `USER-DEFINED`, `tinyint` and `bit`
 * (a number in one dialect and a boolean in another).
 */
export function typeFamily(raw: string): TypeFamily | null {
  let text = raw.toLowerCase().split("*").join("").split("`").join("").trim();
  const paren = text.indexOf("(");
  if (paren >= 0) text = text.slice(0, paren).trim();
  if (!text) return null;
  if (BINARY_TYPES.has(text)) return "binary";
  if (text.includes("json")) return "json";
  if (text.includes("[]") || text.startsWith("_")) return null;
  const words = text.split(" ").filter(Boolean);
  if (words.some((word) => UNKNOWN_SHAPE_WORDS.has(word))) return null;
  const first = words[0];
  if (BOOLEAN_TYPES.has(first)) return "boolean";
  if (TEMPORAL_TYPES.has(first)) return "temporal";
  if (TEXT_TYPES.has(first)) return "text";
  if (BINARY_TYPES.has(first)) return "binary";
  // int8, int64, uint32, float64
  let end = first.length;
  while (end > 0 && first.charCodeAt(end - 1) >= 48 && first.charCodeAt(end - 1) <= 57) end--;
  const stem = first.slice(0, end);
  if (NUMBER_TYPES.has(first) || stem === "int" || stem === "uint" || stem === "float") {
    return "number";
  }
  return null;
}

/**
 * Families that are NOT a disagreement, because the application's type and the
 * column's differ by design somewhere: a boolean kept in an integer column, a
 * time kept as text or as epoch seconds, JSON kept in a text or binary column.
 */
const COMPATIBLE = new Set([
  "boolean:number",
  "number:boolean",
  "temporal:text",
  "text:temporal",
  "temporal:number",
  "number:temporal",
  "json:text",
  "text:json",
  "json:binary",
  "binary:json",
]);

/** True only when both types are understood and cannot describe one column. */
export function typesDisagree(written: string, schema: string): boolean {
  const a = typeFamily(written);
  const b = typeFamily(schema);
  if (!a || !b || a === b) return false;
  return !COMPATIBLE.has(`${a}:${b}`);
}

/** Type words {@link typeFamily} gives no family, and multi-word types as Mermaid writes them. */
const OTHER_TYPE_WORDS = new Set([
  "json",
  "jsonb",
  "tinyint",
  "mediumint",
  "bit",
  "enum",
  "array",
  "inet",
  "cidr",
  "macaddr",
  "tsvector",
  "xml",
  "hstore",
  "oid",
  "year",
  "raw",
  "rowid",
  "nclob",
  "ntext",
  "tinytext",
  "mediumtext",
  "longtext",
  "datetime2",
  "geometry",
  "geography",
  "user_defined",
  "user-defined",
  "character_varying",
  "double_precision",
  "bit_varying",
  "timestamp_with_time_zone",
  "timestamp_without_time_zone",
  "time_with_time_zone",
  "time_without_time_zone",
]);

/**
 * Whether a diagram token is a type and so cannot be the attribute's name.
 * Decided on the whole word: `date_added` and `settings_json` are names.
 */
export function isTypeWord(token: string): boolean {
  let text = token.toLowerCase().split("*").join("");
  const paren = text.indexOf("(");
  if (paren >= 0) text = text.slice(0, paren);
  if (!text) return false;
  if (text.includes("[]")) return true;
  if (
    NUMBER_TYPES.has(text) ||
    TEXT_TYPES.has(text) ||
    BINARY_TYPES.has(text) ||
    BOOLEAN_TYPES.has(text) ||
    TEMPORAL_TYPES.has(text) ||
    OTHER_TYPE_WORDS.has(text)
  ) {
    return true;
  }
  // int8, int64, uint32, float64
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) >= 48 && text.charCodeAt(end - 1) <= 57) end--;
  const stem = text.slice(0, end);
  return end < text.length && (stem === "int" || stem === "uint" || stem === "float");
}

// ---------------------------------------------------------------------------
// Markdown scanning (index-based; linear)
// ---------------------------------------------------------------------------

interface Span {
  text: string;
  /** Index of the first backtick of the opening run. */
  open: number;
  /** Index of the last backtick of the closing run. */
  close: number;
}

/**
 * Each code span of `text` between `from` and `to`, in order, as CommonMark
 * delimits one: a run of N backticks opens a span that the next run of EXACTLY
 * N backticks closes, so `` ``a`b`` `` is one span holding a backtick, and a
 * run with no partner is literal text. A backtick behind a backslash opens
 * nothing. `open` is the first backtick of the opening run and `close` the LAST
 * backtick of the closing run, so `close + 1` is always outside the span: that
 * is where a marker goes.
 *
 * One pass to find the runs, and one forward-only cursor per run length to
 * find a partner, so it is linear in the text.
 */
function spanRanges(text: string, from = 0, to = text.length): Span[] {
  const runs: Array<{ at: number; length: number }> = [];
  const byLength = new Map<number, number[]>();
  for (let i = from; i < to;) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let end = i;
    while (end < to && text[end] === "`") end++;
    push(byLength, end - i, runs.length);
    runs.push({ at: i, length: end - i });
    i = end;
  }
  const cursor = new Map<number, number>();
  /** The first run after `after` that is exactly `length` long, or -1. */
  const partner = (length: number, after: number): number => {
    const candidates = byLength.get(length);
    if (!candidates) return -1;
    let k = cursor.get(length) ?? 0;
    while (k < candidates.length && candidates[k] <= after) k++;
    cursor.set(length, k);
    return k < candidates.length ? candidates[k] : -1;
  };
  const spans: Span[] = [];
  let floor = from;
  let r = 0;
  while (r < runs.length) {
    let open = runs[r].at;
    let length = runs[r].length;
    let slashes = 0;
    while (open - slashes - 1 >= floor && text[open - slashes - 1] === "\\") slashes++;
    if (slashes % 2 === 1) {
      // The first backtick is escaped: the run that can open is one shorter.
      open += 1;
      length -= 1;
    }
    const q = length > 0 ? partner(length, r) : -1;
    if (q < 0) {
      r += 1;
      continue;
    }
    let inner = text.slice(open + length, runs[q].at);
    // One space of padding on each side is not part of the content.
    if (inner.length > 1 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") {
      inner = inner.slice(1, -1);
    }
    const close = runs[q].at + runs[q].length - 1;
    spans.push({ text: inner, open, close });
    floor = close + 1;
    r = q + 1;
  }
  return spans;
}

/** The contents of each `` `code span` `` in a piece of text, in order. */
export function codeSpans(text: string): string[] {
  return spanRanges(text).map((span) => span.text);
}

/** How every marker starts; a name that already carries one is not marked again. */
const MARKED = " *(not in schema";
const NOT_IN_SCHEMA = `${MARKED})*`;

function nearMissMarker(schemaName: string): string {
  return `${MARKED}; the schema has \`${plainSchemaText(schemaName)}\`)*`;
}

/**
 * `line` with each marker inserted at its offset. This is the ONLY function
 * that produces changed model text, and all it can do is insert a marker: the
 * text on either side of every offset is copied unchanged.
 */
function withMarkers(line: string, markers: ReadonlyArray<{ at: number; text: string }>): string {
  if (markers.length === 0) return line;
  const ordered = [...markers].sort((a, b) => a.at - b.at);
  const out: string[] = [];
  let from = 0;
  for (const marker of ordered) {
    out.push(line.slice(from, marker.at));
    // Already there when the text has been through the check before.
    if (!line.startsWith(MARKED, marker.at)) out.push(marker.text);
    from = marker.at;
  }
  out.push(line.slice(from));
  return out.join("");
}

interface Cell {
  text: string;
  start: number;
  end: number;
}

/** The cells of one GFM table row; `\|` does not split. */
export function splitCells(line: string): Cell[] {
  const bars: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") bars.push(i);
  }
  const cells: Cell[] = [];
  for (let k = 0; k + 1 < bars.length; k++) {
    cells.push({
      text: line.slice(bars[k] + 1, bars[k + 1]),
      start: bars[k] + 1,
      end: bars[k + 1],
    });
  }
  return cells;
}

function isTableRow(line: string): boolean {
  return line.trimStart().startsWith("|");
}

/** A line of nothing but spaces, tabs and a carriage return. */
function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** How many cells a GFM row has: the outer pipes are optional, and an escaped pipe is none. */
function cellCount(line: string): number {
  const text = line.trim();
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|" && i > 0 && i < text.length - 1) count++;
  }
  return count;
}

/**
 * A GFM delimiter row: cells of dashes, each with an optional colon at either
 * end, between pipes (the last one optional). Spaces only: with a tab in it,
 * or after it, the export's parser draws no table.
 */
function isDelimiterRow(line: string): boolean {
  let end = line.length;
  if (line[end - 1] === "\r") end -= 1;
  while (end > 0 && line[end - 1] === " ") end--;
  let at = 0;
  while (at < end && line[at] === " ") at++;
  if (line[at] !== "|") return false;
  at += 1;
  let cells = 0;
  while (at < end) {
    while (at < end && line[at] === " ") at++;
    if (line[at] === ":") at++;
    let dashes = 0;
    while (at < end && line[at] === "-") {
      at++;
      dashes++;
    }
    if (dashes === 0) return false;
    if (line[at] === ":") at++;
    while (at < end && line[at] === " ") at++;
    cells += 1;
    if (at === end) return true;
    if (line[at] !== "|") return false;
    at += 1;
  }
  return cells > 0;
}

function plainCell(text: string): string {
  return text.split("*").join("").split("`").join("").trim().toLowerCase();
}

const FIELD_HEADERS = new Set(["field", "column", "attribute", "field name", "column name"]);
const TYPE_HEADERS = new Set(["type", "data type", "datatype"]);

/** `{ typeIndex }` when the header is a field table's, else `null`. */
function fieldTableShape(header: Cell[]): { typeIndex: number } | null {
  if (header.length < 2) return null;
  const names = header.map((cell) => plainCell(cell.text));
  const typeIndex = names.findIndex((name) => TYPE_HEADERS.has(name));
  if (FIELD_HEADERS.has(names[0]) || (names[0] === "name" && typeIndex > 0)) return { typeIndex };
  return null;
}

/**
 * Columns of leading white space, counted to four: a tab runs to the next
 * multiple of four. Four or more is where CommonMark starts an indented code
 * block (or continues a list item; the check cannot tell which).
 */
function indentOf(line: string): number {
  let columns = 0;
  for (let i = 0; i < line.length && columns < 4; i++) {
    if (line[i] === " ") columns += 1;
    else if (line[i] === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return Math.min(columns, 4);
}

/**
 * The fence a line opens, as CommonMark reads it: at most three spaces, then
 * three or more backticks or tildes. A backtick fence whose info string holds
 * a backtick is an inline code span, not a fence.
 */
function fenceOpening(line: string): { char: string; length: number } | null {
  if (indentOf(line) > 3) return null;
  const text = line.trimStart();
  const char = text[0];
  if (char !== "`" && char !== "~") return null;
  let length = 0;
  while (length < text.length && text[length] === char) length++;
  if (length < 3) return null;
  if (char === "`" && text.indexOf("`", length) >= 0) return null;
  return { char, length };
}

/**
 * The two Markdown parsers a generated document goes through do not agree on
 * what closes a fence: the viewer's (remark, which follows CommonMark) and the
 * export's (`marked`). A line that is code to EITHER is treated as code.
 *
 *  - `commonmark`: at most three spaces, the fence's character at least as
 *    many times as it was opened with, then only spaces or tabs.
 *  - `marked`: the same, except that the run may go on in the OTHER fence
 *    character too, and only spaces may follow it (a tab after the fence
 *    leaves the block open).
 *
 * In both, a four-backtick fence is not closed by a three-backtick line
 * inside it, and no fence is closed by a line that opens another (` ```go `).
 */
type FenceDialect = "commonmark" | "marked";

function closesFence(
  line: string,
  fence: { char: string; length: number },
  dialect: FenceDialect,
): boolean {
  if (indentOf(line) > 3) return false;
  let end = line.length;
  if (line[end - 1] === "\r") end -= 1;
  while (
    end > 0 &&
    (line[end - 1] === " " || (dialect === "commonmark" && line[end - 1] === "\t"))
  ) {
    end -= 1;
  }
  let at = 0;
  while (at < end && line[at] === " ") at++;
  let run = 0;
  while (at + run < end && line[at + run] === fence.char) run++;
  if (run < fence.length) return false;
  at += run;
  if (dialect === "marked") while (at < end && (line[at] === "`" || line[at] === "~")) at++;
  return at === end;
}

const RAW_HTML_TAGS = ["pre", "script", "style", "textarea"];
const RAW_HTML_CLOSERS = RAW_HTML_TAGS.map((tag) => `</${tag}>`);

/**
 * How a line that starts raw HTML ends its block, or `null` when the line
 * starts none. `<pre>`, `<script>`, `<style>` and `<textarea>` run to their
 * closing tag and a comment to `-->`, blank lines included; any other tag runs
 * to the next blank line.
 */
function htmlOpening(line: string): { until: readonly string[] | "blank" } | null {
  if (indentOf(line) > 3) return null;
  const text = line.trimStart().toLowerCase();
  if (!text.startsWith("<") || text.length < 2) return null;
  if (text.startsWith("<!--")) return { until: ["-->"] };
  for (const tag of RAW_HTML_TAGS) {
    if (!text.startsWith(tag, 1)) continue;
    const after = text[1 + tag.length];
    if (after === undefined || after === ">" || after === " " || after === "\t" || after === "\r") {
      return { until: RAW_HTML_CLOSERS };
    }
  }
  const next = text.charCodeAt(1);
  const letter = next >= 97 && next <= 122;
  return letter || text[1] === "/" || text[1] === "!" || text[1] === "?"
    ? { until: "blank" }
    : null;
}

interface FencedBlock {
  /** Index of the line after the block: past the closing fence when it has one. */
  end: number;
  closed: boolean;
}

interface Blocks {
  /** The fenced blocks, by the index of their opening line. */
  fences: Map<number, FencedBlock>;
  /**
   * Lines where a marker could land inside code, or where the check cannot
   * tell that it would not: every line of a fenced block, of a raw HTML
   * block, and every line indented four columns or more. Such a line is
   * copied exactly as written and nothing on it is judged.
   */
  opaque: boolean[];
  /** The text ends inside a fence or a raw HTML block that was never closed. */
  openAtEnd: boolean;
}

/**
 * Which lines are, or may be, code: read once as each parser reads fences, and
 * a line is opaque when it is to either. The fenced blocks themselves (read for
 * a diagram, never written to) are CommonMark's.
 */
function scanBlocks(lines: readonly string[]): Blocks {
  const blocks = scanBlocksAs(lines, "commonmark");
  const other = scanBlocksAs(lines, "marked");
  return {
    fences: blocks.fences,
    opaque: blocks.opaque.map((opaque, at) => opaque || other.opaque[at]),
    openAtEnd: blocks.openAtEnd || other.openAtEnd,
  };
}

/** One pass over the lines, with one parser's rule for closing a fence. */
function scanBlocksAs(lines: readonly string[], dialect: FenceDialect): Blocks {
  const fences = new Map<number, FencedBlock>();
  const opaque = lines.map(() => false);
  let openAtEnd = false;
  let i = 0;
  while (i < lines.length) {
    const fence = fenceOpening(lines[i]);
    if (fence) {
      let close = i + 1;
      while (close < lines.length && !closesFence(lines[close], fence, dialect)) close++;
      const closed = close < lines.length;
      const end = closed ? close + 1 : lines.length;
      fences.set(i, { end, closed });
      for (let at = i; at < end; at++) opaque[at] = true;
      openAtEnd = !closed;
      i = end;
      continue;
    }
    const html = htmlOpening(lines[i]);
    if (html) {
      const until = html.until;
      let end = i;
      if (until === "blank") {
        while (end < lines.length && !isBlank(lines[end])) end++;
      } else {
        const closes = (line: string): boolean => {
          const lower = line.toLowerCase();
          return until.some((closer) => lower.includes(closer));
        };
        while (end < lines.length && !closes(lines[end])) end++;
        openAtEnd = end >= lines.length;
        end = Math.min(end + 1, lines.length);
      }
      for (let at = i; at < end; at++) opaque[at] = true;
      i = end;
      continue;
    }
    if (indentOf(lines[i]) > 3 && !isBlank(lines[i])) opaque[i] = true;
    i += 1;
  }
  return { fences, opaque, openAtEnd };
}

const HEADING_LABELS = ["entities:", "entity:", "tables:", "table:"];

export interface HeadingName {
  /** The table name the heading states, with its schema when it gives one. */
  name: string;
  /** Offset in the heading line just past the name as written. */
  end: number;
}

export interface HeadingClaim {
  /** The names the heading states are tables; empty for any other heading. */
  names: HeadingName[];
}

/** Words that stand beside "schema" in a parenthesis without being its name. */
const NOT_A_SCHEMA_NAME = new Set([
  "the",
  "a",
  "an",
  "in",
  "of",
  "its",
  "own",
  "this",
  "that",
  "other",
  "another",
  "different",
  "separate",
  "default",
  "database",
  "db",
  "is",
  "table",
]);

/**
 * The schema a heading's parenthesis names: `(audit schema)`, `(schema audit)`,
 * `(in the audit schema)`, `(schema: audit)`. `null` when it names none.
 */
function schemaNamedIn(text: string): string | null {
  const words = text
    .split("`")
    .join(" ")
    .split(":")
    .join(" ")
    .split(",")
    .join(" ")
    .split(" ")
    .filter(Boolean);
  const at = words.findIndex((word) => word.toLowerCase() === "schema");
  if (at < 0) return null;
  for (const candidate of [words[at - 1], words[at + 1]]) {
    if (candidate && isIdentifier(candidate) && !NOT_A_SCHEMA_NAME.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return null;
}

/** The names between `from` and `to` of a labelled heading, with where each ends. */
function headingNames(line: string, from: number, to: number): HeadingName[] {
  const spans = spanRanges(line, from, to);
  if (spans.length > 0) {
    const names: HeadingName[] = [];
    for (let i = 0; i < spans.length; i++) {
      let name = spans[i].text;
      let close = spans[i].close;
      // `audit`.`users`: each part in its own code span.
      while (i + 1 < spans.length && line.slice(close + 1, spans[i + 1].open) === ".") {
        i += 1;
        name = `${name}.${spans[i].text}`;
        close = spans[i].close;
      }
      // audit.`users`: the schema written before the code span.
      const open = spans[i].open;
      if (name === spans[i].text && open > from && line[open - 1] === ".") {
        let start = open - 1;
        while (start > from && isIdentifierChar(line.charCodeAt(start - 1), false)) start--;
        const prefix = line.slice(start, open - 1);
        if (isIdentifier(prefix)) name = `${prefix}.${name}`;
      }
      if (isQualifiedIdentifier(name)) names.push({ name, end: close + 1 });
    }
    return names;
  }
  const words: HeadingName[] = [];
  const isGap = (ch: string): boolean => ch === " " || ch === "," || ch === "\t";
  let at = from;
  while (at < to) {
    while (at < to && isGap(line[at])) at++;
    let end = at;
    while (end < to && !isGap(line[end])) end++;
    const word = line.slice(at, end);
    if (word && word !== "and" && word !== "&") words.push({ name: word, end });
    at = end;
  }
  const allNames = words.every((word) => isQualifiedIdentifier(word.name));
  return words.length > 0 && words.length <= 4 && allNames ? words : [];
}

/**
 * The table names a heading claims, or `null` for a line that is no heading.
 * Only a heading labelled `Entity:` / `Entities:` / `Table:` / `Tables:` claims
 * any. Every other heading (`#### \`Feed\` struct`, `### Sessions`) carries
 * none, which also ends the context of the labelled heading before it.
 *
 * The schema is read from the heading's WHOLE text, not only from the code
 * span: `audit.` before the span, `` `audit`.`users` ``, and a parenthesis
 * that names one (`(audit schema)`) all make the name `audit.users`.
 */
export function parseHeading(line: string): HeadingClaim | null {
  let level = 0;
  while (level < line.length && level < 7 && line[level] === "#") level++;
  if (level < 2 || level > 6 || line[level] !== " ") return null;
  let at = level + 1;
  while (at < line.length && line[at] === " ") at++;
  const lower = line.slice(at, at + 16).toLowerCase();
  const label = HEADING_LABELS.find((candidate) => lower.startsWith(candidate));
  if (!label) return { names: [] };
  const from = at + label.length;
  // The heading's text stops before trailing white space (a CRLF's carriage
  // return included) and before a closing run of `#`.
  const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\r";
  let stop = line.length;
  while (stop > from && isSpace(line[stop - 1])) stop--;
  let hashes = stop;
  while (hashes > from && line[hashes - 1] === "#") hashes--;
  if (hashes < stop && (hashes === from || isSpace(line[hashes - 1]))) {
    stop = hashes;
    while (stop > from && isSpace(line[stop - 1])) stop--;
  }
  const open = line.indexOf("(", from);
  let paren = open >= 0 && open < stop ? open : -1;
  // A heading that has been through the check carries a marker, whose own
  // parenthesis is neither a name nor the heading's: the names end before the
  // marker, and the heading's parenthesis is the next one. So the heading is
  // read the same on a second pass.
  let namesEnd = paren >= 0 ? paren : stop;
  while (paren >= 2 && line.startsWith(MARKED, paren - 2)) {
    namesEnd = Math.min(namesEnd, paren - 2);
    const next = line.indexOf("(", line.indexOf(")", paren) + 1);
    paren = next > paren && next < stop ? next : -1;
  }
  const names = headingNames(line, from, namesEnd);
  if (paren >= 0 && names.length === 1 && !names[0].name.includes(".")) {
    const close = line.indexOf(")", paren);
    const schema = schemaNamedIn(line.slice(paren + 1, close >= 0 ? close : line.length));
    if (schema) names[0] = { name: `${schema}.${names[0].name}`, end: names[0].end };
  }
  return { names };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function tick(name: string): string {
  return `\`${plainSchemaText(name)}\``;
}

const MAX_LISTED = 12;

function listedWith<T>(items: readonly T[], show: (item: T) => string): string {
  const shown = items.slice(0, MAX_LISTED).map(show).join(", ");
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

function listed(names: readonly string[]): string {
  return listedWith(names, tick);
}

interface Findings {
  unresolvedTables: Set<string>;
  flaggedColumns: Set<string>;
  suggestions: Map<string, string>;
  typeMismatches: Map<string, { written: string; schema: string }>;
  notChecked: Map<string, NotCheckedReason>;
  inDiagram: Set<string>;
}

interface CheckState {
  index: InventoryIndex;
  typed: boolean;
  found: Findings;
}

/** A column the table does not have: recorded; `near` carries the schema's spelling. */
function flagColumn(state: CheckState, qualified: string, match: ColumnMatch): void {
  state.found.flaggedColumns.add(qualified);
  if (match.kind === "near") state.found.suggestions.set(qualified, match.column.name);
}

function noteTypeMismatch(
  state: CheckState,
  column: string,
  written: string,
  schema: string,
): void {
  state.found.typeMismatches.set(column, {
    written: plainSchemaText(written),
    schema: plainSchemaText(schema),
  });
}

/**
 * Whether the document itself calls the thing a view. The inventory cannot tell
 * a view from a table (Postgres lists a view's columns with the tables', other
 * drivers may not list views at all), so a name that does not resolve and is
 * called a view by its own row or heading is not judged.
 */
function saysView(text: string): boolean {
  return /\bviews?\b/i.test(text);
}

/** The first whitespace-separated tokens of a diagram line. */
function diagramTokens(text: string): string[] {
  return text.split(" ").join("\t").split("\t").filter(Boolean);
}

/** An entity as a block header writes it: `USERS`, `USERS["audit.users"]`. */
function entityName(header: string): { id: string; name: string } {
  const bracket = header.indexOf("[");
  const id = (bracket >= 0 ? header.slice(0, bracket) : header).split('"').join("").trim();
  if (bracket < 0) return { id, name: id };
  const close = header.indexOf("]", bracket);
  const alias = header
    .slice(bracket + 1, close >= 0 ? close : header.length)
    .split('"')
    .join("")
    .trim();
  // The alias is the table when it is a name; a caption ("User accounts") is not.
  return { id, name: isQualifiedIdentifier(alias) ? alias : id };
}

/**
 * Which of an attribute line's first two tokens is the column's name. Mermaid's
 * order is `type name`; models also write `name type`. `null` when the line
 * does not say: both tokens are columns, both are type words, or neither is
 * either.
 */
function attributeName(
  state: CheckState,
  block: readonly SchemaInventoryTable[],
  first: string,
  second: string,
): { name: string; type: string } | null {
  const isColumn = (token: string): boolean =>
    isIdentifier(token) && state.index.resolveColumn(block, token).kind === "exact";
  const firstIsColumn = isColumn(first);
  const secondIsColumn = isColumn(second);
  if (secondIsColumn && !firstIsColumn) return { name: second, type: first };
  if (firstIsColumn && !secondIsColumn) return { name: first, type: second };
  if (firstIsColumn && secondIsColumn) return null;
  const firstIsType = isTypeWord(first);
  const secondIsType = isTypeWord(second);
  if (firstIsType && !secondIsType && isIdentifier(second)) return { name: second, type: first };
  if (secondIsType && !firstIsType && isIdentifier(first)) return { name: first, type: second };
  return null;
}

/**
 * One `erDiagram`. Nothing is returned to write back: a diagram is never
 * edited, so everything found here goes to the note.
 */
function checkErDiagram(body: readonly string[], state: CheckState): void {
  // An entity's alias can be declared after a relationship that uses its id.
  const aliases = new Map<string, string>();
  for (const line of body) {
    const text = line.trim();
    if (!text.endsWith("{")) continue;
    const { id, name } = entityName(text.slice(0, -1));
    if (id && name !== id) aliases.set(id, name);
  }
  const entity = (rawId: string): SchemaInventoryTable[] | null => {
    const id = rawId.split('"').join("").trim();
    const name = (aliases.get(id) ?? id).split("-").join("_");
    if (!isQualifiedIdentifier(name)) return null;
    const verdict = state.index.resolveTable(name);
    if (verdict.kind === "found") return verdict.tables;
    if (verdict.kind === "absent") {
      state.found.unresolvedTables.add(name);
      state.found.inDiagram.add(name);
    } else {
      state.found.notChecked.set(name, verdict.kind);
    }
    return null;
  };
  // `undefined` outside an entity block; `null` inside one that did not resolve.
  let block: SchemaInventoryTable[] | null | undefined;
  for (const line of body) {
    const text = line.trim();
    if (block !== undefined) {
      if (text.startsWith("}")) {
        block = undefined;
        continue;
      }
      const tokens = diagramTokens(text);
      if (!block || tokens.length < 2) continue;
      const table = block[0].name;
      const attribute = attributeName(state, block, tokens[0], tokens[1]);
      if (!attribute) {
        // Both columns: there is nothing to say about the line.
        const bothColumns =
          isIdentifier(tokens[0]) &&
          state.index.resolveColumn(block, tokens[0]).kind === "exact" &&
          isIdentifier(tokens[1]) &&
          state.index.resolveColumn(block, tokens[1]).kind === "exact";
        if (!bothColumns) {
          state.found.notChecked.set(`${table}: ${tokens[0]} ${tokens[1]}`, "diagram-line");
        }
        continue;
      }
      const match = state.index.resolveColumn(block, attribute.name);
      if (match.kind !== "exact" && listTablesWithoutColumns(state, block)) continue;
      if (match.kind !== "exact") {
        const qualified = `${table}.${attribute.name}`;
        flagColumn(state, qualified, match);
        state.found.inDiagram.add(qualified);
        continue;
      }
      // With two tables of this name, which one's type is meant is not known.
      if (
        state.typed &&
        block.length === 1 &&
        typesDisagree(attribute.type, match.column.dataType)
      ) {
        noteTypeMismatch(
          state,
          `${match.table.name}.${match.column.name}`,
          attribute.type,
          match.column.dataType,
        );
      }
      continue;
    }
    if (text.endsWith("{")) {
      block = entity(entityName(text.slice(0, -1)).id);
      continue;
    }
    const tokens = diagramTokens(text);
    const relation = tokens.length >= 3 ? tokens[1] : "";
    if (relation.length <= 12 && (relation.includes("--") || relation.includes(".."))) {
      entity(tokens[0]);
      entity(tokens[2].endsWith(":") ? tokens[2].slice(0, -1) : tokens[2]);
    }
  }
}

/**
 * Never judge a column against nothing, per table: when one of the tables a
 * name could be a column of has no known columns, the name is not judged, and
 * each such table is listed once as "columns not checked". True when it applied.
 */
function listTablesWithoutColumns(
  state: CheckState,
  tables: readonly SchemaInventoryTable[],
): boolean {
  const unknown = state.index.withoutColumns(tables);
  for (const table of unknown) state.found.notChecked.set(table.name, "no-columns");
  return unknown.length > 0;
}

interface PendingHeading {
  claim: HeadingClaim;
  /** Index of the heading's line in the output. */
  at: number;
  line: string;
}

interface RowContext {
  /** Tables the enclosing heading resolved to. */
  tables: SchemaInventoryTable[];
  /** False when the heading also named something that did not resolve. */
  complete: boolean;
}

const ROSTER_HEADERS = new Set(["table", "tables", "table name"]);

/** A table that lists tables: its first header cell is `Table`. */
function isTableRoster(header: Cell[]): boolean {
  return header.length > 0 && ROSTER_HEADERS.has(plainCell(header[0].text));
}

/** One row of a table roster: a name in its first cell that is no table is marked. */
function checkRosterRow(line: string, state: CheckState): string {
  const cells = splitCells(line);
  if (cells.length === 0) return line;
  const markers: Array<{ at: number; text: string }> = [];
  for (const span of spanRanges(line, cells[0].start, cells[0].end)) {
    if (!isQualifiedIdentifier(span.text)) continue;
    const verdict = state.index.resolveTable(span.text);
    if (verdict.kind === "found") continue;
    if (saysView(line)) {
      state.found.notChecked.set(span.text, "view");
    } else if (verdict.kind !== "absent") {
      state.found.notChecked.set(span.text, verdict.kind);
    } else {
      state.found.unresolvedTables.add(span.text);
      markers.push({ at: span.close + 1, text: NOT_IN_SCHEMA });
    }
  }
  return withMarkers(line, markers);
}

/** Type words that are never part of a column's type. */
const NON_COLUMN_WORDS = new Set([
  "index",
  "indexes",
  "constraint",
  "trigger",
  "sequence",
  "relation",
  "relationship",
]);
/** Words that say "not a column" when the Type cell STARTS with them. */
const NON_COLUMN_FIRST_WORDS = new Set([
  "key",
  "primary",
  "foreign",
  "unique",
  "fk",
  "pk",
  "uq",
  "check",
  "btree",
  "hash",
  "gin",
  "gist",
  "brin",
]);

/**
 * True when a row's Type cell says the row is an index, a constraint, a key, a
 * trigger, a sequence or a relation: `btree`, `UNIQUE (email)`, `FK`,
 * `relation`, `unique index`. Decided on whole words, and for the key words on
 * the FIRST word only, so `integer (indexed)` and `BIGSERIAL PRIMARY KEY` are
 * still column types.
 */
export function isNonColumnType(cell: string): boolean {
  const words = plainCell(cell).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  return NON_COLUMN_FIRST_WORDS.has(words[0]) || words.some((word) => NON_COLUMN_WORDS.has(word));
}

const INDEX_NAME_PREFIXES = [
  "idx_",
  "ix_",
  "pk_",
  "fk_",
  "uq_",
  "uk_",
  "chk_",
  "index_",
  "unique_",
];
const INDEX_NAME_SUFFIXES = [
  "_idx",
  "_pkey",
  "_fkey",
  "_key",
  "_index",
  "_unique",
  "_uniq",
  "_foreign",
  "_primary",
  "_check",
  "_seq",
  "_trigger",
];

/** A name in the usual shape of an index, a key constraint or a sequence. */
export function looksLikeIndexName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    INDEX_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    INDEX_NAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

/** One field-table row: the line, with a marker after each unmatched name. */
function checkRow(line: string, typeIndex: number, context: RowContext, state: CheckState): string {
  const cells = splitCells(line);
  if (cells.length === 0 || context.tables.length === 0) return line;
  const names = spanRanges(line, cells[0].start, cells[0].end).filter((span) =>
    isQualifiedIdentifier(span.text),
  );
  if (names.length === 0) return line;
  const typeCell = typeIndex > 0 && typeIndex < cells.length ? cells[typeIndex] : undefined;
  // A row that describes an index, a constraint or a relation names no column.
  const notAColumnRow = typeCell != null && isNonColumnType(typeCell.text);
  const markers: Array<{ at: number; text: string }> = [];
  for (const span of names) {
    const dot = span.text.lastIndexOf(".");
    const columnName = dot >= 0 ? span.text.slice(dot + 1) : span.text;
    let tables = context.tables;
    if (dot >= 0) {
      // `table.column` is a claim only when `table` is one of the heading's own
      // tables. Anything else dotted is a path (`settings.theme`, `model.Job`).
      const qualifier = span.text.slice(0, dot).toLowerCase();
      tables = context.tables.filter(
        (table) =>
          table.name.toLowerCase() === qualifier ||
          `${table.schema}.${table.name}`.toLowerCase() === qualifier,
      );
      if (tables.length === 0) {
        state.found.notChecked.set(span.text, "not-a-column");
        continue;
      }
    } else if (!context.complete) {
      // The heading also named something unknown: a bare name may be its column.
      continue;
    }
    const match = state.index.resolveColumn(tables, columnName);
    const qualified = `${tables[0].name}.${columnName}`;
    if (match.kind === "exact") {
      // One name, one type, one table: otherwise whose type is meant is not known.
      if (
        state.typed &&
        typeCell &&
        !notAColumnRow &&
        names.length === 1 &&
        tables.length === 1 &&
        typesDisagree(typeCell.text, match.column.dataType)
      ) {
        noteTypeMismatch(
          state,
          `${match.table.name}.${match.column.name}`,
          typeCell.text.trim(),
          match.column.dataType,
        );
      }
      continue;
    }
    if (notAColumnRow || looksLikeIndexName(columnName)) {
      state.found.notChecked.set(qualified, "not-a-column");
      continue;
    }
    if (listTablesWithoutColumns(state, tables)) continue;
    flagColumn(state, qualified, match);
    markers.push({
      at: span.close + 1,
      text: match.kind === "near" ? nearMissMarker(match.column.name) : NOT_IN_SCHEMA,
    });
  }
  return withMarkers(line, markers);
}

const EMPTY_REPORT: SchemaCheckReport = {
  checked: false,
  unresolvedTables: [],
  flaggedColumns: [],
  suggestions: [],
  typeMismatches: [],
  notChecked: [],
  inDiagram: [],
};

/**
 * Check one section's markdown against the inventory. Returns the markdown
 * with a marker after each name that could not be matched, and nothing else
 * changed, and a report of what was found.
 */
export function checkSchemaClaims(
  markdown: string,
  inventory: SchemaInventory,
): { markdown: string; report: SchemaCheckReport } {
  // Never judge a section against nothing: that would mark all of it.
  if (inventory.tables.length === 0) return { markdown, report: { ...EMPTY_REPORT } };
  const found: Findings = {
    unresolvedTables: new Set(),
    flaggedColumns: new Set(),
    suggestions: new Map(),
    typeMismatches: new Map(),
    notChecked: new Map(),
    inDiagram: new Set(),
  };
  const state: CheckState = {
    index: new InventoryIndex(inventory),
    typed: isTypedInventory(inventory),
    found,
  };

  // Split on LF and joined on LF: a CRLF's carriage return stays at the end of
  // its line, where nothing reads it as part of a name.
  const lines = markdown.split("\n");
  const blocks = scanBlocks(lines);
  const out: string[] = [];
  /**
   * The `Entity:` / `Table:` heading whose field table has not been reached
   * yet. Its context covers ONE table, the first one under it, whatever prose
   * stands between the two. After that table the heading is dropped, so a later
   * field table in the same sub-section (a struct, a message, an index list) is
   * never judged as columns of the heading's table.
   */
  let heading: PendingHeading | null = null;
  /**
   * The heading's own claim: each name it gives is a table. The marker goes
   * into the heading line, which is never code (an opaque line is no heading).
   */
  const claimHeading = (owner: PendingHeading): RowContext => {
    const context: RowContext = { tables: [], complete: true };
    const markers: Array<{ at: number; text: string }> = [];
    for (const { name, end: nameEnd } of owner.claim.names) {
      const verdict = state.index.resolveTable(name);
      if (verdict.kind === "found") {
        context.tables.push(...verdict.tables);
        continue;
      }
      context.complete = false;
      if (saysView(owner.line)) {
        found.notChecked.set(name, "view");
      } else if (verdict.kind !== "absent") {
        found.notChecked.set(name, verdict.kind);
      } else {
        found.unresolvedTables.add(name);
        markers.push({ at: nameEnd, text: NOT_IN_SCHEMA });
      }
    }
    out[owner.at] = withMarkers(owner.line, markers);
    return context;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenced = blocks.fences.get(i);
    if (fenced) {
      const body = lines.slice(i + 1, fenced.closed ? fenced.end - 1 : fenced.end);
      const firstLine = body.find((entry) => entry.trim() !== "")?.trim() ?? "";
      if (line.toLowerCase().includes("mermaid") && firstLine.startsWith("erDiagram")) {
        checkErDiagram(body, state);
      }
      // The fence and everything in it, exactly as written.
      for (let at = i; at < fenced.end; at++) out.push(lines[at]);
      i = fenced.end;
      continue;
    }
    if (blocks.opaque[i]) {
      // Raw HTML, or indented far enough to be a code block: copied as
      // written. A field table written there is still the first table under
      // its heading, so it takes the heading with it (the heading's own name
      // is judged; the rows, which may be code, are not).
      if (
        heading &&
        isTableRow(line) &&
        i + 1 < lines.length &&
        isDelimiterRow(lines[i + 1].trimStart())
      ) {
        if (fieldTableShape(splitCells(line))) claimHeading(heading);
        heading = null;
      }
      out.push(line);
      i += 1;
      continue;
    }
    const claim = parseHeading(line);
    if (claim) {
      out.push(line);
      heading = claim.names.length > 0 ? { claim, at: out.length - 1, line } : null;
      i += 1;
      continue;
    }
    // A table is a header row and a delimiter row of as many cells. With any
    // other count no renderer draws a table: the lines are a paragraph, where
    // a pipe ends nothing and a code span can run from one "cell" into the
    // next, so nothing in them is judged.
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isDelimiterRow(lines[i + 1]) &&
      !blocks.opaque[i + 1] &&
      cellCount(line) === cellCount(lines[i + 1])
    ) {
      let end = i + 2;
      while (end < lines.length && isTableRow(lines[end]) && !blocks.opaque[end]) end++;
      const shape = fieldTableShape(splitCells(line));
      // A field table is read only under an `Entity:` / `Table:` heading, and
      // only the first table under it: this one takes the heading with it.
      const owner = heading;
      heading = null;
      if (!shape || !owner) {
        const roster = isTableRoster(splitCells(line));
        out.push(line, lines[i + 1]);
        for (let row = i + 2; row < end; row++) {
          out.push(roster ? checkRosterRow(lines[row], state) : lines[row]);
        }
        i = end;
        continue;
      }
      const context = claimHeading(owner);
      out.push(line, lines[i + 1]);
      for (let row = i + 2; row < end; row++) {
        out.push(checkRow(lines[row], shape.typeIndex, context, state));
      }
      i = end;
      continue;
    }
    out.push(line);
    i += 1;
  }

  const report: SchemaCheckReport = {
    checked: true,
    unresolvedTables: [...found.unresolvedTables],
    flaggedColumns: [...found.flaggedColumns],
    suggestions: [...found.suggestions].map(([column, schema]) => ({ column, schema })),
    typeMismatches: [...found.typeMismatches].map(([column, types]) => ({ column, ...types })),
    notChecked: [...found.notChecked].map(([name, why]) => ({ name, why })),
    inDiagram: [...found.inDiagram],
  };
  return { markdown: out.join("\n"), report };
}

// ---------------------------------------------------------------------------
// The section as it reaches the document
// ---------------------------------------------------------------------------

const NOT_CHECKED_WHY: Array<[NotCheckedReason, string]> = [
  ["unread", "outside the schemas that were read"],
  [
    "not-a-column",
    "an index, constraint, key or relation row, or a name that is not a plain column name",
  ],
  ["view", "described as a view, which the schema that was read does not list as one"],
  ["diagram-line", "a diagram line whose column name could not be told from its type"],
  ["dataset", "a dataset in the code's data lineage, not a database table"],
];

/**
 * The ONE note the check adds to the section, saying what it found, or `""`
 * when it has nothing to say. Everything is here: what is marked, the schema's
 * spelling for a near miss, the types that differ, what stands in a diagram
 * (which carries no marker) and what was not checked, with the reason.
 */
export function renderSchemaCheckNotice(
  report: SchemaCheckReport,
  inventory: SchemaInventory,
): string {
  if (!report.checked) {
    // A database the project has and that could not be read is not "no
    // connected database": say which it was.
    const unread = inventory.reads.filter((read) => read.how === "unread");
    if (unread.length > 0) {
      const which = listedWith(unread, (read) => `"${read.connector}"`);
      return (
        `> **Schema not verified.** ` +
        (unread.length === 1
          ? `The project's database (${which}) could not be read`
          : `The project's databases (${which}) could not be read`) +
        `, and there is no database document and no SQL schema in the code graph, so the table ` +
        `and column names in this section come from the code analysis alone and were not checked.`
      );
    }
    return (
      `> **Schema not verified.** No database schema was available for this project (no ` +
      `connected database, no database document and no SQL schema in the code graph), so the ` +
      `table and column names in this section come from the code analysis alone and were not ` +
      `checked.`
    );
  }
  const lines: string[] = [];
  if (report.unresolvedTables.length > 0) {
    lines.push(`> - Named as tables, not in the schema: ${listed(report.unresolvedTables)}.`);
  }
  if (report.flaggedColumns.length > 0) {
    const spelling = new Map(report.suggestions.map((s) => [s.column, s.schema]));
    const shown = listedWith(report.flaggedColumns, (column) => {
      const schema = spelling.get(column);
      return schema ? `${tick(column)} (the schema has ${tick(schema)})` : tick(column);
    });
    lines.push(`> - Columns not in the schema: ${shown}.`);
  }
  if (report.inDiagram.length > 0) {
    lines.push(
      `> - Of these, in a diagram, which is left exactly as written and so carries no mark: ` +
        `${listed(report.inDiagram)}.`,
    );
  }
  if (report.typeMismatches.length > 0) {
    const shown = listedWith(
      report.typeMismatches,
      (m) => `${tick(m.column)} (written \`${m.written}\`, schema \`${m.schema}\`)`,
    );
    lines.push(`> - Types that differ from the schema: ${shown}.`);
  }
  for (const [why, words] of NOT_CHECKED_WHY) {
    const names = report.notChecked.filter((entry) => entry.why === why).map((e) => e.name);
    if (names.length > 0) lines.push(`> - Not checked (${words}): ${listed(names)}.`);
  }
  const noColumns = report.notChecked.filter((entry) => entry.why === "no-columns");
  if (noColumns.length > 0) {
    lines.push(
      `> - Columns not checked (no column list for this table): ` +
        `${listed(noColumns.map((entry) => entry.name))}.`,
    );
  }
  // #1096 — a cut read is said even when every name matched: the reader
  // must know the schema compared with is partial.
  const truncated = inventory.reads.filter((read) => read.truncation);
  if (truncated.length > 0) {
    lines.push(
      `> - The schema was read partially: ` +
        truncated
          .map((read) => `"${read.connector}" ${describeTablesRead(read.truncation!)}`)
          .join(", ") +
        ` were read, so tables are missing from it.`,
    );
  }
  if (lines.length === 0) return "";
  // Why a mark is not a verdict, in the words that fit what was compared with.
  const caveat =
    inventory.source === "repository-sql"
      ? "The repository's SQL is not the database (it can lack objects, and can include ones a " +
        "later migration dropped)"
      : "A database read can be incomplete (it covers one schema, and a role may not see every " +
        "column)";
  return [
    `> **Schema check.** The table and column names in this section's diagrams, entity ` +
      `headings, field tables and table lists were compared with ${inventory.label}. Nothing ` +
      `was removed or changed: a name that could not be matched is marked **not in schema** ` +
      `where it stands. ${caveat}, so a marked name is one to verify, not necessarily a mistake.`,
    ...lines,
  ].join("\n");
}

/** Index of the first line matching `test` that is not, and may not be, code. */
function findLine(
  lines: readonly string[],
  blocks: Blocks,
  from: number,
  test: (line: string) => boolean,
): number {
  for (let i = from; i < lines.length; i++) {
    if (!blocks.opaque[i] && test(lines[i])) return i;
  }
  return -1;
}

/**
 * Everything #1061 does to the generated section, in one place: mark the names
 * that could not be matched, add the schema reference rendered from the
 * inventory, and say at the top what was found. Pure, so the section's reuse
 * record stores the result. Besides the markers it only INSERTS whole lines
 * (the note and the reference, each with the blank lines that keep it a block
 * of its own); no line the model wrote is removed or changed.
 *
 * Where they go: the note directly under the section's `##` heading. The
 * reference before the first `###` sub-section; with no sub-section, at the
 * end; and when the text ends inside an unclosed fence, under the heading (and
 * the note) instead, because at the end it would be inside that fence.
 */
export function applySchemaGrounding(
  sectionMarkdown: string,
  inventory: SchemaInventory,
): { markdown: string; report: SchemaCheckReport } {
  const { markdown, report } = checkSchemaClaims(sectionMarkdown, inventory);
  const notice = renderSchemaCheckNotice(report, inventory);
  const reference = renderSchemaReference(inventory);
  if (!notice && !reference) return { markdown, report };

  const lines = markdown.split("\n");
  const blocks = scanBlocks(lines);
  const h2 = findLine(lines, blocks, 0, (line) => line.startsWith("## "));
  /** `block` as whole lines at `at`, kept apart from what follows by a blank line. */
  const insertUnderHeading = (at: number, block: string): void => {
    const next = lines[at];
    lines.splice(at, 0, "", block, ...(next !== undefined && !isBlank(next) ? [""] : []));
  };
  if (reference) {
    // Before the first sub-section, after the section's opening paragraphs.
    const h3 = findLine(lines, blocks, h2 + 1, (line) => line.startsWith("### "));
    if (h3 >= 0) lines.splice(h3, 0, reference, "");
    // No sub-section: at the end, unless the text ends inside a fence or raw
    // HTML block it never closed, where the reference would be swallowed and
    // shown as code. Closing the block would be an edit to the model's text,
    // so the reference goes BEFORE the body instead, under the heading.
    else if (!blocks.openAtEnd) lines.push("", reference);
    else if (h2 >= 0) insertUnderHeading(h2 + 1, reference);
    else lines.unshift(reference, "");
  }
  // A blank line after the note as well as before it: without one, a
  // paragraph that follows directly would be drawn into the note's quote.
  if (notice && h2 >= 0) insertUnderHeading(h2 + 1, notice);
  else if (notice) lines.unshift(notice, "");
  return { markdown: lines.join("\n"), report };
}
