/**
 * #1070 — the topic plan of a business-requirements document.
 *
 * Until now a document's length was settled AFTER it was written: each section
 * was cut at its tail to `DOCS_GEN_SECTION_MAX_CHARS`, then the longest
 * sections were cut again until the total fitted `DOCS_GEN_DOCUMENT_MAX_CHARS`
 * (`section-size.ts`). In #706 run 7 the four catalogue sections of the Miniflux
 * BRD each ran to their 60k cap and lost 53 topics to it, and the document cap
 * then took 34 more: 87 topics, every one of them at a section's tail, which is
 * where the parts written from the lowest-ranked modules land — and where any
 * topic lands when an earlier part overran.
 *
 * The plan settles what each part of the document is ASKED for before anything
 * is written, from what is known then — the modules each section will read and
 * the output each is estimated to produce — with no model call:
 *
 *   - the document budget is shared among the sections ({@link planDocument}):
 *     a section asking for less than an equal share keeps what it asks for, and
 *     the rest is divided among the others (max-min), so the sections' budgets
 *     and the unallocated remainder sum to the document budget exactly;
 *   - a catalogue section's budget is shared among its topics — one topic per
 *     module with content for that section, owned by that section alone — in
 *     proportion to their estimates, each with a floor ({@link MIN_TOPIC_CHARS});
 *   - when even the floors do not fit, the LOWEST-PRIORITY topics are dropped,
 *     here, and named in the plan, instead of whichever topics happened to be
 *     written last.
 *
 * THE INVARIANT. A planned budget is a TARGET: it is what a prompt asks for and
 * the order in which text is given up, never a limit of its own. Nothing a
 * model wrote is discarded because of a budget. The only limits that discard
 * text are the two the operator sets, exactly as without a plan — the section
 * cap when a section is written, the document cap when the document is
 * assembled — and what a plan changes is WHICH text they take:
 *
 *   - every part is kept whole until one of those caps is actually exceeded
 *     ({@link fitSectionToPlan}, {@link fitDocumentToPlan} return their input
 *     unchanged when it fits);
 *   - when one is, the sections the cut without a plan would leave whole
 *     stay whole (the shortest: #741), and the room that leaves is filled in
 *     plan order: every part of every other section, earlier or later, is
 *     offered room in proportion to its budget, paragraph by paragraph, until
 *     no part's next paragraph fits. Room one part or section does not use is
 *     therefore used by the others, and so is room the plan set aside for
 *     footnote definitions that turned out shorter (the fit measures the
 *     definitions; it reserves nothing);
 *   - the result is then compared with what the cap without a plan
 *     (`fitSectionToBudget`, `fitSectionsToDocumentBudget`) keeps of the same
 *     text, and the plan's is used only if it keeps AT LEAST as much — of
 *     kept text ({@link keptContentChars}) and of total length — and leaves no
 *     section bare that the other does not. Otherwise that cut is used. So a
 *     planned document never keeps less than an unplanned one would have kept
 *     of the same sections, and never stops short of its cap while it drops
 *     topics (#995). `document-plan.test.ts` holds this as a property over
 *     generated documents, for the document cap and for the section cap.
 *
 * WHAT THAT GUARANTEE IS, EXACTLY (#1119). Four limits on the sentence above:
 *
 *   - "The same sections" is the whole of the claim. What a plan asks for
 *     differs from what no plan asks for (a share per part; a module that
 *     cannot have even the floor is not read), so the text written differs
 *     too: whether a planned document is the better one is for a model run to
 *     say, not this module.
 *   - It is a guarantee on the DOCUMENT (and, at the section cap, on the one
 *     section being cut), not on each section of a document. A part is filled
 *     in proportion to its budget and nothing bounds how little a shortened
 *     section keeps, short of "not bare": in the #1113 review's seeded search
 *     with adversarial budgets (1,348 cut documents) a section that kept
 *     18,262 characters under the cut without a plan kept 65 under the plan,
 *     with the document total no smaller. There is no
 *     per-section floor. Whether there should be one is to be decided from
 *     run data: every fit reports, per section, what it kept, what the
 *     plan-ordered cut kept and what the cut without a plan would have kept
 *     ({@link PlanFitResult.kept}), and the synthesizer logs it on every
 *     planned run.
 *   - "Kept" counts every character of the section's text as it renders,
 *     HEADINGS AND RULES INCLUDED — everything but the closing note and a
 *     heading or rule left at the very end with nothing under it
 *     ({@link keptContentChars}). A plan cut keeps more topics, each with its
 *     `---` and its heading, so counted in paragraphs alone it can keep
 *     slightly less than the cut without a plan: 35 of the 1,348 documents
 *     of that search, by at most 212 characters (0.35%).
 *   - It compares with a cut that is ITSELF within the cap. Under a very small
 *     document cap (near `MIN_DOCUMENT_MAX_CHARS`, with every section present)
 *     the cut without a plan overruns the cap, because it never cuts a section
 *     below two notes' length. The plan-ordered cut is within the cap and is
 *     used with no comparison, so there the planned document is SHORTER than
 *     the unplanned one — which is over its limit (13 of the 1,348).
 *     {@link PlanFitResult.unplannedWithinCap} is false for such a fit.
 *
 * Pure: no I/O and no model calls.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";
import { compareCodeUnits } from "./canonical-facts.js";
import {
  fitSectionToBudget,
  fitSectionsToDocumentBudget,
  NOTE_RESERVE,
  omittedTopicsSentence,
  SHORTENED_NOTE_LEAD,
  units,
  type Measure,
} from "./section-size.js";

/** Registry key: `on` plans a business-requirements document; `off` (default) does not. */
export const TOPIC_PLAN_KEY = "DOCS_GEN_TOPIC_PLAN";

/**
 * Bumped when the allocation rule changes, so a section written under another
 * rule is not reused (the plan is part of each section's reuse inputs).
 */
export const TOPIC_PLAN_VERSION = 2;

/**
 * The least a planned topic is given: what a model that keeps to its plan
 * writes for one module's topic. A topic that cannot have this much is dropped
 * at planning time, lowest priority first, rather than asked for in a phrase.
 *
 * Measured (#1070, run 8 and the #1074 Haiku A/B, replayed offline from their
 * stored sections): Haiku 5.5 wrote Key Workflows and Data Model at 1.00 and
 * 1.02 of their planned budgets, 43,003 rendered characters over 100 topics
 * and 43,933 over 102 — about 430 a topic. Under the old floor of 150 the plan
 * dropped nothing in run 8 (102 topics in 43k per catalogue section, about 422
 * each), and every topic it lost was cut at a section's tail instead. On run
 * 8's inputs this floor drops two topics per catalogue section, by priority.
 */
export const MIN_TOPIC_CHARS = 430;

/**
 * What a section written in ONE call asks of the document budget: about 4,000
 * words. Its prompt asks for 1,500 to 3,000; across the eleven stored BRDs the
 * median Overview, Capabilities and Integrations sections rendered at 15k, 23k
 * and 21k characters.
 */
export const SINGLE_CALL_SECTION_CHARS = 24_000;

/**
 * How `DOCS_GEN_TOPIC_PLAN` reads. Only the documented `on` turns the plan on
 * (surrounding space and case aside); unset or `off` is off, and so is any
 * other value, which is returned as `unrecognised` for the caller to log.
 */
export function readTopicPlanSetting(config: ConfigService = getConfigService()): {
  enabled: boolean;
  unrecognised?: string;
} {
  const raw = config.get(TOPIC_PLAN_KEY);
  if (raw == null) return { enabled: false };
  const value = raw.trim().toLowerCase();
  if (value === "on") return { enabled: true };
  return value === "off" || value === ""
    ? { enabled: false }
    : { enabled: false, unrecognised: raw };
}

/** Whether the topic plan is on (default: off) for document types that have one. */
export function topicPlanEnabled(config: ConfigService = getConfigService()): boolean {
  return readTopicPlanSetting(config).enabled;
}

/** A topic before planning. */
export interface TopicCandidate {
  /** Unique in the document; a topic belongs to exactly one section. */
  id: string;
  /** What a reader is shown when the topic is listed. */
  title: string;
  /** Higher is planned first and dropped last. */
  priority: number;
  /** Characters the topic is estimated to need (unbounded). */
  estimatedChars: number;
}

/** What one section asks of the plan. */
export interface SectionDemand {
  sectionId: string;
  label: string;
  /**
   * `enumerative` — a catalogue written in parts, one topic per module.
   * `single` — written in one call: the section is its own single topic.
   */
  kind: "enumerative" | "single";
  /** The section's topics; ignored (one is made) for a `single` section. */
  topics: TopicCandidate[];
  /**
   * What a `single` section asks for (default {@link SINGLE_CALL_SECTION_CHARS}).
   * A catalogue section written in one call because batching is switched off
   * asks for the section cap, which is all that bounded it before.
   */
  askChars?: number;
  /**
   * #1175 — the part of a reader-layout document the section is in. Main
   * sections are planned first, within the plan's `mainBudgetChars`; the
   * appendix is planned in the rest. Absent everywhere = one part, as before.
   */
  part?: "main" | "appendix";
}

export interface PlannedTopic extends TopicCandidate {
  sectionId: string;
  budgetChars: number;
}

/** A topic the plan left out, with the section that would have owned it. */
export interface DroppedTopic extends TopicCandidate {
  sectionId: string;
}

export interface PlannedSection {
  sectionId: string;
  label: string;
  kind: "enumerative" | "single";
  /** What the section asked for, after the per-section cap. */
  demandChars: number;
  /** What it was given: the sum of its topics' budgets. */
  budgetChars: number;
  /** Planned topics, highest priority first. */
  topics: PlannedTopic[];
  /** Topics left out at planning time, highest priority first. */
  dropped: DroppedTopic[];
}

export interface DocumentPlan {
  version: typeof TOPIC_PLAN_VERSION;
  /** `DOCS_GEN_DOCUMENT_MAX_CHARS` less the room kept for footnote definitions. */
  budgetChars: number;
  sections: PlannedSection[];
  /** Budget no section asked for. `budgetChars` = the sections' budgets + this. */
  unallocatedChars: number;
  /**
   * #1175 — present on a reader-layout plan only: what the main part was
   * planned within. The appendix was planned in `budgetChars` less what the
   * main sections were given.
   */
  mainBudgetChars?: number;
}

/**
 * Highest priority first; ties by id (by code unit, so on every machine alike),
 * so the order never depends on input order.
 */
function byPriority<T extends TopicCandidate>(topics: readonly T[]): T[] {
  return [...topics].sort((a, b) => b.priority - a.priority || compareCodeUnits(a.id, b.id));
}

/**
 * Share `total` among `asks` max-min: every ask at or below the common level is
 * met in full and the others get the level. Integer shares; the total is never
 * exceeded.
 */
export function waterFill(asks: readonly number[], total: number): number[] {
  const order = asks.map((ask, i) => ({ ask: Math.max(0, Math.floor(ask)), i }));
  order.sort((a, b) => a.ask - b.ask || a.i - b.i);
  const out = asks.map(() => 0);
  let remaining = Math.max(0, Math.floor(total));
  for (let k = 0; k < order.length; k++) {
    const share = Math.floor(remaining / (order.length - k));
    const given = Math.min(order[k].ask, share);
    out[order[k].i] = given;
    remaining -= given;
  }
  return out;
}

/**
 * Share a section's `budget` among its topics. Every kept topic gets its floor
 * (its estimate when that is smaller); what is left is divided in proportion to
 * what each topic still needs, and no topic gets more than its estimate. When
 * the floors alone exceed the budget, the lowest-priority topics are dropped
 * until they fit. The kept budgets sum to at most `budget`, and to exactly
 * `budget` whenever the kept topics' estimates reach it.
 */
export function allocateTopicBudgets(
  topics: readonly TopicCandidate[],
  budget: number,
  minTopicChars: number = MIN_TOPIC_CHARS,
): { kept: Array<TopicCandidate & { budgetChars: number }>; dropped: TopicCandidate[] } {
  const ranked = byPriority(topics);
  const need = (t: TopicCandidate): number => Math.max(1, Math.floor(t.estimatedChars));
  const floorOf = (t: TopicCandidate): number => Math.min(need(t), Math.max(1, minTopicChars));
  const room = Math.max(0, Math.floor(budget));
  let keptCount = ranked.length;
  let floors = ranked.reduce((n, t) => n + floorOf(t), 0);
  while (keptCount > 0 && floors > room) {
    keptCount -= 1;
    floors -= floorOf(ranked[keptCount]);
  }
  const kept = ranked.slice(0, keptCount);
  const dropped = ranked.slice(keptCount);
  const spare = room - floors;
  const wants = kept.map((t) => need(t) - floorOf(t));
  const wanted = wants.reduce((n, w) => n + w, 0);
  const extra =
    wanted <= spare
      ? wants
      : // Largest remainders, so the shares are whole and sum to `spare`.
        largestRemainder(wants, spare);
  return {
    kept: kept.map((t, i) => ({ ...t, budgetChars: floorOf(t) + extra[i] })),
    dropped,
  };
}

/** `total` divided in proportion to `weights`, in whole units that sum to it. */
function largestRemainder(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((n, w) => n + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((n, x) => n + x, 0);
  const order = exact
    .map((x, i) => ({ frac: x - Math.floor(x), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && left > 0; k++, left--) out[order[k].i] += 1;
  return out;
}

/**
 * Plan a document: share `documentMaxChars - reservedChars` among the sections,
 * then each section's share among its topics.
 *
 * A topic id that a second section also submits stays with the first (a topic
 * has one owner); the caller derives ids from the owning section, so this only
 * guards against a mistake there.
 */
export function planDocument(input: {
  sections: readonly SectionDemand[];
  documentMaxChars: number;
  sectionMaxChars: number;
  /** Room set aside before planning (the footnote definitions). */
  reservedChars?: number;
  /**
   * #1175 — with sections marked `part: "main"`: what the main part is
   * planned within (never more than the document budget). The main sections
   * are planned first, in that budget alone; the others in what is left.
   */
  mainBudgetChars?: number;
  /** The least a kept topic is planned (default {@link MIN_TOPIC_CHARS}). */
  minTopicChars?: number;
}): DocumentPlan {
  const budgetChars = Math.max(
    0,
    Math.floor(input.documentMaxChars) - Math.max(0, Math.floor(input.reservedChars ?? 0)),
  );
  if (input.mainBudgetChars !== undefined && input.sections.some((s) => s.part === "main")) {
    return planInParts({ ...input, mainBudgetChars: input.mainBudgetChars }, budgetChars);
  }
  const cap = Math.max(0, Math.floor(input.sectionMaxChars));
  const owned = new Set<string>();
  const demands = input.sections.map((section) => {
    const topics: TopicCandidate[] =
      section.kind === "single"
        ? [
            {
              id: section.sectionId,
              title: section.label,
              priority: 0,
              estimatedChars: section.askChars ?? SINGLE_CALL_SECTION_CHARS,
            },
          ]
        : section.topics.filter((t) => !owned.has(t.id));
    for (const t of topics) owned.add(t.id);
    const asked = topics.reduce((n, t) => n + Math.max(1, Math.floor(t.estimatedChars)), 0);
    return { section, topics, demandChars: Math.min(cap, asked) };
  });
  const shares = waterFill(
    demands.map((d) => d.demandChars),
    budgetChars,
  );
  const planned: PlannedSection[] = demands.map((d, i) => {
    const { kept, dropped } = allocateTopicBudgets(d.topics, shares[i], input.minTopicChars);
    const sectionId = d.section.sectionId;
    return {
      sectionId,
      label: d.section.label,
      kind: d.section.kind,
      demandChars: d.demandChars,
      budgetChars: kept.reduce((n, t) => n + t.budgetChars, 0),
      topics: kept.map((t) => ({ ...t, sectionId })),
      dropped: dropped.map((t) => ({ ...t, sectionId })),
    };
  });
  return {
    version: TOPIC_PLAN_VERSION,
    budgetChars,
    sections: planned,
    unallocatedChars: budgetChars - planned.reduce((n, s) => n + s.budgetChars, 0),
  };
}

/**
 * #1175 — a reader-layout plan: the main sections planned within
 * `min(mainBudgetChars, budgetChars)`, the others within what the main
 * sections were not given. Each part is planned by {@link planDocument} itself,
 * so within a part every rule above holds; the sections come back in input
 * order. A topic id is unique within its part.
 */
function planInParts(
  input: {
    sections: readonly SectionDemand[];
    sectionMaxChars: number;
    mainBudgetChars: number;
    minTopicChars?: number;
  },
  budgetChars: number,
): DocumentPlan {
  const isMain = input.sections.map((s) => s.part === "main");
  const mainBudget = Math.min(budgetChars, Math.max(0, Math.floor(input.mainBudgetChars)));
  const main = planDocument({
    sections: input.sections.filter((_, i) => isMain[i]),
    documentMaxChars: mainBudget,
    sectionMaxChars: input.sectionMaxChars,
    minTopicChars: input.minTopicChars,
  });
  const mainGiven = main.sections.reduce((n, s) => n + s.budgetChars, 0);
  const appendix = planDocument({
    sections: input.sections.filter((_, i) => !isMain[i]),
    documentMaxChars: budgetChars - mainGiven,
    sectionMaxChars: input.sectionMaxChars,
    minTopicChars: input.minTopicChars,
  });
  let m = 0;
  let a = 0;
  const sections = isMain.map((main_) => (main_ ? main.sections[m++] : appendix.sections[a++]));
  return {
    version: TOPIC_PLAN_VERSION,
    budgetChars,
    sections,
    unallocatedChars: budgetChars - sections.reduce((n, s) => n + s.budgetChars, 0),
    mainBudgetChars: mainBudget,
  };
}

/** One line per section, for the log and for a reader of the plan. */
export function summarizeDocumentPlan(plan: DocumentPlan): Array<{
  sectionId: string;
  kind: string;
  demandChars: number;
  budgetChars: number;
  topics: number;
  dropped: number;
}> {
  return plan.sections.map((s) => ({
    sectionId: s.sectionId,
    kind: s.kind,
    demandChars: s.demandChars,
    budgetChars: s.budgetChars,
    topics: s.topics.length,
    dropped: s.dropped.length,
  }));
}

/** How a dropped topic is listed with the section's omissions. */
export function droppedTopicLabel(topic: Pick<TopicCandidate, "title">): string {
  return `${topic.title} (not planned)`;
}

// ---------------------------------------------------------------------------
// Fitting a written document in plan order
// ---------------------------------------------------------------------------

/**
 * Which part of a section each unit of its markdown belongs to (a unit is a
 * heading line or a paragraph, fence or table: `units` of `section-size.ts`),
 * and what each part was planned. A section's closing note is not a unit here.
 */
export interface SectionParts {
  /** Planned characters of each part. */
  budgets: number[];
  /** `partOf[i]` — the part unit `i` belongs to. */
  partOf: number[];
}

/** One section offered to a plan fit. */
export interface PlanFitSection {
  markdown: string;
  /** The section's planned characters: its weight when it is one part. */
  budgetChars: number;
  /** Its parts, for a section written in several; absent = one part. */
  parts?: SectionParts;
  /** Topics an earlier cap or the plan already left out of it. */
  alreadyOmitted?: readonly string[];
}

/** The cap a plan fit applies, for the note of a section it shortens. */
export interface PlanFitLimit {
  /**
   * The limit exceeded. `BRD_MAIN_SUMMARY` and `BRD_MAIN_PART` (#1175) are
   * the main part of a reader-layout BRD, which is not a setting of its own:
   * the first for a summary section whose detail is in the appendix, the
   * second for a section nothing in the appendix stands behind.
   */
  setting:
    | "DOCS_GEN_SECTION_MAX_CHARS"
    | "DOCS_GEN_DOCUMENT_MAX_CHARS"
    | "BRD_MAIN_SUMMARY"
    | "BRD_MAIN_PART";
  maxChars: number;
}

/**
 * `whole` — the section fitted and is unchanged. `plan` — cut in plan order.
 * `tail` — the cut without a plan kept more of this section, so that cut is used.
 */
export type SectionCutKind = "whole" | "plan" | "tail";

/**
 * #1119 — what one section kept under a fit, in {@link keptContentChars}: the
 * figures a per-section floor would be decided from. Numbers only.
 */
export interface SectionKept {
  /** In the section as this fit returns it. */
  chars: number;
  /** In the plan-ordered cut, whether or not that is the cut that was used. */
  planChars: number;
  /** In the cut without a plan of the same text. */
  unplannedChars: number;
}

export interface PlanFitResult {
  sections: string[];
  /** Sections that lost content to this fit. */
  trimmed: number;
  /** Per section, the topics left out, earlier omissions included. */
  omittedTopics: string[][];
  /** Per section, the parts of what was kept (absent where the input had none). */
  parts: Array<SectionParts | undefined>;
  /** Per section, how it was cut ({@link SectionCutKind}). */
  cuts: SectionCutKind[];
  /** The cut of the sections that were shortened; `whole` when none was. */
  mode: SectionCutKind;
  /** Characters kept, closing notes aside, as the fit measured them. */
  keptChars: number;
  /**
   * Per section, what it kept, against the plan-ordered cut and the cut
   * without a plan. All three are the section's own length when nothing was
   * cut.
   */
  kept: SectionKept[];
  /**
   * False when the cut without a plan overran the cap itself (a very small
   * cap): the plan-ordered cut then stands without being compared with it.
   */
  unplannedWithinCap: boolean;
}

/**
 * The closing note of a section a plan fit shortened. It names the one limit
 * that was exceeded, with that limit's own value.
 */
export function plannedOmissionNote(omitted: readonly string[], limit: PlanFitLimit): string {
  if (limit.setting === "BRD_MAIN_SUMMARY" || limit.setting === "BRD_MAIN_PART") {
    // Kept shorter than the generic note, so a tail cut's note is reworded.
    const where =
      limit.setting === "BRD_MAIN_SUMMARY"
        ? "The detail behind this section is in the appendix."
        : "What was left out is not elsewhere in this document; provenance lists it.";
    return `${SHORTENED_NOTE_LEAD} The main part of this document is limited to about ${Math.round(limit.maxChars / 1000)}k characters.${omittedTopicsSentence(omitted)} ${where}`;
  }
  const subject =
    limit.setting === "DOCS_GEN_SECTION_MAX_CHARS" ? "This section is" : "The document is";
  return `${SHORTENED_NOTE_LEAD} ${subject} limited to about ${Math.round(limit.maxChars / 1000)}k characters (${limit.setting}).${omittedTopicsSentence(omitted)} Narrow the document with path prefixes, or raise the limit, for the full detail.`;
}

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_TEXT = /^#{1,6}\s+(.+?)\s*#*\s*$/;
/** Times the room is offered again after a section finished whole and freed its note's room. */
const MAX_FILL_PASSES = 8;

/** `markdown` without its closing note, and the note (or null). */
export function splitClosingNote(markdown: string): { body: string; note: string | null } {
  const at = markdown.lastIndexOf(`\n\n${SHORTENED_NOTE_LEAD}`);
  if (at < 0 || markdown.indexOf("\n\n", at + 2) >= 0) return { body: markdown, note: null };
  return { body: markdown.slice(0, at), note: markdown.slice(at + 2) };
}

/**
 * What a fitted section KEPT, in characters: its text without the closing
 * note, and without a heading or a rule left at its end with nothing under it
 * (a tail cut can end on a rule; that is not content kept).
 *
 * Every other heading and rule IS counted: this is the length of the kept
 * text, not of its paragraphs. The comparison with the cut without a plan is
 * made in this measure (see "what that guarantee is, exactly" in the module
 * comment).
 */
export function keptContentChars(section: string, measure: Measure): number {
  const { body } = splitClosingNote(section);
  const all = units(body);
  let end = all.length;
  while (end > 0 && (all[end - 1].depth > 0 || THEMATIC_BREAK.test(all[end - 1].text))) end -= 1;
  if (end === all.length) return measure(body);
  return measure(
    all
      .slice(0, end)
      .map((u) => u.text)
      .join("\n\n"),
  );
}

interface FitUnit {
  text: string;
  /** Heading depth; 0 for content and for a thematic break. */
  depth: number;
  structural: boolean;
  cost: number;
  /** The headings (and breaks) that must be present for a content unit to be. */
  heads: number[];
  part: number;
}

interface FitSectionState {
  input: PlanFitSection;
  units: FitUnit[];
  note: string | null;
  /** Units present in the result. */
  kept: boolean[];
  /** Per heading or break, the kept content units that need it. */
  refs: number[];
  contentTotal: number;
  contentKept: number;
  /** Room held for the closing note while the section is not whole. */
  reserve: number;
  hasParts: boolean;
}

interface Candidate {
  section: number;
  unit: number;
  /** The part's key in `next`. */
  part: string;
  /** Position of the unit among its part's content units. */
  position: number;
  /** Characters of the part kept before this unit, over the part's budget. */
  level: number;
}

function prepareSection(input: PlanFitSection, measure: Measure): FitSectionState {
  const { body, note } = splitClosingNote(input.markdown);
  const raw = units(body);
  const parts = input.parts;
  const hasParts =
    parts !== undefined &&
    parts.partOf.length === raw.length &&
    parts.partOf.every((p) => Number.isInteger(p) && p >= 0 && p < parts.budgets.length);
  const list: FitUnit[] = [];
  const stack: Array<{ depth: number; chain: number[] }> = [];
  let breaks: number[] = [];
  raw.forEach((u, i) => {
    const isBreak = u.depth === 0 && THEMATIC_BREAK.test(u.text);
    const unit: FitUnit = {
      text: u.text,
      depth: u.depth,
      structural: u.depth > 0 || isBreak,
      cost: measure(u.text) + 2,
      heads: [],
      part: hasParts ? parts.partOf[i] : 0,
    };
    if (isBreak) breaks.push(i);
    else if (u.depth > 0) {
      while (stack.length > 0 && stack[stack.length - 1].depth >= u.depth) stack.pop();
      stack.push({ depth: u.depth, chain: [...breaks, i] });
      breaks = [];
    } else {
      unit.heads = [...stack.flatMap((h) => h.chain), ...breaks];
      breaks = [];
    }
    list.push(unit);
  });
  const kept = list.map(() => false);
  const refs = list.map(() => 0);
  // A section keeps its opening heading whatever happens.
  if (list.length > 0 && list[0].depth > 0) {
    kept[0] = true;
    refs[0] = 1;
  }
  return {
    input,
    units: list,
    note,
    kept,
    refs,
    contentTotal: list.filter((u) => !u.structural).length,
    contentKept: 0,
    reserve: Math.max(NOTE_RESERVE, note === null ? 0 : measure(note) + 2),
    hasParts,
  };
}

interface RenderedSection {
  markdown: string;
  body: string;
  omitted: string[];
  whole: boolean;
}

/** The section as kept so far, with the topics left out of it. */
function renderSection(state: FitSectionState, limit: PlanFitLimit): RenderedSection {
  const earlier = [...(state.input.alreadyOmitted ?? [])];
  if (state.contentKept === state.contentTotal) {
    const { body } = splitClosingNote(state.input.markdown);
    return { markdown: state.input.markdown, body, omitted: earlier, whole: true };
  }
  const lost = state.units.filter((u, i) => u.depth > 0 && !state.kept[i]);
  const level = lost.reduce((min, u) => Math.min(min, u.depth), 7);
  const omitted = [
    ...new Set([
      ...lost.filter((u) => u.depth === level).map((u) => HEADING_TEXT.exec(u.text)?.[1] ?? u.text),
      ...earlier,
    ]),
  ];
  const body = state.units
    .filter((_, i) => state.kept[i])
    .map((u) => u.text)
    .join("\n\n");
  return {
    markdown: `${body}\n\n${plannedOmissionNote(omitted, limit)}`,
    body,
    omitted,
    whole: false,
  };
}

/** Exchanges tried after the fill, and the most parts they are tried among. */
const MAX_EXCHANGES = 24;
const MAX_EXCHANGE_PARTS = 96;

/**
 * Cut `sections` to `maxChars` in plan order. Every part of every section is
 * filled together, each in proportion to its budget: the next unit kept is
 * always the one whose part has so far kept the least for its budget, and a
 * part whose next unit does not fit the room left is finished. A part keeps
 * only a leading run of its units, so what is cut is each part's own tail. A
 * heading is kept exactly when something under it is.
 *
 * Units are whole paragraphs, so the fill can stop with room no part's next
 * unit fits. It then looks for an exchange that uses more of it: one part
 * gives up its last unit so that another can keep a larger one.
 */
export function planOrderedFit(
  sections: readonly PlanFitSection[],
  maxChars: number,
  measure: Measure,
  limit: PlanFitLimit,
  /**
   * Sections to keep whole before anything else is filled: the ones the fit
   * without a plan does not shorten, so the plan shortens no section it would
   * have left alone (and writes no note it would not have).
   */
  wholeFirst: readonly boolean[] = [],
): {
  sections: string[];
  bodies: string[];
  omittedTopics: string[][];
  parts: Array<SectionParts | undefined>;
  trimmed: number;
} {
  const states = sections.map((section) => prepareSection(section, measure));
  const candidates: Candidate[] = [];
  /** Per part, its content units in order, and how many of them are kept. */
  const partUnits = new Map<string, Candidate[]>();
  const next = new Map<string, number>();
  let room = Math.max(0, Math.floor(maxChars));
  states.forEach((state, s) => {
    if (state.kept[0]) room -= state.units[0].cost;
    if (wholeFirst[s]) state.reserve = state.note === null ? 0 : measure(state.note) + 2;
    room -= state.reserve;
    const used = new Map<number, number>();
    state.units.forEach((unit, i) => {
      if (unit.structural) return;
      const budget = Math.max(
        1,
        Math.floor(
          state.hasParts ? (state.input.parts!.budgets[unit.part] ?? 1) : state.input.budgetChars,
        ),
      );
      const part = `${s}:${unit.part}`;
      const list = partUnits.get(part) ?? [];
      partUnits.set(part, list);
      next.set(part, 0);
      const chars = used.get(unit.part) ?? 0;
      const candidate = {
        section: s,
        unit: i,
        part,
        position: list.length,
        level: wholeFirst[s] ? -1 : chars / budget,
      };
      list.push(candidate);
      candidates.push(candidate);
      used.set(unit.part, chars + unit.cost);
    });
  });
  candidates.sort((a, b) => a.level - b.level || a.section - b.section || a.unit - b.unit);

  /** What keeping a unit would cost now: itself and the headings not yet present. */
  const costOf = (c: Candidate): number => {
    const state = states[c.section];
    const unit = state.units[c.unit];
    return unit.heads.reduce(
      (n, h) => n + (state.refs[h] === 0 ? state.units[h].cost : 0),
      unit.cost,
    );
  };
  const noteCost = (state: FitSectionState): number =>
    state.note === null ? 0 : measure(state.note) + 2;
  /** Units kept, in the order they were: the last is always the last of its part. */
  const added: Candidate[] = [];
  const keep = (c: Candidate): void => {
    const state = states[c.section];
    room -= costOf(c);
    for (const h of state.units[c.unit].heads) {
      state.refs[h] += 1;
      state.kept[h] = true;
    }
    state.kept[c.unit] = true;
    state.contentKept += 1;
    next.set(c.part, c.position + 1);
    added.push(c);
    // A section kept whole needs no new note: its room goes back.
    if (state.contentKept === state.contentTotal) room += state.reserve - noteCost(state);
  };
  /** Undo the keeping of a part's LAST kept unit. */
  const giveUp = (c: Candidate): void => {
    const state = states[c.section];
    if (state.contentKept === state.contentTotal) room -= state.reserve - noteCost(state);
    for (const h of state.units[c.unit].heads) {
      state.refs[h] -= 1;
      if (state.refs[h] === 0) state.kept[h] = false;
    }
    state.kept[c.unit] = false;
    state.contentKept -= 1;
    next.set(c.part, c.position);
    added.splice(added.lastIndexOf(c), 1);
    room += costOf(c);
  };
  const fill = (): void => {
    const closed = new Set<string>();
    for (let pass = 0; pass < MAX_FILL_PASSES; pass++) {
      let grew = false;
      for (const candidate of candidates) {
        if (closed.has(candidate.part) || next.get(candidate.part) !== candidate.position) continue;
        if (costOf(candidate) > room) {
          closed.add(candidate.part);
          continue;
        }
        keep(candidate);
        grew = true;
      }
      if (!grew) break;
      closed.clear();
    }
  };
  /** One part's last unit for another part's larger next one, while that gains. */
  const exchange = (): void => {
    const names = [...partUnits.keys()];
    if (names.length < 2 || names.length > MAX_EXCHANGE_PARTS) return;
    for (let k = 0; k < MAX_EXCHANGES; k++) {
      let best: { give: Candidate; take: Candidate; gain: number } | null = null;
      for (const from of names) {
        const kept = next.get(from)!;
        // Never a part's only unit, and nothing of a section kept whole first.
        if (kept < 2) continue;
        const give = partUnits.get(from)![kept - 1];
        if (wholeFirst[give.section]) continue;
        const state = states[give.section];
        const given = state.units[give.unit];
        // What giving it up frees: itself, the headings only it holds, less
        // the note a section that was whole would need again.
        const freed =
          given.heads.reduce(
            (n, h) => n + (state.refs[h] === 1 ? state.units[h].cost : 0),
            given.cost,
          ) - (state.contentKept === state.contentTotal ? state.reserve - noteCost(state) : 0);
        for (const to of names) {
          if (to === from) continue;
          const take = partUnits.get(to)![next.get(to)!];
          if (!take) continue;
          const other = states[take.section];
          const cost = other.units[take.unit].heads.reduce(
            (n, h) =>
              n +
              (other.refs[h] === 0 ||
              (other === state && other.refs[h] === 1 && given.heads.includes(h))
                ? other.units[h].cost
                : 0),
            other.units[take.unit].cost,
          );
          // Only an exchange that uses at least half the room left: a gain of
          // a few characters is not worth moving a part off its share.
          const gain = cost - freed;
          if (cost <= room + freed && gain * 2 >= room && gain > (best?.gain ?? 0)) {
            best = { give, take, gain };
          }
        }
      }
      if (!best) return;
      giveUp(best.give);
      keep(best.take);
      fill();
    }
  };
  fill();
  exchange();
  let rendered = states.map((state) => renderSection(state, limit));
  const total = (): number => rendered.reduce((n, r) => n + measure(r.markdown), 0);
  // The notes are now written, most of them shorter than the room held for
  // them: offer what is left once more, then take back whatever a note that
  // grew (a different level of headings listed) pushed over the cap.
  room = Math.floor(maxChars) - total();
  if (room > 0) {
    fill();
    exchange();
    rendered = states.map((state) => renderSection(state, limit));
  }
  let over = total() - maxChars;
  while (over > 0 && added.length > 0) {
    const last = added[added.length - 1];
    const before = measure(rendered[last.section].markdown);
    giveUp(last);
    rendered[last.section] = renderSection(states[last.section], limit);
    over += measure(rendered[last.section].markdown) - before;
  }
  return {
    sections: rendered.map((r) => r.markdown),
    bodies: rendered.map((r) => r.body),
    omittedTopics: rendered.map((r) => r.omitted),
    parts: states.map((state, s) =>
      !state.hasParts
        ? undefined
        : rendered[s].whole
          ? state.input.parts
          : {
              budgets: state.input.parts!.budgets,
              partOf: state.units.filter((_, i) => state.kept[i]).map((u) => u.part),
            },
    ),
    trimmed: rendered.filter((r) => !r.whole).length,
  };
}

/** The parts of the leading units a tail cut kept. */
function leadingParts(section: PlanFitSection, fitted: string): SectionParts | undefined {
  if (!section.parts) return undefined;
  if (fitted === section.markdown) return section.parts;
  const kept = units(splitClosingNote(fitted).body).length;
  return kept <= section.parts.partOf.length
    ? { budgets: section.parts.budgets, partOf: section.parts.partOf.slice(0, kept) }
    : undefined;
}

/** A tail-cut section with its note reworded to name the one limit exceeded. */
function renote(
  fitted: string,
  original: string,
  omitted: readonly string[],
  limit: PlanFitLimit,
): string {
  if (fitted === original) return fitted;
  const { body, note } = splitClosingNote(fitted);
  if (note === null) return fitted;
  const reworded = `${body}\n\n${plannedOmissionNote(omitted, limit)}`;
  return reworded.length <= fitted.length ? reworded : fitted;
}

/** Whether a fitted section is headings (and a note) only. */
function hasNoContent(section: string): boolean {
  return units(splitClosingNote(section).body).every((u) => u.depth > 0);
}

const sum = (lengths: readonly number[]): number => lengths.reduce((n, l) => n + l, 0);

/** One section after a fit: its text, and how it got there. */
interface SectionCut {
  markdown: string;
  omitted: string[];
  parts: SectionParts | undefined;
  /** Characters kept, the closing note aside. */
  kept: number;
  /** Characters the section counts for, note included. */
  length: number;
  cut: SectionCutKind;
  /** Kept by the plan-ordered cut and by the cut without a plan; absent = `kept`. */
  planKept?: number;
  unplannedKept?: number;
}

/**
 * The best cut of ONE section to `maxChars`: unchanged when it fits; otherwise
 * the plan-ordered cut, unless the tail cut (`fitSectionToBudget`, what a
 * document without a plan gets) keeps more of the section, or keeps something
 * where the plan-ordered cut keeps only headings — then the tail cut, with its
 * note reworded. So this never keeps less than the tail cut does.
 */
function cutSection(
  section: PlanFitSection,
  maxChars: number,
  measure: Measure,
  limit: PlanFitLimit,
): SectionCut {
  const tail = fitSectionToBudget(
    section.markdown,
    maxChars,
    section.alreadyOmitted ?? [],
    measure,
  );
  if (!tail.trimmed) {
    return {
      markdown: section.markdown,
      omitted: tail.omittedTopics,
      parts: section.parts,
      kept: keptContentChars(section.markdown, measure),
      length: measure(section.markdown),
      cut: "whole",
    };
  }
  const tailKept = keptContentChars(tail.markdown, measure);
  const tailMarkdown = renote(tail.markdown, section.markdown, tail.omittedTopics, limit);
  const tailLength = measure(tailMarkdown);
  const plan = planOrderedFit([section], maxChars, measure, limit);
  const planKept = measure(plan.bodies[0]);
  const planLength = measure(plan.sections[0]);
  const compared = { planKept, unplannedKept: tailKept };
  if (
    plan.trimmed > 0 &&
    planLength <= maxChars &&
    planKept >= tailKept &&
    planLength >= tailLength &&
    (!hasNoContent(plan.bodies[0]) || hasNoContent(tail.markdown))
  ) {
    return {
      markdown: plan.sections[0],
      omitted: plan.omittedTopics[0],
      parts: plan.parts[0],
      kept: planKept,
      length: planLength,
      cut: "plan",
      ...compared,
    };
  }
  return {
    markdown: tailMarkdown,
    omitted: tail.omittedTopics,
    parts: leadingParts(section, tail.markdown),
    kept: tailKept,
    length: tailLength,
    cut: "tail",
    ...compared,
  };
}

function resultOf(cuts: readonly SectionCut[], unplannedWithinCap = true): PlanFitResult {
  const shortened = cuts.filter((c) => c.cut !== "whole");
  return {
    kept: cuts.map((c) => ({
      chars: c.kept,
      planChars: c.planKept ?? c.kept,
      unplannedChars: c.unplannedKept ?? c.kept,
    })),
    unplannedWithinCap,
    sections: cuts.map((c) => c.markdown),
    trimmed: shortened.length,
    omittedTopics: cuts.map((c) => c.omitted),
    parts: cuts.map((c) => c.parts),
    cuts: cuts.map((c) => c.cut),
    mode: shortened.length === 0 ? "whole" : shortened[0].cut,
    keptChars: sum(cuts.map((c) => c.kept)),
  };
}

/**
 * Hold ONE written section to the section cap, in plan order. Unchanged when it
 * fits. See the module comment for the invariant.
 */
export function fitSectionToPlan(
  section: PlanFitSection,
  maxChars: number,
  measure: Measure = (markdown) => markdown.length,
): PlanFitResult {
  return resultOf([
    cutSection(section, maxChars, measure, { setting: "DOCS_GEN_SECTION_MAX_CHARS", maxChars }),
  ]);
}

/**
 * Hold a written document to the document cap, in plan order: `maxChars` is
 * the cap less the footnote definitions the sections' citations will need,
 * measured, and `documentMaxChars` the cap itself, for the notes. Unchanged
 * when it fits. See the module comment for the invariant.
 *
 * The sections the fit without a plan leaves whole (the shortest: #741) are
 * kept whole here too. The room that leaves is filled in plan order by every
 * part of the other sections together ({@link planOrderedFit}).
 */
export function fitDocumentToPlan(
  sections: readonly PlanFitSection[],
  maxChars: number,
  measure: Measure = (markdown) => markdown.length,
  documentMaxChars: number = maxChars,
  /** #1175 — the limit a closing note names; the document cap unless given. */
  setting: Exclude<
    PlanFitLimit["setting"],
    "DOCS_GEN_SECTION_MAX_CHARS"
  > = "DOCS_GEN_DOCUMENT_MAX_CHARS",
): PlanFitResult {
  const limit: PlanFitLimit = {
    setting,
    maxChars: documentMaxChars,
  };
  const tail = fitSectionsToDocumentBudget(
    sections.map((section) => section.markdown),
    maxChars,
    sections.map((section) => section.alreadyOmitted ?? []),
    measure,
  );
  const whole = (section: PlanFitSection, omitted: string[]): SectionCut => ({
    markdown: section.markdown,
    omitted,
    parts: section.parts,
    kept: keptContentChars(section.markdown, measure),
    length: measure(section.markdown),
    cut: "whole",
  });
  // Nothing is cut from a document that fits. (Not `tail.trimmed === 0`: under
  // a very small cap that fit leaves a section whole and the document over.)
  if (sum(sections.map((section) => measure(section.markdown))) <= maxChars) {
    return resultOf(sections.map((section, i) => whole(section, tail.omittedTopics[i])));
  }
  // The cut without a plan as it would be returned: its notes reworded.
  const tailSections = tail.sections.map((fitted, i) =>
    renote(fitted, sections[i].markdown, tail.omittedTopics[i], limit),
  );
  const tailLengths = tailSections.map((section) => measure(section));
  const tailWithin = sum(tailLengths) <= maxChars;
  // First the whole document in plan order: every part of every section
  // filled together. It stands when it keeps at least what the fit without a
  // plan keeps of the document and leaves no section bare that the other
  // does not. (When that fit overruns a very small cap — it never cuts a
  // section below two notes' length — the cap is the limit and this stands
  // WITHOUT that comparison: the planned document is then the shorter of the
  // two, because the other is over its cap. `unplannedWithinCap` says so.)
  const plan = planOrderedFit(
    sections,
    maxChars,
    measure,
    limit,
    tailWithin ? sections.map((section, i) => tail.sections[i] === section.markdown) : [],
  );
  const planKept = plan.sections.map((section) => keptContentChars(section, measure));
  const tailKept = tail.sections.map((section) => keptContentChars(section, measure));
  const planLength = sum(plan.sections.map((section) => measure(section)));
  // #1119 — what each section kept under either cut, whichever one is used.
  const compared = (i: number): Pick<SectionCut, "planKept" | "unplannedKept"> => ({
    planKept: planKept[i],
    unplannedKept: tailKept[i],
  });
  if (
    planLength <= maxChars &&
    (!tailWithin ||
      (sum(planKept) >= sum(tailKept) &&
        planLength >= sum(tailLengths) &&
        plan.bodies.every((body, i) => !hasNoContent(body) || hasNoContent(tail.sections[i]))))
  ) {
    return resultOf(
      plan.sections.map((markdown, i) =>
        markdown === sections[i].markdown
          ? { ...whole(sections[i], plan.omittedTopics[i]), ...compared(i) }
          : {
              markdown,
              omitted: plan.omittedTopics[i],
              parts: plan.parts[i],
              kept: planKept[i],
              length: measure(markdown),
              cut: "plan" as const,
              ...compared(i),
            },
      ),
      tailWithin,
    );
  }
  // Otherwise the cut without a plan, which is what keeps more of this text.
  return resultOf(
    sections.map((section, i) => {
      if (tail.sections[i] === section.markdown) {
        return { ...whole(section, tail.omittedTopics[i]), ...compared(i) };
      }
      return {
        markdown: tailSections[i],
        omitted: tail.omittedTopics[i],
        parts: leadingParts(section, tail.sections[i]),
        kept: tailKept[i],
        length: tailLengths[i],
        cut: "tail" as const,
        ...compared(i),
      };
    }),
    tailWithin,
  );
}

/** {@link SectionParts}' `partOf` as runs of `[part, units]`, for a stored section. */
export function encodePartRuns(partOf: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const part of partOf) {
    const last = runs[runs.length - 1];
    if (last && last[0] === part) last[1] += 1;
    else runs.push([part, 1]);
  }
  return runs;
}

/** The inverse of {@link encodePartRuns}. */
export function decodePartRuns(runs: ReadonlyArray<readonly [number, number]>): number[] {
  return runs.flatMap(([part, count]) => Array.from({ length: Math.max(0, count) }, () => part));
}
