/**
 * Epic #609 / Issue #618 — review detail header: title, status, policy, due
 * date, requester, and (post-approval) the produced baseline.
 *
 * #2224 — the header says when requirements changed since their pin: the
 * status still reads "Approved", and the only other signal was inside each
 * item card, below the fold on a long review.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import type { ReviewPolicy, ReviewRequest } from "@/lib/reviews-api";
import { DueDateBadge, ReviewStatusBadge } from "./review-badges";
import { outOfDateVersion } from "./ReviewItemCard";
import { PageHeader } from "@/components/ui/page-header";

/** Human-readable decision-policy summary. Exported for unit testing. */
export function policyLabel(
  policy: ReviewPolicy,
  quorum: number | null,
  reviewerCount: number,
): string {
  if (policy === "quorum") {
    return `Quorum: ${quorum ?? "?"} of ${reviewerCount} approvals required`;
  }
  return "All reviewers must approve";
}

/**
 * #2224 — "1 requirement changed since approval", or null when every pin is
 * current (or the review no longer stands on its pins). Exported for testing.
 */
export function outOfDateSummary(review: Pick<ReviewRequest, "items" | "status">): string | null {
  const count = review.items.filter(
    (item) => outOfDateVersion(item, review.status) !== null,
  ).length;
  if (count === 0) return null;
  const noun = count === 1 ? "requirement" : "requirements";
  return review.status === "approved"
    ? `${count} ${noun} changed since approval.`
    : `${count} ${noun} changed since this review was submitted; the reviewers are deciding on the earlier wording.`;
}

export function ReviewHeader({
  review,
  actions,
}: {
  review: ReviewRequest;
  /** Page-level actions for this review, e.g. Withdraw review (#1032). */
  actions?: ReactNode;
}) {
  const outOfDate = outOfDateSummary(review);
  return (
    <PageHeader
      data-testid="review-header"
      title={review.title}
      actions={actions}
      titleExtra={
        <>
          <ReviewStatusBadge status={review.status} />
          <DueDateBadge dueAt={review.dueAt} status={review.status} />
        </>
      }
      description={
        <>
          Requested by {review.requestedBy.displayName} ·{" "}
          {policyLabel(review.policy, review.quorum, review.assignments.length)}
        </>
      }
    >
      {review.description ? (
        <p className="text-sm text-foreground/90">{review.description}</p>
      ) : null}
      {outOfDate ? (
        <p
          role="status"
          className="rounded-md border border-warning/40 bg-warning-muted px-3 py-2 text-sm"
          data-testid="review-out-of-date-banner"
        >
          {outOfDate}
        </p>
      ) : null}
      {review.baseline ? (
        <p className="text-xs text-muted-foreground">
          {/* #2224 — a re-review keeps the earlier round's baseline linked
          until its own approval replaces it. */}
          {review.status === "approved"
            ? "Baseline created on approval: "
            : "Baseline from the earlier approval: "}
          <Link
            href={`/projects/${review.projectId}/baselines/${review.baseline.id}`}
            className="font-medium underline-offset-2 hover:underline"
          >
            {review.baseline.name}
          </Link>
        </p>
      ) : null}
    </PageHeader>
  );
}
