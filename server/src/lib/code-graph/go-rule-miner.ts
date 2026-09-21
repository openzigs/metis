/**
 * Go-specific business rule miner (#274).
 *
 * Why this exists: the LLM-driven Phase 1 fact extraction in
 * docs-gen/holistic-synthesizer.ts misses categories of Go business logic that
 * are trivially identifiable by structure but easy to overlook in dense source
 * dumps. Go business logic IS the guard-clause + error surface:
 *
 *   1. Guard clauses (`if cond { return err }`) — validation conditions whose
 *      body returns an error or exits early.
 *   2. `errors.New("msg")` / `fmt.Errorf("...")` — every error documents a
 *      failure mode.
 *   3. `switch x { case ... }` — state/business dispatch.
 *   4. `const NAME = <literal>` — thresholds, limits, magic numbers.
 *
 * Deterministic line-local passes (no LLM call), mirroring {@link mineJavaRules}
 * / {@link mineSasRules}. Semgrep-safe: all regex are literal (no `RegExp`
 * constructor on non-literal input).
 */

export interface MinedGoRule {
  kind: "guard" | "error" | "switch-case" | "const";
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

const MAX_EXPR = 200;
const MAX_RULES = 400;

// `if <cond> {` — capture the condition (the trailing brace may open a block).
const IF_RE = /^\s*if\s+(.+?)\s*\{?\s*$/;
// Inline guard `if <cond> { return ... }` on one line.
const INLINE_IF_RE = /^\s*if\s+(.+?)\s*\{\s*(return\b.*?|panic\(.*?\))\s*\}\s*$/;
// `errors.New("...")` / `fmt.Errorf("...")`.
const ERRORS_NEW_RE = /errors\.New\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/;
const ERRORF_RE = /fmt\.Errorf\s*\(\s*("(?:[^"\\]|\\.)*")/;
// `switch <subject> {` (subject optional for type switches / bare switch).
const SWITCH_RE = /^\s*switch\s+(.+?)\s*\{\s*$/;
const CASE_RE = /^\s*case\s+(.+?)\s*:/;
// `const NAME = <value>` (single) — value capture.
const CONST_RE = /^\s*const\s+([A-Za-z_]\w*)\s*(?:[\w.[\]*]+\s*)?=\s*(.+?)\s*(?:\/\/.*)?$/;
// Opening of a grouped const block: `const (` (Go parenthesized const group).
const CONST_GROUP_OPEN_RE = /^\s*const\s*\(\s*(?:\/\/.*)?$/;
// A grouped-const member line that carries an explicit value:
// `NAME [Type] = value` (e.g. `NAME = iota`). Captures name + value.
// Bare iota-continuation members (no `=`) have no literal value and are skipped.
const CONST_GROUP_MEMBER_RE = /^\s*([A-Za-z_]\w*)\s*(?:[\w.[\]*]+\s*)?=\s*(.+?)\s*(?:\/\/.*)?$/;
// A comparison against a numeric / quoted literal — a threshold rule.
const THRESHOLD_RE = /(?:[<>]=?|==|!=)\s*(?:-?\d+(?:\.\d+)?|"[^"]*")/;
const RETURN_OR_PANIC_RE = /^\s*(?:return\b|panic\()/;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function stripQuotes(s: string): string {
  return s.replace(/^"|"$/g, "").trim();
}

/** Indentation/brace-depth-free check: does the if-body return/panic? */
function bodyExits(lines: string[], headerIdx: number): boolean {
  // Header line opened a block with `{` — scan until the matching close.
  let depth = 0;
  let started = false;
  for (let j = headerIdx; j < Math.min(headerIdx + 8, lines.length); j++) {
    const l = lines[j];
    for (const ch of l) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") depth -= 1;
    }
    if (j > headerIdx && RETURN_OR_PANIC_RE.test(l)) return true;
    if (started && depth <= 0) break;
  }
  return false;
}

/**
 * Mine all rule-bearing Go patterns from a source slice.
 *
 * @param source   Raw source text (a func body, a whole file, or slice).
 * @param filePath Relative path — stored on each MinedGoRule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name (e.g. "Service.Add").
 */
export function mineGoRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
): MinedGoRule[] {
  const rules: MinedGoRule[] = [];
  const lines = source.split("\n");
  // Tracks whether we are inside a grouped `const ( ... )` block so each member
  // line is mined as its own constant (#278).
  let inConstGroup = false;

  for (let i = 0; i < lines.length && rules.length < MAX_RULES; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const lineNum = baseLine + i;
    if (line.length === 0 || line.startsWith("//")) continue;

    // ---- 0. grouped const block: `const ( ... )` (#278) ----
    if (CONST_GROUP_OPEN_RE.test(raw)) {
      inConstGroup = true;
      continue;
    }
    if (inConstGroup) {
      if (line.startsWith(")")) {
        inConstGroup = false;
        continue;
      }
      const gMatch = CONST_GROUP_MEMBER_RE.exec(raw);
      if (gMatch) {
        rules.push({
          kind: "const",
          expression: truncate(line, MAX_EXPR),
          summary: `Constant \`${gMatch[1]}\` = ${truncate(gMatch[2], 120)}`,
          filePath,
          line: lineNum,
          context,
        });
      }
      continue;
    }

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

    // ---- 2. switch dispatch (look ahead for case labels) ----
    const swMatch = SWITCH_RE.exec(raw);
    if (swMatch) {
      const cases: string[] = [];
      let depth = 0;
      let started = false;
      for (let j = i; j < Math.min(i + 120, lines.length); j++) {
        for (const ch of lines[j]) {
          if (ch === "{") {
            depth += 1;
            started = true;
          } else if (ch === "}") depth -= 1;
        }
        const cm = CASE_RE.exec(lines[j]);
        if (cm) cases.push(cm[1]);
        if (started && depth <= 0) break;
      }
      if (cases.length > 0) {
        rules.push({
          kind: "switch-case",
          expression: `switch ${truncate(swMatch[1], 80)} { ${cases.length} cases }`,
          summary: `Dispatch on \`${truncate(swMatch[1], 60)}\` with ${cases.length} branches: ${cases
            .slice(0, 8)
            .map((c) => truncate(c, 30))
            .join(", ")}${cases.length > 8 ? ", …" : ""}`,
          filePath,
          line: lineNum,
          context,
        });
      }
      continue;
    }

    // ---- 3. errors.New / fmt.Errorf (failure modes) ----
    const enMatch = ERRORS_NEW_RE.exec(raw);
    if (enMatch) {
      rules.push({
        kind: "error",
        expression: truncate(line, MAX_EXPR),
        summary: `Error: ${truncate(stripQuotes(enMatch[1]), 140)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }
    const efMatch = ERRORF_RE.exec(raw);
    if (efMatch) {
      rules.push({
        kind: "error",
        expression: truncate(line, MAX_EXPR),
        summary: `Error: ${truncate(stripQuotes(efMatch[1]), 140)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }

    // ---- 4. guard clauses ----
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
    if (ifMatch && raw.includes("{")) {
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
    }
  }

  return rules;
}

/**
 * Render mined Go rules as a compact markdown-ish block for an LLM prompt.
 * Mirrors {@link renderMinedRules}.
 */
export function renderMinedGoRules(rules: MinedGoRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  const groups = new Map<MinedGoRule["kind"], MinedGoRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedGoRule["kind"][] = ["const", "guard", "error", "switch-case"];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${goKindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more Go rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function goKindLabel(k: MinedGoRule["kind"]): string {
  switch (k) {
    case "const":
      return "Constants / thresholds";
    case "guard":
      return "Guards (validation + reject)";
    case "error":
      return "Errors (failure modes)";
    case "switch-case":
      return "State machines (switch/case)";
  }
}
