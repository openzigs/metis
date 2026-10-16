/**
 * #1175 — the reader layout of a full-scope business-requirements document: a
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
 *      the default document cap) by the plan-ordered fit, then the appendix
 *      to the rest of the document cap ({@link fitReaderDocument}). What the
 *      main cap removes is listed in the section's closing note and in
 *      provenance, as every other cut is.
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
 * How `DOCS_GEN_BRD_LAYOUT` reads. Only the documented `reader` turns the
 * layout on (surrounding space and case aside); unset, empty or `catalogue`
 * is the catalogue layout, and so is any other value, which is returned as
 * `unrecognised` for the caller to log.
 */
export function readBrdLayoutSetting(config: ConfigService = getConfigService()): {
  layout: BrdLayout;
  unrecognised?: string;
} {
  const raw = config.get(BRD_LAYOUT_KEY);
  if (raw == null) return { layout: "catalogue" };
  const value = raw.trim().toLowerCase();
  if (value === "reader") return { layout: "reader" };
  return value === "catalogue" || value === ""
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
 * SAME budget they are planned without this layout and keep the topics they
 * keep today (`brd-layout.test.ts` holds this on a run-sized input).
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
  /** Characters of the fitted main part (its sections, closing notes included). */
  mainChars: number;
  /** What the appendix was fitted to: the body limit less the main part and the divider. */
  appendixMaxChars: number;
}

const sum = (values: readonly number[]): number => values.reduce((n, v) => n + v, 0);

/**
 * Fit a reader-layout document: the main sections (`isMain[i]`) to
 * {@link mainFitCap} of `bodyMaxChars`, then the appendix sections to what is
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
): ReaderFitResult {
  const mainAt = sections.flatMap((_, i) => (isMain[i] ? [i] : []));
  const appendixAt = sections.flatMap((_, i) => (isMain[i] ? [] : [i]));
  const cap = mainFitCap(bodyMaxChars);
  const main = fitDocumentToPlan(
    mainAt.map((i) => sections[i]),
    cap,
    measure,
    cap,
    "BRD_MAIN_PART",
  );
  const mainChars = sum(main.sections.map((section) => measure(section)));
  // The divider and the blank line that joins it to the document.
  const divider = appendixAt.length > 0 ? measure(APPENDIX_DIVIDER) + 2 : 0;
  const appendixMaxChars = Math.max(0, Math.floor(bodyMaxChars) - mainChars - divider);
  const appendix = fitDocumentToPlan(
    appendixAt.map((i) => sections[i]),
    appendixMaxChars,
    measure,
    documentMaxChars,
  );
  const at = new Map<number, { result: PlanFitResult; k: number }>();
  mainAt.forEach((i, k) => at.set(i, { result: main, k }));
  appendixAt.forEach((i, k) => at.set(i, { result: appendix, k }));
  const pick = <T>(of: (result: PlanFitResult) => readonly T[]): T[] =>
    sections.map((_, i) => {
      const { result, k } = at.get(i)!;
      return of(result)[k];
    });
  const cuts = pick((r) => r.cuts);
  const shortened = cuts.filter((cut): cut is Exclude<SectionCutKind, "whole"> => cut !== "whole");
  return {
    sections: pick((r) => r.sections),
    trimmed: main.trimmed + appendix.trimmed,
    omittedTopics: pick((r) => r.omittedTopics),
    parts: pick((r) => r.parts),
    cuts,
    mode: shortened[0] ?? "whole",
    keptChars: main.keptChars + appendix.keptChars,
    kept: pick((r) => r.kept),
    unplannedWithinCap: main.unplannedWithinCap && appendix.unplannedWithinCap,
    mainChars,
    appendixMaxChars,
  };
}
