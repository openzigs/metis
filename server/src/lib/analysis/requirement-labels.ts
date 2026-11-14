/**
 * The hidden-label rule for a requirement's `labels` JSON column, shared by the
 * write path (`updateRequirementRow`) and the `PATCH …/requirements/:reqId`
 * 409 conflict loader so the two cannot drift. Dependency-free on purpose: a
 * route test that mocks the analysis barrel still gets the real rule.
 */
import { REQUIREMENT_REVIEW_STATUSES } from "@metis/shared";

/** A label the caller never sees: `finding:*` traceability or legacy `review:*`. */
export function isHiddenRequirementLabel(label: string): boolean {
  return label.startsWith("review:") || label.startsWith("finding:");
}

/** The stored `labels` JSON column as a string[]; malformed or absent is `[]`. */
export function parseRequirementLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A caller's new label list merged onto the stored one: the caller's visible
 * labels, then every hidden label already stored. The caller never sees the
 * hidden ones, so it can neither keep nor drop them — and any hidden label it
 * sends is ignored, so a traceability link cannot be forged through a save.
 */
export function mergeHiddenRequirementLabels(next: string[], stored: string[]): string[] {
  const hidden = stored.filter(isHiddenRequirementLabel);
  const visible = next.filter((l) => !isHiddenRequirementLabel(l));
  return [...new Set([...visible, ...hidden])];
}

/**
 * The labels a caller sees: the hidden `finding:*` / legacy `review:*` labels
 * removed, as the snapshot shows them and as the write strips and preserves
 * them.
 */
export function visibleRequirementLabels(raw: string | null | undefined): string[] {
  return parseRequirementLabels(raw).filter((l) => !isHiddenRequirementLabel(l));
}

/**
 * #1016 — the status a requirement holds for review purposes: the typed column,
 * else a legacy `review:*` label (rows written before the column existed), the
 * precedence every reader uses (`resolveRequirementReviewStatus`). Null when it
 * has neither, or the label is not a known status.
 *
 * Deliberately not `resolveRequirementReviewStatus` itself: that one is for
 * display and reads "nothing recorded" as `draft`, whereas this result is what
 * a submit CAPTURES to restore later. A requirement that never had a status
 * must get null back on withdraw (#989), not a `draft` it never held — and a
 * `draft` capture is skipped by the restore, which would leave the submit's
 * `draft` in the column for good. The precedence (column, then label) is the
 * same; only the empty case differs. An unknown column value is returned as
 * is, so it is restored exactly; readers show it as `draft` either way.
 */
export function heldReviewStatus(column: string | null, labelsRaw: string | null): string | null {
  if (column !== null) return column;
  const label = parseRequirementLabels(labelsRaw).find((l) => l.startsWith("review:"));
  const fromLabel = label ? label.slice("review:".length) : null;
  return fromLabel !== null &&
    (REQUIREMENT_REVIEW_STATUSES as readonly string[]).includes(fromLabel)
    ? fromLabel
    : null;
}
