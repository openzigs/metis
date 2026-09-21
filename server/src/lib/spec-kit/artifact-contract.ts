/**
 * Issue #376 (Phase 3) — LLM-optimized artifact contract.
 *
 * The `/specify`, `/plan`, and `/tasks` system prompts (in `commands/*.ts`)
 * instruct the agent to emit Markdown that downstream agents
 * (analysis → requirements → code-issue) can consume *deterministically*:
 *
 *   - `spec.md` — every acceptance criterion in strict Given/When/Then form,
 *     each with a stable `AC-N` id, at least one example I/O per behavior
 *     where applicable, and NO implementation detail ("what/why, not how").
 *   - `plan.md` — every component/decision is traceable to the spec AC id(s)
 *     it satisfies, with the required Mermaid `## Architecture diagram` block.
 *   - `tasks.md` — atomic checklist tasks, each mapped to one or more spec
 *     AC ids and sized so one task ≈ one PR-able unit.
 *
 * This module provides the structural parser/validator that makes that
 * contract *testable*. It is intentionally pure (string in → structured
 * out) so golden/fixture tests can assert the shape without an LLM, and so
 * future downstream consumers have a single canonical extractor to reuse.
 *
 * It does NOT touch dispatch, artifact names, or the governance chain — it
 * only reads artifact text.
 */

/** Stable acceptance-criterion id form, e.g. `AC-1`, `AC-12`. */
export const AC_ID_RE = /\bAC-(\d+)\b/;
const AC_ID_RE_G = /\bAC-(\d+)\b/g;

/** A parsed Given/When/Then acceptance criterion from `spec.md`. */
export interface ParsedAcceptanceCriterion {
  /** Canonical id, e.g. `AC-1`. */
  id: string;
  /** Text of the `Given` clause (without the keyword), when present. */
  given: string | null;
  /** Text of the `When` clause (without the keyword), when present. */
  when: string | null;
  /** Text of the `Then` clause (without the keyword), when present. */
  then: string | null;
  /** Raw text block for the criterion (id line + any continuation lines). */
  raw: string;
}

/** A parsed task checklist item from `tasks.md`. */
export interface ParsedContractTask {
  /** Whether the checkbox is checked (`[x]`) or not (`[ ]`). */
  checked: boolean;
  /** Task title text (the checklist line, minus the AC reference suffix). */
  title: string;
  /** AC ids this task is mapped to, e.g. `["AC-1", "AC-2"]`. */
  acIds: string[];
  /** Raw checklist line. */
  raw: string;
}

/** Result of structurally validating a `spec.md` body. */
export interface SpecContract {
  /** Markdown headings present (normalized to lowercase, `#` stripped). */
  sections: string[];
  /** Acceptance criteria parsed out of the `Acceptance criteria` section. */
  acceptanceCriteria: ParsedAcceptanceCriterion[];
  /** True when every required section heading is present. */
  hasRequiredSections: boolean;
  /** Required sections that are missing (empty when valid). */
  missingSections: string[];
}

/** Result of structurally validating a `plan.md` body. */
export interface PlanContract {
  sections: string[];
  /** Distinct AC ids referenced anywhere in the plan body. */
  referencedAcIds: string[];
  /** True when the required Mermaid architecture diagram block is present. */
  hasArchitectureDiagram: boolean;
  hasRequiredSections: boolean;
  missingSections: string[];
}

/** Result of structurally validating a `tasks.md` body. */
export interface TasksContract {
  tasks: ParsedContractTask[];
  /** True when at least one task exists and every task maps to ≥1 AC id. */
  allTasksMapped: boolean;
  /** Tasks (by title) that are missing an AC mapping. */
  unmappedTaskTitles: string[];
}

/** Required `spec.md` section headings (normalized, in canonical order). */
export const SPEC_REQUIRED_SECTIONS = [
  "spec",
  "stakeholders",
  "in scope",
  "out of scope",
  "acceptance criteria",
  "non-functional requirements",
] as const;

/** Required `plan.md` section headings (normalized). */
export const PLAN_REQUIRED_SECTIONS = [
  "plan",
  "components",
  "architecture diagram",
  "sequence diagrams",
  "adrs",
  "risks & mitigations",
] as const;

/** Normalize a heading line to a comparable key (strip `#`, trim, lowercase). */
function normalizeHeading(line: string): string {
  return line.replace(/^#+/, "").trim().toLowerCase();
}

/** Collect every Markdown ATX heading in a document (normalized). */
export function extractHeadings(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^#{1,6}\s+\S/.test(line)) out.push(normalizeHeading(line));
  }
  return out;
}

/** Distinct AC ids referenced anywhere in `text`, in first-seen order. */
export function extractAcIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(AC_ID_RE_G)) {
    const id = `AC-${m[1]}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Slice the body of a section identified by a normalized heading key
 * (e.g. `"acceptance criteria"`), up to the next heading of the same or
 * shallower depth. Returns "" when the section is absent.
 */
export function extractSectionBody(markdown: string, headingKey: string): string {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h && normalizeHeading(line) === headingKey) {
      start = i + 1;
      startDepth = h[1]!.length;
      break;
    }
  }
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const h = /^(#{1,6})\s+/.exec(lines[i]!);
    if (h && h[1]!.length <= startDepth) break;
    body.push(lines[i]!);
  }
  return body.join("\n").trim();
}

/**
 * Parse Given/When/Then acceptance criteria out of an `Acceptance criteria`
 * section body. Each criterion begins with a line carrying an `AC-N` id; the
 * Given/When/Then clauses may be on the same line or on indented
 * continuation lines, in any common separator style (`**Given**`, `Given:`,
 * `- Given …`).
 */
export function parseAcceptanceCriteria(sectionBody: string): ParsedAcceptanceCriterion[] {
  const lines = sectionBody.split(/\r?\n/);
  const criteria: ParsedAcceptanceCriterion[] = [];
  let current: { id: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const raw = current.lines.join("\n");
    criteria.push({
      id: current.id,
      given: extractClause(raw, "given"),
      when: extractClause(raw, "when"),
      then: extractClause(raw, "then"),
      raw,
    });
    current = null;
  };

  for (const line of lines) {
    const idMatch = AC_ID_RE.exec(line);
    // A new criterion starts on a non-indented bullet/line that carries an id.
    const isNewItem = idMatch && /^\s{0,3}(?:[-*]\s+|\d+\.\s+|\*\*|`?AC-)/.test(line);
    if (idMatch && (isNewItem || current === null)) {
      flush();
      current = { id: `AC-${idMatch[1]}`, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return criteria;
}

// Precompiled literal patterns per keyword. Avoids constructing a RegExp from a
// dynamic string (Semgrep detect-non-literal-regexp / ReDoS hardening); the
// `keyword` is always one of three internal literals, never user input.
// Matches `**Given**: x`, `Given: x`, `- Given x`, `_Given_ x`, etc.
const CLAUSE_RE: Record<"given" | "when" | "then", RegExp> = {
  given: /(?:^|\n)\s*(?:[-*]\s*)?[*_`]{0,2}given[*_`]{0,2}\s*:?\s*(.+)/i,
  when: /(?:^|\n)\s*(?:[-*]\s*)?[*_`]{0,2}when[*_`]{0,2}\s*:?\s*(.+)/i,
  then: /(?:^|\n)\s*(?:[-*]\s*)?[*_`]{0,2}then[*_`]{0,2}\s*:?\s*(.+)/i,
};

/** Extract the text following a Given/When/Then keyword (any common style). */
function extractClause(block: string, keyword: "given" | "when" | "then"): string | null {
  const re = CLAUSE_RE[keyword];
  const m = re.exec(block);
  if (!m) return null;
  // Strip any leftover emphasis/quote punctuation (e.g. the trailing `**` of a
  // bare `- **When**` with no body) so an empty clause reads as null.
  const text = m[1]!.replace(/^[*_`\s]+|[*_`\s]+$/g, "").trim();
  return text.length > 0 ? text : null;
}

/** Parse checklist tasks out of a `tasks.md` body. */
export function parseContractTasks(markdown: string): ParsedContractTask[] {
  const out: ParsedContractTask[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[([ xX])\]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const checked = m[1]!.toLowerCase() === "x";
    const body = m[2]!;
    const acIds = extractAcIds(body);
    // Title = body with a trailing AC reference clause stripped, when present.
    const title = body
      .replace(/\(\s*(?:satisfies|maps?\s*(?:to)?|ac)\s*:?\s*AC-[\d,\s-]*AC?-?\d*\s*\)/i, "")
      .replace(/\b(?:satisfies|maps?\s*to|ac)\s*:?\s*(?:AC-\d+\s*,?\s*)+$/i, "")
      .trim();
    out.push({ checked, title: title.length > 0 ? title : body.trim(), acIds, raw: line });
  }
  return out;
}

/** Structurally validate a `spec.md` body against the Phase 3 contract. */
export function validateSpecContract(markdown: string): SpecContract {
  const sections = extractHeadings(markdown);
  const sectionSet = new Set(sections);
  const missingSections = SPEC_REQUIRED_SECTIONS.filter((s) => !sectionSet.has(s));
  const acBody = extractSectionBody(markdown, "acceptance criteria");
  const acceptanceCriteria = parseAcceptanceCriteria(acBody);
  return {
    sections,
    acceptanceCriteria,
    hasRequiredSections: missingSections.length === 0,
    missingSections,
  };
}

/** Structurally validate a `plan.md` body against the Phase 3 contract. */
export function validatePlanContract(markdown: string): PlanContract {
  const sections = extractHeadings(markdown);
  const sectionSet = new Set(sections);
  const missingSections = PLAN_REQUIRED_SECTIONS.filter((s) => !sectionSet.has(s));
  const diagramBody = extractSectionBody(markdown, "architecture diagram");
  const hasArchitectureDiagram = /```\s*mermaid[\s\S]*?```/i.test(diagramBody);
  return {
    sections,
    referencedAcIds: extractAcIds(markdown),
    hasArchitectureDiagram,
    hasRequiredSections: missingSections.length === 0,
    missingSections,
  };
}

/** Structurally validate a `tasks.md` body against the Phase 3 contract. */
export function validateTasksContract(markdown: string): TasksContract {
  const tasks = parseContractTasks(markdown);
  const unmapped = tasks.filter((t) => t.acIds.length === 0);
  return {
    tasks,
    allTasksMapped: tasks.length > 0 && unmapped.length === 0,
    unmappedTaskTitles: unmapped.map((t) => t.title),
  };
}
