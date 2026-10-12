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
 * state: those whose name is mentioned in at least two places in the module
 * facts the sections are written from. Each has ONE owning section. A section
 * is given the facts its own input mentions, told to state a value only as
 * given and to leave the derivation to the owner, and cites a fact by its id
 * like any other source — so the fact-check judge reads the canonical value as
 * evidence for the claim, and the footnote shows the reader the source line.
 *
 * Pure: no I/O and no model calls.
 */
import { createHash } from "node:crypto";
import type { ExtractedFormula } from "../code-graph/formula-extractor.js";
import { FACT_SLICES, sliceModuleFacts, type PersistedMinedRule } from "./fact-slices.js";
import type { GroundingContext, GroundingSource } from "./grounding/grounding-context.js";
import { repositoryPathIdentity, type RepositoryIdentity } from "./repository-identity.js";

/** Bumped when what is on the sheet, or how it is worded to a section, changes. */
export const FACT_SHEET_VERSION = 1;

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
  /** The words whose presence in a text means the text is about this fact. */
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
/** An arithmetic operator between two operands (not the `*` of a `[]*T` type). */
const ARITHMETIC = /[\w)]\s*[*/%+-]\s*[\w(]/;
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

function clip(value: string): string {
  const flat = stripComment(value).replace(/\s+/g, " ").trim();
  return flat.length > FACT_VALUE_MAX_CHARS ? `${flat.slice(0, FACT_VALUE_MAX_CHARS - 1)}…` : flat;
}

/** What kind of fact a `name = value` is, or null when it is not one worth a line. */
export function classifyFactValue(
  value: string,
  source: "constant" | "arithmetic",
): CanonicalFactKind | null {
  const v = stripComment(value);
  if (v.length === 0 || v.length > 400) return null;
  if (NUMBER_LITERAL.test(v) || SCALED_NUMBER.test(v)) return "constant";
  if (source === "constant") return STRING_LITERAL.test(v) && v.length > 2 ? "enumeration" : null;
  // A computation: operators between operands, at least one number or two
  // names — and no string in it, which is a path, a message or a query.
  if (HAS_QUOTE.test(v) || ALLOCATION.test(v) || !ARITHMETIC.test(v)) return null;
  const names = new Set(v.match(IDENTIFIER) ?? []);
  return HAS_DIGIT.test(v) || names.size >= 2 ? "formula" : null;
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
      name: match[1],
      kind,
      value: clip(match[2]),
      file: rule.file,
      line: rule.line,
      terms: isDistinctiveName(match[1]) ? [match[1]] : [],
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
      name: fn ? `${fn}.${f.name}` : f.name,
      kind,
      value: clip(raw),
      file: f.filePath,
      line: f.startLine,
      terms: [fn, f.name].filter((t): t is string => t != null && isDistinctiveName(t)),
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
 * the names that have two values in the source, kept when mentioned in at
 * least two (module, slice) places of the module facts, ranked by how many.
 */
export function buildFactSheet(
  modules: readonly FactSheetModule[],
  options: { maxFacts?: number } = {},
): FactSheet {
  const maxFacts = Math.max(0, options.maxFacts ?? FACT_SHEET_MAX);
  const byName = new Map<string, Candidate[]>();
  let candidates = 0;
  for (const m of modules) {
    for (const c of candidatesOf(m)) {
      const same = byName.get(c.name) ?? [];
      // One source line can be read by two extractors: count it once.
      if (same.some((o) => o.file === c.file && o.line === c.line && o.value === c.value)) continue;
      candidates += 1;
      same.push(c);
      byName.set(c.name, same);
    }
  }
  // The places a term can be mentioned: each topic slice of each module.
  const places: Array<Set<string>> = [];
  for (const m of modules) {
    const slices = sliceModuleFacts(m.facts);
    for (const slice of FACT_SLICES) {
      if (slices[slice]) places.push(identifiersOf(slices[slice]));
    }
  }
  let ambiguous = 0;
  let notShared = 0;
  const shared: CanonicalFact[] = [];
  for (const [, group] of byName) {
    if (new Set(group.map((c) => c.value)).size > 1) {
      ambiguous += group.length;
      continue;
    }
    const c = group[0];
    const mentions =
      c.terms.length === 0
        ? 0
        : places.reduce((n, place) => n + (c.terms.some((t) => place.has(t)) ? 1 : 0), 0);
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
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
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
  return sheet.facts.filter((f) => f.terms.some((t) => words.has(t)));
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
 * {@link FACT_SHEET_MAX_PER_CALL} are listed; the closing line counts the rest.
 * Empty when there is none, so a prompt without a sheet is unchanged.
 */
export function renderCanonicalFactsBlock(
  facts: readonly CanonicalFact[],
  section: { id: string; label: string },
  ownerLabel: (sectionId: string) => string,
  limit = FACT_SHEET_MAX_PER_CALL,
): string {
  if (facts.length === 0) return "";
  const listed = facts.slice(0, Math.max(0, limit));
  const more = facts.length - listed.length;
  return [
    "=== CANONICAL FACTS (read directly from the source code; every section is given the same values) ===",
    "Each line is: [citation id] name = value | source line | owning section.",
    "- State one of these values ONLY as it is given here. If your other material disagrees with a line, the line is right.",
    `- Cite the fact where you state it by writing its id in square brackets, e.g. [${canonicalSourceId(listed[0])}].`,
    `- A fact owned by THIS section ("${section.label}"): state it once, completely.`,
    "- A fact owned by ANOTHER section: mention it in at most one sentence and name the owning section. Do not re-derive it, restate its formula or redefine its variables.",
    "",
    ...listed.map(
      (f) =>
        `[${canonicalSourceId(f)}] ${factStatement(f)} | ${f.file}:${f.line} | owner: ${
          f.ownerSectionId === section.id ? "THIS section" : ownerLabel(f.ownerSectionId)
        }`,
    ),
    ...(more > 0
      ? [`(${more} more canonical fact${more === 1 ? " is" : "s are"} not listed for this call.)`]
      : []),
    "=== END CANONICAL FACTS ===",
  ].join("\n");
}

/** What a section's reuse inputs record of the facts it was given. */
export function factSheetFingerprint(facts: readonly CanonicalFact[]): string[] {
  return facts.map((f) => `${f.id}|${f.name}|${f.value}|${f.file}:${f.line}|${f.ownerSectionId}`);
}
