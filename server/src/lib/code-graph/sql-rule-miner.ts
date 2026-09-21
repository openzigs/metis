/**
 * SQL business rule miner (#274).
 *
 * Why this exists: SQL is NOT a code-graph-parsed language (the `Language` type
 * in parsers.ts is ts|js|py|go|java|sas; `.sql` files are only RAG-ingested),
 * so there are NO CodeSymbol rows to dispatch on. Yet `.sql` schema files
 * encode a huge amount of business logic declaratively:
 *
 *   1. CHECK constraints — value-domain business rules.
 *   2. NOT NULL — mandatory-field rules.
 *   3. UNIQUE — uniqueness invariants.
 *   4. PRIMARY KEY / FOREIGN KEY — identity + referential-integrity rules.
 *   5. DEFAULT values — implicit business defaults.
 *   6. Triggers — event-driven rules.
 *   7. View WHERE clauses — derived-dataset filters.
 *   8. Stored-procedure / function IF logic — imperative business branches.
 *
 * Integration: this miner is wired into the holistic synthesizer's extraction
 * phase, which loads project `.sql` source (bounded) from the clone dir and
 * runs {@link mineSqlRules} at the FILE level (baseLine = 1, context = file
 * path), contributing path-keyed rules that render into the Phase-1 prompt like
 * the other miners. See holistic-synthesizer.ts `mineSqlForCloneDir`.
 *
 * Strategy: a deterministic line-local literal scanner is the SOLE producer of
 * the {@link MinedSqlRule}s returned by {@link mineSqlRules}. It gives precise
 * file:line provenance (which the AST cannot cleanly map back to source lines)
 * and handles every SQL dialect uniformly. node-sql-parser is used ONLY as a
 * TEST-TIME cross-check (see {@link sqlAstConstraintKinds}) to sanity-check
 * which constraint kinds the line scanner is expected to cover — it does NOT
 * contribute any rule to production output. Semgrep-safe: all regex are literal
 * (no `RegExp` constructor on non-literal input).
 */
import nodeSqlParser from "node-sql-parser";

const { Parser } = nodeSqlParser;

export interface MinedSqlRule {
  kind:
    | "check"
    | "not-null"
    | "unique"
    | "primary-key"
    | "foreign-key"
    | "default"
    | "trigger"
    | "view-filter"
    | "proc-conditional";
  /** Raw statement / clause as found in source (trimmed, collapsed). */
  expression: string;
  /** Human-readable summary of what the rule enforces. */
  summary: string;
  /** Source file path (relative). */
  filePath: string;
  /** 1-based line number where the rule lives. */
  line: number;
  /** File path or object name when known (SQL has no AST symbols). */
  context: string | null;
}

const MAX_EXPR = 200;
const MAX_RULES = 500;

// CHECK ( ... ) — capture the (possibly nested-paren) condition heuristically.
const CHECK_RE = /\bCHECK\s*\(\s*(.+)$/i;
// `<col> <type> ... NOT NULL` — capture the leading column identifier.
const COL_NAME_RE = /^\s*"?([A-Za-z_]\w*)"?\s+\w/;
// REFERENCES <table>(<cols>) — column-level FK.
const REFERENCES_RE = /\bREFERENCES\s+"?([A-Za-z_]\w*)"?\s*(\([^)]*\))?/i;
// FOREIGN KEY (<cols>) REFERENCES <table>(<cols>) — table-level FK.
const FK_RE = /\bFOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"?([A-Za-z_]\w*)"?\s*(\([^)]*\))?/i;
// DEFAULT <value>.
const DEFAULT_RE = /\bDEFAULT\s+('[^']*'|"[^"]*"|[\w.()-]+)/i;
// CREATE TRIGGER <name>.
const TRIGGER_RE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?([A-Za-z_]\w*)"?/i;
// CREATE VIEW <name> ... — view detection (the WHERE may be on a later line).
const VIEW_RE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+"?([A-Za-z_]\w*)"?/i;
// WHERE <condition> — capture the filter expression (line-local).
const WHERE_RE = /\bWHERE\s+(.+?)\s*;?\s*$/i;
// IF <cond> THEN — plpgsql / proc conditional.
const PROC_IF_RE = /^\s*(?:ELSE\s*)?IF\s+(.+?)\s+THEN\b/i;
// CREATE FUNCTION / PROCEDURE — to scope proc conditionals.
const PROC_DECL_RE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+"?([A-Za-z_]\w*)"?/i;
// Start of a DML (data-manipulation) statement. Data rows are NOT business
// rules — only DDL is rule-bearing (#278). When a DML statement begins we skip
// rule mining until the statement terminates with `;`.
const DML_START_RE = /^\s*(?:INSERT\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\b/i;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * Extract the balanced contents of a CHECK ( ... ) starting at the position of
 * the first inner char. Handles nested parens; bounded to the current + a few
 * following lines so a malformed file can't run away.
 */
function balancedParen(s: string): string {
  let depth = 1;
  let out = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    out += ch;
  }
  return out.trim();
}

/**
 * TEST-TIME AST cross-check: parse CREATE statements with node-sql-parser and
 * report which constraint kinds the AST can see. Best-effort — any failure
 * returns an empty set. This is NOT used by {@link mineSqlRules}; it exists
 * purely so tests/diagnostics can sanity-check the line scanner's expected
 * coverage. The line scanner remains the authoritative producer of rules
 * because the AST does not carry source line numbers.
 */
function astConstraintKinds(source: string): Set<string> {
  // Returns the set of "kind" present per AST so the line scanner's coverage
  // can be sanity-checked in tests; the line scanner is authoritative for
  // line numbers, so AST findings never enter production output.
  const present = new Set<string>();
  const parser = new Parser();
  for (const dialect of ["postgresql", "mysql", "sqlite"] as const) {
    try {
      const ast = parser.astify(source, { database: dialect });
      const stmts = Array.isArray(ast) ? ast : [ast];
      for (const st of stmts) {
        const defs = (st as { create_definitions?: unknown[] }).create_definitions;
        if (!Array.isArray(defs)) continue;
        for (const d of defs as Array<Record<string, unknown>>) {
          if (d.check) present.add("check");
          if (d.unique) present.add("unique");
          if (d.primary_key) present.add("primary-key");
          if (d.reference_definition) present.add("foreign-key");
          const nullable = d.nullable as { type?: string } | undefined;
          if (nullable?.type === "not null") present.add("not-null");
          if (d.default_val) present.add("default");
        }
      }
      return present; // first dialect that parses wins
    } catch {
      // try next dialect
    }
  }
  return present;
}

/**
 * Mine all rule-bearing SQL patterns from a source slice / file.
 *
 * @param source   Raw SQL text (a whole `.sql` file or a bounded slice).
 * @param filePath Relative path — stored on each MinedSqlRule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to (usually 1).
 * @param context  Optional object/file name (SQL has no AST symbols).
 */
export function mineSqlRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
): MinedSqlRule[] {
  const rules: MinedSqlRule[] = [];
  const lines = source.split("\n");
  // Track the current containing object for better context attribution.
  let currentProc: string | null = null;
  // Track whether we are inside a DML (INSERT/UPDATE/...) statement whose data
  // rows must NOT be mined as rules (#278). Cleared on the terminating `;`.
  let inDml = false;

  for (let i = 0; i < lines.length && rules.length < MAX_RULES; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const lineNum = baseLine + i;
    if (
      line.length === 0 ||
      line.startsWith("--") ||
      line.startsWith("/*") ||
      line.startsWith("*")
    ) {
      continue;
    }

    // ---- DML suppression (#278): skip data rows of INSERT/UPDATE/etc. ----
    if (!inDml && DML_START_RE.test(line)) {
      inDml = true;
    }
    if (inDml) {
      // Consume the statement (including this line) without mining; reset once
      // the statement terminates with a semicolon.
      if (line.endsWith(";")) inDml = false;
      continue;
    }
    const ctx = currentProc ? `${context ?? filePath}::${currentProc}` : context;

    // ---- proc / function scope tracking ----
    const procDecl = PROC_DECL_RE.exec(line);
    if (procDecl) currentProc = procDecl[1];

    // ---- 1. CHECK constraint ----
    const checkMatch = CHECK_RE.exec(line);
    if (checkMatch) {
      const cond = balancedParen(checkMatch[1]);
      rules.push({
        kind: "check",
        expression: truncate(line, MAX_EXPR),
        summary: `Value rule (CHECK): ${truncate(cond, 150)}`,
        filePath,
        line: lineNum,
        context: ctx,
      });
      // Fall through — a column line can carry CHECK + NOT NULL etc.
    }

    // ---- 2. table-level FOREIGN KEY ----
    const fkMatch = FK_RE.exec(line);
    if (fkMatch) {
      rules.push({
        kind: "foreign-key",
        expression: truncate(line, MAX_EXPR),
        summary: `Referential rule: ${truncate(fkMatch[1], 60)} → ${fkMatch[2]}${fkMatch[3] ?? ""}`,
        filePath,
        line: lineNum,
        context: ctx,
      });
      continue;
    }

    // ---- 3. column-level REFERENCES (FK) ----
    const refMatch = REFERENCES_RE.exec(line);
    if (refMatch) {
      const col = COL_NAME_RE.exec(raw);
      rules.push({
        kind: "foreign-key",
        expression: truncate(line, MAX_EXPR),
        summary: `Referential rule: ${col ? `\`${col[1]}\` ` : ""}→ ${refMatch[1]}${refMatch[2] ?? ""}`,
        filePath,
        line: lineNum,
        context: ctx,
      });
    }

    // ---- 4. PRIMARY KEY ----
    if (/\bPRIMARY\s+KEY\b/i.test(line)) {
      const col = COL_NAME_RE.exec(raw);
      rules.push({
        kind: "primary-key",
        expression: truncate(line, MAX_EXPR),
        summary: `Identity (PRIMARY KEY)${col ? `: \`${col[1]}\`` : ""}`,
        filePath,
        line: lineNum,
        context: ctx,
      });
    }

    // ---- 5. NOT NULL ----
    if (/\bNOT\s+NULL\b/i.test(line)) {
      const col = COL_NAME_RE.exec(raw);
      rules.push({
        kind: "not-null",
        expression: truncate(line, MAX_EXPR),
        summary: `Mandatory${col ? ` field \`${col[1]}\`` : ""} (NOT NULL)`,
        filePath,
        line: lineNum,
        context: ctx,
      });
    }

    // ---- 6. UNIQUE ----
    if (/\bUNIQUE\b/i.test(line)) {
      const col = COL_NAME_RE.exec(raw);
      rules.push({
        kind: "unique",
        expression: truncate(line, MAX_EXPR),
        summary: `Uniqueness${col ? ` on \`${col[1]}\`` : ""} (UNIQUE)`,
        filePath,
        line: lineNum,
        context: ctx,
      });
    }

    // ---- 7. DEFAULT ----
    const defMatch = DEFAULT_RE.exec(line);
    if (defMatch) {
      const col = COL_NAME_RE.exec(raw);
      rules.push({
        kind: "default",
        expression: truncate(line, MAX_EXPR),
        summary: `Default${col ? ` for \`${col[1]}\`` : ""}: ${truncate(defMatch[1], 80)}`,
        filePath,
        line: lineNum,
        context: ctx,
      });
    }

    // ---- 8. TRIGGER ----
    const trigMatch = TRIGGER_RE.exec(line);
    if (trigMatch) {
      rules.push({
        kind: "trigger",
        expression: truncate(line, MAX_EXPR),
        summary: `Trigger \`${trigMatch[1]}\` (event-driven rule)`,
        filePath,
        line: lineNum,
        context: ctx,
      });
      continue;
    }

    // ---- 9. VIEW filter (WHERE on the VIEW line or a following line) ----
    if (VIEW_RE.test(line)) {
      const viewName = VIEW_RE.exec(line)?.[1] ?? "";
      // Scan this + the next several lines for a WHERE clause.
      for (let j = i; j < Math.min(i + 12, lines.length); j++) {
        const wm = WHERE_RE.exec(lines[j]);
        if (wm) {
          rules.push({
            kind: "view-filter",
            expression: truncate(lines[j].trim(), MAX_EXPR),
            summary: `View \`${viewName}\` includes rows where ${truncate(wm[1], 140)}`,
            filePath,
            line: baseLine + j,
            context: ctx,
          });
          break;
        }
        if (/;\s*$/.test(lines[j]) && j > i) break; // statement ended
      }
      continue;
    }

    // ---- 10. proc/function conditional (IF ... THEN) ----
    const ifMatch = PROC_IF_RE.exec(line);
    if (ifMatch) {
      rules.push({
        kind: "proc-conditional",
        expression: truncate(line, MAX_EXPR),
        summary: `Branch when ${truncate(ifMatch[1], 140)}`,
        filePath,
        line: lineNum,
        context: ctx,
      });
    }
  }

  return rules;
}

/**
 * For diagnostics/tests: which constraint kinds the AST parser can see in this
 * SQL. Exported so callers can cross-check line-scanner coverage if desired.
 */
export function sqlAstConstraintKinds(source: string): Set<string> {
  return astConstraintKinds(source);
}

/**
 * Render mined SQL rules as a compact markdown-ish block for an LLM prompt.
 * Mirrors {@link renderMinedRules}.
 */
export function renderMinedSqlRules(rules: MinedSqlRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  const groups = new Map<MinedSqlRule["kind"], MinedSqlRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedSqlRule["kind"][] = [
    "check",
    "not-null",
    "unique",
    "primary-key",
    "foreign-key",
    "default",
    "trigger",
    "view-filter",
    "proc-conditional",
  ];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${sqlKindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more SQL rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function sqlKindLabel(k: MinedSqlRule["kind"]): string {
  switch (k) {
    case "check":
      return "CHECK constraints (value rules)";
    case "not-null":
      return "NOT NULL (mandatory fields)";
    case "unique":
      return "UNIQUE (uniqueness invariants)";
    case "primary-key":
      return "Primary keys (identity)";
    case "foreign-key":
      return "Foreign keys (referential rules)";
    case "default":
      return "DEFAULT values";
    case "trigger":
      return "Triggers (event-driven rules)";
    case "view-filter":
      return "View filters (derived datasets)";
    case "proc-conditional":
      return "Stored-proc conditionals";
  }
}
