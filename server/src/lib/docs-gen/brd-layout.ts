/**
 * #1175 — the reader layout of a business-requirements document generated
 * from code (full, repository or path scope; a requirements-scoped document is
 * built elsewhere, from stored rows, and is not affected): a
 * MAIN document a business reader can read through and sign off, followed by
 * an APPENDIX, in the same document, holding the module-by-module detail.
 *
 * Owner decision (2026-10-16): the main part is about 40–60k characters
 * (roughly 12–18 printed pages) — executive summary, scope, business
 * capabilities, business rules, and requirements with acceptance criteria;
 * the appendix keeps the per-module catalogue so nothing is lost and the
 * answer key's per-module facts stay checkable. Not chosen: a companion
 * document (two documents to keep in sync) or a summary only (it loses the
 * per-module coverage).
 *
 * Without this layout the BRD fills the document cap (run 9: 247,171 of
 * 250,000 characters, about 60–70 pages) and grows with the repository, not
 * with what the reader needs.
 *
 * HOW THE MAIN PART IS HELD TO ITS LENGTH. Two steps, both deterministic:
 *
 *   1. Planning: each main section is a single-call section of the topic plan
 *      (`document-plan.ts`) asking for its own target
 *      ({@link BRD_MAIN_SECTION_TARGETS}, 48k together). The main part is
 *      planned FIRST, within {@link mainPlanBudget}; the appendix is planned
 *      in what is left of the document budget. Every main prompt states its
 *      target as a length limit.
 *   2. Assembly: the main sections are fitted to {@link mainFitCap} (60k at
 *      the default document cap), then the appendix to the rest of the
 *      document cap ({@link fitReaderDocument}). Within the main part the
 *      SUMMARY sections (Capabilities, Key Business Rules), whose detail is in
 *      the appendix, give up text first, down to a floor; only then are the
 *      sections nothing in the appendix stands behind (the opening, the
 *      requirements) cut. Each cut section's closing note says which of the
 *      two it is, and what was cut is listed in provenance.
 *
 * Pure: no I/O and no model calls.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";
import {
  fitDocumentToPlan,
  type PlanFitResult,
  type PlanFitSection,
  type SectionCutKind,
} from "./document-plan.js";
import type { Measure } from "./section-size.js";

/** Registry key: `reader` writes a main document plus an appendix; `catalogue` (default) does not. */
export const BRD_LAYOUT_KEY = "DOCS_GEN_BRD_LAYOUT";

export type BrdLayout = "catalogue" | "reader";

/**
 * How `DOCS_GEN_BRD_LAYOUT` reads, matching the registry's `z.enum(["reader",
 * "catalogue"])`: exactly `reader` turns the layout on; unset, empty or
 * `catalogue` is the catalogue layout, and so is any other value (` Reader `
 * included, which Settings would reject too), returned as `unrecognised` for
 * the caller to log.
 */
export function readBrdLayoutSetting(config: ConfigService = getConfigService()): {
  layout: BrdLayout;
  unrecognised?: string;
} {
  const raw = config.get(BRD_LAYOUT_KEY);
  if (raw == null) return { layout: "catalogue" };
  if (raw === "reader") return { layout: "reader" };
  return raw === "catalogue" || raw === ""
    ? { layout: "catalogue" }
    : { layout: "catalogue", unrecognised: raw };
}

/**
 * What each main section of the reader layout is planned, in characters. The
 * ids are section-group ids of `sectionGroupsFor("business-requirements")`.
 *
 * Together 48k: inside the owner's 40–60k, and exactly two single-call asks
 * (2 × `SINGLE_CALL_SECTION_CHARS`), which is what the Overview and
 * Capabilities sections asked of the plan in the catalogue layout. So, under
 * the default document cap, the appendix's catalogue sections are planned the
 * SAME budget they are planned without this layout, and plan out the same
 * topics (`holistic-synthesizer-reader-layout.test.ts` holds this on a project
 * whose catalogue outgrows the budget). That is at planning time only: what
 * the appendix loses at assembly depends on how long the main part is written,
 * which is for a model run (#1074) to measure.
 */
export const BRD_MAIN_SECTION_TARGETS: Readonly<Record<string, number>> = {
  overview: 8_000,
  capabilities: 12_000,
  "key-rules": 12_000,
  requirements: 16_000,
};

/** The main sections' targets together. */
export const BRD_MAIN_TARGET_CHARS = Object.values(BRD_MAIN_SECTION_TARGETS).reduce(
  (n, chars) => n + chars,
  0,
);

/** The longest the main part may be at assembly: the top of the owner's 40–60k. */
export const BRD_MAIN_MAX_CHARS = 60_000;

/**
 * The most of the document budget the main part is planned, and the most of
 * the body it may keep at assembly. Under the default 250k cap neither binds
 * (the targets are 48k and 60k); under a small cap they leave the appendix
 * room instead of giving the whole document to the main part.
 */
export const BRD_MAIN_PLAN_SHARE = 0.4;
export const BRD_MAIN_FIT_SHARE = 0.5;

/**
 * The main sections whose detail the appendix holds (a summary of the
 * capabilities and of the rules catalogue): when the main part is over its
 * cap these give up text first, down to {@link MAIN_SUMMARY_FLOOR_CHARS}.
 * The other main sections (the opening and the reconstructed requirements)
 * have nothing behind them in the appendix.
 */
export const BRD_MAIN_SUMMARY_SECTIONS: ReadonlySet<string> = new Set([
  "capabilities",
  "key-rules",
]);

/** The least each summary section keeps before the other main sections are cut. */
export const MAIN_SUMMARY_FLOOR_CHARS = 4_000;

/**
 * The fixed lead-in of the reconstructed-requirements section, written by
 * METIS and not by the model: those requirements are inferred from the code,
 * and must not be read as the project's approved requirements.
 */
export const REQUIREMENTS_LEAD_IN =
  "> **Reconstructed from the code.** METIS inferred these requirements from what the system's code does. They are not the project's approved requirements: those are in METIS under **Requirements**, or in a Business Requirements document scoped to Requirements. The numbers RC-1, RC-2, … are local to this document and are not requirement ids.";

/**
 * A reconstructed-requirements section with {@link REQUIREMENTS_LEAD_IN}
 * directly under its first `##` heading (at the top when it has none). A
 * section that already carries it is returned unchanged.
 */
export function withRequirementsLeadIn(markdown: string): string {
  if (markdown.includes(REQUIREMENTS_LEAD_IN)) return markdown;
  const heading = /^## .*$/m.exec(markdown);
  if (!heading) return `${REQUIREMENTS_LEAD_IN}\n\n${markdown}`;
  const end = heading.index + heading[0].length;
  return `${markdown.slice(0, end)}\n\n${REQUIREMENTS_LEAD_IN}\n\n${markdown.slice(end).replace(/^\n+/, "")}`;
}

/** Whether a section-group id belongs to the main part of the reader layout. */
export function isMainSection(sectionId: string): boolean {
  return Object.hasOwn(BRD_MAIN_SECTION_TARGETS, sectionId);
}

/** What the main part is planned out of a document budget of `budgetChars`. */
export function mainPlanBudget(budgetChars: number): number {
  return Math.max(
    0,
    Math.min(BRD_MAIN_TARGET_CHARS, Math.floor(Math.max(0, budgetChars) * BRD_MAIN_PLAN_SHARE)),
  );
}

/** The most the main part keeps out of a body limit of `bodyMaxChars`. */
export function mainFitCap(bodyMaxChars: number): number {
  return Math.max(
    0,
    Math.min(BRD_MAIN_MAX_CHARS, Math.floor(Math.max(0, bodyMaxChars) * BRD_MAIN_FIT_SHARE)),
  );
}

/**
 * The heading that ends the main document and opens the appendix. An H1, so
 * the appendix's sections keep their own H2 headings (and every check that
 * reads H2 sections reads them as before).
 */
export const APPENDIX_DIVIDER = [
  "# Appendix: Module-by-Module Detail",
  "> The main document ends above. This appendix holds the detail behind it, module by module: the full catalogue of business rules, the workflows, calculations, data model and integrations. A business reader can stop before it.",
].join("\n\n");

/** What {@link fitReaderDocument} returns: one fit result over both parts. */
export interface ReaderFitResult extends PlanFitResult {
  /**
   * Characters of the fitted main part as it renders: its sections, closing
   * notes included, and the blank lines that join them.
   */
  mainChars: number;
  /** What the appendix was fitted to: the body limit less the main part and the divider. */
  appendixMaxChars: number;
}

const sum = (values: readonly number[]): number => values.reduce((n, v) => n + v, 0);

/**
 * Fit a reader-layout document: the main sections (`isMain[i]`) to
 * {@link mainFitCap} of `bodyMaxChars` — the summary sections (`isSummary[i]`)
 * first, to what the other main sections leave of that cap but not below
 * {@link MAIN_SUMMARY_FLOOR_CHARS} each, then the others to what the summaries
 * kept — then the appendix sections to what is
 * left of `bodyMaxChars` after the main part as fitted and the divider. Each
 * part is fitted by `fitDocumentToPlan`, so within a part nothing is cut while
 * it fits, and what is cut is listed. Room the main part does not use is the
 * appendix's. The result is in the input order.
 */
export function fitReaderDocument(
  sections: readonly PlanFitSection[],
  isMain: readonly boolean[],
  bodyMaxChars: number,
  measure: Measure,
  documentMaxChars: number,
  /** Per section, whether it is a summary section ({@link BRD_MAIN_SUMMARY_SECTIONS}). */
  isSummary: readonly boolean[] = [],
): ReaderFitResult {
  const mainAt = sections.flatMap((_, i) => (isMain[i] ? [i] : []));
  const appendixAt = sections.flatMap((_, i) => (isMain[i] ? [] : [i]));
  // The cap a note names, and the room the sections have: the blank lines that
  // join the main sections count against it too.
  const limit = mainFitCap(bodyMaxChars);
  const joins = 2 * Math.max(0, mainAt.length - 1);
  const cap = Math.max(0, limit - joins);
  // The summaries first: they get what the other main sections leave of the
  // cap, but never less than their floor while they are longer than it.
  const summaryAt = mainAt.filter((i) => isSummary[i] === true);
  const ownAt = mainAt.filter((i) => isSummary[i] !== true);
  const length = (at: readonly number[]): number =>
    sum(at.map((i) => measure(sections[i].markdown)));
  const summaryFloor = Math.min(length(summaryAt), MAIN_SUMMARY_FLOOR_CHARS * summaryAt.length);
  const summaries = fitDocumentToPlan(
    summaryAt.map((i) => sections[i]),
    Math.max(0, Math.min(cap, Math.max(summaryFloor, cap - length(ownAt)))),
    measure,
    limit,
    "BRD_MAIN_SUMMARY",
  );
  const own = fitDocumentToPlan(
    ownAt.map((i) => sections[i]),
    Math.max(0, cap - sum(summaries.sections.map((section) => measure(section)))),
    measure,
    limit,
    "BRD_MAIN_PART",
  );
  const main = mergeFits(mainAt.length, [
    { at: summaryAt.map((i) => mainAt.indexOf(i)), result: summaries },
    { at: ownAt.map((i) => mainAt.indexOf(i)), result: own },
  ]);
  const mainChars = sum(main.sections.map((section) => measure(section))) + joins;
  // The divider and the blank line that joins it to the document.
  const divider = appendixAt.length > 0 ? measure(APPENDIX_DIVIDER) + 2 : 0;
  const appendixMaxChars = Math.max(0, Math.floor(bodyMaxChars) - mainChars - divider);
  const appendix = fitDocumentToPlan(
    appendixAt.map((i) => sections[i]),
    appendixMaxChars,
    measure,
    documentMaxChars,
  );
  return {
    ...mergeFits(sections.length, [
      { at: mainAt, result: main },
      { at: appendixAt, result: appendix },
    ]),
    mainChars,
    appendixMaxChars,
  };
}

/** Fit results of disjoint subsets of `count` sections, merged back in order. */
function mergeFits(
  count: number,
  fits: ReadonlyArray<{ at: readonly number[]; result: PlanFitResult }>,
): PlanFitResult {
  const where = new Map<number, { result: PlanFitResult; k: number }>();
  for (const { at, result } of fits) at.forEach((i, k) => where.set(i, { result, k }));
  const pick = <T>(of: (result: PlanFitResult) => readonly T[]): T[] =>
    Array.from({ length: count }, (_, i) => {
      const { result, k } = where.get(i)!;
      return of(result)[k];
    });
  const cuts = pick((r) => r.cuts);
  const shortened = cuts.filter((cut): cut is Exclude<SectionCutKind, "whole"> => cut !== "whole");
  return {
    sections: pick((r) => r.sections),
    trimmed: sum(fits.map((f) => f.result.trimmed)),
    omittedTopics: pick((r) => r.omittedTopics),
    parts: pick((r) => r.parts),
    cuts,
    mode: shortened[0] ?? "whole",
    keptChars: sum(fits.map((f) => f.result.keptChars)),
    kept: pick((r) => r.kept),
    unplannedWithinCap: fits.every((f) => f.result.unplannedWithinCap),
  };
}
