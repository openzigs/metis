/**
 * Issue #2219 — what an edit of a requirement does to its approval.
 *
 * Editing an approved requirement used to save silently: the requirement kept
 * `reviewStatus = approved` and the approved review kept showing the old
 * version, so "approved" no longer meant "this wording was approved". The edit
 * now returns the requirement to awaiting review, and the Edit dialog says so
 * BEFORE the save, from `GET /api/requirements/:id/approval`.
 */

/** A review that pinned a version of the requirement and has not been settled away. */
export interface RequirementApprovalReview {
  id: string;
  title: string;
  /** Only reviews whose pin an edit makes out of date are listed. */
  status: "approved" | "in_review";
  /** The requirement version the review pinned. */
  pinnedVersion: number;
  /** Display names of the reviewers who approved this round. */
  approvedBy: string[];
}

/** Body of `GET /api/requirements/:id/approval`. */
export interface RequirementApproval {
  requirementId: string;
  /** The requirement's current version. */
  version: number;
  /** Its review status (the typed column, else a legacy `review:*` label). */
  reviewStatus: string | null;
  /** Approved and in-review reviews of it, most recent first. */
  reviews: RequirementApprovalReview[];
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The warning the Edit dialog shows before a save, or null when the edit
 * touches no approval and no open review.
 *
 * - An approved review pinned at the current version: "Approved as v1 by Test
 *   Coordinator; saving creates v2 and reopens review."
 * - A review in progress on the current version: the reviewers are deciding on
 *   v1, and only a withdraw and a new submit shows them v2.
 * - Approved with no formal review (the card's Approve button): saving returns
 *   it to awaiting review.
 *
 * A review pinned at an OLDER version is already out of date and says nothing
 * new, so it is skipped.
 */
export function approvalEditWarning(
  approval: RequirementApproval | null | undefined,
): string | null {
  if (!approval) return null;
  const next = approval.version + 1;
  const current = approval.reviews.filter((r) => r.pinnedVersion === approval.version);
  const approved = current.find((r) => r.status === "approved");
  if (approved) {
    const by = approved.approvedBy.length > 0 ? ` by ${joinNames(approved.approvedBy)}` : "";
    return `Approved as v${approved.pinnedVersion}${by}; saving creates v${next} and reopens review.`;
  }
  const inReview = current.find((r) => r.status === "in_review");
  if (inReview) {
    return `In review as v${inReview.pinnedVersion} ("${inReview.title}"); saving creates v${next}, and the reviewers keep deciding on v${inReview.pinnedVersion} unless the review is withdrawn and submitted again.`;
  }
  if (approval.reviewStatus === "approved") {
    return `Approved as v${approval.version}; saving creates v${next} and returns it to awaiting review.`;
  }
  return null;
}
