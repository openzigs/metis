/**
 * #2491 — a review as its reader may see it. A review's items are requirements,
 * and an item resting on a source the reader cannot see (`source-redaction.ts`)
 * keeps its id and pinned version but shows the "Restricted" placeholder for
 * its title, and no note on criteria it shares. A sibling the shared-criteria
 * note names (#1203) is named by the placeholder the same way. Nothing is
 * removed, so the review keeps its counts.
 *
 * One read of every named requirement's sources for all the reviews at once.
 */
import { RESTRICTED_SOURCE_TITLE } from "@metis/shared";
import { restrictedRequirementIds, type SourceReader } from "../analysis/source-redaction.js";

interface SharedWithEntry {
  requirementId: string | null;
  title: string;
}

interface RedactableItem {
  requirementId: string | null;
  requirement?: { title: string } | null;
  sharedCriteria?: { record: { sharedWith: SharedWithEntry[] } } | null;
}

interface RedactableReview {
  /** Absent (or not a list) on a review read without its items: nothing to redact. */
  items?: unknown;
}

function itemsOf(review: RedactableReview): RedactableItem[] {
  return Array.isArray(review.items) ? review.items : [];
}

function sharedSiblingIds(item: RedactableItem): string[] {
  return (item.sharedCriteria?.record.sharedWith ?? []).flatMap((s) =>
    s.requirementId ? [s.requirementId] : [],
  );
}

/** `reviews` with every requirement `reader` cannot see as the placeholder. */
export async function redactReviewsFor<T>(
  reader: SourceReader,
  reviews: readonly T[],
): Promise<T[]> {
  const typed = reviews as unknown as RedactableReview[];
  const ids = typed.flatMap((r) =>
    itemsOf(r).flatMap((i) => [
      ...(i.requirementId ? [i.requirementId] : []),
      ...sharedSiblingIds(i),
    ]),
  );
  const hidden = await restrictedRequirementIds(reader, ids);
  if (hidden.size === 0) return [...reviews];
  return typed.map((review) => {
    if (!Array.isArray(review.items)) return review;
    return {
      ...review,
      items: itemsOf(review).map((item) => {
        if (item.requirementId && hidden.has(item.requirementId)) {
          return {
            ...item,
            ...(item.requirement
              ? { requirement: { ...item.requirement, title: RESTRICTED_SOURCE_TITLE } }
              : {}),
            ...(item.sharedCriteria !== undefined ? { sharedCriteria: null } : {}),
            restricted: true,
          };
        }
        if (!item.sharedCriteria) return item;
        const { record } = item.sharedCriteria;
        return {
          ...item,
          sharedCriteria: {
            ...item.sharedCriteria,
            record: {
              ...record,
              sharedWith: record.sharedWith.map((s) =>
                s.requirementId && hidden.has(s.requirementId)
                  ? { ...s, title: RESTRICTED_SOURCE_TITLE }
                  : s,
              ),
            },
          },
        };
      }),
    };
  }) as unknown as T[];
}

/** One review (or nothing) as {@link redactReviewsFor} shows it. */
export async function redactReviewFor<T>(reader: SourceReader, review: T): Promise<T> {
  if (review === null || review === undefined) return review;
  return (await redactReviewsFor(reader, [review]))[0]!;
}
