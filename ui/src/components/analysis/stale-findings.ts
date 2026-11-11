/**
 * #2222 — which analysis findings judge an earlier wording of a requirement.
 *
 * A requirement is synthesised from the analysis findings it lists
 * (`evidenceFindingIds`); those judged the wording at its `analysedVersion`.
 * Once a person edits the requirement, each of its findings says so wherever
 * the analysis view lists it: a finding the stale requirement drew on reads
 * "judged an earlier version of …".
 */
import { requirementFindingsStale } from "@metis/shared";

export interface StaleFindingRequirement {
  id: string;
  title: string;
  version: number;
  analysedVersion?: number;
  evidenceFindingIds: readonly string[];
}

/** By finding id, one note per requirement edited since the finding judged it. */
export function staleFindingNotes(
  requirements: readonly StaleFindingRequirement[],
): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  for (const r of requirements) {
    const stale = requirementFindingsStale(r);
    if (!stale) continue;
    const note = `Stale: judged v${stale.judgedVersion} of “${r.title}”, which is now v${stale.currentVersion}.`;
    for (const id of r.evidenceFindingIds) notes.set(id, [...(notes.get(id) ?? []), note]);
  }
  return notes;
}
