/**
 * #1578 — three readings the consistency check (`fact-consistency.ts`) makes
 * of a document against what METIS read from the source, for the hallucination
 * pattern of #706 run 10's business-requirements document:
 *
 *   - a HEX LENGTH stated as the byte count: `GenerateRandomStringHex(32)`
 *     returns 64 characters, and the document said "32 hex characters" (run 7
 *     made the same mistake, #1066). The formula extractor records what such a
 *     call returns (`formula-extractor.ts`, `encodedLength`); a length the
 *     document gives in hex characters that equals some call's BYTE count, and
 *     no call's character count, is reported;
 *   - a COLUMN DEFAULT that is not the database's: a data-dictionary row whose
 *     Default cell gives a literal (a number, a boolean, a quoted or code-span
 *     word, "empty") that differs from the default the live schema declares
 *     for that column. A cell in prose ("first category", "from the feed") and
 *     a column the database gives no default are never judged: the application
 *     can set a value the database does not;
 *   - an UNCITED VALUE in the main part: a statement in a main section of a
 *     reader-layout business-requirements document that gives a concrete value
 *     (a number with a unit or a noun, a percentage, "ten seconds") and cites
 *     no source. The main part's rules ask for both, and it is what a business
 *     reader signs off.
 *
 * Like the rest of the check these only REPORT: nothing in the document is
 * removed, rewritten or marked, and the findings join the one `info` note.
 * Every pattern is bounded and anchored, so a line is read in linear time.
 *
 * Pure: no I/O and no model calls.
 */
import type { ConsistencyFinding } from "./fact-consistency.js";
import { codeSpans, numberVariants, splitCells } from "./schema-claim-check.js";
import type { SchemaInventory, SchemaInventoryTable } from "./schema-inventory.js";

/** A hex-encoding call the extractor read: `bytes` bytes, `characters` characters. */
export interface EncodedLengthFact {
  bytes: number;
  characters: number;
  /** The call as written: `GenerateRandomStringHex(32)`. */
  expression: string;
  /** `file:line`. */
  source: string;
}

/** One section as the check reads it. */
export interface CheckedSection {
  label: string;
  markdown: string;
  /** A main section of a reader-layout document, written by a model. */
  main?: boolean;
}

/** What one reading found, and how many statements it had something to compare with. */
export interface SourceCheckResult {
  findings: ConsistencyFinding[];
  /** Statements read. */
  statements: number;
  /** Of those, the ones there was a source value to compare with. */
  compared: number;
}

/** Longest quoted statement. */
const MAX_QUOTE = 120;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Lines a `$$` block may run before it is taken to be unclosed (as `fact-consistency.ts`). */
const MAX_MATH_LINES = 40;

/**
 * Each line of `markdown` outside fenced code and `$$` blocks, as the
 * consistency check's other scanners skip them. A Unicode or non-breaking
 * hyphen reads as a hyphen.
 */
export function proseLines(markdown: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let mathLines = 0;
  for (let n = 0; n < lines.length; n++) {
    const text = lines[n].replace(/\r$/, "");
    const trimmed = text.trim();
    if (fence) {
      if (trimmed.startsWith(fence) && trimmed.replace(/[`~]/g, "").trim() === "") fence = null;
      continue;
    }
    if (mathLines > 0) {
      mathLines = trimmed.endsWith("$$") || mathLines >= MAX_MATH_LINES ? 0 : mathLines + 1;
      continue;
    }
    const opened = FENCE.exec(text);
    if (opened) {
      fence = opened[1];
      continue;
    }
    if (trimmed.startsWith("$$") && !(trimmed.length > 4 && trimmed.endsWith("$$"))) {
      mathLines = 1;
      continue;
    }
    out.push({ text: text.replace(/[‐‑]/g, "-"), line: n + 1 });
  }
  return out;
}

const clipQuote = (text: string): string => {
  const flat = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE - 1)}…` : flat;
};

// ---------------------------------------------------------------------------
// Hex lengths
// ---------------------------------------------------------------------------

const CHAR_UNIT = String.raw`(?:characters?|chars?|digits?)`;
const HEX_WORD = String.raw`(?:hex|hexadecimal)`;
/**
 * A length given in hex characters: "32 hex characters", "32-hex-character",
 * "16-hex ID", "32-char random hex", "64-character lowercase hex string". The
 * number must not follow a word character, a point, a comma or a hyphen, and
 * every repetition is bounded.
 */
const HEX_LENGTH = new RegExp(
  String.raw`(?<![\w.,-])(\d{1,4})(?:-${HEX_WORD}\b(?:[- ]${CHAR_UNIT}\b)?|\s${HEX_WORD}[- ]${CHAR_UNIT}\b|[- ]${CHAR_UNIT}\s+(?:[A-Za-z][A-Za-z0-9-]{0,30}\s+){0,2}?${HEX_WORD}\b)`,
  "gi",
);

/** Every length `markdown` gives in hex characters. */
export function scanHexLengths(
  markdown: string,
): Array<{ length: number; raw: string; line: number }> {
  const out: Array<{ length: number; raw: string; line: number }> = [];
  for (const { text, line } of proseLines(markdown)) {
    if (!/hex/i.test(text)) continue;
    for (const m of text.matchAll(HEX_LENGTH)) {
      out.push({ length: Number(m[1]), raw: clipQuote(m[0]), line });
    }
  }
  return out;
}

/**
 * The hex lengths a document gives that are some call's byte count and no
 * call's character count: one finding per length.
 */
export function hexLengthFindings(
  sections: readonly CheckedSection[],
  facts: readonly EncodedLengthFact[],
): SourceCheckResult {
  const stated = sections.flatMap((section) =>
    scanHexLengths(section.markdown).map((s) => ({ ...s, section: section.label })),
  );
  if (facts.length === 0) return { findings: [], statements: stated.length, compared: 0 };
  const byLength = new Map<number, typeof stated>();
  let compared = 0;
  for (const s of stated) {
    if (!facts.some((f) => f.bytes === s.length || f.characters === s.length)) continue;
    compared += 1;
    const list = byLength.get(s.length) ?? [];
    list.push(s);
    byLength.set(s.length, list);
  }
  const findings: ConsistencyFinding[] = [];
  for (const [length, list] of byLength) {
    if (facts.some((f) => f.characters === length)) continue;
    const call = facts.find((f) => f.bytes === length)!;
    findings.push({
      kind: "byte-length",
      name: `${length} hex characters`,
      canonical: {
        value: `${call.expression} returns ${call.characters} hex characters (${call.bytes} bytes)`,
        source: call.source,
      },
      statements: list.map((s) => ({ section: s.section, line: s.line, value: s.raw })),
      sections: new Set(list.map((s) => s.section)).size,
      forms: 2,
    });
  }
  return { findings, statements: stated.length, compared };
}

// ---------------------------------------------------------------------------
// Column defaults
// ---------------------------------------------------------------------------

const DELIMITER_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING = /^ {0,3}#{1,6}\s+(.*)$/;
/** Words of a heading that say what kind of thing it names, not which. */
const HEADING_FILLER = new Set(["entity", "entities", "table", "tables", "the", "and", "model"]);
/** Cells that state no default. */
const NO_VALUE = /^(?:—|–|-|n\/a|none|null|nil|unknown|not set|\?)$/i;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const BARE_WORD = /^[A-Za-z_][A-Za-z0-9_.-]{0,60}$/;
/** A trailing PostgreSQL cast: `'unread'::entry_status`, `''::character varying`. */
const CAST = /::[A-Za-z_][A-Za-z0-9_ ]{0,60}(?:\[\])?$/;

const squash = (name: string): string => name.toLowerCase().replace(/_/g, "");

/**
 * A default as a comparable `class:value`, or null when it is not a literal:
 * an expression (`now()`, `nextval(…)`), a keyword (`CURRENT_TIMESTAMP`,
 * `NULL`), or prose.
 */
function literalOf(value: string, quotedOnlyStrings: boolean): string | null {
  let v = value.trim();
  // `('x'::text)::character varying`: casts and parentheses, outside in.
  for (let k = 0; k < 4; k++) {
    const before = v;
    v = v.replace(CAST, "").trim();
    if (v.startsWith("(") && v.endsWith(")")) v = v.slice(1, -1).trim();
    if (v === before) break;
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return `text:${v.slice(1, -1).replace(/''/g, "'")}`;
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return `text:${v.slice(1, -1)}`;
  if (NUMBER.test(v)) return `number:${Number(v)}`;
  if (/^(?:true|false)$/i.test(v)) return `boolean:${v.toLowerCase()}`;
  if (quotedOnlyStrings) return null;
  if (/^(?:null|current_timestamp|current_date|current_time|localtimestamp)$/i.test(v)) return null;
  return BARE_WORD.test(v) ? `text:${v}` : null;
}

/** A schema's declared default, comparable, or null. */
export function schemaDefaultLiteral(raw: string): string | null {
  // MySQL reports a text default unquoted; PostgreSQL and SQL Server quote it.
  return literalOf(raw, false);
}

/** What a Default cell states, comparable, or null when it states no literal. */
export function statedDefaultLiteral(cell: string): string | null {
  let v = cell.replace(/\*\*/g, "").trim();
  if (v === "" || NO_VALUE.test(v)) return null;
  if (/^empty(?: string)?$/i.test(v)) return "text:";
  const spans = codeSpans(v);
  if (spans.length === 1 && v.startsWith("`") && v.endsWith("`")) {
    v = spans[0].trim();
    if (v === "") return null;
    if (/^(?:null|nil|none)$/i.test(v)) return null;
    // A word in a code span is a literal: `unread`.
    return literalOf(v, false);
  }
  // Outside a code span only a quoted string, a number or a boolean is a literal.
  return literalOf(v, true);
}

/** The heading words that could name a table, and the whole heading run together. */
function headingKeys(heading: string): { joined: string; words: string[] } {
  const spans = codeSpans(heading);
  const source = spans.length > 0 ? spans.join(" ") : heading;
  const words = (source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter(
    (w) => !HEADING_FILLER.has(w.toLowerCase()),
  );
  return { joined: squash(words.join("")), words: words.map(squash) };
}

class TableIndex {
  private readonly bySquashed = new Map<string, SchemaInventoryTable[]>();

  constructor(tables: readonly SchemaInventoryTable[]) {
    for (const table of tables) {
      const key = squash(table.name);
      const list = this.bySquashed.get(key) ?? [];
      list.push(table);
      this.bySquashed.set(key, list);
    }
  }

  /** The tables a squashed key names, in either grammatical number. */
  private named(key: string): SchemaInventoryTable[] {
    if (!key) return [];
    const found = new Set<SchemaInventoryTable>();
    for (const variant of [key, ...numberVariants(key)]) {
      for (const table of this.bySquashed.get(variant) ?? []) found.add(table);
    }
    return [...found];
  }

  /** The one table a name or heading names, or null when it names none or several. */
  resolve(name: string): SchemaInventoryTable | null {
    const tables = this.named(squash(name));
    return tables.length === 1 ? tables[0] : null;
  }

  resolveHeading(heading: string): SchemaInventoryTable | null {
    const { joined, words } = headingKeys(heading);
    const whole = this.named(joined);
    if (whole.length === 1) return whole[0];
    const found = new Set<SchemaInventoryTable>();
    for (const word of words) for (const table of this.named(word)) found.add(table);
    return found.size === 1 ? [...found][0] : null;
  }
}

/** The column names a first cell gives: its code spans, else its text when it is one name. */
function namesInFirstCell(cell: string): string[] {
  const spans = codeSpans(cell)
    .map((s) => s.trim())
    .filter(Boolean);
  if (spans.length > 0) return spans;
  const plain = cell.replace(/\*\*/g, "").trim();
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(plain) ? [plain] : [];
}

/**
 * The data-dictionary rows whose Default cell states a literal other than the
 * one the database declares for that column: one finding per column.
 */
export function columnDefaultFindings(
  sections: readonly CheckedSection[],
  inventory: SchemaInventory | undefined,
): SourceCheckResult {
  const tables = (inventory?.tables ?? []).filter((table) =>
    table.columns.some((col) => col.defaultValue != null),
  );
  if (!inventory || tables.length === 0) return { findings: [], statements: 0, compared: 0 };
  // Every table resolves names, so a heading naming a table with no defaults
  // is not taken for one that has some.
  const index = new TableIndex(inventory.tables);
  const byColumn = new Map<
    string,
    { schema: string; statements: Array<{ section: string; line: number; value: string }> }
  >();
  let statements = 0;
  let compared = 0;
  for (const section of sections) {
    const lines = proseLines(section.markdown);
    let heading = "";
    for (let k = 0; k < lines.length; k++) {
      const { text } = lines[k];
      const h = HEADING.exec(text);
      if (h) {
        heading = h[1];
        continue;
      }
      if (!text.trimStart().startsWith("|")) continue;
      const next = lines[k + 1];
      if (!next || next.line !== lines[k].line + 1 || !DELIMITER_ROW.test(next.text)) continue;
      const header = splitCells(text).map((c) => c.text.replace(/\*\*/g, "").trim().toLowerCase());
      const at = header.findIndex((cell) => cell === "default" || cell === "default value");
      if (at <= 0) continue;
      const headingTable = index.resolveHeading(heading);
      // The rows run to the first line that is not a table row.
      let r = k + 2;
      for (; r < lines.length && lines[r].text.trimStart().startsWith("|"); r++) {
        const row = splitCells(lines[r].text);
        if (row.length <= at) continue;
        const stated = statedDefaultLiteral(row[at].text);
        if (stated === null) continue;
        for (const name of namesInFirstCell(row[0].text)) {
          const dot = name.lastIndexOf(".");
          const table = dot > 0 ? index.resolve(name.slice(0, dot)) : headingTable;
          const columnName = dot > 0 ? name.slice(dot + 1) : name;
          if (!table) continue;
          const matches = table.columns.filter((c) => squash(c.name) === squash(columnName));
          if (matches.length !== 1) continue;
          const column = matches[0];
          statements += 1;
          if (column.defaultValue == null) continue;
          const declared = schemaDefaultLiteral(column.defaultValue);
          if (declared === null) continue;
          const cls = (v: string) => v.slice(0, v.indexOf(":"));
          if (cls(declared) !== cls(stated)) continue;
          compared += 1;
          if (declared === stated) continue;
          const key = `${table.schema}.${table.name}.${column.name}`;
          const entry = byColumn.get(key) ?? { schema: column.defaultValue, statements: [] };
          entry.statements.push({
            section: section.label,
            line: lines[r].line,
            value: clipQuote(`${name}: ${row[at].text}`),
          });
          byColumn.set(key, entry);
        }
      }
      k = r - 1;
    }
  }
  const findings: ConsistencyFinding[] = [];
  for (const [key, entry] of byColumn) {
    const name = key.slice(key.indexOf(".") + 1);
    findings.push({
      kind: "column-default",
      name,
      canonical: { value: clipQuote(entry.schema), source: inventory.label },
      statements: entry.statements,
      sections: new Set(entry.statements.map((s) => s.section)).size,
      forms: 2,
    });
  }
  return { findings, statements, compared };
}

// ---------------------------------------------------------------------------
// Uncited values in the main part
// ---------------------------------------------------------------------------

/** A citation marker as the model writes it, before it becomes a footnote. */
const CITATION = /\[\s*(?:facts|rag|web):/i;
const CITATION_MARKER = /\[\s*(?:facts|rag|web):[^\]\n]{0,400}\]?/gi;
const URL = /\bhttps?:\/\/\S{1,400}/gi;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const RULE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
/**
 * A concrete value: a number followed by a unit, a noun or `%` ("1,000
 * articles", "60 days", "5-second", "25%"), not part of a name or a version
 * (`HTTP/2`, `v2.3.3`, `OAuth2`). Bounded: the number is at most 12 characters.
 */
const DIGIT_VALUE = /(?<![\w./:#-])\d[\d,]{0,9}(?:\.\d{1,3})?(?![\d.]\d)(?:\s?%|[- ]?[a-z]{2,})/;
const SPELLED_VALUE =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|thousand)[- ](?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|characters?|bytes?|attempts?|retries|times)\b/i;

/** Whether a statement, its markers removed, gives a concrete value. */
export function givesValue(text: string): boolean {
  const plain = text.replace(CITATION_MARKER, " ").replace(URL, " ").replace(LIST_ITEM, "");
  return DIGIT_VALUE.test(plain) || SPELLED_VALUE.test(plain);
}

/**
 * The statements of a section: each list item, table row and paragraph, with
 * its continuation lines. Headings, block quotes (notes METIS adds), rules and
 * table delimiter rows are not statements.
 */
export function mainStatements(markdown: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number; last: number }> = [];
  /** Whether the last statement in `out` is still open to continuation lines. */
  let open = false;
  for (const { text, line } of proseLines(markdown)) {
    const trimmed = text.trim();
    const last = out[out.length - 1];
    if (
      trimmed === "" ||
      HEADING.test(text) ||
      trimmed.startsWith(">") ||
      RULE.test(trimmed) ||
      DELIMITER_ROW.test(trimmed)
    ) {
      open = false;
      continue;
    }
    // A skipped fence or math block between two lines ends the statement too.
    if (
      open &&
      last &&
      last.last + 1 === line &&
      !trimmed.startsWith("|") &&
      !LIST_ITEM.test(text)
    ) {
      last.text += ` ${trimmed}`;
      last.last = line;
      continue;
    }
    out.push({ text: trimmed, line, last: line });
    // A table row is one statement.
    open = !trimmed.startsWith("|");
  }
  return out.map(({ text, line }) => ({ text, line }));
}

/** The main sections' statements that give a value and cite nothing: one finding per section. */
export function uncitedMainFindings(sections: readonly CheckedSection[]): SourceCheckResult {
  const findings: ConsistencyFinding[] = [];
  let statements = 0;
  for (const section of sections) {
    if (!section.main) continue;
    const uncited: Array<{ section: string; line: number; value: string }> = [];
    for (const s of mainStatements(section.markdown)) {
      if (!givesValue(s.text)) continue;
      statements += 1;
      if (CITATION.test(s.text)) continue;
      uncited.push({ section: section.label, line: s.line, value: clipQuote(s.text) });
    }
    if (uncited.length === 0) continue;
    findings.push({
      kind: "uncited",
      name: section.label,
      statements: uncited,
      sections: 1,
      forms: uncited.length,
    });
  }
  return { findings, statements, compared: 0 };
}
