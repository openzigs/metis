/**
 * #1218 — the requirements section of a reader-layout BRD (`brd-layout.ts`,
 * #1175) when the project has approved requirements: the requirements the
 * analysts analysed, clarified, reviewed and approved in METIS, from ONE
 * analysis run (#1230: the run the Requirements hub opens on, chosen by the
 * same rule, `defaultRequirementsRunIdFor`), copied from
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
  readBrdLayoutSetting,
} from "./brd-layout.js";
import { defaultRequirementsRunIdFor } from "../analysis/requirement-runs.js";
import {
  loadScopedRequirements,
  renderRequirementEntry,
  type ScopedRequirement,
} from "./requirements-scope.js";
import type { Measure } from "./section-size.js";
import {
  isScopedApprovedRequirements,
  requirementsInScope,
  type ApprovedRequirementsScope,
} from "./approved-requirements-scope.js";

/** The section's H2 heading and its section-group label. */
export const APPROVED_REQUIREMENTS_HEADING = "Approved Requirements";

/** What the manifest records as the "model" of a section no model wrote. */
export const APPROVED_REQUIREMENTS_MODEL = "none (stored approved requirements)";

/**
 * The project's approved requirements, highest priority first, from the run
 * the Requirements hub opens on (#1230): the newest completed run with any
 * requirements. Requirements belong to the run that produced them, and a
 * re-run writes a new set, so reading every run's approved rows would list
 * superseded and duplicate requirements. A re-run whose requirements are all
 * still draft is the current set: it has nothing approved yet, so the section
 * is reconstructed from the code until the analysts approve some, rather than
 * listing the superseded run's approvals. Both reads are filtered on
 * `projectId`: the run is one of THIS project's, and its rows are read through
 * `requirementsScopeWhere` (live rows of the project whose review status is
 * `approved`), so another project's rows are never selected. No run: none.
 *
 * #1246 — a repository- or path-scoped document passes its `scope`
 * (`approvedRequirementsScopeOf`): only the approved requirements with a code
 * link in it are listed, and one with no code link is left out
 * (`approved-requirements-scope.ts`).
 */
export async function loadApprovedRequirements(
  projectId: string,
  scope: ApprovedRequirementsScope = {},
): Promise<ScopedRequirement[]> {
  const runId = await defaultRequirementsRunIdFor(projectId);
  if (!runId) return [];
  const approved = await loadScopedRequirements(projectId, {
    analysisId: runId,
    approvedOnly: true,
  });
  return isScopedApprovedRequirements(scope)
    ? requirementsInScope(projectId, approved, scope)
    : approved;
}

/**
 * #1230 — what of each approved requirement the section depends on: exactly
 * the stored fields it renders (`renderRequirementEntry` with `showId` and
 * `codeLinks: false`), in order. Not the write bookkeeping (`version`,
 * `updatedAt`), and not the code links (`codeMappings`, `implementations`),
 * which the section does not show: re-scoring a mapping or linking a PR
 * changes nothing a reader sees, so it neither makes the section `changed` for
 * #857 reuse nor makes the document's input snapshot stale.
 */
export function approvedRequirementsFacts(requirements: readonly ScopedRequirement[]): string {
  return JSON.stringify(
    requirements.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      type: r.type,
      priority: r.priority,
      reviewStatus: r.reviewStatus,
      verdict: r.verdict,
      acceptanceCriteria: r.acceptanceCriteria,
    })),
  );
}

/**
 * #1230 — whether a generated document lists the project's approved
 * requirements when it is generated: a BRD (the default type of a `full` or
 * `repository` document, as the generate route reads it) under the reader
 * layout. Such a document's input snapshot covers its approved requirements,
 * so approving or editing one makes it stale.
 */
export function readsApprovedRequirements(doc: { scope: string; scopeFilter: string }): boolean {
  if (doc.scope !== "full" && doc.scope !== "repository") return false;
  let docType: unknown;
  try {
    docType = (JSON.parse(doc.scopeFilter) as { docType?: unknown } | null)?.docType;
  } catch {
    return false;
  }
  // The generate route writes a BRD unless the stored type names another.
  const isBrd = docType !== "architecture" && docType !== "user-guide";
  return isBrd && readBrdLayoutSetting().layout === "reader";
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

/** How the section is rendered: `scoped` for a repository- or path-scoped document (#1246). */
export interface ApprovedRequirementsRenderOptions {
  scoped?: boolean;
}

function leadIn(total: number, scoped: boolean): string {
  const noun = total === 1 ? "requirement" : "requirements";
  if (scoped) {
    return `> **Approved in METIS.** The ${total} approved ${noun} linked to code in this document's repository or paths. Each one's id, title, description and acceptance criteria are copied from METIS; no model wrote or reworded them. Highest priority first.\n>\n> **Only requirements linked to this part of the code are listed.** A requirement is listed when it has a code link or a merged pull request in this document's repository or paths; a pull request counts only if it is in a repository connected to this project under the same owner and name. Approved requirements with no code link, or linked only to other code, are not listed here; every approved requirement is in METIS under **Requirements**.`;
  }
  return `> **Approved in METIS.** The ${total} approved ${noun} of the analysis run METIS opens under **Requirements**, as the analysts left them in METIS: each one's id, title, description and acceptance criteria are copied from the stored requirement, and no model wrote or reworded them. Highest priority first.`;
}

/**
 * The note that ends the section when not every approved requirement fits:
 * what is listed, and where the full list is. The full list is never cut
 * short: a requirement is listed whole or not at all.
 */
export function overflowPointer(listed: number, total: number, scoped = false): string {
  const rest = total - listed;
  const noun = scoped
    ? "approved requirements linked to this document's code"
    : "approved requirements";
  return `> **${listed} of ${total} ${noun} are listed here.** The other ${rest} did not fit in the main part of this document, so they are left out whole rather than cut short. The full list, each with its acceptance criteria, is in METIS under **Requirements**, and in a Business Requirements document generated with the scope **Requirements (analysis run)**, the run METIS opens under **Requirements** chosen, and **Approved requirements only**.`;
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
  options: ApprovedRequirementsRenderOptions = {},
): ApprovedRequirementsSection {
  const total = requirements.length;
  const scoped = options.scoped === true;
  const head = `## ${APPROVED_REQUIREMENTS_HEADING}\n\n${leadIn(total, scoped)}`;
  const entries = requirements.map((r, i) =>
    renderRequirementEntry(r, i + 1, { showId: true, codeLinks: false }).join("\n"),
  );
  const assemble = (listed: number, pointer: boolean): string =>
    [
      head,
      ...entries.slice(0, listed),
      ...(pointer ? [overflowPointer(listed, total, scoped)] : []),
    ].join("\n\n");
  const all = assemble(total, false);
  if (measure(all) <= maxChars) return { markdown: all, listed: total, total };
  // The longest prefix of whole requirements that fits with the pointer, by
  // binary search (#1230): a longer prefix is never shorter, so the prefixes
  // that fit are exactly those up to some length. A linear scan measured
  // O(N) prefixes of O(N) length each.
  let fits = 0;
  let fails = total;
  while (fails - fits > 1) {
    const mid = Math.floor((fits + fails) / 2);
    if (measure(assemble(mid, true)) <= maxChars) fits = mid;
    else fails = mid;
  }
  return { markdown: assemble(fits, true), listed: fits, total };
}
