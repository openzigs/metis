/**
 * #1070 — the cross-section consistency check of a generated document.
 *
 * After every section is written and fitted to the length caps, the document
 * is read once for the places it STATES a named value — `` `NAME = 5` ``,
 * `` `NAME` (default 5 min) ``, a formula in `$…$` or `$$…$$` — and two things
 * are looked for:
 *
 *   - a CONFLICT: a name on the canonical facts sheet (`canonical-facts.ts`)
 *     stated with a value that differs from the sheet's, in the same kind (a
 *     number against a number, a duration against a duration). A name the
 *     sheet does not hold is never judged: two values of `status` or
 *     `retryCount` in one document are a state change or two cases far more
 *     often than a contradiction, and the check has no source to say which;
 *   - a RESTATEMENT: a formula on the sheet written out in more than one
 *     section, with how many different forms it took. #706 run 7 wrote the
 *     Miniflux scheduler interval in four sections.
 *
 * #1070 (run 8) — the sheet alone found nothing in a BRD that contradicted
 * itself in prose: "five distinct authentication mechanisms" against "four
 * independent authentication paths", `POST /v1/entries/{id}/save` against
 * `PUT …/save`. Three prose statements are therefore also read, and two
 * SECTIONS that state one of them differently are reported. A section that
 * states two values itself is left alone: that is far more often two cases
 * than a contradiction.
 *
 *   - an ENDPOINT stated with a different write method (POST, PUT, PATCH),
 *     compared line by line, so within one section too; a line that names
 *     both methods is describing both and is left alone;
 *   - a COUNT of a qualified kind — "five authentication mechanisms" — where
 *     the nouns that name a kind of thing (mechanism, path, method, way, mode,
 *     …) are read as one, and at least one qualifying word is required;
 *   - a SIZE of a qualified thing — "64-character API token" — in one unit.
 *
 * These have no source to compare with, so the note says only that two
 * sections disagree, and quotes both.
 *
 * The check only REPORTS. It is a text heuristic over model output: it cannot
 * tell `1440` minutes from `24h`, and two spellings of one formula are two
 * forms to it. So it never edits, removes or rewrites anything — the markdown
 * is read, not returned — and what it finds is an `info` note on the document
 * (`fact-inconsistent`), which neither degrades it nor stops a section being
 * reused (#1061's lesson, `schema-claim-check.ts`).
 *
 * Linear in the document: one pass over the lines, every per-line pattern
 * bounded, fenced code skipped, CRLF tolerated.
 *
 * Pure: no I/O and no model calls.
 */
import {
  compareCodeUnits,
  isDistinctiveName,
  type CanonicalFact,
  type FactSheet,
} from "./canonical-facts.js";
import { GROUNDING_RUN_SECTION, type DocWarning } from "./grounding/degraded-warnings.js";

/** How a value was written. */
export type StatementKind = "assignment" | "default" | "expression";

/** One place the document states a value. */
export interface StatedValue {
  /** The name it is given to; null for a bare expression. */
  name: string | null;
  /** The value as written (clipped). */
  raw: string;
  /** The value with notation removed, for comparison. */
  form: string;
  /** 1-based line within the scanned text. */
  line: number;
  kind: StatementKind;
}

/** Longest span or math block read as one statement. */
const MAX_STATEMENT_CHARS = 400;
/** Lines a `$$` block may run before it is taken to be unclosed. */
const MAX_MATH_LINES = 40;
/** Text after `` `NAME` `` searched for its default. */
const DEFAULT_WINDOW = 80;
/** Findings the document note spells out; the rest are counted. */
export const MAX_LISTED_FINDINGS = 6;
/** Statements one finding spells out; the rest are counted. */
export const MAX_LISTED_STATEMENTS = 5;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const IDENTIFIER_ONLY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?::=|=)(?!=)\s*(\S[\s\S]*)$/;
const OPERATOR = /[\w)\]}]\s*[*/%+×÷·⋅-]\s*[\w({\\]/;
const DEFAULT_AFTER =
  /^[^`|]{0,24}?\bdefaults?(?:\s+(?:is|to|of|value))?\s*[:=]?\s*(`[^`|]{1,60}`|"[^"|]{1,60}"|-?\d[\d,._]*(?:\s?[A-Za-z%]{1,12})?)/i;

/** LaTeX commands whose braces only wrap text. */
const WRAPPERS = new Set([
  "text",
  "mathrm",
  "mathit",
  "mathbf",
  "mathsf",
  "operatorname",
  "textbf",
  "textit",
]);
const FRACTIONS = new Set(["frac", "dfrac", "tfrac"]);
const SYMBOLS: Readonly<Record<string, string>> = {
  times: "*",
  cdot: "*",
  div: "/",
  le: "<=",
  leq: "<=",
  ge: ">=",
  geq: ">=",
  left: "",
  right: "",
  quad: "",
  qquad: "",
};

/**
 * A value with its notation removed: LaTeX wrappers and spacing dropped,
 * `\frac{a}{b}` as `(a)/(b)`, every multiplication sign as `*`, no whitespace.
 * One pass, no recursion; unbalanced braces are simply dropped.
 */
export function normalizeForm(value: string): string {
  const out: string[] = [];
  /** What each open `{` closes with. */
  const closers: string[] = [];
  let numerator = false;
  let denominator = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\") {
      let j = i + 1;
      while (j < value.length && /[A-Za-z]/.test(value[j])) j++;
      if (j === i + 1) {
        // `\,` `\;` `\ ` `\!` — spacing; `\$` and the like — the character.
        const next = value[j] ?? "";
        if (!/[,;!\s]/.test(next)) out.push(next);
        i = j;
        continue;
      }
      const name = value.slice(i + 1, j);
      i = j - 1;
      if (FRACTIONS.has(name)) numerator = true;
      else if (WRAPPERS.has(name)) continue;
      else out.push(name in SYMBOLS ? SYMBOLS[name] : name);
      continue;
    }
    if (ch === "{") {
      if (numerator) {
        closers.push(")/");
        out.push("(");
        numerator = false;
      } else if (denominator) {
        closers.push(")");
        out.push("(");
        denominator = false;
      } else closers.push("");
      continue;
    }
    if (ch === "}") {
      const closer = closers.pop() ?? "";
      out.push(closer);
      denominator = closer === ")/";
      continue;
    }
    if (/\s/.test(ch)) continue;
    denominator = false;
    if (ch === "×" || ch === "·" || ch === "⋅") out.push("*");
    else if (ch === "÷") out.push("/");
    else if (ch !== "`" && ch !== "$") out.push(ch);
  }
  return out.join("").replace(/[.,;:]+$/, "");
}

const clip = (s: string): string =>
  s.length > MAX_STATEMENT_CHARS ? s.slice(0, MAX_STATEMENT_CHARS) : s;

/** The statement a code span or a math span makes, if it makes one. */
function statementOf(content: string, line: number, math: boolean): StatedValue | null {
  const text = clip(content.trim());
  if (text.length < 3) return null;
  const plain = math ? normalizeForm(text) : text;
  const assignment = ASSIGNMENT.exec(plain);
  if (assignment) {
    return {
      name: assignment[1],
      raw: math ? text : assignment[2].trim(),
      form: normalizeForm(assignment[2]),
      line,
      kind: "assignment",
    };
  }
  if (OPERATOR.test(plain)) {
    return { name: null, raw: text, form: normalizeForm(text), line, kind: "expression" };
  }
  return null;
}

/**
 * The value after "default": a number keeps the word that follows it only when
 * that word is a unit (`60 min`), not the next word of the sentence (`3 failures`).
 */
function defaultValue(matched: string): string {
  const value = matched.trim();
  const parts = /^(-?\d[\d,._]*)\s?([A-Za-z%]+)$/.exec(value);
  if (!parts) return value;
  const unit = parts[2].toLowerCase();
  return unit in SECONDS || SIZE_UNITS.has(unit) ? value : parts[1];
}

/** Read one line (not inside a fence or a `$$` block) for statements. */
function scanLine(text: string, line: number, out: StatedValue[]): void {
  let i = 0;
  let codeOpen = true;
  let mathOpen = true;
  // The next backtick and dollar sign at or after `i`, searched for again only
  // once passed: a line of one kind of delimiter must not re-scan for the
  // other at every step (quadratic on 200 KB of dollar signs).
  let tick = -2;
  let dollar = -2;
  while (i < text.length) {
    if (!codeOpen) tick = -1;
    else if (tick !== -1 && tick < i) tick = text.indexOf("`", i);
    if (!mathOpen) dollar = -1;
    else if (dollar !== -1 && dollar < i) dollar = text.indexOf("$", i);
    if (tick < 0 && dollar < 0) return;
    if (tick >= 0 && (dollar < 0 || tick < dollar)) {
      let run = tick;
      while (text[run] === "`") run++;
      const fence = text.slice(tick, run);
      const close = text.indexOf(fence, run);
      if (close < 0) {
        // Unclosed on this line: no later span can close either.
        codeOpen = false;
        i = run;
        continue;
      }
      const content = text.slice(run, close);
      const after = close + fence.length;
      if (IDENTIFIER_ONLY.test(content)) {
        const match = DEFAULT_AFTER.exec(text.slice(after, after + DEFAULT_WINDOW));
        if (match) {
          const raw = defaultValue(match[1]);
          out.push({ name: content, raw, form: normalizeForm(raw), line, kind: "default" });
        }
      } else {
        const statement = statementOf(content, line, false);
        if (statement) out.push(statement);
      }
      i = after;
      continue;
    }
    const double = text[dollar + 1] === "$";
    const open = dollar + (double ? 2 : 1);
    const close = text.indexOf(double ? "$$" : "$", open);
    if (close < 0) {
      mathOpen = false;
      i = open;
      continue;
    }
    const statement = statementOf(text.slice(open, close), line, true);
    if (statement) out.push(statement);
    i = close + (double ? 2 : 1);
  }
}

/**
 * Every place `markdown` states a value. Fenced code is skipped; a `$$` block
 * is read as one statement; the text itself is never changed.
 */
export function scanFactStatements(markdown: string): StatedValue[] {
  const out: StatedValue[] = [];
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let math: { from: number; lines: string[] } | null = null;
  for (let n = 0; n < lines.length; n++) {
    // A CRLF line keeps its `\r`: every pattern below reads up to it, never across.
    const text = lines[n];
    const trimmed = text.trim();
    if (fence) {
      if (trimmed.startsWith(fence) && trimmed.replace(/[`~]/g, "").trim() === "") fence = null;
      continue;
    }
    if (math) {
      const closes = trimmed.endsWith("$$");
      math.lines.push(closes ? trimmed.slice(0, -2) : trimmed);
      if (closes || math.lines.length >= MAX_MATH_LINES) {
        const statement = statementOf(math.lines.join(" "), math.from, true);
        if (statement) out.push(statement);
        math = null;
      }
      continue;
    }
    const opened = FENCE.exec(text);
    if (opened) {
      fence = opened[1];
      continue;
    }
    if (trimmed.startsWith("$$") && !(trimmed.length > 4 && trimmed.endsWith("$$"))) {
      math = { from: n + 1, lines: [trimmed.slice(2)] };
      continue;
    }
    scanLine(text, n + 1, out);
  }
  if (math) {
    const statement = statementOf(math.lines.join(" "), math.from, true);
    if (statement) out.push(statement);
  }
  return out;
}

const SECONDS: Readonly<Record<string, number>> = {
  ms: 0.001,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
};
const SIZE_UNITS = new Set(["%", "b", "kb", "mb", "gb", "kib", "mib", "gib", "bytes"]);
const QUANTITY = /^(-?\d+(?:\.\d+)?)([A-Za-z%]*)$/;
const QUOTED = /^(?:"[^"]*"|'[^']*')$/;

/**
 * The comparable value of a statement, as `class:value` — two statements
 * conflict only within one class — or null when the value is an expression,
 * which is not compared by name.
 */
export function comparableValue(form: string): string | null {
  const digits = form.replace(/(\d)[,_](?=\d)/g, "$1");
  const quantity = QUANTITY.exec(digits);
  if (quantity) {
    const n = Number(quantity[1]);
    const unit = quantity[2].toLowerCase();
    if (!unit) return `number:${n}`;
    if (unit in SECONDS) return `duration:${n * SECONDS[unit]}`;
    return `${unit}:${n}`;
  }
  if (QUOTED.test(form)) return `literal:${form.slice(1, -1)}`;
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(form) ? `literal:${form}` : null;
}

export interface FindingStatement {
  section: string;
  line: number;
  value: string;
}

/**
 * `conflict` — a sheet value stated differently. `restated` — a sheet formula,
 * several sections. `endpoint`, `count`, `size` — a prose statement two
 * sections make differently (no source to compare with).
 */
export type ConsistencyFindingKind = "conflict" | "restated" | "endpoint" | "count" | "size";

export interface ConsistencyFinding {
  kind: ConsistencyFindingKind;
  name: string;
  /** For a prose finding, what it is about as written ("API token (characters)"). */
  label?: string;
  /** The sheet's value and source line; absent for a prose finding. */
  canonical?: { value: string; source: string };
  statements: FindingStatement[];
  /** Distinct sections among the statements. */
  sections: number;
  /** Distinct values (a conflict) or distinct forms (a restatement). */
  forms: number;
}

export interface ConsistencyReport {
  findings: ConsistencyFinding[];
  /** Statements that had something to be compared with: the source's value or another place. */
  compared: number;
  /** Statements read, for the log. */
  statements: number;
}

const NUMBER_TOKEN = /^\d+(?:\.\d+)?/;

/** The distinctive names and the numbers an expression is made of. */
function operandsOf(form: string): { names: Set<string>; numbers: Set<string> } {
  const names = new Set<string>();
  const numbers = new Set<string>();
  for (const token of form.split(/[^A-Za-z0-9_.]+/)) {
    if (!token) continue;
    const number = NUMBER_TOKEN.exec(token);
    if (number) {
      numbers.add(String(Number(number[0])));
      continue;
    }
    for (const part of token.split(".")) if (isDistinctiveName(part)) names.add(part);
  }
  return { names, numbers };
}

const shared = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
};

/**
 * Whether a written expression is the sheet's formula: two of its distinctive
 * names, or one of them and two of its numbers.
 */
function restates(
  fact: { names: Set<string>; numbers: Set<string> },
  statement: { names: Set<string>; numbers: Set<string> },
): boolean {
  const names = shared(fact.names, statement.names);
  return names >= 2 || (names >= 1 && shared(fact.numbers, statement.numbers) >= 2);
}

// ---------------------------------------------------------------------------
// Prose statements (#1070, run 8)
// ---------------------------------------------------------------------------

/** One prose statement: what it is about, its value, and where. */
export interface ProseStatement {
  kind: "endpoint" | "count" | "size";
  /** What it is about, normalised: the path, the kind counted, the thing sized. */
  key: string;
  /** What is compared: the method, the count, the size with its unit. */
  value: string;
  /** As written (clipped), for the note. */
  raw: string;
  /** What it is about as a reader would name it: "API token (characters)". */
  label: string;
  /** 1-based line within the scanned text. */
  line: number;
}

/** Longest prose statement quoted. */
const MAX_PROSE_QUOTE = 120;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);
/**
 * How a write method is compared. PUT and PATCH on one path are routinely
 * both offered (replace and update), so they are one answer; POST against
 * either is the run-8 contradiction (`POST …/save` vs `PUT …/save`).
 */
const updateOrCreate = (method: string): string =>
  method === "PUT" || method === "PATCH" ? "PUT or PATCH" : method;
/** `POST /v1/entries/{id}/save`, in a code span or not. One bounded run of path characters. */
const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[A-Za-z0-9_{}:.~\-/]{0,200})/g;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Nouns that name a KIND of thing, each mapped to the class it is compared
 * in. Only the nouns for a way of DOING something are read as one:
 * "five authentication mechanisms" and "four authentication paths" count the
 * same thing (run 8). An option, a type, a mode or a category is its own
 * noun: "two payment methods" and "three payment options", or "file paths"
 * and "file types", are different things (PR #1316 review).
 */
const KIND_NOUNS: Readonly<Record<string, string>> = {
  mechanism: "ways",
  method: "ways",
  path: "ways",
  way: "ways",
  flow: "ways",
  scheme: "ways",
  mode: "modes",
  option: "options",
  strategy: "strategies",
  variant: "variants",
  type: "types",
  category: "categories",
  state: "states",
  status: "states",
  role: "roles",
  level: "levels",
  format: "formats",
  scheduler: "schedulers",
  tier: "tiers",
  backend: "backends",
  protocol: "protocols",
  provider: "providers",
};

/**
 * A count, up to three words, then a kind noun. The number must not follow a
 * digit, a letter, a point or a comma: the `5` of "Version 1.5 release types"
 * is not a count. Every quantifier is bounded and
 * the words are separated by required whitespace, so one match attempt costs a
 * constant and a line is read in linear time.
 */
const COUNTED = new RegExp(
  `(?<![\\w.,-])(${Object.keys(NUMBER_WORDS).join("|")}|[2-9]|[1-9]\\d)\\s+((?:[A-Za-z][A-Za-z0-9/-]{0,30}\\s+){0,3}?)(mechanisms|methods|paths|ways|modes|options|flows|schemes|strategies|variants|types|categories|states|statuses|roles|levels|formats|schedulers|tiers|backends|protocols|providers)\\b`,
  "gi",
);

const PROSE_UNITS: Readonly<Record<string, string>> = {
  byte: "bytes",
  bytes: "bytes",
  character: "characters",
  characters: "characters",
  char: "characters",
  chars: "characters",
  bit: "bits",
  bits: "bits",
  digit: "digits",
  digits: "digits",
};

/** "64-character API token", "32 byte session key". Bounded like {@link COUNTED}. */
const SIZED =
  /(?<![\w.,-])(\d{1,4})[- ](bytes?|characters?|chars?|bits?|digits?)\s+((?:[A-Za-z][A-Za-z0-9-]{0,30}\s+){0,2}?)(tokens?|keys?|secrets?|verifiers?|hashes|hash|digests?|identifiers?|passwords?|salts?|nonces?|codes?|strings?)\b/gi;

/**
 * Words that qualify nothing: "five DISTINCT authentication mechanisms", a
 * "32-character HEX string". A phrase of these alone does not say what is
 * counted or sized, so it is not compared.
 */
const FILLER = new Set([
  "distinct",
  "independent",
  "different",
  "separate",
  "supported",
  "main",
  "core",
  "key",
  "primary",
  "available",
  "unique",
  "possible",
  "built-in",
  "builtin",
  "other",
  "more",
  "additional",
  "major",
  "basic",
  "standard",
  "random",
  "secure",
  "opaque",
  "generated",
  "new",
  "lowercase",
  "uppercase",
  "hex",
  "hexadecimal",
  "base64",
  "alphanumeric",
  "ascii",
  "encoded",
]);

/** A word that makes the phrase something other than "N <qualifier> <kind>". */
const BREAKS = new Set([
  "of",
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "in",
  "on",
  "with",
  "per",
  "each",
  "by",
  "from",
  "at",
  "are",
  "is",
  "be",
  "its",
  "their",
  "these",
  "those",
]);

/** `entries` → `entry`, `feeds` → `feed`: enough for a comparison key. */
export function singularWord(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:sh|ch|x|z|ss|us)es$/.test(word)) return word.slice(0, -2);
  if (/(?:ss|us|is)$/.test(word)) return word;
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * The qualifying words of a phrase, normalised, or null when the phrase does
 * not qualify a kind ("two of the …", "three ways to …") or holds only filler.
 */
function qualifiersOf(words: string): string[] | null {
  const list = words
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (list.some((w) => BREAKS.has(w))) return null;
  const kept = list.filter((w) => !FILLER.has(w)).map(singularWord);
  return kept.length > 0 ? kept : null;
}

/** The qualifying words as written, filler left out: "distinct authentication" → "authentication". */
function asWritten(words: string): string {
  return words
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER.has(w.toLowerCase()))
    .join(" ");
}

/** An endpoint path compared: placeholders as `{}`, no trailing slash or punctuation. */
export function endpointKey(path: string): string {
  return path
    .replace(/[.,;:]+$/, "")
    .replace(/\{[^}/]*\}|:[A-Za-z_][A-Za-z0-9_]*/g, "{}")
    .replace(/\/+$/, "");
}

/** Read one line (not in a fence or a `$$` block) for prose statements. */
function scanProseLine(written: string, line: number, out: ProseStatement[]): void {
  // A non-breaking or Unicode hyphen ("64‑character") reads as a hyphen. One
  // character for one, so every index below is an index into the line.
  const text = written.replace(/[\u2010\u2011]/g, "-");
  const quote = (from: number, length: number): string =>
    text.slice(from, from + Math.min(length, MAX_PROSE_QUOTE)).replace(/`/g, "");
  for (const m of text.matchAll(ENDPOINT)) {
    const key = endpointKey(m[2]);
    if (key.length < 2) continue;
    const method = m[1].toUpperCase();
    const path = m[2].replace(/[.,;:]+$/, "");
    out.push({
      kind: "endpoint",
      key,
      value: updateOrCreate(method),
      raw: `${method} ${path}`,
      label: key,
      line,
    });
  }
  for (const m of text.matchAll(COUNTED)) {
    const words = qualifiersOf(m[2]);
    if (!words) continue;
    const noun = singularWord(m[3].toLowerCase());
    out.push({
      kind: "count",
      key: `${words.join(" ")} ${KIND_NOUNS[noun] ?? `${noun}s`}`,
      value: String(NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1])),
      raw: quote(m.index, m[0].length),
      label: `${asWritten(m[2])} ${m[3]}`,
      line,
    });
  }
  for (const m of text.matchAll(SIZED)) {
    const words = qualifiersOf(m[3]);
    if (!words) continue;
    // The unit is part of what is compared: 32 bytes and 64 characters of hex
    // are one value, which the check cannot know.
    out.push({
      kind: "size",
      key: `${words.join(" ")} ${singularWord(m[4].toLowerCase())} in ${PROSE_UNITS[m[2].toLowerCase()]}`,
      value: String(Number(m[1])),
      raw: quote(m.index, m[0].length),
      label: `${asWritten(m[3])} ${singularWord(m[4])} (${PROSE_UNITS[m[2].toLowerCase()]})`,
      line,
    });
  }
}

/**
 * Every endpoint, count of a kind and size `markdown` states outside code
 * blocks (tables and code spans included; fenced code and `$$` blocks skipped).
 */
export function scanProseStatements(markdown: string): ProseStatement[] {
  const out: ProseStatement[] = [];
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let mathLines = 0;
  for (let n = 0; n < lines.length; n++) {
    const text = lines[n];
    const trimmed = text.trim();
    if (fence) {
      if (trimmed.startsWith(fence) && trimmed.replace(/[`~]/g, "").trim() === "") fence = null;
      continue;
    }
    if (mathLines > 0) {
      // As `scanFactStatements` reads it: closed by `$$`, or taken as unclosed.
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
    scanProseLine(text, n + 1, out);
  }
  return out;
}

/**
 * The prose statements two or more SECTIONS make differently. A statement some
 * section makes with more than one value is left alone: that section is
 * describing several cases, and the others may each describe one of them.
 */
function proseFindings(statements: ReadonlyArray<ProseStatement & { section: string }>): {
  findings: ConsistencyFinding[];
  /** Statements that had another place to be compared with. */
  compared: number;
} {
  const groups = new Map<string, Array<ProseStatement & { section: string }>>();
  for (const s of statements) {
    // A read and a write on one path are two operations, not two answers.
    if (s.kind === "endpoint" && !WRITE_METHODS.has(s.raw.slice(0, s.raw.indexOf(" ")))) continue;
    const id = `${s.kind}\u0000${s.key}`;
    const list = groups.get(id) ?? [];
    list.push(s);
    groups.set(id, list);
  }
  const findings: ConsistencyFinding[] = [];
  let compared = 0;
  for (const list of groups.values()) {
    // An endpoint is compared line by line, within a section too: one path
    // with two write methods is rare enough to be worth a look (run 8 gave
    // `…/save` as POST in a table and PUT twenty lines later), and a line
    // that names both is describing both. Counts and sizes are compared
    // section by section.
    const scope = (s: ProseStatement & { section: string }): string =>
      s.kind === "endpoint" ? `${s.section}\u0000${s.line}` : s.section;
    const byScope = new Map<string, Set<string>>();
    for (const s of list) {
      const values = byScope.get(scope(s)) ?? new Set<string>();
      values.add(s.value);
      byScope.set(scope(s), values);
    }
    if (byScope.size < 2) continue;
    compared += list.length;
    if ([...byScope.values()].some((values) => values.size > 1)) continue;
    const forms = new Set(list.map((s) => s.value)).size;
    if (forms < 2) continue;
    // One quote per place and value: where each says what it says.
    const quoted = new Map<string, ProseStatement & { section: string }>();
    for (const s of list) {
      const id = `${s.section}\u0000${s.value}`;
      if (!quoted.has(id)) quoted.set(id, s);
    }
    findings.push({
      kind: list[0].kind,
      name: list[0].key,
      label: list[0].label,
      statements: [...quoted.values()].map((s) => ({
        section: s.section,
        line: s.line,
        value: s.raw,
      })),
      sections: new Set(list.map((s) => s.section)).size,
      forms,
    });
  }
  return { findings, compared };
}

/**
 * Check the sections of one document against each other and against the sheet.
 * `markdown` is each section as it goes into the document, after the length
 * fit and before its citations become footnotes (citation markers do not
 * matter): a statement the fit removed is not there to be quoted (#1119).
 */
export function checkFactConsistency(
  sections: ReadonlyArray<{ label: string; markdown: string }>,
  sheet?: Pick<FactSheet, "facts">,
): ConsistencyReport {
  const all: Array<StatedValue & { section: string }> = [];
  const prose: Array<ProseStatement & { section: string }> = [];
  for (const section of sections) {
    for (const s of scanFactStatements(section.markdown))
      all.push({ ...s, section: section.label });
    for (const s of scanProseStatements(section.markdown))
      prose.push({ ...s, section: section.label });
  }
  const findings: ConsistencyFinding[] = [];
  const facts = sheet?.facts ?? [];
  const canonicalByName = new Map<string, CanonicalFact>();
  for (const fact of facts) if (fact.kind !== "formula") canonicalByName.set(fact.name, fact);

  // Conflicts: a name ON THE SHEET stated with a value that differs from the
  // sheet's, in the same class (a number against a number). A name the sheet
  // does not hold is not judged at all: a workflow that sets `status` to
  // "unread" and later to "read" states two values and contradicts nothing.
  const stated = new Map<string, Array<StatedValue & { section: string; value: string }>>();
  for (const s of all) {
    if (s.kind === "expression" || !s.name || !canonicalByName.has(s.name)) continue;
    const value = comparableValue(s.form);
    if (!value) continue;
    const list = stated.get(s.name) ?? [];
    list.push({ ...s, value });
    stated.set(s.name, list);
  }
  let compared = 0;
  for (const [name, statements] of stated) {
    const fact = canonicalByName.get(name)!;
    const canonical = comparableValue(normalizeForm(fact.value));
    if (!canonical) continue;
    const cls = canonical.slice(0, canonical.indexOf(":"));
    const differing = statements.filter(
      (s) => s.value.slice(0, s.value.indexOf(":")) === cls && s.value !== canonical,
    );
    compared += statements.filter((s) => s.value.slice(0, s.value.indexOf(":")) === cls).length;
    if (differing.length === 0) continue;
    findings.push({
      kind: "conflict",
      name,
      canonical: { value: fact.value, source: `${fact.file}:${fact.line}` },
      statements: differing.map((s) => ({ section: s.section, line: s.line, value: s.raw })),
      sections: new Set(differing.map((s) => s.section)).size,
      // Distinct values: the ones stated, and the source's.
      forms: new Set(differing.map((s) => s.value)).size + 1,
    });
  }

  // Restatements: a sheet formula written out in more than one section.
  const expressions = all
    .filter((s) => OPERATOR.test(s.form) || s.kind === "expression")
    .map((s) => ({ statement: s, operands: operandsOf(s.form) }));
  for (const fact of facts) {
    if (fact.kind !== "formula") continue;
    const operands = operandsOf(normalizeForm(fact.value));
    if (operands.names.size === 0) continue;
    const matches = expressions.filter((e) => restates(operands, e.operands));
    const inSections = new Set(matches.map((m) => m.statement.section));
    compared += matches.length;
    if (inSections.size < 2) continue;
    findings.push({
      kind: "restated",
      name: fact.name,
      canonical: { value: fact.value, source: `${fact.file}:${fact.line}` },
      statements: matches.map((m) => ({
        section: m.statement.section,
        line: m.statement.line,
        value: m.statement.raw,
      })),
      sections: inSections.size,
      forms: new Set(matches.map((m) => m.statement.form)).size,
    });
  }
  // #1070 (run 8) — prose statements two sections make differently.
  const fromProse = proseFindings(prose);
  findings.push(...fromProse.findings);
  compared += fromProse.compared;
  // By code unit, like the sheet: the note lists its findings in the same
  // order on every machine, which `localeCompare` does not promise.
  findings.sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.name, b.name));
  return { findings, statements: all.length + prose.length, compared };
}

const quote = (s: string): string => `\`${s.replace(/`/g, "'").slice(0, 80)}\``;

function describeFinding(f: ConsistencyFinding): string {
  const listed = f.statements.slice(0, MAX_LISTED_STATEMENTS);
  const more = f.statements.length - listed.length;
  const where = `${listed.map((s) => `${quote(s.value)} in ${s.section}`).join("; ")}${
    more > 0 ? `; and ${more} more` : ""
  }`;
  if (f.kind === "endpoint" || f.kind === "count" || f.kind === "size") {
    const what =
      f.kind === "endpoint"
        ? `the endpoint ${quote(f.name)} is given ${f.forms} different methods`
        : f.kind === "count"
          ? `the number of ${quote(f.label ?? f.name)} is given ${f.forms} different ways`
          : `the size of ${quote(f.label ?? f.name)} is given ${f.forms} different ways`;
    return `${what} in ${f.sections === 1 ? "one section" : `${f.sections} sections`} (${where}).`;
  }
  const canonical = f.canonical
    ? ` The source has ${quote(f.canonical.value)} at ${f.canonical.source}.`
    : "";
  return f.kind === "conflict"
    ? `${quote(f.name)} is stated with a value that is not the source's (${where}).${canonical}`
    : `the formula ${quote(f.name)} is written out ${f.statements.length} times in ${f.sections} sections, in ${f.forms} form${f.forms === 1 ? "" : "s"} (${where}).${canonical}`;
}

/**
 * The document's `fact-inconsistent` note, or null when the check found
 * nothing. Informational: see the module comment.
 */
export function factInconsistentWarning(report: ConsistencyReport): DocWarning | null {
  const { findings } = report;
  if (findings.length === 0) return null;
  const conflicts = findings.filter((f) => f.kind === "conflict").length;
  const restated = findings.filter((f) => f.kind === "restated").length;
  const disagree = findings.length - conflicts - restated;
  const counts = [
    conflicts > 0
      ? `${conflicts} value${conflicts === 1 ? "" : "s"} stated differently from the source`
      : "",
    restated > 0
      ? `${restated} formula${restated === 1 ? "" : "s"} written out in more than one section`
      : "",
    disagree > 0
      ? `${disagree} statement${disagree === 1 ? "" : "s"} made in more than one way`
      : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const listed = findings.slice(0, MAX_LISTED_FINDINGS);
  const more = findings.length - listed.length;
  return {
    kind: "fact-inconsistent",
    section: GROUNDING_RUN_SECTION,
    message:
      `Consistency check: ${counts}. ${listed
        .map((f) => `${describeFinding(f).replace(/^t/, "T")}`)
        .join(" ")}${more > 0 ? ` And ${more} more.` : ""} ` +
      `Nothing was removed or changed: the check compares how values are written, so two ` +
      `spellings of one value can be reported. Compare the statements with the source.`,
    severity: "info",
  };
}
