/**
 * #1070 — the canonical facts sheet of a business-requirements document.
 *
 * No section owned a fact, so each section that touched one wrote it out again
 * from its own slice of the module facts. In #706 run 7 the Miniflux feed
 * scheduler's interval formula was written in four sections; one defined
 * `weeklyCount` as refreshes per week (it counts entries), another sent a feed
 * with no history to the round-robin policy (it waits the maximum interval).
 *
 * A FACT here is a named constant, limit, enumeration value or formula that the
 * deterministic extractors read from a line of source: `MaxEntryLimit = 1000`
 * at `internal/model/entry.go:20`, or `ScheduleNextCheck.interval = (7 * 24 *
 * time.Hour) / …` at `internal/model/feed.go:131`. It is extracted ONCE, with
 * no model call, and it needs no judge of its own: the value IS the source
 * line. What an extractor does not read — a default held in a struct literal,
 * a rule that exists only as control flow — is not on the sheet.
 *
 * The sheet holds the facts more than one part of the document is likely to
 * state: those mentioned BY THEIR OWN NAME in at least two places in the module
 * facts the sections are written from ({@link mentionTerms}). What qualifies
 * as a fact at all is narrow on purpose ({@link classifyFactValue}): a sum or a
 * difference alone is an offset, a counter or a concatenation, not a business
 * formula, and `0`, `1` or a one-character string is a flag, not a limit. On
 * the #706 run-7 inputs the first version of these rules listed 30 formulas, of
 * which about 18 were incidental arithmetic such as `len(e.args) + 1`.
 *
 * Each fact has ONE owning section, by kind — when that section is written in
 * this document and reads the fact's module; otherwise the fact has no owner
 * (the caller decides: {@link FactOwnerLookup}). A section is given the facts
 * its own input mentions AND every fact it owns, told to state a value only as
 * given and to leave an owned fact's derivation to its owner, and cites a fact
 * by its id like any other source — so the fact-check judge reads the
 * canonical value as evidence for the claim, and the footnote shows the reader
 * the source line.
 *
 * A fact's name, value and source path are text from an ingested repository.
 * Before they are placed in a prompt block that calls itself authoritative they
 * are made unable to close that block or forge one of its lines
 * ({@link neutralize}); the value and the path are also put on one line.
 *
 * The sheet's order is part of every prompt that lists it, and so of the
 * sections' reuse hashes: it is settled by code-unit comparison
 * ({@link compareCodeUnits}), never by the locale data of the Node build.
 *
 * Pure: no I/O and no model calls.
 */
import { createHash } from "node:crypto";
import type { ExtractedFormula } from "../code-graph/formula-extractor.js";
import { FACT_SLICES, sliceModuleFacts, type PersistedMinedRule } from "./fact-slices.js";
import type { GroundingContext, GroundingSource } from "./grounding/grounding-context.js";
import { repositoryPathIdentity, type RepositoryIdentity } from "./repository-identity.js";

/** Bumped when what is on the sheet, or how it is worded to a section, changes. */
export const FACT_SHEET_VERSION = 2;

/** Most facts one document's sheet holds; the rest are counted, not listed. */
export const FACT_SHEET_MAX = 60;

/** Most facts one section call is given; the block says how many more there are. */
export const FACT_SHEET_MAX_PER_CALL = 40;

/** Longest value a fact carries; a longer one is cut and marked with an ellipsis. */
export const FACT_VALUE_MAX_CHARS = 200;

/** Source ids of canonical facts: `facts:canon:<fact id>`. */
export const CANONICAL_SOURCE_PREFIX = "facts:canon:";

export type CanonicalFactKind = "formula" | "constant" | "enumeration";

/** The section that owns each kind of fact (business-requirements section ids). */
export const FACT_OWNER_SECTION: Readonly<Record<CanonicalFactKind, string>> = {
  formula: "formulas",
  constant: "rules",
  enumeration: "data-model",
};

export interface CanonicalFact {
  /** Stable for a (repository, file, name): a changed value keeps its id. */
  id: string;
  /** `MaxEntryLimit`, or `ScheduleNextCheck.interval` for a value computed in a function. */
  name: string;
  kind: CanonicalFactKind;
  /** The value or expression, as written in the source. */
  value: string;
  file: string;
  line: number;
  /** The words that must ALL be in a text for the text to mention this fact. */
  terms: string[];
  ownerSectionId: string;
  modulePath: string;
  repository?: RepositoryIdentity;
  /** Distinct (module, topic slice) places of the module facts that mention it. */
  mentions: number;
}

export interface FactSheet {
  version: typeof FACT_SHEET_VERSION;
  facts: CanonicalFact[];
  /** Named, quantitative candidates the extractors produced. */
  candidates: number;
  /** Left off: one name with different values in the source. */
  ambiguous: number;
  /** Left off: mentioned in fewer than two places, so no section would restate it. */
  notShared: number;
  /** Left off: shared, but past {@link FACT_SHEET_MAX}. */
  overCap: number;
}

/** The module fields the sheet reads (a `ModuleFacts` satisfies it). */
export interface FactSheetModule {
  repository?: RepositoryIdentity;
  modulePath: string;
  moduleName: string;
  facts: string;
  formulas: readonly ExtractedFormula[];
  minedRules?: readonly PersistedMinedRule[];
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
const NUMBER_LITERAL = /^[-+]?\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
/** A number, optionally scaled by named units or other numbers: `20 * time.Second`, `4096 * 4096`. */
const SCALED_NUMBER = /^[-+]?\d[\d_.]*(?:\s*(?:\*|<<)\s*[A-Za-z0-9_.]+){0,3}$/;
const STRING_LITERAL = /^(?:"[^"\\$]*"|'[^'\\$]*')$/;
/**
 * A multiplication, division or remainder between two operands (not the `*`
 * of a `[]*T` type). A sum or difference alone does not make a formula.
 */
const MULTIPLICATIVE = /[\w)]\s*[*/%]\s*[\w(]/;
/** A trailing line comment, which is not part of the value. */
const LINE_COMMENT = /\s+(?:\/\/|#)\s.*$/;
/** Sizing a container is not a business computation. */
const ALLOCATION = /^(?:make|append|new)\s*\(/;
const HAS_DIGIT = /\d/;
const HAS_QUOTE = /["'`]/;

/**
 * A name specific enough that finding it in a text means the text is about the
 * fact: a compound identifier (`weeklyCount`, `MAX_ENTRY_LIMIT`), not a word a
 * dozen functions use (`interval`, `total`, `err`).
 */
export function isDistinctiveName(name: string): boolean {
  if (name.length < 6) return false;
  return /[a-z0-9][A-Z]/.test(name) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(name);
}

/** `value` on one line of at most 400 characters, without a trailing line comment. */
function stripComment(value: string): string {
  const line = value.trim();
  return line.length > 400 ? line : line.replace(LINE_COMMENT, "").trim();
}

/** The character between the fields of a fact line. A field never holds it. */
export const FACT_FIELD_DELIMITER = "|";
/** What a `|` in a field is written as: a broken bar, which is not the delimiter. */
const FACT_FIELD_BAR = "¦";

/** Characters that take no room on the line: zero-width space, joiners, word joiner, BOM. */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200d) || code === 0x2060 || code === 0xfeff || code === 0x180e
  );
}

/**
 * Characters that end or break a line and are not all in JavaScript's `\s`:
 * the C0 and C1 controls (U+0085 NEXT LINE and the U+001C to U+001F
 * separators among them), DELETE, and the Unicode line and paragraph
 * separators.
 */
function isLineOrControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/**
 * `text` with every zero-width character removed and every control or line
 * separator made a space, so nothing in it can end the line it is written on
 * or hide inside one of the block's markers. One pass; ordinary text is
 * returned as it is.
 */
function printable(text: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const zeroWidth = isZeroWidth(code);
    if (!zeroWidth && !isLineOrControl(code)) continue;
    out += zeroWidth ? text.slice(from, i) : `${text.slice(from, i)} `;
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * Text from the source made unable to break out of the facts block: a run of
 * three or more `=` (the block's delimiters) is spaced out, the opening of a
 * citation id (`[facts:`) loses its bracket, and EVERY `|` (the block's field
 * delimiter) becomes a broken bar, wherever it is. A control or line
 * separator becomes a space and a zero-width character is dropped
 * ({@link printable}). Everything else is kept as written.
 *
 * The bar is replaced at every position, not only between two spaces (#1119
 * review): the renderer puts a space on each side of its own delimiters, so a
 * bar at the start or the end of a field met that space and read as one more
 * field boundary (`100 | | owner: THIS section`). A neutralised field holds no
 * delimiter at all, so a fact line always has exactly two.
 */
export function neutralize(text: string): string {
  return printable(text)
    .replace(/={3,}/g, (run) => run.split("").join(" "))
    .replace(/\[(\s*facts:)/gi, "($1")
    .replaceAll(FACT_FIELD_DELIMITER, FACT_FIELD_BAR);
}

/** `text` on one line: {@link printable}, runs of white space as one space, trimmed. */
function oneLine(text: string): string {
  return printable(text).replace(/\s+/g, " ").trim();
}

/**
 * A source path as the sheet carries it: on one line and neutralised, like a
 * value. A path is repository text too (#1119): one holding a newline and the
 * block's end marker closed the block early, and put the newline in the
 * footnote that cites the fact.
 */
function sourcePath(file: string): string {
  return neutralize(oneLine(file));
}

/**
 * Order two strings by UTF-16 code unit: the same on every machine, which
 * `localeCompare` is not (it follows the ICU data Node was built with).
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clip(value: string): string {
  const flat = neutralize(oneLine(stripComment(value)));
  if (flat.length <= FACT_VALUE_MAX_CHARS) return flat;
  let end = FACT_VALUE_MAX_CHARS - 1;
  // Never end on the first half of a surrogate pair.
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${flat.slice(0, end)}…`;
}

/**
 * What kind of fact a `name = value` is, or null when it is not one worth a
 * line. The rules, in full:
 *
 *   - a number is a constant, unless it is a bare `0`, `1` or `-1` (a flag or
 *     an identity, not a limit); a number scaled by a unit (`20 * time.Second`)
 *     always is;
 *   - a string constant is an enumeration value when it is at least two
 *     characters long (`"a"` is a parameter letter);
 *   - a computed value is a formula only when it multiplies, divides or takes a
 *     remainder, holds a number or at least two names, and has no string or
 *     allocation in it. `len(args) + 1`, `version + 1`, `prefix + suffix` and
 *     `a - b` are not formulas.
 */
export function classifyFactValue(
  value: string,
  source: "constant" | "arithmetic",
): CanonicalFactKind | null {
  const v = stripComment(value);
  if (v.length === 0 || v.length > 400) return null;
  if (NUMBER_LITERAL.test(v)) {
    return Math.abs(Number(v.replace(/_/g, ""))) === 1 || Number(v.replace(/_/g, "")) === 0
      ? null
      : "constant";
  }
  if (SCALED_NUMBER.test(v)) return "constant";
  if (source === "constant") return STRING_LITERAL.test(v) && v.length > 3 ? "enumeration" : null;
  if (HAS_QUOTE.test(v) || ALLOCATION.test(v) || !MULTIPLICATIVE.test(v)) return null;
  const names = new Set(v.match(IDENTIFIER) ?? []);
  return HAS_DIGIT.test(v) || names.size >= 2 ? "formula" : null;
}

/**
 * The words that must all be in a text for it to mention a fact — its OWN
 * name: a constant's name; a formula's variable when that is distinctive
 * (`weeklyCount`), otherwise the variable together with its function
 * (`ScheduleNextCheck` and `interval`). Empty when the name is too general to
 * mean anything on its own. The enclosing function's name alone never counts:
 * that is how arithmetic incidental to a much-discussed function got listed.
 */
export function mentionTerms(name: string, fn: string | null = null): string[] {
  if (isDistinctiveName(name)) return [name];
  return fn && isDistinctiveName(fn) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? [fn, name] : [];
}

interface Candidate {
  name: string;
  kind: CanonicalFactKind;
  value: string;
  file: string;
  line: number;
  terms: string[];
  modulePath: string;
  repository?: RepositoryIdentity;
}

const MINED_CONSTANT = /^Constant `([^`]+)` = ([\s\S]+)$/;

/** The function a `file::function` symbol context names, or null. */
function functionOf(symbolContext: string | null): string | null {
  if (!symbolContext) return null;
  const at = symbolContext.lastIndexOf("::");
  const name = at >= 0 ? symbolContext.slice(at + 2) : "";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

function candidatesOf(m: FactSheetModule): Candidate[] {
  const out: Candidate[] = [];
  const base = { modulePath: m.modulePath, ...(m.repository ? { repository: m.repository } : {}) };
  for (const rule of m.minedRules ?? []) {
    if (rule.kind !== "const") continue;
    const match = MINED_CONSTANT.exec(rule.summary);
    if (!match) continue;
    const kind = classifyFactValue(match[2], "constant");
    if (!kind) continue;
    out.push({
      ...base,
      name: neutralize(match[1]),
      kind,
      value: clip(match[2]),
      file: sourcePath(rule.file),
      line: rule.line,
      terms: mentionTerms(match[1]),
    });
  }
  for (const f of m.formulas) {
    if (!f.name || (f.kind !== "constant" && f.kind !== "arithmetic")) continue;
    const raw = f.kind === "constant" ? (f.resolvedValue ?? f.expression) : f.expression;
    const kind = classifyFactValue(raw, f.kind);
    if (!kind) continue;
    const fn = kind === "formula" ? functionOf(f.symbolContext) : null;
    out.push({
      ...base,
      name: neutralize(fn ? `${fn}.${f.name}` : f.name),
      kind,
      value: clip(raw),
      file: sourcePath(f.filePath),
      line: f.startLine,
      terms: mentionTerms(f.name, fn),
    });
  }
  return out;
}

const KIND_ORDER: Readonly<Record<CanonicalFactKind, number>> = {
  formula: 0,
  constant: 1,
  enumeration: 2,
};

function factId(c: Candidate): string {
  const identity = repositoryPathIdentity(c.repository, c.file);
  return `cf-${createHash("sha256").update(`${identity}\n${c.name}`).digest("hex").slice(0, 10)}`;
}

/** The identifiers of `text`, for whole-word membership tests. */
export function identifiersOf(text: string): Set<string> {
  return new Set(text.match(IDENTIFIER) ?? []);
}

/**
 * Build the sheet: every named, quantitative value the extractors read, less
 * the names that have two values in the source, kept when mentioned by name in
 * at least two (module, slice) places of the module facts, ranked by how many.
 *
 * One pass over the module facts, whatever the number of candidates: each
 * place's identifiers are looked up in an index of the candidates' terms.
 */
export function buildFactSheet(
  modules: readonly FactSheetModule[],
  options: { maxFacts?: number } = {},
): FactSheet {
  const maxFacts = Math.max(0, options.maxFacts ?? FACT_SHEET_MAX);
  const byName = new Map<string, Candidate[]>();
  const read = new Set<string>();
  let candidates = 0;
  for (const m of modules) {
    for (const c of candidatesOf(m)) {
      // One source line can be read by two extractors: count it once.
      const key = `${c.name}\u0000${c.file}\u0000${c.line}\u0000${c.value}`;
      if (read.has(key)) continue;
      read.add(key);
      candidates += 1;
      const same = byName.get(c.name);
      if (same) same.push(c);
      else byName.set(c.name, [c]);
    }
  }
  let ambiguous = 0;
  let notShared = 0;
  const unique: Candidate[] = [];
  for (const [, group] of byName) {
    if (group.some((c) => c.value !== group[0].value)) ambiguous += group.length;
    else unique.push(group[0]);
  }
  // first term → second term (or "" when the fact has one) → places counted.
  const index = new Map<string, Map<string, { count: number }>>();
  const counterOf = new Map<Candidate, { count: number }>();
  for (const c of unique) {
    if (c.terms.length === 0) continue;
    const second = index.get(c.terms[0]) ?? new Map<string, { count: number }>();
    index.set(c.terms[0], second);
    const counter = second.get(c.terms[1] ?? "") ?? { count: 0 };
    second.set(c.terms[1] ?? "", counter);
    counterOf.set(c, counter);
  }
  // The places a fact can be mentioned: each topic slice of each module.
  for (const m of modules) {
    const slices = sliceModuleFacts(m.facts);
    for (const slice of FACT_SLICES) {
      if (!slices[slice]) continue;
      const words = identifiersOf(slices[slice]);
      for (const word of words) {
        const second = index.get(word);
        if (!second) continue;
        for (const [also, counter] of second) {
          if (also === "" || words.has(also)) counter.count += 1;
        }
      }
    }
  }
  const shared: CanonicalFact[] = [];
  for (const c of unique) {
    const mentions = counterOf.get(c)?.count ?? 0;
    if (mentions < 2) {
      notShared += 1;
      continue;
    }
    shared.push({
      id: factId(c),
      name: c.name,
      kind: c.kind,
      value: c.value,
      file: c.file,
      line: c.line,
      terms: c.terms,
      ownerSectionId: FACT_OWNER_SECTION[c.kind],
      modulePath: c.modulePath,
      ...(c.repository ? { repository: c.repository } : {}),
      mentions,
    });
  }
  shared.sort(
    (a, b) =>
      b.mentions - a.mentions ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      compareCodeUnits(a.name, b.name) ||
      compareCodeUnits(a.id, b.id),
  );
  return {
    version: FACT_SHEET_VERSION,
    facts: shared.slice(0, maxFacts),
    candidates,
    ambiguous,
    notShared,
    overCap: Math.max(0, shared.length - maxFacts),
  };
}

/** The sheet's facts that `text` mentions, in sheet order. */
export function factsMentionedIn(
  sheet: { facts: readonly CanonicalFact[] } | undefined,
  text: string,
): CanonicalFact[] {
  if (!sheet || sheet.facts.length === 0) return [];
  const words = identifiersOf(text);
  return sheet.facts.filter((f) => f.terms.length > 0 && f.terms.every((t) => words.has(t)));
}

/**
 * The section that owns a fact IN THIS DOCUMENT, or null when none can state
 * it: its owning section is not written, or does not read the fact's module.
 */
export type FactOwnerLookup = (fact: CanonicalFact) => { id: string; label: string } | null;

/**
 * The facts one section is given: those its input mentions and every fact it
 * owns, in sheet order.
 */
export function factsGivenTo(
  sheet: { facts: readonly CanonicalFact[] } | undefined,
  text: string,
  sectionId: string,
  ownerOf: FactOwnerLookup,
): CanonicalFact[] {
  if (!sheet || sheet.facts.length === 0) return [];
  const mentioned = new Set(factsMentionedIn(sheet, text));
  return sheet.facts.filter((f) => mentioned.has(f) || ownerOf(f)?.id === sectionId);
}

/**
 * The facts one CALL lists, at most `limit`: the ones its section owns first,
 * so the owner is never the one left without a fact, then sheet order.
 */
export function factsListedFor(
  facts: readonly CanonicalFact[],
  sectionId: string,
  ownerOf: FactOwnerLookup,
  limit = FACT_SHEET_MAX_PER_CALL,
): CanonicalFact[] {
  const owned = facts.filter((f) => ownerOf(f)?.id === sectionId);
  const others = facts.filter((f) => ownerOf(f)?.id !== sectionId);
  return [...owned, ...others].slice(0, Math.max(0, limit));
}

export function canonicalSourceId(fact: Pick<CanonicalFact, "id">): string {
  return `${CANONICAL_SOURCE_PREFIX}${fact.id}`;
}

/** `name = value`, the way a fact is written everywhere. */
export function factStatement(fact: Pick<CanonicalFact, "name" | "value">): string {
  return `${fact.name} = ${fact.value}`;
}

/** A fact as a citable grounding source: what the judge reads as evidence. */
export function canonicalFactSource(fact: CanonicalFact): GroundingSource {
  return {
    sourceId: canonicalSourceId(fact),
    kind: "facts",
    label: `${fact.file}:${fact.line} — ${factStatement(fact)}`,
    text: `CANONICAL FACT (read from the source code at ${fact.file}:${fact.line}): ${factStatement(fact)}`,
    ...(fact.repository
      ? { repository: fact.repository, evidenceClass: "repository-source" as const }
      : {}),
  };
}

/**
 * `ctx` with the given facts as extra citable sources, after its own. The
 * context itself is not changed; without facts it is returned as it is.
 */
export function withCanonicalSources(
  ctx: GroundingContext | undefined,
  facts: readonly CanonicalFact[],
): GroundingContext | undefined {
  if (facts.length === 0) return ctx;
  const sources = [...(ctx?.sources ?? [])];
  const sourceIds = new Set(ctx?.sourceIds ?? []);
  for (const fact of facts) {
    const source = canonicalFactSource(fact);
    if (sourceIds.has(source.sourceId)) continue;
    sourceIds.add(source.sourceId);
    sources.push(source);
  }
  return { sources, sourceIds, isEmpty: sources.length === 0 };
}

/**
 * The prompt block that gives one call its canonical facts. At most
 * {@link FACT_SHEET_MAX_PER_CALL} are listed ({@link factsListedFor}); the
 * closing line counts the rest. Empty when there is none, so a prompt without
 * a sheet is unchanged.
 *
 * The block constrains what a section states; it does not ask for anything to
 * be stated. "Do not re-derive it" is said only of a fact another section of
 * this document really owns: a fact with no owner is marked so.
 */
export function renderCanonicalFactsBlock(
  facts: readonly CanonicalFact[],
  section: { id: string; label: string },
  ownerOf: FactOwnerLookup,
  limit = FACT_SHEET_MAX_PER_CALL,
): string {
  if (facts.length === 0) return "";
  const listed = factsListedFor(facts, section.id, ownerOf, limit);
  const more = facts.length - listed.length;
  const owners = listed.map((f) => ownerOf(f));
  return [
    "=== CANONICAL FACTS (read directly from the source code; every section is given the same values) ===",
    "Each line is: [citation id] name = value | source line | owning section.",
    "- You are not asked to state these facts. The rules below apply to the ones your section does state.",
    "- State one of these values ONLY as it is given here. If your other material disagrees with a line, the line is right.",
    `- Cite the fact where you state it by writing its id in square brackets, e.g. [${canonicalSourceId(listed[0])}].`,
    `- A fact owned by THIS section ("${section.label}"): if you state it, state it once and completely.`,
    "- A fact owned by ANOTHER section: mention it in at most one sentence and name the owning section. Do not re-derive it, restate its formula or redefine its variables.",
    ...(owners.some((owner) => owner === null)
      ? [
          "- A fact with NO owning section: no other section of this document states it. State it where it is relevant, once.",
        ]
      : []),
    "",
    ...listed.map(
      (f, i) =>
        `[${canonicalSourceId(f)}] ${factStatement(f)} | ${f.file}:${f.line} | owner: ${
          owners[i] === null
            ? "none"
            : owners[i].id === section.id
              ? "THIS section"
              : owners[i].label
        }`,
    ),
    ...(more > 0
      ? [`(${more} more canonical fact${more === 1 ? " is" : "s are"} not listed for this call.)`]
      : []),
    "=== END CANONICAL FACTS ===",
  ].join("\n");
}

/**
 * What a section's reuse inputs record of the facts it was given: each one's
 * value, source line and the section that owns it in this document.
 */
export function factSheetFingerprint(
  facts: readonly CanonicalFact[],
  ownerOf: FactOwnerLookup,
): string[] {
  return facts.map(
    (f) => `${f.id}|${f.name}|${f.value}|${f.file}:${f.line}|${ownerOf(f)?.id ?? "-"}`,
  );
}
