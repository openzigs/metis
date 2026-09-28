/**
 * Issue #161 — helpers shared by the Scala, Rust and C/C++ rule miners.
 *
 * Every helper here is a single left-to-right scan (or a regex with no two
 * quantifiers able to match the same text), so each is linear in its input;
 * the miners call them on one physical line, or on one logical line that
 * {@link joinLogicalLine} bounded to 12 lines / 4,000 characters, and scan at
 * most {@link BODY_LOOKAHEAD} lines ahead of any header. No regex here is built
 * from input (Semgrep's non-literal-regexp rule has nothing to flag).
 */

/** Longest expression kept on a rule; longer text is ellipsed. */
export const MAX_EXPR = 200;
/** Default cap on rules per call (docs-gen Phase 1 passes `Infinity`). */
export const MAX_RULES = 400;
/** Most lines read ahead of a header for its body or its arms. */
export const BODY_LOOKAHEAD = 100;

/** One rule, as every miner in this family produces it. */
export interface BraceMinedRule<K extends string> {
  kind: K;
  /** Raw statement as found in source (trimmed, single-line-collapsed). */
  expression: string;
  /** Human-readable summary of what the rule enforces. */
  summary: string;
  /** Source file path (relative). */
  filePath: string;
  /** 1-based line number where the rule lives. */
  line: number;
  /** Containing function/type qualified name when known. */
  context: string | null;
}

/** Collapse whitespace and ellipse past `n` characters. */
export function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** Drop one layer of surrounding double quotes. */
export function stripQuotes(s: string): string {
  return s.replace(/^"|"$/g, "").trim();
}

/**
 * The index just past the string or character literal that opens at `k`, or
 * `k + 1` when the quote at `k` does not open one (a Rust lifetime `'a`).
 * An unterminated `"` string runs to the end of the text.
 */
export function skipLiteral(text: string, k: number): number {
  const q = text[k];
  if (q === "'") {
    // A char literal is `'x'` or `'\x'`; anything else is a lifetime / label.
    if (text[k + 1] === "\\" && text[k + 3] === "'") return k + 4;
    if (text[k + 2] === "'") return k + 3;
    return k + 1;
  }
  for (let j = k + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === q) return j + 1;
  }
  return text.length;
}

/**
 * `text` with the contents of every string and char literal replaced by spaces,
 * quotes kept and length unchanged, so an offset into the result is an offset
 * into `text`. Lets a keyword regex (`match `) ignore a literal's words.
 */
export function blankLiterals(text: string): string {
  let out = "";
  let k = 0;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '"' || ch === "'") {
      const end = skipLiteral(text, k);
      out += end - k >= 2 ? ch + " ".repeat(end - k - 2) + text[end - 1] : text.slice(k, end);
      k = end;
      continue;
    }
    out += ch;
    k++;
  }
  return out;
}

export interface SplitHead {
  /** Text inside the parentheses. */
  cond: string;
  /** Text after the closing parenthesis. */
  rest: string;
}

/**
 * Split a parenthesised head (`if (`, `require(`, `switch (`) whose `(` ends at
 * `afterOpen` into the text inside the parentheses and the text after the
 * matching `)`. Strings and char literals are skipped. Null when the
 * parentheses do not close in `text` — the caller then retries on the joined
 * logical line.
 */
export function splitParen(text: string, afterOpen: number): SplitHead | null {
  let depth = 1;
  let k = afterOpen;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '"' || ch === "'") {
      k = skipLiteral(text, k);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return { cond: text.slice(afterOpen, k).trim(), rest: text.slice(k + 1).trim() };
      }
    }
    k++;
  }
  return null;
}

/**
 * The index of the first `{` at bracket depth 0 at or after `from` (strings
 * skipped), or -1. Reads a Rust `if <cond> {` / `match <x> {` header, whose
 * condition carries no parentheses of its own.
 */
export function firstTopLevelBrace(text: string, from: number): number {
  let depth = 0;
  let k = from;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '"' || ch === "'") {
      k = skipLiteral(text, k);
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "{") {
      if (depth === 0) return k;
      depth++;
    } else if (ch === "}") depth = Math.max(0, depth - 1);
    k++;
  }
  return -1;
}

/** `text` split on `sep` where it occurs outside brackets and literals; parts trimmed. */
export function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  let k = 0;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '"' || ch === "'") {
      k = skipLiteral(text, k);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === sep) {
      parts.push(text.slice(from, k).trim());
      from = k + 1;
    }
    k++;
  }
  parts.push(text.slice(from).trim());
  return parts.filter((p) => p.length > 0);
}

/**
 * Net `{` minus `}` on a line, outside strings, char literals and a trailing
 * `//` comment — so a Rust `println!("{}", x)` or a C `'{'` does not move it.
 */
export function braceDelta(line: string): number {
  let delta = 0;
  let k = 0;
  while (k < line.length) {
    const ch = line[k];
    if (ch === '"' || ch === "'") {
      k = skipLiteral(line, k);
      continue;
    }
    if (ch === "/" && line[k + 1] === "/") break;
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
    k++;
  }
  return delta;
}

/** The identifier that ends `s` (after trimming), or "" — a backwards scan. */
export function trailingIdentifier(s: string): string {
  const t = s.trimEnd();
  let k = t.length;
  while (k > 0 && /\w/.test(t[k - 1])) k--;
  const id = t.slice(k);
  return /^[A-Za-z_]/.test(id) ? id : "";
}

// A literal value: a number (with any suffix / digit separators), a string, a
// char, or a boolean. One quantifier per alternative, so no backtracking blowup.
const LITERAL_VALUE_RE = /^(?:-?\d[\w.']*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)+'|true|false)$/;

/** True when `value` (parentheses around it allowed) is a literal constant. */
export function isLiteralValue(value: string): boolean {
  let v = value.trim();
  if (v.startsWith("(") && v.endsWith(")")) v = v.slice(1, -1).trim();
  return LITERAL_VALUE_RE.test(v);
}

// A comparison against a literal: `> 0`, `== "OPEN"`, `<= 0.5f`.
const LITERAL_CMP_RE = /(?:[<>]=?|==|!=)\s*(?:-?\d[\w.]*|"[^"]*"|'[^'\\]')/;
// A comparison against a named constant or an enum value: `>= MAX_ITEMS`,
// `== Status::Open`, `== Status.Open`, `< kLimit`, `== MaxItems`.
const NAMED_CMP_RE = /(?:[<>]=?|==|!=)\s*(?:[A-Z]\w*(?:(?:::|\.)[A-Z]\w*)?\b|k[A-Z]\w*\b)/;

/** True when `cond` compares something to a literal or a named constant. */
export function comparesToConstant(cond: string): boolean {
  return LITERAL_CMP_RE.test(cond) || NAMED_CMP_RE.test(cond);
}

/**
 * The top-level statements of a block body that starts after `headerIdx`:
 * either a braced block (K&R or Allman) or a single unbraced statement.
 * Continuation lines of a multi-line call are not separate statements, so `{`
 * and `(` are counted together and only lines that START at body depth are
 * returned. At most {@link BODY_LOOKAHEAD} lines are read.
 */
export function blockBody(lines: readonly string[], headerIdx: number): string[] {
  let depth = lines[headerIdx].trimEnd().endsWith("{") ? 1 : 0;
  const body: string[] = [];
  const last = Math.min(headerIdx + 1 + BODY_LOOKAHEAD, lines.length);
  for (let j = headerIdx + 1; j < last; j++) {
    const l = lines[j].trim();
    if (l.length === 0 || l.startsWith("//") || l.startsWith("/*") || l.startsWith("*")) continue;
    if (depth === 0) {
      if (l === "{") {
        depth = 1;
        continue;
      }
      body.push(l); // unbraced single-statement body
      break;
    }
    const startDepth = depth;
    let k = 0;
    while (k < l.length) {
      const ch = l[k];
      if (ch === '"' || ch === "'") {
        k = skipLiteral(l, k);
        continue;
      }
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth--;
      k++;
    }
    const stmt = l
      .replace(/^[})\s]+/, "")
      .replace(/\}\s*$/, "")
      .trim();
    if (startDepth === 1 && stmt.length > 0 && !/^[})]/.test(l)) body.push(stmt);
    if (depth <= 0) break;
  }
  return body;
}

/** True when every statement is a logging call. */
export function isLoggingOnly(statements: readonly string[], logRe: RegExp): boolean {
  return statements.length > 0 && statements.every((s) => logRe.test(s));
}

/** True when the first non-logging statement exits (per `exitRe`). */
export function exitsAfterLogging(
  statements: readonly string[],
  logRe: RegExp,
  exitRe: RegExp,
): boolean {
  const first = statements.find((s) => !logRe.test(s));
  return first !== undefined && exitRe.test(first);
}

// A dispatch label that names a constant: a number / string / char literal, a
// numeric range, or a (possibly qualified) name whose last segment is
// capitalised (`Status::Open`, `Status.Open`, `OPEN`, `Open`).
const NUMBER_LABEL_RE = /^-?\d[\w.']*(?:\s*(?:\.\.=?|\.\.\.)\s*-?\d[\w.']*)?$/;
const STRING_LABEL_RE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)+')$/;
const PATH_LABEL_RE = /^(?:[A-Za-z_]\w*(?:::|\.))*[A-Z]\w*$/;
/** Constructors of the standard option/result types: destructuring, not state. */
const NON_STATE_LABELS: ReadonlySet<string> = new Set([
  "Some",
  "None",
  "Ok",
  "Err",
  "Nil",
  "Left",
  "Right",
  "Success",
  "Failure",
]);

/**
 * The constant a dispatch arm's label names, or null when it is a binding,
 * wildcard or destructuring pattern. A payload is dropped:
 * `Event::Paid { amount }` / `Paid(amount)` → `Event::Paid` / `Paid`.
 */
export function constantLabel(label: string): string | null {
  let l = label.trim();
  if (NUMBER_LABEL_RE.test(l) || STRING_LABEL_RE.test(l)) return l;
  const open = l.search(/[({]/);
  if (open > 0) l = l.slice(0, open).trim();
  if (!PATH_LABEL_RE.test(l)) return null;
  const last = l.split(/::|\./).pop() ?? l;
  return NON_STATE_LABELS.has(last) ? null : l;
}

/** Render a miner's rules grouped by kind, `- L<line>: <summary>` per rule (docs-gen rewrites the prefix to `file:line`). */
export function renderGroupedRules<K extends string>(
  rules: readonly BraceMinedRule<K>[],
  maxChars: number,
  order: readonly K[],
  label: (kind: K) => string,
  languageName: string,
): string {
  if (rules.length === 0) return "";
  const groups = new Map<K, BraceMinedRule<K>[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${label(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more ${languageName} rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}
