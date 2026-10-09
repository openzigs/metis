/**
 * The hidden-label rule for a requirement's `labels` JSON column, shared by the
 * write path (`updateRequirementRow`) and the `PATCH …/requirements/:reqId`
 * 409 conflict loader so the two cannot drift. Dependency-free on purpose: a
 * route test that mocks the analysis barrel still gets the real rule.
 */

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
