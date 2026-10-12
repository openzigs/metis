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
import { isDistinctiveName, type CanonicalFact, type FactSheet } from "./canonical-facts.js";
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

export interface ConsistencyFinding {
  /** `conflict` — a sheet value stated differently. `restated` — a sheet formula, several sections. */
  kind: "conflict" | "restated";
  name: string;
  /** The sheet's value and source line. */
  canonical: { value: string; source: string };
  statements: FindingStatement[];
  /** Distinct sections among the statements. */
  sections: number;
  /** Distinct values (a conflict) or distinct forms (a restatement). */
  forms: number;
}

export interface ConsistencyReport {
  findings: ConsistencyFinding[];
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
  for (const section of sections) {
    for (const s of scanFactStatements(section.markdown))
      all.push({ ...s, section: section.label });
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
  for (const [name, statements] of stated) {
    const fact = canonicalByName.get(name)!;
    const canonical = comparableValue(normalizeForm(fact.value));
    if (!canonical) continue;
    const cls = canonical.slice(0, canonical.indexOf(":"));
    const differing = statements.filter(
      (s) => s.value.slice(0, s.value.indexOf(":")) === cls && s.value !== canonical,
    );
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
  findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { findings, statements: all.length };
}

const quote = (s: string): string => `\`${s.replace(/`/g, "'").slice(0, 80)}\``;

function describeFinding(f: ConsistencyFinding): string {
  const listed = f.statements.slice(0, MAX_LISTED_STATEMENTS);
  const more = f.statements.length - listed.length;
  const where = `${listed.map((s) => `${quote(s.value)} in ${s.section}`).join("; ")}${
    more > 0 ? `; and ${more} more` : ""
  }`;
  const canonical = ` The source has ${quote(f.canonical.value)} at ${f.canonical.source}.`;
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
  const restated = findings.length - conflicts;
  const counts = [
    conflicts > 0
      ? `${conflicts} value${conflicts === 1 ? "" : "s"} stated differently from the source`
      : "",
    restated > 0
      ? `${restated} formula${restated === 1 ? "" : "s"} written out in more than one section`
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
