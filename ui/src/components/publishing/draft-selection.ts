/**
 * #863 — which drafts a publish batch may include.
 *
 * The server publishes only `draft | approved | failed` and rejects the whole
 * batch with `400 DRAFT_INELIGIBLE` otherwise. The page kept a published draft
 * in its selection (checked and disabled), so every batch after the first
 * failed until a reload. The selection a batch sends is therefore derived from
 * this predicate, never read raw from the checkbox state.
 */
export const PUBLISHABLE_DRAFT_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "approved",
  "failed",
]);

export function isPublishableDraft(draft: { status: string }): boolean {
  return PUBLISHABLE_DRAFT_STATUSES.has(draft.status);
}

/** The selected drafts a batch may actually publish, in list order. */
export function publishableSelection<T extends { id: string; status: string }>(
  drafts: readonly T[] | undefined,
  selected: ReadonlySet<string>,
): T[] {
  return (drafts ?? []).filter((d) => selected.has(d.id) && isPublishableDraft(d));
}
