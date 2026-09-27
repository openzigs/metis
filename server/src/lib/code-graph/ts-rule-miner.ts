/**
 * TypeScript / JavaScript business rule miner (#274).
 *
 * Why this exists: the LLM-driven Phase 1 fact extraction in
 * docs-gen/holistic-synthesizer.ts misses categories of TS/JS business logic
 * that are trivially identifiable by structure but easy to overlook in dense
 * source dumps:
 *
 *   1. `if` / ternary guards whose body throws or returns early — validation
 *      conditions and thresholds.
 *   2. `throw new XxxError("msg")` — every throw documents a failure mode.
 *   3. zod / validation-schema constraints (`.min`, `.max`, `.length`,
 *      `.regex`, `.email`, `.enum`, `.gte`, `.lte`, `.positive`, `.nonempty`).
 *   4. enum / union type constraints (`type X = "a" | "b" | "c"`).
 *   5. numeric / string constants (thresholds, limits, status codes).
 *
 * Deterministic line-local passes (no LLM call), mirroring {@link mineJavaRules}
 * / {@link mineSasRules}. Covers JS too — same family. A guard, ternary, throw
 * or zod chain that spans lines is read as one logical line (#170,
 * {@link joinLogicalLine}: bounded look-ahead, no regex, linear time). Semgrep-safe: all regex
 * are literal (no `RegExp` constructor on non-literal input).
 */

import { joinLogicalLine, opensBracket } from "./rule-miner-continuation.js";

export interface MinedTsRule {
  kind: "guard" | "throw" | "schema-constraint" | "union" | "const";
  /** Raw statement as found in source (trimmed, single-line-collapsed). */
  expression: string;
  /** Human-readable summary of what the rule enforces. */
  summary: string;
  /** Source file path (relative). */
  filePath: string;
  /** 1-based line number where the rule lives. */
  line: number;
  /** Containing function/class qualified name when known. */
  context: string | null;
}

const MAX_EXPR = 200;
const MAX_RULES = 400;

// `if (<cond>) {` — capture the condition.
const IF_RE = /^\s*(?:\}\s*else\s+)?if\s*\((.+)\)\s*\{?\s*$/;
// Inline guard `if (<cond>) throw ...` / `if (<cond>) return ...`.
const INLINE_IF_RE = /^\s*if\s*\((.+?)\)\s*(?:\{)?\s*(throw\b.*|return\b.*)$/;
// `throw new XxxError("...")` / `throw new Error(`...`)`.
const THROW_RE = /throw\s+new\s+([A-Za-z_]\w*)\s*\(\s*([`"'][^`"']*[`"'])?/;
// zod constraint methods chained on a schema. We only flag lines that look
// like schema definitions (contain `z.` or a `.string()`/`.number()` base).
const ZOD_BASE_RE = /\bz\.[a-z]/;
const ZOD_CONSTRAINT_RE =
  /\.(min|max|length|regex|email|url|uuid|enum|literal|gte|gt|lte|lt|positive|negative|nonempty|int|nonnegative)\s*\(/g;
// `type X = "a" | "b"` / inline `"a" | "b" | "c"` union of string literals.
const UNION_RE = /^\s*(?:export\s+)?type\s+(\w+)\s*=\s*(.*["'][^=]*\|[^=]*)$/;
// Narrow / single-value literal-narrowed type alias (#278): a `type` whose RHS
// is one or more string/number literals (and ONLY literals + `|` separators),
// e.g. `type Mode = "strict"` or `type Toggle = "on" | "off"`. Aliases to
// primitives, objects, or functions are deliberately excluded so we capture
// only real value-domain constraints. Anchored so the whole RHS must be
// literal tokens to avoid over-capturing structural aliases.
const LITERAL_TYPE_RE =
  /^\s*(?:export\s+)?type\s+(\w+)\s*=\s*((?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)(?:\s*\|\s*(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?))*)\s*;?\s*$/;
// `const NAME = <number|"string">;`
const CONST_RE =
  /^\s*(?:export\s+)?const\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(-?\d+(?:\.\d+)?|["'`][^"'`]*["'`])\s*;?\s*$/;
// Threshold comparison against a numeric / quoted literal.
const THRESHOLD_RE = /(?:[<>]=?|===?|!==?)\s*(?:-?\d+(?:\.\d+)?|["'][^"']*["'])/;
const THROW_OR_RETURN_RE = /^\s*(?:throw\b|return\b)/;
// #170 — the start of an `if (` header, used to decide whether to join a
// condition that continues onto later lines.
const IF_HEAD_RE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/;
// #170 — a zod chain continued on the next line: `email: z` ⏎ `.string()` ⏎ `.email()`.
// `\s*` sits between two fixed tokens, so it cannot backtrack against another quantifier.
const ZOD_JOINED_BASE_RE = /\bz\s*\.\s*[a-z]/;
const ZOD_CHAIN_HEAD_RE = /\bz\s*$/;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function stripQuotes(s: string): string {
  return s.replace(/^[`"']|[`"']$/g, "").trim();
}

/**
 * The condition of `x = cond ? a : b` — the text between the first `=` and the
 * next `?` — in the `[whole, cond]` shape of the regex it replaces
 * (`/=\s*(.+?)\s*\?/`, which was cubic on a run of `=` then whitespace, #170).
 */
function ternaryCondition(text: string): [string, string] | null {
  const eq = text.indexOf("=");
  if (eq === -1) return null;
  const q = text.indexOf("?", eq + 2);
  if (q === -1) return null;
  return [text.slice(eq, q + 1), text.slice(eq + 1, q).trim()];
}

// #170 — `const fee = …` / `let x: T = …` / `obj.field = …` — the head of an
// assignment whose right-hand side may be a ternary continued on later lines.
// `=(?![=>])` excludes `==`/`===`/`=>`. Linear: `\s*` is followed by a literal
// `:` or `=`, and a type annotation is `[^=]*` up to the one `=` it can stop at.
const ASSIGN_HEAD_RE =
  /^\s*(?:(?:export\s+)?(?:const|let|var)\s+[\w$]+|[\w$.]+)\s*(?::[^=]*)?=(?![=>])/;
// A ternary carried on: the next line starts with `?` (not `?.` / `??`) or `:`,
// or the last line ends with `=`, `?`, `:`, `&&` or `||`.
const TERNARY_NEXT_RE = /^(?:\?(?![.?])|:)/;
const TERNARY_LAST_RE = /(?:[=?:]|&&|\|\|)$/;

function ternaryContinues(last: string, next: string): boolean {
  return TERNARY_NEXT_RE.test(next) || TERNARY_LAST_RE.test(last);
}

/**
 * The condition of a joined `x = cond ? a : b`: between the ASSIGNMENT `=` (not
 * one inside `==`, `===`, `!=`, `<=`, `>=`, `=>`) and the first `?` that is not
 * `?.` / `??`. Null when there is no such `?`.
 */
function assignedTernaryCondition(text: string): [string, string] | null {
  const head = ASSIGN_HEAD_RE.exec(text);
  if (!head) return null;
  const eq = head[0].length - 1;
  for (let q = text.indexOf("?", eq + 1); q !== -1; q = text.indexOf("?", q + 2)) {
    const next = text[q + 1];
    if (next === "." || next === "?") continue;
    return [text.slice(eq, q + 1), text.slice(eq + 1, q).trim()];
  }
  return null;
}

/** A zod chain whose next line continues it with `.method(...)`. */
function chainContinues(_last: string, next: string): boolean {
  return next.startsWith(".");
}

/** Does the if-body (next few lines) throw or return early? */
function bodyExits(lines: string[], headerIdx: number): boolean {
  for (let j = headerIdx + 1; j < Math.min(headerIdx + 6, lines.length); j++) {
    const l = lines[j].trim();
    if (l.length === 0 || l === "{") continue;
    if (l === "}") break;
    return THROW_OR_RETURN_RE.test(l);
  }
  return false;
}

/**
 * Mine all rule-bearing TS/JS patterns from a source slice.
 *
 * @param source   Raw source text (a function body, a whole file, or slice).
 * @param filePath Relative path — stored on each MinedTsRule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name (e.g. "OrderService.charge").
 */
export function mineTsRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
  /**
   * Most rules returned (default {@link MAX_RULES}). Docs-gen Phase 1 passes
   * `Infinity`: it mines whole files and must not lose any rule past the cap.
   */
  maxRules: number = MAX_RULES,
): MinedTsRule[] {
  const rules: MinedTsRule[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length && rules.length < maxRules; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const lineNum = baseLine + i;
    if (line.length === 0 || line.startsWith("//") || line.startsWith("*")) continue;

    // ---- 1. const thresholds ----
    const cMatch = CONST_RE.exec(raw);
    if (cMatch) {
      rules.push({
        kind: "const",
        expression: truncate(line, MAX_EXPR),
        summary: `Constant \`${cMatch[1]}\` = ${truncate(cMatch[2], 120)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }

    // ---- 2. union/enum type constraints ----
    const uMatch = UNION_RE.exec(raw);
    if (uMatch) {
      rules.push({
        kind: "union",
        expression: truncate(line, MAX_EXPR),
        summary: `Allowed values for \`${uMatch[1]}\`: ${truncate(uMatch[2].replace(/;$/, ""), 140)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }
    // ---- 2b. narrow / single-value literal-narrowed type (#278) ----
    // Captures `type X = "v"` and small literal-only unions that UNION_RE (which
    // requires a `|`) misses — these encode a real value-domain constraint.
    const litMatch = LITERAL_TYPE_RE.exec(raw);
    if (litMatch) {
      rules.push({
        kind: "union",
        expression: truncate(line, MAX_EXPR),
        summary: `Allowed values for \`${litMatch[1]}\`: ${truncate(litMatch[2].replace(/;$/, ""), 140)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }

    // ---- 3. zod / schema constraints (may be several per line) ----
    // #170 — a chain continued on following `.method()` lines is read whole.
    // Only a `.`-led next line continues the chain: a `z.object({` whose braces
    // span the whole schema must not absorb its fields' constraints.
    const zodChain =
      (ZOD_BASE_RE.test(raw) || ZOD_CHAIN_HEAD_RE.test(line)) &&
      !opensBracket(raw) &&
      (lines[i + 1] ?? "").trim().startsWith(".")
        ? joinLogicalLine(lines, i, { comment: "//", continues: chainContinues })
        : null;
    const zodText = zodChain ? zodChain.text : raw;
    if (zodChain ? ZOD_JOINED_BASE_RE.test(zodText) : ZOD_BASE_RE.test(raw)) {
      const found: string[] = [];
      ZOD_CONSTRAINT_RE.lastIndex = 0;
      let zm: RegExpExecArray | null;
      while ((zm = ZOD_CONSTRAINT_RE.exec(zodText)) !== null) {
        found.push(zm[1]);
      }
      if (found.length > 0) {
        // Field name = identifier preceding the first `:` on the line, if any.
        const fieldMatch = /^\s*(\w+)\s*:/.exec(raw);
        const field = fieldMatch ? fieldMatch[1] : "";
        rules.push({
          kind: "schema-constraint",
          expression: truncate(zodChain ? zodText : line, MAX_EXPR),
          summary: `${field ? `Field \`${field}\` ` : ""}schema constraints: ${found.join(", ")}`,
          filePath,
          line: lineNum,
          context,
        });
        continue;
      }
    }

    // ---- 4. throw (failure modes) ----
    const tMatch = THROW_RE.exec(raw);
    if (tMatch) {
      const exType = tMatch[1];
      // #170 — `throw new XError(` ⏎ `"message")`: read the message off the next line.
      const tJoined =
        !tMatch[2] && opensBracket(raw) ? joinLogicalLine(lines, i, { comment: "//" }) : null;
      const tFull = tJoined ? THROW_RE.exec(tJoined.text) : null;
      const msgLit = tMatch[2] ?? tFull?.[2];
      const msg = msgLit ? stripQuotes(msgLit) : "";
      rules.push({
        kind: "throw",
        expression: truncate(line, MAX_EXPR),
        summary: `Throws ${exType}${msg ? `: ${truncate(msg, 140)}` : ""}`,
        filePath,
        line: lineNum,
        context,
      });
      // Don't `continue` — an inline `if (...) throw` also encodes the guard.
    }

    // ---- 5. guard clauses (if / inline if / threshold ternary) ----
    // #170 — a condition that spans lines is read up to its closing `)`; the
    // rule is anchored at the `if` line and the body is read after the header.
    const header =
      IF_HEAD_RE.test(raw) && opensBracket(raw)
        ? joinLogicalLine(lines, i, { comment: "//" })
        : null;
    const guardText = header ? header.text : raw;
    const guardLine = header ? header.text : line;
    const inline = INLINE_IF_RE.exec(guardText);
    if (inline) {
      rules.push({
        kind: "guard",
        expression: truncate(guardLine, MAX_EXPR),
        summary: `Rejects when ${truncate(inline[1], 140)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }
    const ifMatch = IF_RE.exec(guardText);
    if (ifMatch) {
      const cond = ifMatch[1];
      const exits = bodyExits(lines, header ? header.end : i);
      const hasThreshold = THRESHOLD_RE.test(cond);
      if (exits || hasThreshold) {
        rules.push({
          kind: "guard",
          expression: truncate(guardLine, MAX_EXPR),
          summary: exits
            ? `Rejects/exits when ${truncate(cond, 140)}`
            : `Branches on threshold ${truncate(cond, 140)}`,
          filePath,
          line: lineNum,
          context,
        });
      }
      continue;
    }
    // Threshold ternary: `... = cond ? a : b` with a comparison constant.
    // #170 — `= cond` ⏎ `? a` ⏎ `: b` (or `=` ⏎ `cond ? a : b`) is read whole.
    // Joined only from an assignment/declaration head that opens no bracket, and
    // only across `?` / `:` / trailing-operator continuations — so a JSX block or
    // a call's argument list is never read as a ternary.
    const ternary =
      ASSIGN_HEAD_RE.test(raw) && !(line.includes("?") && line.includes(":")) && !opensBracket(raw)
        ? joinLogicalLine(lines, i, { comment: "//", continues: ternaryContinues })
        : null;
    const tern = ternary ? ternary.text : line;
    if (tern.includes("?") && tern.includes(":") && THRESHOLD_RE.test(tern) && !tMatch) {
      const condMatch = ternary ? assignedTernaryCondition(tern) : ternaryCondition(tern);
      if (condMatch && THRESHOLD_RE.test(condMatch[1])) {
        rules.push({
          kind: "guard",
          expression: truncate(tern, MAX_EXPR),
          summary: `Branches on threshold ${truncate(condMatch[1], 140)}`,
          filePath,
          line: lineNum,
          context,
        });
      }
    }
  }

  return rules;
}

/**
 * Render mined TS/JS rules as a compact markdown-ish block for an LLM prompt.
 * Mirrors {@link renderMinedRules}.
 */
export function renderMinedTsRules(rules: MinedTsRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  const groups = new Map<MinedTsRule["kind"], MinedTsRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedTsRule["kind"][] = ["const", "union", "schema-constraint", "guard", "throw"];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${tsKindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more TypeScript rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function tsKindLabel(k: MinedTsRule["kind"]): string {
  switch (k) {
    case "const":
      return "Constants / thresholds";
    case "union":
      return "Union / enum constraints";
    case "schema-constraint":
      return "Schema constraints (zod)";
    case "guard":
      return "Guards (validation + reject)";
    case "throw":
      return "Throws (failure modes)";
  }
}
