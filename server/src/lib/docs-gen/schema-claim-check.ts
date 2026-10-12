/**
 * The deterministic check on the architecture document's Data Architecture
 * section (#1061): every table and column the section CLAIMS is resolved
 * against the schema inventory (`schema-inventory.ts`), with no model call.
 *
 * ## What counts as a claim
 *
 * Only the four structures in which a name can mean nothing but a table or a
 * column:
 *
 *   1. a Mermaid `erDiagram` — its entities, and the attribute lines inside an
 *      entity block;
 *   2. a heading labelled `Entity:` / `Entities:` / `Table:` / `Tables:` that
 *      has a field table under it (a table whose first header cell is Field,
 *      Column or Attribute) — the names in the heading;
 *   3. the rows of such a field table — a backticked name in the first cell is
 *      a column of the heading's table, and a backticked `table.column`
 *      anywhere in the row is a column of that table when the table resolves;
 *   4. a table whose first header cell is `Table` — a backticked name in a
 *      row's first cell is a table.
 *
 * A field table that is NOT under such a heading is not read at all: under
 * `#### \`Feed\` struct` or `### Sessions` it may describe a struct, a class or
 * a message, whose fields are not columns.
 *
 * Free prose is NOT read. A sentence can name a queue, a cache, a Go struct, a
 * view, an index or `entries.length`, and nothing short of understanding the
 * sentence tells those from a table. Prose is what the grounding in the prompt
 * is for; this check covers what can be decided.
 *
 * ## Remove, mark or correct
 *
 *   - **A name at table level is only ever marked.** The thing may be real and
 *     simply not a table, and removing an entity block would delete prose.
 *   - **A column of a table that does resolve** is unambiguous and sits in a
 *     self-contained row or diagram line. It is REMOVED when the inventory is
 *     `current` (every database was introspected in this run), and marked
 *     otherwise: a stored graph can be out of date and repository SQL is
 *     incomplete, so against those a missing name is "not verified", not
 *     "wrong".
 *   - **A type** that disagrees with the schema is annotated with the schema's.
 *   - **A near miss** is corrected only on one rule: the names are equal once
 *     case and underscores are ignored, and exactly one column of the table
 *     matches (`google_reader_username` for `googlereader_username`). Nothing
 *     is corrected on similarity. Against a non-current inventory the schema's
 *     spelling is suggested, not written in.
 *
 * With an empty inventory nothing is checked and nothing is changed.
 *
 * Every scan here walks model output, so it is linear: lines are split once,
 * cells and code spans are found by index in a single pass, names resolve
 * through maps, and there is no backtracking pattern.
 */
import {
  isTypedInventory,
  plainSchemaText,
  renderSchemaReference,
  type SchemaInventory,
  type SchemaInventoryColumn,
  type SchemaInventoryTable,
} from "./schema-inventory.js";

export interface SchemaCheckReport {
  /** False when there was no inventory to check against. */
  checked: boolean;
  /** Names claimed as tables that the inventory does not hold. Marked. */
  unresolvedTables: string[];
  /** `table.column` rows and diagram lines removed (current inventory only). */
  removedColumns: string[];
  /** `table.column` names marked as not in the schema. */
  flaggedColumns: string[];
  /** Spellings rewritten to the schema's (current inventory only). */
  corrected: Array<{ from: string; to: string }>;
  /** Types that disagree with the schema. */
  typeMismatches: Array<{ column: string; written: string; schema: string }>;
}

/** How many names the report found a problem with (corrections excluded). */
export function schemaCheckFindings(report: SchemaCheckReport): number {
  return (
    report.unresolvedTables.length +
    report.removedColumns.length +
    report.flaggedColumns.length +
    report.typeMismatches.length
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const IDENTIFIER_MAX = 200;

function isIdentifier(text: string): boolean {
  if (text.length === 0 || text.length > IDENTIFIER_MAX) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    const digit = c >= 48 && c <= 57;
    if (!(letter || (i > 0 && (digit || c === 36)))) return false;
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

/** Lookups built once, so resolving a name does not walk the schema. */
class InventoryIndex {
  private readonly byName = new Map<string, SchemaInventoryTable[]>();
  private readonly columns = new Map<SchemaInventoryTable, ColumnLookup>();

  constructor(tables: readonly SchemaInventoryTable[]) {
    for (const table of tables) {
      const key = table.name.toLowerCase();
      const bucket = this.byName.get(key);
      if (bucket) bucket.push(table);
      else this.byName.set(key, [table]);
      const lookup: ColumnLookup = { exact: new Map(), squashed: new Map() };
      for (const column of table.columns) {
        lookup.exact.set(column.name.toLowerCase(), column);
        const squashed = squash(column.name);
        const same = lookup.squashed.get(squashed);
        if (same) same.push(column);
        else lookup.squashed.set(squashed, [column]);
      }
      this.columns.set(table, lookup);
    }
  }

  /**
   * The tables a name refers to, or `null`. Case is ignored and a schema prefix
   * is dropped. With `singular`, a singular also resolves to its plural (`USER`
   * for `users`) when that plural is a table: a diagram or heading that names
   * the entity rather than the table is not an invention. The qualifier of a
   * `table.column` is resolved without it, so `feed.entries` is not read as a
   * column of `feeds`.
   */
  resolveTable(raw: string, singular = true): SchemaInventoryTable[] | null {
    const name = raw.trim().toLowerCase();
    if (!name) return null;
    const bare = name.slice(name.lastIndexOf(".") + 1);
    const keys = [name, bare];
    if (singular) {
      keys.push(`${bare}s`, `${bare}es`);
      if (bare.endsWith("y")) keys.push(`${bare.slice(0, -1)}ies`);
    }
    for (const key of keys) {
      const found = this.byName.get(key);
      if (found) return found;
    }
    return null;
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

// ---------------------------------------------------------------------------
// Markdown scanning (index-based; linear)
// ---------------------------------------------------------------------------

/** The contents of each `` `code span` `` in a piece of text, in order. */
export function codeSpans(text: string): string[] {
  const spans: string[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("`", from);
    const close = open < 0 ? -1 : text.indexOf("`", open + 1);
    if (close < 0) break;
    spans.push(text.slice(open + 1, close));
    from = close + 1;
  }
  return spans;
}

const NOT_IN_SCHEMA = "*(not in schema)*";
const MARKED = " *(not in schema";

type SpanEdit = { replace: string } | { mark: string } | { remove: true } | null;

/**
 * Rewrite the code spans of `text` in ONE pass. `edit` sees each span's
 * contents in order and may replace it, put a marker after it (skipped when the
 * span already carries one), or remove it.
 */
function rewriteSpans(text: string, edit: (span: string) => SpanEdit): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("`", from);
    const close = open < 0 ? -1 : text.indexOf("`", open + 1);
    if (close < 0) break;
    const action = edit(text.slice(open + 1, close));
    out.push(text.slice(from, open));
    if (action && "replace" in action) {
      out.push(`\`${action.replace}\``);
    } else if (!action || "mark" in action) {
      out.push(text.slice(open, close + 1));
      if (action && !text.startsWith(MARKED, close + 1)) out.push(` ${action.mark}`);
    }
    from = close + 1;
  }
  out.push(text.slice(from));
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

function isDelimiterRow(line: string): boolean {
  const text = line.trim();
  if (!text.startsWith("|") || !text.includes("-")) return false;
  for (const ch of text) {
    if (ch !== "|" && ch !== "-" && ch !== ":" && ch !== " ") return false;
  }
  return true;
}

function headerName(cell: Cell): string {
  return cell.text.split("*").join("").split("`").join("").trim().toLowerCase();
}

const FIELD_HEADERS = new Set(["field", "column", "attribute", "field name", "column name"]);
const TYPE_HEADERS = new Set(["type", "data type", "datatype"]);

/** `{ typeIndex }` when the header is a field table's, else `null`. */
function fieldTableShape(header: Cell[]): { typeIndex: number } | null {
  if (header.length < 2) return null;
  const names = header.map(headerName);
  const typeIndex = names.findIndex((name) => TYPE_HEADERS.has(name));
  if (FIELD_HEADERS.has(names[0]) || (names[0] === "name" && typeIndex > 0)) return { typeIndex };
  return null;
}

function fenceOf(line: string): string | null {
  const text = line.trimStart();
  if (text.startsWith("```")) return "```";
  if (text.startsWith("~~~")) return "~~~";
  return null;
}

const HEADING_LABELS = ["entities:", "entity:", "tables:", "table:"];

export interface HeadingClaim {
  /** The names the heading states are tables; empty for any other heading. */
  names: string[];
}

/**
 * The table names a heading claims, or `null` for a line that is no heading.
 * Only a heading labelled `Entity:` / `Entities:` / `Table:` / `Tables:` claims
 * any. Every other heading (`#### \`Feed\` struct`, `### Sessions`) carries
 * none, which also ends the context of the labelled heading before it.
 */
export function parseHeading(line: string): HeadingClaim | null {
  let level = 0;
  while (level < line.length && level < 7 && line[level] === "#") level++;
  if (level < 2 || level > 6 || line[level] !== " ") return null;
  let text = line.slice(level + 1);
  const paren = text.indexOf("(");
  if (paren >= 0) text = text.slice(0, paren);
  text = text.trim();
  const lower = text.toLowerCase();
  const label = HEADING_LABELS.find((candidate) => lower.startsWith(candidate));
  if (!label) return { names: [] };
  text = text.slice(label.length).trim();
  const spans = codeSpans(text).filter(isQualifiedIdentifier);
  if (spans.length > 0) return { names: spans };
  const words = text
    .split(",")
    .join(" ")
    .split(" ")
    .filter((word) => word && word !== "and" && word !== "&");
  if (words.length > 0 && words.length <= 4 && words.every(isQualifiedIdentifier)) {
    return { names: words };
  }
  return { names: [] };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function tick(name: string): string {
  return `\`${plainSchemaText(name)}\``;
}

const MAX_LISTED = 12;

function listed(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED).map(tick).join(", ");
  return names.length > MAX_LISTED ? `${shown} and ${names.length - MAX_LISTED} more` : shown;
}

interface Findings {
  unresolvedTables: Set<string>;
  removedColumns: Set<string>;
  flaggedColumns: Set<string>;
  corrected: Map<string, string>;
  typeMismatches: Map<string, { written: string; schema: string }>;
}

interface CheckState {
  index: InventoryIndex;
  typed: boolean;
  current: boolean;
  label: string;
  found: Findings;
}

function notATableNote(names: readonly string[], where: string, label: string): string {
  const verb = names.length === 1 ? "is not a table" : "are not tables";
  return (
    `> **Not in the schema:** ${where}${listed(names)} ${verb} in ${label}. If what is ` +
    `described is something else (a queue, a cache, a struct, a view or an external store), ` +
    `read it as that; otherwise treat it as unverified.`
  );
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

function checkErDiagram(
  body: readonly string[],
  state: CheckState,
): { lines: string[]; notes: string[] } {
  const out: string[] = [];
  const unresolved = new Set<string>();
  const unverifiedAttributes = new Set<string>();
  const entity = (raw: string): SchemaInventoryTable[] | null => {
    let name = raw.split('"').join("");
    const alias = name.indexOf("[");
    if (alias >= 0) name = name.slice(0, alias);
    name = name.trim();
    if (!name || name.length > IDENTIFIER_MAX) return null;
    const tables = state.index.resolveTable(name.split("-").join("_"));
    if (!tables) {
      unresolved.add(name);
      state.found.unresolvedTables.add(name);
    }
    return tables;
  };
  // `undefined` outside an entity block; `null` inside an unresolved entity's.
  let block: SchemaInventoryTable[] | null | undefined;
  for (const line of body) {
    const text = line.trim();
    if (block !== undefined) {
      if (text.startsWith("}")) {
        block = undefined;
        out.push(line);
        continue;
      }
      const tokens = text.split(" ").filter(Boolean);
      if (!block || tokens.length < 2 || !isIdentifier(tokens[1])) {
        out.push(line);
        continue;
      }
      const [type, name] = tokens;
      const match = state.index.resolveColumn(block, name);
      if (match.kind === "none") {
        const qualified = `${block[0].name}.${name}`;
        if (state.current) {
          state.found.removedColumns.add(qualified);
          continue;
        }
        state.found.flaggedColumns.add(qualified);
        unverifiedAttributes.add(qualified);
        out.push(line);
        continue;
      }
      // Rewritten by position: the type comes first, the name after it.
      const typeAt = line.indexOf(type);
      const nameAt = line.indexOf(name, typeAt + type.length);
      let newType = type;
      let newName = name;
      if (match.kind === "near") {
        const from = `${match.table.name}.${name}`;
        if (state.current && isIdentifier(match.column.name)) {
          state.found.corrected.set(from, `${match.table.name}.${match.column.name}`);
          newName = match.column.name;
        } else {
          state.found.flaggedColumns.add(from);
          unverifiedAttributes.add(from);
        }
      }
      if (state.typed && typesDisagree(type, match.column.dataType)) {
        const column = `${match.table.name}.${match.column.name}`;
        noteTypeMismatch(state, column, type, match.column.dataType);
        const schemaType = match.column.dataType.toLowerCase().split(" ").join("_");
        if (state.current && isIdentifier(schemaType)) newType = schemaType;
      }
      out.push(
        line.slice(0, typeAt) +
          newType +
          line.slice(typeAt + type.length, nameAt) +
          newName +
          line.slice(nameAt + name.length),
      );
      continue;
    }
    if (text.endsWith("{")) {
      block = entity(text.slice(0, -1));
      out.push(line);
      continue;
    }
    const tokens = text.split(" ").filter(Boolean);
    const relation = tokens.length >= 3 ? tokens[1] : "";
    if (relation.length <= 12 && (relation.includes("--") || relation.includes(".."))) {
      entity(tokens[0]);
      entity(tokens[2].endsWith(":") ? tokens[2].slice(0, -1) : tokens[2]);
    }
    out.push(line);
  }
  const notes: string[] = [];
  if (unresolved.size > 0) {
    notes.push(notATableNote([...unresolved], "in the diagram above, ", state.label));
  }
  if (unverifiedAttributes.size > 0) {
    notes.push(
      `> **Not in the schema:** the diagram above shows ` +
        `${listed([...unverifiedAttributes])}, which ${state.label} does not hold.`,
    );
  }
  return { lines: out, notes };
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
  return header.length > 0 && ROSTER_HEADERS.has(headerName(header[0]));
}

/** One row of a table roster: a name that is no table is marked, never removed. */
function checkRosterRow(line: string, state: CheckState): string {
  const cells = splitCells(line);
  if (cells.length === 0) return line;
  const first = rewriteSpans(cells[0].text, (name): SpanEdit => {
    if (!isQualifiedIdentifier(name) || state.index.resolveTable(name)) return null;
    state.found.unresolvedTables.add(name);
    return { mark: NOT_IN_SCHEMA };
  });
  if (first === cells[0].text) return line;
  return line.slice(0, cells[0].start) + first + line.slice(cells[0].end);
}

/** One field-table row, rewritten; `null` when the row is removed. */
function checkRow(
  line: string,
  typeIndex: number,
  context: RowContext,
  state: CheckState,
): string | null {
  const cells = splitCells(line);
  if (cells.length === 0) return line;
  const edits = new Map<number, string>();
  const typeCell = typeIndex > 0 && typeIndex < cells.length ? cells[typeIndex] : undefined;
  const typeParts = typeCell ? typeCell.text.split("/") : [];
  const nameCount = codeSpans(cells[0].text).filter(isQualifiedIdentifier).length;
  const alignedTypes = nameCount > 1 && typeParts.length === nameCount;
  const typeNotes: string[] = [];
  const droppedTypeParts = new Set<number>();
  const kept: string[] = [];
  let claims = 0;
  let removed = 0;
  let position = -1;

  let first = rewriteSpans(cells[0].text, (name): SpanEdit => {
    if (!isQualifiedIdentifier(name)) {
      kept.push(name);
      return null;
    }
    position += 1;
    const dot = name.lastIndexOf(".");
    const columnName = dot >= 0 ? name.slice(dot + 1) : name;
    let tables: SchemaInventoryTable[] | null;
    if (dot >= 0) tables = state.index.resolveTable(name.slice(0, dot), false);
    else tables = context.complete && context.tables.length > 0 ? context.tables : null;
    // A qualifier that is no table (`model.Themes`) is not a column claim.
    if (!tables) {
      kept.push(name);
      return null;
    }
    claims += 1;
    const match = state.index.resolveColumn(tables, columnName);
    if (match.kind === "none") {
      const qualified = `${tables[0].name}.${columnName}`;
      if (state.current) {
        state.found.removedColumns.add(qualified);
        droppedTypeParts.add(position);
        removed += 1;
        return { remove: true };
      }
      state.found.flaggedColumns.add(qualified);
      kept.push(name);
      return { mark: NOT_IN_SCHEMA };
    }
    const tableName = match.table.name;
    let action: SpanEdit = null;
    let keptName = name;
    if (match.kind === "near") {
      const qualified = `${tableName}.${columnName}`;
      const schemaName = plainSchemaText(match.column.name);
      if (state.current) {
        state.found.corrected.set(qualified, `${tableName}.${schemaName}`);
        keptName = dot >= 0 ? `${name.slice(0, dot)}.${schemaName}` : schemaName;
        action = { replace: keptName };
      } else {
        state.found.flaggedColumns.add(qualified);
        action = { mark: `*(not in schema; the schema has \`${schemaName}\`)*` };
      }
    }
    kept.push(keptName);
    if (state.typed && typeCell && tables.length === 1) {
      const written = alignedTypes
        ? typeParts[position]
        : typeParts.length === 1
          ? typeParts[0]
          : "";
      if (written && typesDisagree(written, match.column.dataType)) {
        const column = `${tableName}.${match.column.name}`;
        noteTypeMismatch(state, column, written, match.column.dataType);
        const schemaType = plainSchemaText(match.column.dataType);
        typeNotes.push(
          nameCount > 1 ? `${tick(match.column.name)} is \`${schemaType}\`` : `\`${schemaType}\``,
        );
      }
    }
    return action;
  });

  if (claims > 0 && removed === claims) return null;
  // The names that are left, without the separators the removed ones leave.
  if (removed > 0) first = ` ${kept.map((name) => `\`${name}\``).join(" / ")} `;
  if (first !== cells[0].text) edits.set(0, first);
  if (typeCell) {
    let typeText = typeCell.text;
    if (alignedTypes && droppedTypeParts.size > 0) {
      const left = typeParts.filter((_, i) => !droppedTypeParts.has(i)).map((part) => part.trim());
      typeText = ` ${left.join("/")} `;
    }
    if (typeNotes.length > 0 && !typeText.includes("(schema:")) {
      typeText = `${typeText.trimEnd()} *(schema: ${typeNotes.join(", ")})* `;
    }
    if (typeText !== typeCell.text) edits.set(typeIndex, typeText);
  }

  // A `table.column` elsewhere in the row (an FK target): marked, never removed.
  for (let i = 1; i < cells.length; i++) {
    const before = edits.get(i) ?? cells[i].text;
    if (!before.includes("`")) continue;
    const text = rewriteSpans(before, (span): SpanEdit => {
      const dot = span.lastIndexOf(".");
      if (dot <= 0 || !isQualifiedIdentifier(span)) return null;
      const tables = state.index.resolveTable(span.slice(0, dot), false);
      if (!tables) return null;
      const columnName = span.slice(dot + 1);
      const match = state.index.resolveColumn(tables, columnName);
      if (match.kind === "exact") return null;
      const qualified = `${tables[0].name}.${columnName}`;
      if (match.kind === "near" && state.current) {
        const schemaName = plainSchemaText(match.column.name);
        state.found.corrected.set(qualified, `${tables[0].name}.${schemaName}`);
        return { replace: `${span.slice(0, dot)}.${schemaName}` };
      }
      state.found.flaggedColumns.add(qualified);
      return { mark: NOT_IN_SCHEMA };
    });
    if (text !== cells[i].text) edits.set(i, text);
  }

  if (edits.size === 0) return line;
  const rebuilt: string[] = [];
  let from = 0;
  cells.forEach((cell, i) => {
    rebuilt.push(line.slice(from, cell.start), edits.get(i) ?? cell.text);
    from = cell.end;
  });
  rebuilt.push(line.slice(from));
  return rebuilt.join("");
}

/**
 * Check one section's markdown against the inventory. Returns the markdown
 * with unverifiable names marked (or, against a current inventory, unresolved
 * columns removed and near misses corrected) and a report of what was found.
 */
export function checkSchemaClaims(
  markdown: string,
  inventory: SchemaInventory,
): { markdown: string; report: SchemaCheckReport } {
  const checked = inventory.tables.length > 0;
  // Never judge a section against nothing: that would mark all of it.
  if (!checked) {
    return {
      markdown,
      report: {
        checked,
        unresolvedTables: [],
        removedColumns: [],
        flaggedColumns: [],
        corrected: [],
        typeMismatches: [],
      },
    };
  }
  const found: Findings = {
    unresolvedTables: new Set(),
    removedColumns: new Set(),
    flaggedColumns: new Set(),
    corrected: new Map(),
    typeMismatches: new Map(),
  };
  const typed = isTypedInventory(inventory);
  const state: CheckState = {
    index: new InventoryIndex(inventory.tables),
    typed,
    current: inventory.current && typed,
    label: inventory.label,
    found,
  };

  const lines = markdown.split("\n");
  const out: string[] = [];
  /** Notes to place after `out[index]`, kept aside so nothing is spliced. */
  const after = new Map<number, string[]>();
  let heading: { claim: HeadingClaim; at: number; judged: boolean; context: RowContext } | null =
    null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = fenceOf(line);
    if (fence) {
      let close = i + 1;
      while (close < lines.length && !lines[close].trimStart().startsWith(fence)) close++;
      const body = lines.slice(i + 1, close);
      const firstLine = body.find((entry) => entry.trim() !== "")?.trim() ?? "";
      const isEr = line.toLowerCase().includes("mermaid") && firstLine.startsWith("erDiagram");
      const diagram = isEr ? checkErDiagram(body, state) : { lines: body, notes: [] };
      out.push(line);
      for (const entry of diagram.lines) out.push(entry);
      if (close < lines.length) out.push(lines[close]);
      if (diagram.notes.length > 0) after.set(out.length - 1, diagram.notes);
      i = close + 1;
      continue;
    }
    const claim = parseHeading(line);
    if (claim) {
      out.push(line);
      heading = {
        claim,
        at: out.length - 1,
        judged: false,
        context: { tables: [], complete: false },
      };
      i += 1;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      let end = i + 2;
      while (end < lines.length && isTableRow(lines[end])) end++;
      const shape = fieldTableShape(splitCells(line));
      // A field table is read only under an `Entity:` / `Table:` heading.
      const entityTable = shape != null && heading != null && heading.claim.names.length > 0;
      if (!shape || !entityTable) {
        const roster = isTableRoster(splitCells(line));
        out.push(line, lines[i + 1]);
        for (let row = i + 2; row < end; row++) {
          out.push(roster ? checkRosterRow(lines[row], state) : lines[row]);
        }
        i = end;
        continue;
      }
      if (heading && !heading.judged) {
        heading.judged = true;
        const unresolved: string[] = [];
        for (const name of heading.claim.names) {
          const tables = state.index.resolveTable(name);
          if (tables) heading.context.tables.push(...tables);
          else unresolved.push(name);
        }
        heading.context.complete = unresolved.length === 0;
        if (unresolved.length > 0) {
          for (const name of unresolved) found.unresolvedTables.add(name);
          after.set(heading.at, [notATableNote(unresolved, "", state.label)]);
        }
      }
      const context = heading?.context ?? { tables: [], complete: false };
      out.push(line, lines[i + 1]);
      for (let row = i + 2; row < end; row++) {
        const rewritten = checkRow(lines[row], shape.typeIndex, context, state);
        if (rewritten != null) out.push(rewritten);
      }
      i = end;
      continue;
    }
    out.push(line);
    i += 1;
  }

  const report: SchemaCheckReport = {
    checked,
    unresolvedTables: [...found.unresolvedTables],
    removedColumns: [...found.removedColumns],
    flaggedColumns: [...found.flaggedColumns],
    corrected: [...found.corrected].map(([from, to]) => ({ from, to })),
    typeMismatches: [...found.typeMismatches].map(([column, types]) => ({ column, ...types })),
  };
  if (after.size === 0) return { markdown: out.join("\n"), report };
  const merged: string[] = [];
  out.forEach((entry, at) => {
    merged.push(entry);
    for (const note of after.get(at) ?? []) {
      // Already there when the text has been through the check before.
      const present = out[at + 2] === note || out[at + 4] === note;
      if (!present) merged.push("", note);
    }
  });
  return { markdown: merged.join("\n"), report };
}

// ---------------------------------------------------------------------------
// The section as it reaches the document
// ---------------------------------------------------------------------------

/** The note at the top of the section saying what the check found, or `""`. */
export function renderSchemaCheckNotice(
  report: SchemaCheckReport,
  inventory: SchemaInventory,
): string {
  if (!report.checked) {
    return (
      `> **Schema not verified.** No database schema was available for this project (no ` +
      `connected database, no database document and no SQL schema in the code graph), so the ` +
      `table and column names in this section come from the code analysis alone and were not ` +
      `checked.`
    );
  }
  const lines: string[] = [];
  if (report.unresolvedTables.length > 0) {
    lines.push(`> - Named as tables but not in the schema: ${listed(report.unresolvedTables)}.`);
  }
  if (report.removedColumns.length > 0) {
    lines.push(
      `> - Removed, because the table has no such column: ${listed(report.removedColumns)}.`,
    );
  }
  if (report.flaggedColumns.length > 0) {
    lines.push(`> - Columns not found in the schema: ${listed(report.flaggedColumns)}.`);
  }
  if (report.typeMismatches.length > 0) {
    const shown = report.typeMismatches
      .slice(0, MAX_LISTED)
      .map((m) => `${tick(m.column)} (written \`${m.written}\`, schema \`${m.schema}\`)`);
    lines.push(`> - Types that differ from the schema: ${shown.join(", ")}.`);
  }
  if (report.corrected.length > 0) {
    const shown = report.corrected
      .slice(0, MAX_LISTED)
      .map((c) => `${tick(c.from)} to ${tick(c.to)}`);
    lines.push(`> - Spelling corrected to the schema's: ${shown.join(", ")}.`);
  }
  if (lines.length === 0) return "";
  return [
    `> **Schema check.** The tables and columns in this section were checked against ` +
      `${inventory.label}.`,
    ...lines,
  ].join("\n");
}

/** Index of the first line matching `test` that is outside a code fence. */
function findLine(lines: readonly string[], from: number, test: (line: string) => boolean): number {
  let fence: string | null = null;
  for (let i = from; i < lines.length; i++) {
    const marker = fenceOf(lines[i]);
    if (fence) {
      if (marker === fence) fence = null;
      continue;
    }
    if (marker) fence = marker;
    else if (test(lines[i])) return i;
  }
  return -1;
}

/**
 * Everything #1061 does to the generated section, in one place: check its
 * claims, add the schema reference rendered from the inventory, and say at the
 * top what was found. Pure, so the section's reuse record stores the result.
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
  const h2 = findLine(lines, 0, (line) => line.startsWith("## "));
  if (reference) {
    // Before the first sub-section, after the section's opening paragraphs.
    const h3 = findLine(lines, h2 + 1, (line) => line.startsWith("### "));
    if (h3 >= 0) lines.splice(h3, 0, reference, "");
    else lines.push("", reference);
  }
  if (notice && h2 >= 0) lines.splice(h2 + 1, 0, "", notice);
  else if (notice) lines.unshift(notice, "");
  return { markdown: lines.join("\n"), report };
}
