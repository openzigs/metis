/**
 * Python-specific business rule miner (#274).
 *
 * Why this exists: the LLM-driven Phase 1 fact extraction in
 * docs-gen/holistic-synthesizer.ts misses categories of Python business logic
 * that are trivially identifiable by structure but easy for an LLM to overlook
 * in dense source dumps:
 *
 *   1. `if` / `elif` guard & validation conditions whose body raises, returns
 *      early, or asserts — each is a discrete business rule.
 *   2. `raise XxxError("msg")` — every raise documents a failure mode.
 *   3. `assert cond, "msg"` — runtime invariants.
 *   4. Comparison / threshold constants embedded in guards (`score >= 0.8`).
 *   5. pydantic `Field(..., gt=, ge=, lt=, le=, max_length=, min_length=,
 *      regex=, pattern=)` constraints — declarative validation rules.
 *   6. Validation decorators (`@validator`, `@field_validator`).
 *   7. Early returns guarded by a condition.
 *
 * This miner runs deterministic line-local passes over the raw source (no LLM
 * call) and produces a structured inventory that gets injected into the Phase 1
 * user prompt as a "MUST INCLUDE THESE RULES" checklist, exactly like
 * {@link mineJavaRules} / {@link mineSasRules}. It deliberately mirrors their
 * public shape so the holistic synthesizer can treat them interchangeably.
 *
 * Regex/line-based (not tree-sitter) because it runs per-symbol-slice, slices
 * may not parse cleanly out of context, and the patterns are line-local. To
 * stay Semgrep-safe NO non-literal `RegExp` is constructed — all patterns are
 * literal regex.
 */

export interface MinedPyRule {
  kind: "guard" | "raise" | "assert" | "field-constraint" | "validator" | "early-return";
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

/** Cap on a single rendered expression so one runaway line can't blow the budget. */
const MAX_EXPR = 200;
/** Cap on rules produced from one slice — keeps per-module output bounded. */
const MAX_RULES = 400;

// `if <cond>:` / `elif <cond>:` — capture the condition (without the colon).
const IF_RE = /^\s*(?:el)?if\s+(.+?)\s*:\s*(?:#.*)?$/;
// `raise XxxError("msg")` / bare `raise`.
const RAISE_RE = /^\s*raise\s+([A-Za-z_][\w.]*)\s*(?:\((.*)\))?\s*(?:#.*)?$/;
// `assert <cond>[, "msg"]`.
const ASSERT_RE = /^\s*assert\s+(.+?)\s*$/;
// pydantic Field(...) constraints — only fires when a known constraint kw appears.
const FIELD_RE = /(\w+)\s*[:=].*\bField\s*\((.*)\)/;
// Opening of a (possibly multi-line) Field(...): `name: Type = Field(` with no
// closing paren on the same line (#278).
const FIELD_OPEN_RE = /(\w+)\s*[:=].*\bField\s*\(\s*(?:#.*)?$/;
const FIELD_CONSTRAINT_RE =
  /\b(gt|ge|lt|le|max_length|min_length|max_items|min_items|regex|pattern|multiple_of)\s*=/;
// `@validator(...)` / `@field_validator(...)` / `@model_validator(...)`.
const VALIDATOR_RE = /^\s*@((?:field_|model_)?validator|root_validator)\s*(?:\((.*)\))?\s*$/;
// `return ...` / `return` early-exit detection.
const RETURN_RE = /^\s*return\b/;
const RAISE_KW_RE = /^\s*raise\b/;
const ASSERT_KW_RE = /^\s*assert\b/;
// A comparison against a numeric or quoted literal — a business threshold even
// when the guard body is a plain assignment (the constant IS the rule).
const THRESHOLD_RE = /(?:[<>]=?|==|!=)\s*(?:-?\d+(?:\.\d+)?|["'][^"']*["'])/;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function stripQuotes(s: string): string {
  return s.replace(/^[rfb]?["']|["']$/g, "").trim();
}

/** Leading-whitespace count (column) of a line, for indentation comparison. */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/**
 * Scan the body lines immediately following an `if`/`elif` header (deeper
 * indentation) for the first rule-bearing statement. Returns the kind of the
 * body's terminal action, or null if the body is ordinary (no raise/return/
 * assert) — so we don't over-capture plain control flow.
 */
function classifyGuardBody(
  lines: string[],
  headerIdx: number,
  headerIndent: number,
): "raise" | "early-return" | "assert" | null {
  for (let j = headerIdx + 1; j < Math.min(headerIdx + 6, lines.length); j++) {
    const body = lines[j];
    if (body.trim().length === 0) continue;
    if (indentOf(body) <= headerIndent) break; // dedent — body ended
    if (RAISE_KW_RE.test(body)) return "raise";
    if (ASSERT_KW_RE.test(body)) return "assert";
    if (RETURN_RE.test(body)) return "early-return";
  }
  return null;
}

/**
 * Mine all rule-bearing Python patterns from a source slice.
 *
 * @param source   Raw source text (a function body, a whole file, or slice).
 * @param filePath Relative path — stored on each MinedPyRule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name (e.g. "pricing.compute").
 */
export function minePyRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
  /**
   * Most rules returned (default {@link MAX_RULES}). Docs-gen Phase 1 passes
   * `Infinity`: it mines whole files and must not lose any rule past the cap.
   */
  maxRules: number = MAX_RULES,
): MinedPyRule[] {
  const rules: MinedPyRule[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length && rules.length < maxRules; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const lineNum = baseLine + i;
    if (line.length === 0 || line.startsWith("#")) continue;

    // ---- 1. Validator decorators ----
    const vMatch = VALIDATOR_RE.exec(raw);
    if (vMatch) {
      const args = (vMatch[2] ?? "").trim();
      rules.push({
        kind: "validator",
        expression: truncate(line, MAX_EXPR),
        summary: args
          ? `Validation hook \`@${vMatch[1]}\` for ${truncate(args, 120)}`
          : `Validation hook \`@${vMatch[1]}\``,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }

    // ---- 2. pydantic Field(...) constraints (single-line) ----
    const fMatch = FIELD_RE.exec(line);
    if (fMatch && FIELD_CONSTRAINT_RE.test(fMatch[2])) {
      rules.push({
        kind: "field-constraint",
        expression: truncate(line, MAX_EXPR),
        summary: `Field \`${fMatch[1]}\` constraints: ${truncate(fMatch[2], 140)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }

    // ---- 2b. multi-line Field(...) constraints (#278). When `Field(` opens
    // with no closing paren on the same line, gather the argument lines until
    // the balancing `)` (bounded) and mine the combined args. The rule is
    // anchored at the opening line for stable provenance. ----
    const fOpen = FIELD_OPEN_RE.exec(line);
    if (fOpen) {
      const argParts: string[] = [];
      let closed = false;
      for (let j = i + 1; j < Math.min(i + 24, lines.length); j++) {
        const body = lines[j].trim();
        if (body.startsWith(")")) {
          closed = true;
          break;
        }
        argParts.push(body);
      }
      const args = argParts.join(" ");
      if (closed && FIELD_CONSTRAINT_RE.test(args)) {
        rules.push({
          kind: "field-constraint",
          expression: truncate(`${line} ${args} )`, MAX_EXPR),
          summary: `Field \`${fOpen[1]}\` constraints: ${truncate(args, 140)}`,
          filePath,
          line: lineNum,
          context,
        });
      }
      continue;
    }

    // ---- 3. if / elif guard — only when its body raises/returns/asserts ----
    const ifMatch = IF_RE.exec(raw);
    if (ifMatch) {
      const cond = ifMatch[1];
      const bodyKind = classifyGuardBody(lines, i, indentOf(raw));
      // Capture when the body rejects/exits OR the condition encodes a
      // numeric/string threshold (the constant itself is a business rule).
      const hasThreshold = THRESHOLD_RE.test(cond);
      if (bodyKind === "early-return") {
        rules.push({
          kind: "early-return",
          expression: truncate(line, MAX_EXPR),
          summary: `Early exit when ${truncate(cond, 140)}`,
          filePath,
          line: lineNum,
          context,
        });
      } else if (bodyKind || hasThreshold) {
        rules.push({
          kind: "guard",
          expression: truncate(line, MAX_EXPR),
          summary: bodyKind
            ? `Rejects when ${truncate(cond, 140)} (then ${bodyKind})`
            : `Branches on threshold ${truncate(cond, 140)}`,
          filePath,
          line: lineNum,
          context,
        });
      }
      continue;
    }

    // ---- 4. raise (failure mode) ----
    const rMatch = RAISE_RE.exec(raw);
    if (rMatch) {
      const exType = rMatch[1];
      const arg = (rMatch[2] ?? "").trim();
      rules.push({
        kind: "raise",
        expression: truncate(line, MAX_EXPR),
        summary: `Raises ${exType}${arg ? `: ${truncate(stripQuotes(arg), 140)}` : ""}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }

    // ---- 5. assert invariant ----
    if (ASSERT_KW_RE.test(raw)) {
      const aMatch = ASSERT_RE.exec(raw);
      if (aMatch) {
        const parts = aMatch[1].split(/,(?=\s*["'])/);
        const cond = parts[0].trim();
        const msg = parts[1] ? stripQuotes(parts[1].trim()) : "";
        rules.push({
          kind: "assert",
          expression: truncate(line, MAX_EXPR),
          summary: `Asserts ${truncate(cond, 140)}${msg ? ` — ${truncate(msg, 80)}` : ""}`,
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
 * Render mined Python rules as a compact markdown-ish block for an LLM prompt.
 * Caps total length to keep the prompt budget bounded. Mirrors
 * {@link renderMinedRules} so the synthesizer renders with the same call shape.
 */
export function renderMinedPyRules(rules: MinedPyRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  const groups = new Map<MinedPyRule["kind"], MinedPyRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedPyRule["kind"][] = [
    "field-constraint",
    "validator",
    "guard",
    "raise",
    "assert",
    "early-return",
  ];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${pyKindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more Python rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function pyKindLabel(k: MinedPyRule["kind"]): string {
  switch (k) {
    case "field-constraint":
      return "Field constraints (pydantic)";
    case "validator":
      return "Validator decorators";
    case "guard":
      return "Guards (validation + reject)";
    case "raise":
      return "Raises (failure modes)";
    case "assert":
      return "Assertions (invariants)";
    case "early-return":
      return "Early returns (conditional exits)";
  }
}
