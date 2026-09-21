/**
 * SAS-specific business rule / step miner.
 *
 * Why this exists: the LLM-driven Phase 1 fact extraction in
 * docs-gen/holistic-synthesizer.ts misses categories of SAS business logic
 * that are trivially identifiable by structure but easy for an LLM to overlook
 * in dense DATA/PROC source dumps. SAS *business logic IS* the DATA-step
 * conditional + PROC-step option surface:
 *
 *   1. Subsetting `IF` / `WHERE` statements — these EXCLUDE or SELECT
 *      observations and are first-class business rules ("only keep rows
 *      where status = 'A'"). A subsetting IF with no THEN/output keeps the
 *      record only when the expression is true.
 *   2. Conditional `IF ... THEN ... [ELSE ...]` assignments / DO blocks —
 *      branch logic that derives or flags values.
 *   3. `RETAIN` statements — values carried across DATA-step iterations
 *      (running totals, last-seen flags, cumulative business state).
 *   4. `KEEP` / `DROP` statements — explicit field-selection rules that
 *      shape the output entity (data-dictionary relevant).
 *   5. PROC-step options / clauses — `BY`, `CLASS`, `VAR`, `WHERE=`,
 *      `GROUP BY`, `HAVING`, `ORDER BY`, join `ON` — the parameters that
 *      define a procedure's behaviour.
 *   6. `%macro foo(params)` declarations — the parameter contract of a macro.
 *
 * This miner runs deterministic regex passes over the raw source (no LLM
 * call) and produces a structured inventory that gets injected into the
 * Phase 1 user prompt as a "MUST INCLUDE THESE RULES" checklist, exactly
 * like {@link mineJavaRules}.
 *
 * The miner is regex-based (not a full SAS grammar) because:
 *   - It runs per-symbol-slice, not per-whole-program, and slices may not
 *     parse cleanly out of context.
 *   - The statement shapes we care about are line-local and unambiguous.
 *   - SAS has no widely-available tree-sitter grammar; the existing SAS
 *     parser in parsers.ts is itself line/statement based.
 *
 * It deliberately mirrors the public shape of the Java miner so the
 * holistic synthesizer can treat the two interchangeably.
 */

import type { SchemaGraphWriter } from "./schema-graph.js";
import {
  extractUsageSafe,
  type ExtractUsageResult,
  type IntrospectedSchema,
  type SqlLineageAccess,
  type SqlLineageClient,
} from "./sql-lineage-client.js";

export interface MinedSasRule {
  kind:
    | "subsetting-if"
    | "where-filter"
    | "conditional"
    | "retain"
    | "keep-drop"
    | "proc-option"
    | "macro-param";
  /** Raw statement as found in source (trimmed, single-line-collapsed). */
  expression: string;
  /** Human-readable summary of what the rule enforces. */
  summary: string;
  /** Source file path (relative). */
  filePath: string;
  /** 1-based line number where the rule lives. */
  line: number;
  /** Containing macro / step qualified name when known. */
  context: string | null;
}

// A subsetting IF has NO `then`/`do`/`output` — it is a pure row filter.
// `if <expr>;`  → keep the observation only when <expr> is true.
const SUBSETTING_IF_RE = /^\s*if\s+(.+?)\s*;\s*$/i;

// Conditional assignment / branch: `if <expr> then ...` (optionally `else ...`).
const CONDITIONAL_IF_RE = /^\s*(?:else\s+)?if\s+(.+?)\s+then\b(.*)$/i;
// Bare `else <consequence>;` following an IF/THEN.
const ELSE_RE = /^\s*else\s+(?!if\b)(.+?)\s*;?\s*$/i;

// `where <expr>;`  (DATA-step or PROC where clause).
const WHERE_RE = /^\s*where\s+(.+?)\s*;\s*$/i;

// `retain a b c [initial];`
const RETAIN_RE = /^\s*retain\s+(.+?)\s*;\s*$/i;

// `keep a b c;` / `drop a b c;`
const KEEP_DROP_RE = /^\s*(keep|drop)\s+(.+?)\s*;\s*$/i;

// PROC clauses we treat as behaviour-defining options. Each captures the
// operand list following the keyword.
const PROC_OPTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^\s*by\s+(.+?)\s*;/i, label: "Group/sort BY" },
  { re: /^\s*class\s+(.+?)\s*;/i, label: "Classification CLASS" },
  { re: /^\s*var\s+(.+?)\s*;/i, label: "Analysis VAR" },
  { re: /^\s*tables\s+(.+?)\s*;/i, label: "Frequency TABLES" },
  { re: /^\s*model\s+(.+?)\s*;/i, label: "MODEL specification" },
  { re: /\bgroup\s+by\s+(.+?)(?:;|having|order\s+by|$)/i, label: "SQL GROUP BY" },
  { re: /\bhaving\s+(.+?)(?:;|order\s+by|$)/i, label: "SQL HAVING filter" },
  { re: /\border\s+by\s+(.+?)(?:;|$)/i, label: "SQL ORDER BY" },
  { re: /\bon\s+(.+?\=.+?)(?:;|where|group\s+by|$)/i, label: "SQL join ON" },
];

// `%macro foo(a, b=, c=default)` — capture name + raw param list.
const MACRO_DECL_RE = /^\s*%macro\s+([A-Za-z_][A-Za-z0-9_]{0,63})\s*(?:\(([^)]*)\))?/i;

/** Cap on a single rendered expression so one runaway line can't blow the budget. */
const MAX_EXPR = 200;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * Mine all rule-bearing SAS patterns from a source slice.
 *
 * @param source   Raw source text (a step/macro body, a whole file, or slice).
 * @param filePath Relative path — stored on each MinedSasRule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to. When
 *                 mining a slice extracted from the middle of a file, pass the
 *                 slice's startLine so reported line numbers stay accurate.
 * @param context  Optional symbol qualified name (e.g. "load.sas::clean").
 */
export function mineSasRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
): MinedSasRule[] {
  const rules: MinedSasRule[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const lineNum = baseLine + i;
    if (line.length === 0) continue;

    const lower = line.toLowerCase();

    // ---- 1. Conditional IF/THEN (and ELSE IF) — branch logic ----
    const cond = CONDITIONAL_IF_RE.exec(line);
    if (cond) {
      const expr = cond[1];
      const consequence = cond[2].trim().replace(/;?\s*$/, "");
      rules.push({
        kind: "conditional",
        expression: truncate(line, MAX_EXPR),
        summary: `When ${truncate(expr, 120)} then ${truncate(consequence || "(branch)", 80)}`,
        filePath,
        line: lineNum,
        context,
      });
      continue;
    }

    // Bare ELSE consequence (paired with a preceding IF/THEN).
    if (lower.startsWith("else ") && !/^else\s+if\b/i.test(line)) {
      const m = ELSE_RE.exec(line);
      if (m) {
        rules.push({
          kind: "conditional",
          expression: truncate(line, MAX_EXPR),
          summary: `Otherwise ${truncate(m[1], 120)}`,
          filePath,
          line: lineNum,
          context,
        });
        continue;
      }
    }

    // ---- 2. Subsetting IF (no THEN) — pure row filter ----
    if (lower.startsWith("if ")) {
      const m = SUBSETTING_IF_RE.exec(line);
      if (m && !/\bthen\b/i.test(line)) {
        rules.push({
          kind: "subsetting-if",
          expression: truncate(line, MAX_EXPR),
          summary: `Keep observation only when ${truncate(m[1], 140)}`,
          filePath,
          line: lineNum,
          context,
        });
        continue;
      }
    }

    // ---- 3. WHERE filter ----
    if (lower.startsWith("where ")) {
      const m = WHERE_RE.exec(line);
      if (m) {
        rules.push({
          kind: "where-filter",
          expression: truncate(line, MAX_EXPR),
          summary: `Select rows where ${truncate(m[1], 140)}`,
          filePath,
          line: lineNum,
          context,
        });
        continue;
      }
    }

    // ---- 4. RETAIN — carried state across iterations ----
    if (lower.startsWith("retain ")) {
      const m = RETAIN_RE.exec(line);
      if (m) {
        rules.push({
          kind: "retain",
          expression: truncate(line, MAX_EXPR),
          summary: `Retains across rows: ${truncate(m[1], 140)}`,
          filePath,
          line: lineNum,
          context,
        });
        continue;
      }
    }

    // ---- 5. KEEP / DROP — output field selection ----
    {
      const m = KEEP_DROP_RE.exec(line);
      if (m) {
        const verb = m[1].toLowerCase();
        rules.push({
          kind: "keep-drop",
          expression: truncate(line, MAX_EXPR),
          summary: `${verb === "keep" ? "Output keeps" : "Output drops"} fields: ${truncate(m[2], 140)}`,
          filePath,
          line: lineNum,
          context,
        });
        continue;
      }
    }

    // ---- 6. Macro parameter contract ----
    {
      const m = MACRO_DECL_RE.exec(line);
      if (m) {
        const params = (m[2] ?? "").trim();
        rules.push({
          kind: "macro-param",
          expression: truncate(line, MAX_EXPR),
          summary: params
            ? `Macro \`${m[1]}\` parameters: ${truncate(params, 140)}`
            : `Macro \`${m[1]}\` (no parameters)`,
          filePath,
          line: lineNum,
          context,
        });
        continue;
      }
    }

    // ---- 7. PROC-step options / SQL clauses ----
    for (const { re, label } of PROC_OPTION_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        rules.push({
          kind: "proc-option",
          expression: truncate(line, MAX_EXPR),
          summary: `${label}: ${truncate(m[1], 140)}`,
          filePath,
          line: lineNum,
          context,
        });
        break; // one option classification per line is enough
      }
    }
  }

  return rules;
}

/**
 * Render mined SAS rules as a compact markdown-ish block for an LLM prompt.
 * Caps total length to keep the prompt budget under control. Mirrors
 * {@link renderMinedRules} for the Java miner so the synthesizer can render
 * either with the same call shape.
 */
export function renderMinedSasRules(rules: MinedSasRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  const groups = new Map<MinedSasRule["kind"], MinedSasRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedSasRule["kind"][] = [
    "subsetting-if",
    "where-filter",
    "conditional",
    "retain",
    "keep-drop",
    "proc-option",
    "macro-param",
  ];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${sasKindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more SAS rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function sasKindLabel(k: MinedSasRule["kind"]): string {
  switch (k) {
    case "subsetting-if":
      return "Subsetting IF (row filters)";
    case "where-filter":
      return "WHERE filters";
    case "conditional":
      return "Conditional logic (IF/THEN/ELSE)";
    case "retain":
      return "RETAIN (carried state)";
    case "keep-drop":
      return "KEEP/DROP (output fields)";
    case "proc-option":
      return "PROC options / SQL clauses";
    case "macro-param":
      return "Macro parameters";
  }
}

// ============================================================================
// SAS WORKFLOW + DATA-LINEAGE miner.
//
// Why this exists (SAS doc-gen grounding gap): the regex parser captures SAS
// symbol NAMES/locations, and {@link mineSasRules} captures business RULES
// (IF/WHERE/threshold). That is why the Business Rules section grounds well. But
// the "Key Workflows", "Data & Domain Model", and "Integrations" sections need
// STEP SEQUENCES (which DATA/PROC step runs, in order, and what it does) and
// DATASET LINEAGE (which datasets each step READS and WRITES). Those facts were
// never mined into the per-module facts blob the synthesizer reads, so the model
// had nothing concrete to describe and fell back to meta-commentary ("many
// modules had empty bodies…"), scoring 0% on Workflows.
//
// This miner runs the SAME deterministic, no-LLM approach that already works for
// rules, over the SAME per-symbol source slices the synthesizer feeds to
// {@link mineSasRules}. A SAS program IS an ordered pipeline of DATA steps and
// PROC steps; each step's SET/MERGE/UPDATE/MODIFY inputs and DATA/OUT=/CREATE
// TABLE/OUTPUT outputs ARE its data lineage. We surface both so workflow + data-
// model sections describe real code, not inferred structure.
// ============================================================================

/** One mined SAS pipeline step (a DATA step or a PROC step). */
export interface MinedSasStep {
  /** "data" or "proc". */
  kind: "data" | "proc";
  /** Step label, e.g. "DATA flagged" or "PROC SQL" / "PROC means". */
  name: string;
  /** 1-based line where the step begins. */
  line: number;
  /** Datasets this step READS (SET/MERGE/UPDATE/MODIFY, DATA=, FROM). Deduped, ordered. */
  reads: string[];
  /** Datasets this step WRITES (DATA out, OUT=, CREATE TABLE/VIEW, explicit OUTPUT). Deduped, ordered. */
  writes: string[];
  /**
   * Ordered, compact summaries of the notable statements inside the step
   * (filters, branches, retained state, key/drop selections, merges) — the
   * step's "what it does", in source order. Bounded per step.
   */
  actions: string[];
}

/** Result of mining a SAS source slice for workflow + lineage facts. */
export interface MinedSasWorkflow {
  steps: MinedSasStep[];
}

// Step openers. A DATA step: `data out1 out2;`. A PROC step: `proc <name> ...;`.
const DATA_STEP_RE = /^\s*data\b(.*)$/i;
const PROC_STEP_RE = /^\s*proc\s+([A-Za-z_][A-Za-z0-9_]{0,63})\b(.*)$/i;
// Step terminators close the current step.
const STEP_TERMINATOR_RE = /^\s*(run|quit)\s*;?\s*$/i;
// Input statements inside a DATA step.
const DATA_INPUT_RE = /^\s*(set|merge|update|modify)\b(.*?);?\s*$/i;
// Inline lineage options (PROC + DATA-step I/O): data=NAME (input), out=NAME (output).
const DATA_OPT_RE = /\bdata\s*=\s*([A-Za-z_][A-Za-z0-9_.]{0,127})/gi;
const OUT_OPT_RE = /\bout\s*=\s*([A-Za-z_][A-Za-z0-9_.]{0,127})/gi;
// PROC SQL lineage.
const CREATE_TABLE_RE = /\bcreate\s+(?:table|view)\s+([A-Za-z_][A-Za-z0-9_.]{0,127})/gi;
const FROM_RE = /\bfrom\s+([A-Za-z_][A-Za-z0-9_.]{0,127})/gi;
// Explicit OUTPUT statement (writes the current output dataset).
const OUTPUT_STMT_RE = /^\s*output\b(.*?);?\s*$/i;

/** Bounded per-step action count so one huge step can't blow the prompt budget. */
const MAX_ACTIONS_PER_STEP = 12;

/**
 * Extract bare dataset names from a fragment (e.g. `work.out (keep=x) out2`).
 * Strips parenthesised dataset options and `key=value` tokens. Self-contained
 * mirror of the parser's helper so the miner has no parser dependency.
 */
function sasStepDatasets(fragment: string): string[] {
  const cleaned = fragment.replace(/\([^()]{0,500}\)/g, " ");
  const out: string[] = [];
  for (const tok of cleaned.split(/[\s,]+/)) {
    const t = tok.trim();
    if (t.length === 0 || t.includes("=")) continue;
    // Drop SAS dataset OPTIONS keywords that are not dataset names.
    if (/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(t)) out.push(t);
  }
  return out;
}

/** Push a value into an ordered, de-duplicating accumulator. */
function pushUnique(arr: string[], value: string): void {
  if (value && !arr.includes(value)) arr.push(value);
}

/** Run a global regex over text, pushing each capture-group-1 into `arr` (deduped). */
function collectAll(re: RegExp, text: string, arr: string[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) pushUnique(arr, m[1]);
}

/**
 * Mine the ordered DATA/PROC step pipeline AND per-step dataset lineage from a
 * SAS source slice. Deterministic, no LLM. Mirrors {@link mineSasRules}'s
 * line-local approach so it runs on the same per-symbol slices.
 *
 * Robust to slices that begin mid-step (no opening `data`/`proc` in view): such
 * statements are attributed to a synthetic leading step only if they carry
 * lineage/actions, so a partial slice still contributes facts.
 *
 * @param source   Raw source text (a step/macro body, a whole file, or slice).
 * @param filePath Relative path (currently unused in output but kept for parity
 *                 and future traceability).
 * @param baseLine 1-based line number that source[0] corresponds to.
 */
export function mineSasWorkflow(
  source: string,
  _filePath: string,
  baseLine: number,
): MinedSasWorkflow {
  const lines = source.split("\n");
  const steps: MinedSasStep[] = [];
  let current: MinedSasStep | null = null;

  const closeStep = (): void => {
    if (
      current &&
      (current.reads.length > 0 || current.writes.length > 0 || current.actions.length > 0)
    ) {
      steps.push(current);
    }
    current = null;
  };

  const addAction = (summary: string): void => {
    if (!current) return;
    if (current.actions.length >= MAX_ACTIONS_PER_STEP) return;
    current.actions.push(summary);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const lineNum = baseLine + i;
    if (line.length === 0) continue;
    const lower = line.toLowerCase();

    // ---- Step terminator (run; / quit;) closes the open step ----
    if (STEP_TERMINATOR_RE.test(line)) {
      closeStep();
      continue;
    }

    // ---- DATA step opener ----
    const dataOpen = DATA_STEP_RE.exec(line);
    // Guard: `data=` option lines (e.g. `set x; data=foo`) are not step openers;
    // a real DATA step opener is `data <names>;` with no leading `=` glue. The
    // regex requires `data` as a leading word, and `data=` would have `=` right
    // after — exclude that.
    if (dataOpen && !/^\s*data\s*=/i.test(line)) {
      closeStep();
      const outputs = sasStepDatasets(dataOpen[1].replace(/;.*$/, ""));
      const name = outputs[0] ? `DATA ${outputs[0]}` : "DATA step";
      current = { kind: "data", name, line: lineNum, reads: [], writes: [], actions: [] };
      for (const ds of outputs) pushUnique(current.writes, ds);
      continue;
    }

    // ---- PROC step opener ----
    const procOpen = PROC_STEP_RE.exec(line);
    if (procOpen) {
      closeStep();
      const procName = `PROC ${procOpen[1].toLowerCase()}`;
      current = { kind: "proc", name: procName, line: lineNum, reads: [], writes: [], actions: [] };
      // Inline lineage on the proc statement itself (e.g. `proc sort data=a out=b;`).
      collectAll(DATA_OPT_RE, line, current.reads);
      collectAll(OUT_OPT_RE, line, current.writes);
      continue;
    }

    // Statements below only matter inside an open step.
    if (!current) continue;

    // ---- DATA-step inputs: SET / MERGE / UPDATE / MODIFY ----
    const input = DATA_INPUT_RE.exec(line);
    if (input && current.kind === "data") {
      const verb = input[1].toLowerCase();
      const datasets = sasStepDatasets(input[2]);
      for (const ds of datasets) pushUnique(current.reads, ds);
      if (datasets.length > 0) {
        addAction(
          `${verb === "merge" ? "Merges" : verb === "set" ? "Reads" : `${verb}s`} ${datasets.join(", ")}`,
        );
      }
      continue;
    }

    // ---- Inline lineage options anywhere in the step ----
    collectAll(DATA_OPT_RE, line, current.reads);
    collectAll(OUT_OPT_RE, line, current.writes);
    collectAll(CREATE_TABLE_RE, line, current.writes);
    collectAll(FROM_RE, line, current.reads);

    // ---- Explicit OUTPUT statement ----
    if (OUTPUT_STMT_RE.test(line)) {
      const targets = sasStepDatasets(line.replace(/^\s*output\b/i, "").replace(/;.*$/, ""));
      for (const ds of targets) pushUnique(current.writes, ds);
      addAction(
        targets.length > 0 ? `Writes row to ${targets.join(", ")}` : "Writes the current row",
      );
      continue;
    }

    // ---- Notable business actions (mirror the rule miner's classifications) ----
    if (CONDITIONAL_IF_RE.test(line)) {
      const m = CONDITIONAL_IF_RE.exec(line)!;
      addAction(
        `If ${truncate(m[1], 80)} then ${truncate(m[2].trim().replace(/;?\s*$/, "") || "(branch)", 60)}`,
      );
      continue;
    }
    if (lower.startsWith("where ")) {
      const m = WHERE_RE.exec(line);
      if (m) {
        addAction(`Filters rows where ${truncate(m[1], 100)}`);
        continue;
      }
    }
    if (lower.startsWith("if ")) {
      const m = SUBSETTING_IF_RE.exec(line);
      if (m && !/\bthen\b/i.test(line)) {
        addAction(`Keeps rows where ${truncate(m[1], 100)}`);
        continue;
      }
    }
    if (lower.startsWith("retain ")) {
      const m = RETAIN_RE.exec(line);
      if (m) {
        addAction(`Retains across rows: ${truncate(m[1], 80)}`);
        continue;
      }
    }
    {
      const m = KEEP_DROP_RE.exec(line);
      if (m) {
        addAction(
          `${m[1].toLowerCase() === "keep" ? "Keeps" : "Drops"} fields ${truncate(m[2], 80)}`,
        );
        continue;
      }
    }
  }
  closeStep();

  return { steps };
}

/**
 * Render mined SAS workflow steps as a WORKFLOW-headed markdown block for the
 * Phase-1 facts. Each step becomes a numbered pipeline entry with its ordered
 * actions, so the synthesizer's "Key Workflows" section can describe the real
 * step sequence instead of inferring one. Caps total length for prompt budget.
 * Returns "" when there are no steps.
 */
export function renderSasWorkflow(workflow: MinedSasWorkflow, maxChars = 6000): string {
  if (workflow.steps.length === 0) return "";
  const parts: string[] = [];
  let total = 0;
  let n = 0;
  for (const step of workflow.steps) {
    n += 1;
    const io: string[] = [];
    if (step.reads.length > 0) io.push(`reads ${step.reads.join(", ")}`);
    if (step.writes.length > 0) io.push(`writes ${step.writes.join(", ")}`);
    const header = `${n}. **${step.name}** (L${step.line})${io.length > 0 ? ` — ${io.join("; ")}` : ""}`;
    if (total + header.length > maxChars) {
      parts.push("- (... more steps truncated for prompt budget)");
      break;
    }
    parts.push(header);
    total += header.length;
    for (const action of step.actions) {
      const a = `   - ${action}`;
      if (total + a.length > maxChars) break;
      parts.push(a);
      total += a.length;
    }
  }
  return parts.join("\n");
}

/**
 * Render mined SAS per-step dataset lineage as a DATA_LINEAGE-style block: one
 * line per step listing the datasets it reads → writes. This complements (and is
 * keyed the same way as) the code-graph lineage already injected as DATA_LINEAGE,
 * but is derived purely from the source slice so it survives even when the
 * code-graph edge lineage is empty for a module. Returns "" when no step has any
 * lineage.
 */
export function renderSasDataLineage(workflow: MinedSasWorkflow, maxChars = 4000): string {
  const withLineage = workflow.steps.filter((s) => s.reads.length > 0 || s.writes.length > 0);
  if (withLineage.length === 0) return "";
  const parts: string[] = [];
  let total = 0;
  for (const step of withLineage) {
    const reads = step.reads.length > 0 ? step.reads.join(", ") : "(none)";
    const writes = step.writes.length > 0 ? step.writes.join(", ") : "(none)";
    const line = `- ${step.name}: reads [${reads}] → writes [${writes}]`;
    if (total + line.length > maxChars) {
      parts.push("- (... more lineage truncated for prompt budget)");
      break;
    }
    parts.push(line);
    total += line.length;
  }
  return parts.join("\n");
}

// ============================================================================
// PROC SQL schema-usage extraction — Epic #294 (#306).
//
// SAS `PROC SQL` blocks contain real SQL. The regex miner above captures their
// CLAUSES as prompt rules, but it does NOT resolve the TABLE/COLUMN references
// into the schema graph. This section locates `proc sql; ... quit;` blocks,
// splits them into statements, and routes each through the `metis-sql-lineage`
// sidecar (#303/#304) to emit `reads`/`writes`/`persists-to` edges with
// `source = "sqlglot"`.
//
// NON-REGRESSION GUARANTEE: this is purely ADDITIVE. {@link mineSasRules} (the
// DATA-step + PROC-clause prompt miner) is unchanged and still handles
// non-PROC-SQL SAS. Only the SQL *inside* PROC SQL blocks is sent to the sidecar.
// ============================================================================

const PROC_SQL_ACCESS_EDGE: Record<SqlLineageAccess, "reads" | "writes" | "persists-to"> = {
  read: "reads",
  write: "writes",
  persist: "persists-to",
};

/** One located PROC SQL block with its inner SQL and 1-based start line. */
export interface ProcSqlBlock {
  /** The SQL body between `proc sql;` and `quit;` (statements joined with `;`). */
  sql: string;
  /** 1-based line of the `proc sql` statement. */
  line: number;
}

/**
 * Locate `PROC SQL; ... QUIT;` blocks in SAS source and return their inner SQL.
 *
 * SAS PROC SQL starts with `proc sql;` (optionally with options like
 * `proc sql noprint;`) and ends with `quit;`. We capture everything in between.
 * A block missing its terminating `quit;` is captured to end-of-source (SAS
 * tolerates this at program end). Case-insensitive; line numbers are 1-based.
 */
export function findProcSqlBlocks(source: string): ProcSqlBlock[] {
  const blocks: ProcSqlBlock[] = [];
  // `proc sql` + optional options up to the first `;`, then lazily everything
  // until `quit;` (or end of input). Literal regex (Semgrep-safe).
  const re = /\bproc\s+sql\b[^;]*;([\s\S]*?)(?:\bquit\s*;|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    const line = source.slice(0, m.index).split("\n").length;
    blocks.push({ sql: body, line });
  }
  return blocks;
}

/**
 * Strip SAS-isms that confuse a generic SQL parser, leaving statements a SQL
 * dialect can parse. We:
 *   - drop SAS macro-variable references (`&macvar`) → a literal placeholder,
 *   - drop `into :host_var` clauses (SAS host-variable capture, not standard).
 * SAS block comments already use standard SQL slash-star comment syntax, so they
 * are parser-compatible and left untouched. Best-effort: anything still
 * unparseable comes back from the sidecar as `uncertain` and is preserved
 * (never dropped).
 */
export function sanitizeProcSql(sql: string): string {
  return sql
    .replace(/&&?[A-Za-z_][A-Za-z0-9_]*\.?/g, "'macro'") // &var / &&var. → literal
    .replace(/\binto\s*:[^;]*?(?=\bfrom\b)/gi, ""); // `select x into :n from t` → `select x from t`
}

/** Split a PROC SQL body into individual statements on top-level semicolons. */
export function splitProcSqlStatements(body: string): string[] {
  return body
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface SasProcSqlOptions {
  /** Override the dialect hint sent to the sidecar (default: SAS/ANSI). */
  dialect?: string;
  /** Introspected schema for SELECT* expansion / column qualification. */
  schema?: IntrospectedSchema | null;
  /** Inject a client (tests); production uses the env-configured singleton. */
  client?: SqlLineageClient;
  /** Epic #882 (#894) — resolved per-project SQL-lineage override. */
  sqlLineageOverride?: boolean | null;
}

export interface SasProcSqlResult {
  /** Number of schema edges written. */
  edges: number;
  /** Number of PROC SQL blocks found. */
  blocks: number;
  /** Number of statements resolved to at least one table. */
  resolved: number;
  /** Uncertain refs reported by the sidecar (never dropped). */
  uncertain: { reason: string; detail: string; line: number }[];
}

/** Persist one sidecar result's tables/columns as schema edges (source sqlglot). */
async function persistProcSqlResult(
  writer: SchemaGraphWriter,
  filePath: string,
  line: number,
  result: ExtractUsageResult,
): Promise<number> {
  if (result.tables.length === 0) return 0;
  const fromId = await writer.createOriginSymbol(
    "method",
    `procsql@${line}`,
    `${filePath}::procsql@${line}`,
    filePath,
    line,
  );
  const colsByTable = new Map<string, { column: string; access: SqlLineageAccess }[]>();
  for (const c of result.columns) {
    const list = colsByTable.get(c.table) ?? [];
    list.push({ column: c.column, access: c.access });
    colsByTable.set(c.table, list);
  }
  let edges = 0;
  for (const table of result.tables) {
    const tableId = await writer.ensureTable(table.name, "sqlglot", {
      schema: table.schema || undefined,
      filePath,
      line,
    });
    await writer.addEdge(fromId, PROC_SQL_ACCESS_EDGE[table.access], tableId, "sqlglot", {
      toQualifiedName: table.qualifiedName,
      filePath,
      line,
    });
    edges++;
    for (const col of colsByTable.get(table.qualifiedName) ?? []) {
      const colId = await writer.ensureColumn(table.name, col.column, "sqlglot", {
        schema: table.schema || undefined,
        filePath,
        line,
      });
      await writer.addEdge(fromId, PROC_SQL_ACCESS_EDGE[col.access], colId, "sqlglot", {
        toQualifiedName: `${table.qualifiedName}.${col.column}`,
        filePath,
        line,
      });
      edges++;
    }
  }
  return edges;
}

/**
 * Extract schema usage from the PROC SQL blocks in one SAS source file and
 * persist the resulting schema edges (`source = "sqlglot"`). Returns counts +
 * any uncertain refs. NEVER throws on sidecar problems (graceful degradation);
 * returns a zeroed result when no PROC SQL is present (no sidecar call).
 *
 * Non-PROC-SQL SAS (DATA steps, other PROCs) is NOT touched here — it remains the
 * job of {@link mineSasRules}.
 */
export async function extractSasProcSql(
  writer: SchemaGraphWriter,
  filePath: string,
  source: string,
  opts: SasProcSqlOptions = {},
): Promise<SasProcSqlResult> {
  const result: SasProcSqlResult = { edges: 0, blocks: 0, resolved: 0, uncertain: [] };
  const blocks = findProcSqlBlocks(source);
  result.blocks = blocks.length;
  if (blocks.length === 0) return result;

  const dialect = opts.dialect ?? "sas";
  for (const block of blocks) {
    for (const rawStmt of splitProcSqlStatements(block.sql)) {
      const sql = sanitizeProcSql(rawStmt);
      if (!sql) continue;
      const extraction = await extractUsageSafe(
        { sql, dialect, schema: opts.schema ?? null },
        opts.client,
        opts.sqlLineageOverride,
      );
      if (!extraction) continue; // sidecar unavailable → degrade (left for re-run)
      result.edges += await persistProcSqlResult(writer, filePath, block.line, extraction);
      if (extraction.tables.length > 0) result.resolved++;
      for (const u of extraction.uncertain) {
        result.uncertain.push({ reason: u.reason, detail: u.detail, line: block.line });
      }
    }
  }
  return result;
}
