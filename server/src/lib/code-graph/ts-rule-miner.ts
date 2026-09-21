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
 * / {@link mineSasRules}. Covers JS too — same family. Semgrep-safe: all regex
 * are literal (no `RegExp` constructor on non-literal input).
 */

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

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function stripQuotes(s: string): string {
  return s.replace(/^[`"']|[`"']$/g, "").trim();
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
): MinedTsRule[] {
  const rules: MinedTsRule[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length && rules.length < MAX_RULES; i++) {
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
    if (ZOD_BASE_RE.test(raw)) {
      const found: string[] = [];
      ZOD_CONSTRAINT_RE.lastIndex = 0;
      let zm: RegExpExecArray | null;
      while ((zm = ZOD_CONSTRAINT_RE.exec(raw)) !== null) {
        found.push(zm[1]);
      }
      if (found.length > 0) {
        // Field name = identifier preceding the first `:` on the line, if any.
        const fieldMatch = /^\s*(\w+)\s*:/.exec(raw);
        const field = fieldMatch ? fieldMatch[1] : "";
        rules.push({
          kind: "schema-constraint",
          expression: truncate(line, MAX_EXPR),
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
      const msg = tMatch[2] ? stripQuotes(tMatch[2]) : "";
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
    const inline = INLINE_IF_RE.exec(raw);
    if (inline) {
      rules.push({
        kind: "guard",
        expression: truncate(line, MAX_EXPR),
        summary: `Rejects when ${truncate(inline[1], 140)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }
    const ifMatch = IF_RE.exec(raw);
    if (ifMatch) {
      const cond = ifMatch[1];
      const exits = bodyExits(lines, i);
      const hasThreshold = THRESHOLD_RE.test(cond);
      if (exits || hasThreshold) {
        rules.push({
          kind: "guard",
          expression: truncate(line, MAX_EXPR),
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
    if (line.includes("?") && line.includes(":") && THRESHOLD_RE.test(line) && !tMatch) {
      const condMatch = /=\s*(.+?)\s*\?/.exec(line);
      if (condMatch && THRESHOLD_RE.test(condMatch[1])) {
        rules.push({
          kind: "guard",
          expression: truncate(line, MAX_EXPR),
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
