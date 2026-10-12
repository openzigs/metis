/**
 * Issue #1063 — which imported item a synthesised requirement came from.
 *
 * A run started from imported items (#1006) records them on the analysis as
 * `metadata.sourceRequirements`, each under the `NR-*` id it carried through
 * the run. Synthesis then rewrites titles, merges findings and adds
 * requirements of its own: in #706 run 7, five imported items became seven
 * requirements, none titled as imported and none linked back.
 *
 * The link is made by the synthesis model, the only step that knows what it
 * merged: it names the `NR-*` ids each requirement restates. That is model
 * output, so nothing here trusts it — an id is kept only when it is one of the
 * run's own, and the title and URL shown come from the analysis record, never
 * from the model.
 *
 * Three states are kept apart on purpose:
 *   - ids     — the requirement restates those imported items;
 *   - `[]`    — the model said it restates none: the analysis added it;
 *   - `null`  — not recorded. Never shown as "added by the analysis".
 *
 * Pure: no I/O, so every caller (and test) can use it without a database.
 */
import type { AnalysisSourceRequirement } from "@metis/shared";

/** One imported item as the synthesis prompt lists it. */
export interface SynthesisSourceItem {
  /** The `NR-*` id the item carried through the run. */
  id: string;
  title: string;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The `sourceRequirements` persisted on an analysis, keeping only well-formed
 * entries. Accepts the metadata object or its JSON text; anything else is `[]`.
 */
export function readSourceRequirements(metadata: unknown): AnalysisSourceRequirement[] {
  let meta: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      meta = JSON.parse(metadata);
    } catch {
      return [];
    }
  }
  if (!meta || typeof meta !== "object") return [];
  const value = (meta as Record<string, unknown>).sourceRequirements;
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): AnalysisSourceRequirement[] => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    const candidateId = str(r.candidateId);
    const requirementId = str(r.requirementId);
    const title = str(r.title);
    const externalSource = str(r.externalSource);
    if (!candidateId || !requirementId || title === null || !externalSource) return [];
    return [
      {
        candidateId,
        requirementId,
        title,
        externalSource,
        externalId: str(r.externalId),
        externalUrl: str(r.externalUrl),
      },
    ];
  });
}

/** The imported items in the shape the synthesis prompt lists them. */
export function toSynthesisSourceItems(
  sources: ReadonlyArray<Pick<AnalysisSourceRequirement, "candidateId" | "title">> | undefined,
): SynthesisSourceItem[] {
  return (sources ?? []).map((s) => ({ id: s.candidateId, title: s.title }));
}

/**
 * Check the model's `sourceIds` against the run's own ids.
 *
 *   - the run has no imported items, or the model gave no list → `undefined`;
 *   - an empty list → `[]` (the model's explicit "none");
 *   - a list with no id of this run → `undefined`: a model that named only
 *     ids that do not exist has not said the requirement is its own;
 *   - otherwise the known ids, de-duplicated, in the order given.
 */
export function cleanSourceIds(
  sourceIds: readonly string[] | undefined,
  knownIds: ReadonlySet<string>,
): string[] | undefined {
  if (sourceIds === undefined || knownIds.size === 0) return undefined;
  if (sourceIds.length === 0) return [];
  const kept = [...new Set(sourceIds.map((id) => id.trim()).filter((id) => knownIds.has(id)))];
  return kept.length > 0 ? kept : undefined;
}

/**
 * The `Requirement.sourceCandidateIds` column value for one synthesised
 * requirement: JSON text of the checked ids, or `null` when not recorded.
 */
export function serializeSourceCandidateIds(
  sourceIds: readonly string[] | undefined,
  sources: ReadonlyArray<Pick<AnalysisSourceRequirement, "candidateId">>,
): string | null {
  const cleaned = cleanSourceIds(sourceIds, new Set(sources.map((s) => s.candidateId)));
  return cleaned === undefined ? null : JSON.stringify(cleaned);
}

/**
 * Resolve a stored `sourceCandidateIds` column against the run's imported
 * items. `null` when the column is null or unreadable, the run has no imported
 * items, or none of the stored ids is one of them; otherwise an id the run does
 * not list is left out, and a repeated id is listed once.
 */
export function resolveSourceItems(
  column: string | null | undefined,
  sources: readonly AnalysisSourceRequirement[],
): AnalysisSourceRequirement[] | null {
  if (!column || sources.length === 0) return null;
  let ids: unknown;
  try {
    ids = JSON.parse(column);
  } catch {
    return null;
  }
  if (!Array.isArray(ids)) return null;
  const byId = new Map(sources.map((s) => [s.candidateId, s] as const));
  // De-duplicated on read as well as on write: the page keys the list by
  // `candidateId`, and a column edited by hand could repeat one.
  const items = [...new Set(ids)].flatMap((id) => {
    const hit = typeof id === "string" ? byId.get(id) : undefined;
    return hit ? [hit] : [];
  });
  // Ids were stored and none resolves: unknown, not "the analysis added it".
  return ids.length > 0 && items.length === 0 ? null : items;
}
