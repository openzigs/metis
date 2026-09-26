/**
 * #154 / #155 — topic-sliced Phase-1 facts and the deterministic mined-rule
 * inventory that travels with them.
 *
 * Phase 1 writes one free-text facts blob per module under fixed headings
 * (PURPOSE, ENTITIES, RULES, WORKFLOWS, FORMULAS, INTEGRATIONS, KEY_APIS,
 * STATUS_TRANSITIONS, NOTES, plus the deterministic DATA_LINEAGE appendix).
 * Phase 2 used to send each section the WHOLE blob, so a section paid for every
 * module's unrelated topics and only 8–11 of 143 modules fitted a 200K-char
 * budget (onyourleft, 2026-09-23). This module splits a blob into topic
 * {@link FactSlice}s deterministically, so a section can read only the slices it
 * declares (`SectionGroup.factSlices` in the holistic synthesizer).
 *
 * `summary` is the short PURPOSE; NOTES (caching, security, performance
 * asides) get their own `notes` slice because they are long — on onyourleft the
 * modules cut off at the output cap had run away in NOTES (up to 28K chars).
 *
 * It also owns the language-neutral {@link PersistedMinedRule} shape: every rule
 * miner (Java, TS/JS, Python, Go, SAS, SQL) is normalised into it, persisted in
 * `docs_gen_fact_cache.minedRulesJson`, and rendered into the Rules section's
 * input as a structured, `file:line`-citable inventory that does not depend on
 * the LLM having repeated the rule in its summary.
 *
 * Pure functions only — no I/O — so the parsing and rendering contracts are
 * unit-testable without a model or a database.
 */

/** The topic slices a module's Phase-1 facts are split into. */
export const FACT_SLICES = [
  "summary",
  "rules",
  "formulas",
  "workflows",
  "entities",
  "capabilities",
  "integrations",
  "notes",
] as const;
export type FactSlice = (typeof FACT_SLICES)[number];

/** One module's facts, split by topic. Each value keeps its original heading lines. */
export type ModuleFactSlices = Record<FactSlice, string>;

/**
 * Which slice(s) each Phase-1 heading feeds. A heading may feed more than one
 * slice: STATUS_TRANSITIONS are both rules and workflow steps, and DATA_LINEAGE
 * (dataset reads/writes) is what both the workflow and data-model sections
 * reconstruct from. Anything not listed here (including text before the first
 * heading) lands in `summary`.
 */
const HEADING_SLICES: Readonly<Record<string, readonly FactSlice[]>> = {
  PURPOSE: ["summary"],
  NOTES: ["notes"],
  ENTITIES: ["entities"],
  RULES: ["rules"],
  STATUS_TRANSITIONS: ["rules", "workflows"],
  WORKFLOWS: ["workflows"],
  DATA_LINEAGE: ["workflows", "entities"],
  FORMULAS: ["formulas"],
  INTEGRATIONS: ["integrations"],
  KEY_APIS: ["capabilities"],
};

/**
 * A heading line: the bare token the Phase-1 prompt asks for, tolerating the
 * decorations small local models add (`## RULES`, `**RULES**`, `RULES:`,
 * `**1. RULES**`, `2) RULES`). With a colon, the heading may also carry its
 * first item inline (`RULES: - amount > 0`); group 2 is that remainder. The
 * token is upper-case only, so prose such as `Rules apply: daily` is not a
 * heading, and a bullet line (`- NOTES: ...`) never is.
 */
const HEADING_LINE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:\d+[.)]\s*)?([A-Z][A-Z_ ]{2,}?)\s*(?:\*\*)?\s*(?::\s*(?:\*\*)?\s*([^*\s].*?))?\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/;

/** A bullet or numbered-list line. */
const BULLET_LINE = /^\s*(?:[-•*]|\d+\.)\s/;

/** A section body that says nothing: `(none)`, `none`, `(none extracted in offline mode)`. */
const EMPTY_BODY = /^\(?\s*none\b[^)]*\)?\.?$/i;

/** A record with one fresh value per {@link FactSlice}. */
function perSlice<T>(make: () => T): Record<FactSlice, T> {
  return Object.fromEntries(FACT_SLICES.map((slice) => [slice, make()])) as Record<FactSlice, T>;
}

/** A recognised heading, plus any first item written on the heading line itself. */
interface Heading {
  token: string;
  inline: string | null;
}

function headingOf(line: string): Heading | null {
  const m = HEADING_LINE.exec(line);
  if (!m) return null;
  const token = m[1].trim().replace(/\s+/g, "_");
  return token in HEADING_SLICES ? { token, inline: m[2] ?? null } : null;
}

/**
 * Split a Phase-1 facts blob into topic slices.
 *
 * Deterministic and total: a reply with NO recognised heading (a model that
 * ignored the format, a failure fallback, a truncated fragment) is returned
 * whole in `summary` — never dropped. Repeated headings (the SAS pipeline
 * appendix adds a second WORKFLOWS / DATA_LINEAGE block) are concatenated.
 * Blocks whose body is empty or just "(none)" are dropped, since sending
 * "STATUS_TRANSITIONS\n(none)" to every section only burns budget, and a
 * bullet repeated verbatim within a slice is kept once.
 */
export function sliceModuleFacts(text: string): ModuleFactSlices {
  const slices = perSlice(() => "");
  const lines = text.split("\n");
  if (!lines.some((line) => headingOf(line) !== null)) {
    slices.summary = text.trim();
    return slices;
  }
  const parts = perSlice<string[]>(() => []);
  let heading: string | null = null;
  let body: string[] = [];
  // Bullets already emitted into each slice — a model caught in a repetition
  // loop repeats the same bullet hundreds of times until the output cap stops
  // it (onyourleft's truncated modules: 453 RULES bullets, 32 distinct).
  const seen = perSlice(() => new Set<string>());
  const flush = (): void => {
    if (heading !== null) {
      const targets = HEADING_SLICES[heading];
      body = body.filter((line) => {
        if (!BULLET_LINE.test(line)) return true;
        const key = line.trim();
        if (targets.every((slice) => seen[slice].has(key))) return false;
        for (const slice of targets) seen[slice].add(key);
        return true;
      });
    }
    const content = body.join("\n").trim();
    if (heading === null) {
      if (content) parts.summary.push(content);
    } else if (content && !EMPTY_BODY.test(content)) {
      for (const slice of HEADING_SLICES[heading]) parts[slice].push(`${heading}\n${content}`);
    }
    body = [];
  };
  for (const line of lines) {
    const next = headingOf(line);
    if (next !== null) {
      flush();
      heading = next.token;
      if (next.inline !== null) body.push(next.inline);
    } else {
      body.push(line);
    }
  }
  flush();
  for (const slice of FACT_SLICES) slices[slice] = parts[slice].join("\n\n");
  return slices;
}

/** Count of bullet / numbered-list items in a slice — the relevance signal. */
export function countFactBullets(text: string): number {
  return text.split("\n").filter((line) => BULLET_LINE.test(line)).length;
}

// ============================================================================
// Mined rules (#155)
// ============================================================================

/** Languages with a deterministic rule miner. */
export type MinedRuleLanguage = "java" | "ts" | "js" | "py" | "go" | "sas" | "sql" | "cs" | "kt";

/**
 * One deterministically mined rule, language-neutral. This is the shape
 * persisted in `docs_gen_fact_cache.minedRulesJson` and rendered into the Rules
 * section. `file` + `line` make it citable against the code.
 */
export interface PersistedMinedRule {
  language: MinedRuleLanguage;
  kind: string;
  expression: string;
  summary: string;
  file: string;
  line: number;
  context: string | null;
}

/** The fields every language's miner output has in common. */
interface AnyMinedRule {
  kind: string;
  expression: string;
  summary: string;
  filePath: string;
  line: number;
  context: string | null;
}

/** Normalise one miner's output into the persisted, language-neutral shape. */
export function toPersistedMinedRules(
  language: MinedRuleLanguage,
  rules: readonly AnyMinedRule[],
): PersistedMinedRule[] {
  return rules.map((r) => ({
    language,
    kind: r.kind,
    expression: r.expression,
    summary: r.summary,
    file: r.filePath,
    line: r.line,
    context: r.context,
  }));
}

const LANGUAGES: ReadonlySet<string> = new Set([
  "java",
  "ts",
  "js",
  "py",
  "go",
  "sas",
  "sql",
  "cs",
  "kt",
]);

function isPersistedMinedRule(value: unknown): value is PersistedMinedRule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.language === "string" &&
    LANGUAGES.has(r.language) &&
    typeof r.kind === "string" &&
    typeof r.expression === "string" &&
    typeof r.summary === "string" &&
    typeof r.file === "string" &&
    typeof r.line === "number" &&
    (r.context === null || typeof r.context === "string")
  );
}

/**
 * Read `minedRulesJson` back from a cache row. Returns `null` — "not usable,
 * re-mine" — for malformed JSON and for legacy rows written before #155, which
 * stored only Java rules in the Java miner's own shape (no `language`).
 */
export function parsePersistedMinedRules(
  json: string | null | undefined,
): PersistedMinedRule[] | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.every(isPersistedMinedRule) ? parsed : null;
}

/** Whitespace-collapsed, backtick-free, lower-cased text for duplicate matching. */
function normalizeForMatch(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Expressions shorter than this are too generic to call two rules the same
 * (`x > 0` appears inside many unrelated conditions).
 */
const MIN_DEDUP_EXPRESSION_CHARS = 10;

/**
 * #155 — remove LLM-described rule bullets that restate a mined rule, so a rule
 * is not listed twice in the Rules section input.
 *
 * A bullet is a duplicate when it quotes the mined rule's expression (after
 * normalising whitespace/backticks/case) or names its exact `file:line`. The
 * MINED entry is kept, not the bullet: it is the one that carries the
 * `file:line` a claim can be verified against. Headings and non-bullet lines are
 * never removed, and a slice with no mined rules is returned unchanged.
 *
 * Pass only the rules the inventory RENDERS ({@link minedRulesThatFit}), never
 * the uncapped list — see there for why.
 */
export function dedupeRulesAgainstMined(
  rulesSlice: string,
  mined: readonly PersistedMinedRule[],
): string {
  if (!rulesSlice || mined.length === 0) return rulesSlice;
  const expressions = mined
    .map((r) => normalizeForMatch(r.expression))
    .filter((e) => e.length >= MIN_DEDUP_EXPRESSION_CHARS);
  const locations = mined.map((r) => `${r.file}:${r.line}`.toLowerCase());
  return rulesSlice
    .split("\n")
    .filter((line) => {
      if (!BULLET_LINE.test(line)) return true;
      const norm = normalizeForMatch(line);
      if (expressions.some((e) => norm.includes(e))) return false;
      return !locations.some((loc) => norm.includes(loc));
    })
    .join("\n");
}

/**
 * Per-module char cap on the rendered mined-rule inventory (~25 rules). It
 * counts against the section's facts budget like any other slice, so it is kept
 * small enough that one rule-dense module cannot crowd the others out.
 */
export const MINED_RULES_ENTRY_CHAR_CAP = 4_000;

/** Heading the mined inventory is rendered under inside a module's facts entry. */
export const MINED_RULES_HEADING = "MINED_RULES";

/** One mined rule as a line of the rendered inventory. */
function minedRuleLine(r: PersistedMinedRule): string {
  const expr = r.expression.replace(/\s+/g, " ").trim().slice(0, 200);
  return `- [${r.language} ${r.kind}] \`${expr}\` — ${r.summary} (${r.file}:${r.line})`;
}

function minedInventoryHeader(total: number): string {
  return `${MINED_RULES_HEADING} (deterministically mined from source — ${total} rule(s); each cites file:line)`;
}

/**
 * The prefix of `rules` that {@link renderMinedRuleInventory} actually renders
 * within `maxChars`. A step that drops something "because the inventory covers
 * it" — {@link dedupeRulesAgainstMined} — must match against THIS list, not the
 * uncapped one: a rule past the cut is in no inventory line, so removing the LLM
 * bullet that restates it would lose the rule from the section entirely.
 */
export function minedRulesThatFit(
  rules: readonly PersistedMinedRule[],
  maxChars = MINED_RULES_ENTRY_CHAR_CAP,
): PersistedMinedRule[] {
  const fitted: PersistedMinedRule[] = [];
  let used = minedInventoryHeader(rules.length).length;
  for (const r of rules) {
    const len = minedRuleLine(r).length + 1;
    if (used + len > maxChars) break;
    fitted.push(r);
    used += len;
  }
  return fitted;
}

/**
 * Render a module's mined rules as a deterministic, citable inventory block for
 * the Rules section input. Each line carries `file:line` so a claim derived from
 * it resolves against code. Bounded by `maxChars` (the rendered rules are
 * exactly {@link minedRulesThatFit}); the number of rules that did not fit is
 * stated rather than silently dropped. Returns "" when there are none.
 */
export function renderMinedRuleInventory(
  rules: readonly PersistedMinedRule[],
  maxChars = MINED_RULES_ENTRY_CHAR_CAP,
): string {
  if (rules.length === 0) return "";
  const lines = minedRulesThatFit(rules, maxChars).map(minedRuleLine);
  const omitted = rules.length - lines.length;
  if (omitted > 0) lines.push(`- (${omitted} more mined rule(s) omitted to fit the budget)`);
  return [minedInventoryHeader(rules.length), ...lines].join("\n");
}

/** Characters one mined rule adds to a rendered inventory (its line plus newline). */
export function minedRuleLineChars(r: PersistedMinedRule): number {
  return minedRuleLine(r).length + 1;
}

/**
 * One page of a module's mined rules, rendered in full (no char cap): the
 * batched Rules section (#157) pages a module's inventory across batches so no
 * mined rule is ever dropped. `from` is the 0-based index of the page's first
 * rule in the module's whole inventory of `total` rules.
 */
export function renderMinedRulePage(
  rules: readonly PersistedMinedRule[],
  from: number,
  total: number,
): string {
  if (rules.length === 0) return "";
  const range =
    rules.length === total
      ? `${total} rule(s)`
      : `rules ${from + 1}–${from + rules.length} of ${total}`;
  return [
    `${MINED_RULES_HEADING} (deterministically mined from source — ${range}; each cites file:line)`,
    ...rules.map(minedRuleLine),
  ].join("\n");
}

/**
 * Split facts text into pages of at most `maxChars`, cutting only before a line
 * that starts a new item (a heading or a top-level bullet), so no fact is split
 * across pages. An item longer than `maxChars` becomes a page of its own, and
 * a page that starts inside a section repeats that section's heading.
 */
export function pageFactsText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text ? [text] : [];
  const pages: string[] = [];
  let current: string[] = [];
  let size = 0;
  // A page that starts mid-section repeats the section's heading, so its facts
  // still say what they are.
  let heading: string | null = null;
  for (const line of text.split("\n")) {
    const startsItem = !/^\s/.test(line);
    if (startsItem && current.length > 0 && size + line.length + 1 > maxChars) {
      pages.push(current.join("\n").trim());
      current = heading && headingOf(line) === null ? [`${heading} (continued)`] : [];
      size = current.join("\n").length;
    }
    if (headingOf(line) !== null) heading = line.trim();
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) pages.push(current.join("\n").trim());
  return pages.filter((p) => p.length > 0);
}
