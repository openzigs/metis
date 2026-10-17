/**
 * #1218 — the requirements section of a reader-layout BRD (`brd-layout.ts`,
 * #1175) when the project has approved requirements: the requirements the
 * analysts analysed, clarified, reviewed and approved in METIS, from ONE
 * analysis run (the newest completed run with any approved, as the
 * Requirements hub opens on the newest run with requirements), copied from
 * their stored rows as a requirements-scoped BRD shows them
 * (`requirements-scope.ts`): stored id, title, body and acceptance criteria,
 * with the analysts' edits. No model writes or rewords any of it.
 *
 * Without approved requirements the section is written by the model from the
 * code, under the #1175 "Reconstructed from the code" lead-in, as before.
 *
 * LENGTH. The section is part of the main document, which is held to
 * {@link mainFitCap}. It is given {@link approvedRequirementsMaxChars} of it,
 * the share the main part's other sections' targets leave, and is rendered
 * WHOLE requirements at a time, highest priority first: when the next one
 * does not fit, the section stops and points to the full list rather than
 * cutting a requirement in half. At assembly it is kept as rendered (a
 * "fixed" section in `fitReaderDocument`): the other main sections are fitted
 * to what it leaves.
 */
import {
  BRD_MAIN_MAX_CHARS,
  BRD_MAIN_SECTION_TARGETS,
  BRD_MAIN_TARGET_CHARS,
  mainFitCap,
} from "./brd-layout.js";
import { prisma } from "../prisma.js";
import {
  loadScopedRequirements,
  renderRequirementEntry,
  type ScopedRequirement,
} from "./requirements-scope.js";
import type { Measure } from "./section-size.js";

/** The section's H2 heading and its section-group label. */
export const APPROVED_REQUIREMENTS_HEADING = "Approved Requirements";

/** What the manifest records as the "model" of a section no model wrote. */
export const APPROVED_REQUIREMENTS_MODEL = "none (stored approved requirements)";

/**
 * The project's approved requirements, highest priority first, from the
 * newest completed analysis run of the project that has any. Requirements
 * belong to the run that produced them, and a re-run writes a new set, so
 * reading every run's approved rows would list superseded and duplicate
 * requirements. Both reads are filtered on `projectId`: the run is one of
 * THIS project's, and its rows are read through `requirementsScopeWhere`
 * (live rows of the project whose review status is `approved`), so another
 * project's rows are never selected. No such run: none.
 */
export async function loadApprovedRequirements(projectId: string): Promise<ScopedRequirement[]> {
  const run = await prisma.analysis.findFirst({
    where: {
      projectId,
      deletedAt: null,
      status: "completed",
      requirements: { some: { projectId, deletedAt: null, reviewStatus: "approved" } },
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!run) return [];
  return loadScopedRequirements(projectId, { analysisId: run.id, approvedOnly: true });
}

/** The main part's other sections' targets: what the approved requirements leave them. */
const OTHER_MAIN_TARGET_CHARS = BRD_MAIN_TARGET_CHARS - BRD_MAIN_SECTION_TARGETS.requirements;

/**
 * The most the approved-requirements section may be out of a body limit of
 * `bodyMaxChars`: the share of {@link mainFitCap} the other main sections'
 * targets leave of {@link BRD_MAIN_MAX_CHARS}. 28k under the default 250k
 * document cap (60k − 32k), against the 16k a reconstructed section is
 * planned; proportionally less under a smaller cap.
 */
export function approvedRequirementsMaxChars(bodyMaxChars: number): number {
  return Math.max(
    0,
    Math.floor(
      (mainFitCap(bodyMaxChars) * (BRD_MAIN_MAX_CHARS - OTHER_MAIN_TARGET_CHARS)) /
        BRD_MAIN_MAX_CHARS,
    ),
  );
}

function leadIn(total: number): string {
  const noun = total === 1 ? "requirement" : "requirements";
  return `> **Approved in METIS.** The ${total} approved ${noun} of the project's latest analysis run that has any, as the analysts left them in METIS: each one's id, title, description and acceptance criteria are copied from the stored requirement, and no model wrote or reworded them. Highest priority first.`;
}

/**
 * The note that ends the section when not every approved requirement fits:
 * what is listed, and where the full list is. The full list is never cut
 * short: a requirement is listed whole or not at all.
 */
export function overflowPointer(listed: number, total: number): string {
  const rest = total - listed;
  return `> **${listed} of ${total} approved requirements are listed here.** The other ${rest} did not fit in the main part of this document, so they are left out whole rather than cut short. The full list, each with its acceptance criteria, is in METIS under **Requirements**, and in a Business Requirements document generated with the scope **Requirements (analysis run)**, the latest run with approved requirements chosen, and **Approved requirements only**.`;
}

/** What {@link renderApprovedRequirementsSection} returns. */
export interface ApprovedRequirementsSection {
  markdown: string;
  /** How many requirements are listed in full. */
  listed: number;
  /** How many approved requirements there are. */
  total: number;
}

/**
 * The section as Markdown, within `maxChars` as `measure` counts: every
 * requirement in order while they fit, then the {@link overflowPointer}. When
 * not even the pointer fits beside one requirement, the section is its heading,
 * lead-in and pointer alone.
 */
export function renderApprovedRequirementsSection(
  requirements: readonly ScopedRequirement[],
  maxChars: number,
  measure: Measure = (markdown) => markdown.length,
): ApprovedRequirementsSection {
  const total = requirements.length;
  const head = `## ${APPROVED_REQUIREMENTS_HEADING}\n\n${leadIn(total)}`;
  const entries = requirements.map((r, i) =>
    renderRequirementEntry(r, i + 1, { showId: true, codeLinks: false }).join("\n"),
  );
  const assemble = (listed: number, pointer: boolean): string =>
    [head, ...entries.slice(0, listed), ...(pointer ? [overflowPointer(listed, total)] : [])].join(
      "\n\n",
    );
  const all = assemble(total, false);
  if (measure(all) <= maxChars) return { markdown: all, listed: total, total };
  // The longest prefix of whole requirements that fits with the pointer.
  let listed = 0;
  while (listed < total && measure(assemble(listed + 1, true)) <= maxChars) listed += 1;
  return { markdown: assemble(listed, true), listed, total };
}
