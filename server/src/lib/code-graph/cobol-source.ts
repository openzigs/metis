/**
 * COBOL source normalisation and tokenising (#160) — shared by the COBOL
 * code-graph parser ({@link ./cobol-parser.ts}) and rule miner
 * ({@link ./cbl-rule-miner.ts}).
 *
 * Why a hand-written scanner and not a grammar: the only COBOL tree-sitter
 * grammar on npm (`tree-sitter-cobol@0.0.1`, MIT, one release, 2025-05) ships a
 * native `nan` binding rather than the WASM build this repository loads through
 * `web-tree-sitter`, and unpacks to ~46 MB. The code graph needs programs,
 * paragraphs/sections, PERFORM/CALL/COPY and level-01/77/88 data items — all
 * line- and keyword-shaped — so, as for SAS, a targeted line-oriented scanner
 * is the smaller and more predictable choice.
 *
 * Source formats:
 *
 *  - **Fixed** (the default, and what IBM Enterprise COBOL reads): columns 1–6
 *    are the sequence area (ignored), column 7 the indicator area (`*` or `/`
 *    comment, `-` continuation, `D` debugging line, `$` directive), columns
 *    8–72 the program text (area A = 8–11, area B = 12–72), and columns 73–80
 *    the identification area (ignored). Tabs are expanded to 8-column stops.
 *  - **Free** (COBOL 2002 / GnuCOBOL `-free`): the whole line is program text.
 *
 * The format is chosen per file: `>>SOURCE [FORMAT] [IS] FREE|FIXED` and
 * `$SET SOURCEFORMAT"FREE"|"FIXED"` switch it from the next line on; with no
 * directive, a file is fixed unless one of its lines has something other than a
 * valid indicator character in column 7 (`PROCEDURE DIVISION.` at column 1 is
 * free format). `*>` starts an inline comment in either format.
 *
 * Complexity: every function here is a single left-to-right pass over its
 * input with no regular expression applied to unbounded text, so normalising
 * and tokenising an N-character source is O(N).
 */

/** One physical line after format handling. Line numbers are preserved. */
export interface CobolLine {
  /** Program text of the line (sequence/indicator/identification areas removed). */
  code: string;
  /** Comment text when the line is (or ends in) a comment; `null` otherwise. */
  comment: string | null;
  /** Whether the line was read as fixed format (area A = code columns 0–3). */
  fixed: boolean;
}

/** Valid column-7 indicator characters in fixed format. */
const FIXED_INDICATORS = new Set([" ", "*", "/", "-", "D", "d", "$"]);

/** Tabs to 8-column stops, as COBOL compilers read fixed-format source. */
export function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) {
    if (ch === "\t") out += " ".repeat(8 - (out.length % 8));
    else out += ch;
  }
  return out;
}

/** True when a line cannot be fixed format (column 7 holds program text). */
function breaksFixedFormat(line: string): boolean {
  if (line.length <= 6) return false;
  const trimmed = line.trimStart();
  if (trimmed.startsWith(">>") || trimmed.startsWith("*>")) return false;
  return !FIXED_INDICATORS.has(line[6]);
}

/** Case-insensitive `>>SOURCE ... FREE|FIXED` / `$SET SOURCEFORMAT"..."` switch, or null. */
function formatDirective(text: string): "free" | "fixed" | null {
  const upper = text.trim().toUpperCase();
  if (upper.startsWith(">>SOURCE")) {
    if (upper.includes("FREE")) return "free";
    if (upper.includes("FIXED")) return "fixed";
    return null;
  }
  if (upper.startsWith("$SET") && upper.includes("SOURCEFORMAT")) {
    if (upper.includes("FREE")) return "free";
    if (upper.includes("FIXED")) return "fixed";
  }
  return null;
}

/** Split `text` at the first `*>` outside a string literal. */
function splitInlineComment(text: string): { code: string; comment: string | null } {
  let quote = "";
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "*" && text[k + 1] === ">") {
      return { code: text.slice(0, k), comment: text.slice(k + 2).trim() };
    }
  }
  return { code: text, comment: null };
}

/**
 * The quote character of the string literal still open at the end of `text`
 * (`""` when none), given the one open at its start.
 */
function openQuoteAfter(text: string, open = ""): string {
  let quote = open;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') quote = ch;
  }
  return quote;
}

/**
 * Normalise COBOL source into one {@link CobolLine} per physical line (so line
 * numbers are unchanged). Comment, directive and continuation lines get empty
 * `code`; a continuation line's text is appended to the last code line (for a
 * continued literal, without its opening quote), as the compiler reads it.
 */
export function normalizeCobolSource(source: string): CobolLine[] {
  const raw = source.split(/\r?\n/).map(expandTabs);
  let fixed = true;
  // No leading directive: fixed unless some line cannot be fixed format.
  for (const line of raw) {
    const dir = formatDirective(line.length > 7 ? line.slice(7) : "") ?? formatDirective(line);
    if (dir) {
      fixed = dir === "fixed";
      break;
    }
    if (line.trim().length > 0 && breaksFixedFormat(line)) {
      fixed = false;
      break;
    }
  }

  const out: CobolLine[] = [];
  let lastCode = -1;
  // Literal still open at the end of the last code line — tracked, not
  // re-scanned, so a run of continuation lines stays linear.
  let lastQuote = "";
  for (const line of raw) {
    // A directive switches the format from the next line on.
    const dirText = fixed ? (line.length > 7 ? line.slice(7) : "") : line;
    const indicator = fixed ? (line[6] ?? " ") : " ";
    const dir =
      formatDirective(dirText) ??
      (fixed && indicator === "$" ? formatDirective(line.slice(6)) : null);
    if (dir || dirText.trimStart().startsWith(">>") || (fixed && indicator === "$")) {
      out.push({ code: "", comment: null, fixed });
      if (dir) fixed = dir === "fixed";
      continue;
    }
    if (fixed) {
      const area = line.length > 7 ? line.slice(7, 72) : "";
      if (indicator === "*" || indicator === "/" || indicator === "D" || indicator === "d") {
        out.push({ code: "", comment: area.trim() || null, fixed });
        continue;
      }
      if (indicator === "-") {
        // Continuation: the text resumes at its first non-blank character; a
        // continued literal repeats its quote, which the compiler drops.
        let rest = area.padEnd(65).trimStart();
        if (lastCode >= 0) {
          const prev = out[lastCode];
          if (lastQuote && rest.startsWith(lastQuote)) {
            rest = rest.slice(1);
          } else {
            prev.code = prev.code.trimEnd();
          }
          lastQuote = openQuoteAfter(rest, lastQuote);
          prev.code += lastQuote ? rest : rest.trimEnd();
        }
        out.push({ code: "", comment: null, fixed });
        continue;
      }
      const { code, comment } = splitInlineComment(area);
      // A literal left open runs to column 72 (a short line is space-padded),
      // where a `-` continuation line picks it up.
      const quote = openQuoteAfter(code);
      out.push({ code: quote ? code.padEnd(65) : code.trimEnd(), comment, fixed });
      if (code.trim().length > 0) {
        lastCode = out.length - 1;
        lastQuote = quote;
      }
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("*>")) {
      out.push({ code: "", comment: trimmed.slice(2).trim() || null, fixed });
      continue;
    }
    const { code, comment } = splitInlineComment(line);
    out.push({ code: code.trimEnd(), comment, fixed });
    if (code.trim().length > 0) {
      lastCode = out.length - 1;
      lastQuote = "";
    }
  }
  return out;
}

export type CobolTokenKind = "word" | "number" | "literal" | "op" | "period";

export interface CobolToken {
  kind: CobolTokenKind;
  /** Text as written. */
  text: string;
  /** Upper-cased text (COBOL words are case-insensitive); literals keep their case. */
  upper: string;
  /** 0-based index into the normalised lines. */
  line: number;
  /** 0-based column in the line's `code` (area A is 0–3 in fixed format). */
  col: number;
  /** First token on its line. */
  first: boolean;
}

const isWordChar = (ch: string): boolean =>
  (ch >= "A" && ch <= "Z") ||
  (ch >= "a" && ch <= "z") ||
  (ch >= "0" && ch <= "9") ||
  ch === "-" ||
  ch === "_";

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

/** Two-character operators, then one-character ones. */
const OPS2 = new Set(["**", ">=", "<=", "<>"]);
const OPS1 = new Set(["=", "<", ">", "(", ")", "+", "-", "*", "/", ",", ";", ":", "&"]);

/** Tokenise normalised COBOL lines. Commas and semicolons are separators and are kept as `op`. */
export function tokenizeCobol(lines: readonly CobolLine[]): CobolToken[] {
  const tokens: CobolToken[] = [];
  for (let li = 0; li < lines.length; li++) {
    const code = lines[li].code;
    let first = true;
    const push = (kind: CobolTokenKind, text: string, col: number): void => {
      tokens.push({
        kind,
        text,
        upper: kind === "literal" ? text : text.toUpperCase(),
        line: li,
        col,
        first,
      });
      first = false;
    };
    let k = 0;
    while (k < code.length) {
      const ch = code[k];
      if (ch === " ") {
        k++;
        continue;
      }
      const start = k;
      if (ch === "'" || ch === '"') {
        k++;
        while (k < code.length) {
          if (code[k] === ch) {
            if (code[k + 1] === ch) {
              k += 2; // doubled quote inside the literal
              continue;
            }
            k++;
            break;
          }
          k++;
        }
        push("literal", code.slice(start, k), start);
        continue;
      }
      if (ch === "." && !isDigit(code[k + 1])) {
        push("period", ".", start);
        k++;
        continue;
      }
      if (isWordChar(ch) || (ch === "." && isDigit(code[k + 1]))) {
        let allDigits = true;
        while (k < code.length) {
          const c = code[k];
          if (isWordChar(c)) {
            if (!isDigit(c)) allDigits = false;
            k++;
          } else if (c === "." && allDigits && isDigit(code[k + 1])) {
            k++; // decimal point inside a numeric literal
          } else break;
        }
        // A word that is all digits (and dots) is a number; `1000-INIT` is a word.
        push(allDigits ? "number" : "word", code.slice(start, k), start);
        continue;
      }
      const two = code.slice(k, k + 2);
      if (OPS2.has(two)) {
        push("op", two, start);
        k += 2;
        continue;
      }
      if (OPS1.has(ch)) push("op", ch, start);
      // Any other character (`@`, `#`, stray punctuation) is skipped.
      k++;
    }
  }
  return tokens;
}

/** Normalise and tokenise in one step. */
export function lexCobol(source: string): { lines: CobolLine[]; tokens: CobolToken[] } {
  const lines = normalizeCobolSource(source);
  return { lines, tokens: tokenizeCobol(lines) };
}

/**
 * Render a token run as readable text: tokens joined by a space, with no space
 * before `,` `)` `.` or after `(`.
 */
export function renderTokens(tokens: readonly CobolToken[]): string {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const tight =
      i === 0 || t.text === "," || t.text === ")" || t.kind === "period" || prev?.text === "(";
    out += tight ? t.text : ` ${t.text}`;
  }
  return out;
}

/**
 * Words that begin a COBOL statement (or end a scope) — where a condition,
 * a COMPUTE expression or a WHEN arm stops. Every construct the miner starts
 * reading at (`IF`, `EVALUATE`, `WHEN`, `COMPUTE`) is in this set, so a read
 * never runs past the next construct: reading every construct in a file
 * touches each token a bounded number of times.
 */
export const STATEMENT_VERBS: ReadonlySet<string> = new Set([
  "ACCEPT",
  "ADD",
  "ALTER",
  "CALL",
  "CANCEL",
  "CLOSE",
  "COMPUTE",
  "CONTINUE",
  "DELETE",
  "DISPLAY",
  "DIVIDE",
  "ELSE",
  "EVALUATE",
  "EXEC",
  "EXIT",
  "GENERATE",
  "GO",
  "GOBACK",
  "IF",
  "INITIALIZE",
  "INITIATE",
  "INSPECT",
  "INVOKE",
  "MERGE",
  "MOVE",
  "MULTIPLY",
  "NEXT",
  "OPEN",
  "PERFORM",
  "READ",
  "RELEASE",
  "RETURN",
  "REWRITE",
  "SEARCH",
  "SET",
  "SORT",
  "START",
  "STOP",
  "STRING",
  "SUBTRACT",
  "TERMINATE",
  "UNSTRING",
  "WHEN",
  "WRITE",
]);

/** A statement verb, or a scope terminator (`END-IF`, `END-EVALUATE`, ...). */
export function isStatementBoundary(t: CobolToken): boolean {
  return (
    t.kind === "period" ||
    (t.kind === "word" && (STATEMENT_VERBS.has(t.upper) || t.upper.startsWith("END-")))
  );
}
