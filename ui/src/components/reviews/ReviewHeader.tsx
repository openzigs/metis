/**
 * Epic #609 / Issue #618 — review detail header: title, status, policy, due
 * date, requester, and (post-approval) the produced baseline.
 */
import Link from "next/link";
import type { ReviewPolicy, ReviewRequest } from "@/lib/reviews-api";
import { DueDateBadge, ReviewStatusBadge } from "./review-badges";

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

export function ReviewHeader({ review }: { review: ReviewRequest }) {
  return (
    <header className="space-y-2" data-testid="review-header">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{review.title}</h1>
        <ReviewStatusBadge status={review.status} />
        <DueDateBadge dueAt={review.dueAt} status={review.status} />
      </div>
      <p className="text-sm text-muted-foreground">
        Requested by {review.requestedBy.displayName} ·{" "}
        {policyLabel(review.policy, review.quorum, review.assignments.length)}
      </p>
      {review.description ? (
        <p className="text-sm text-foreground/90">{review.description}</p>
      ) : null}
      {review.baseline ? (
        <p className="text-xs text-muted-foreground">
          Baseline created on approval:{" "}
          <Link
            href={`/projects/${review.projectId}/baselines/${review.baseline.id}`}
            className="font-medium underline-offset-2 hover:underline"
          >
            {review.baseline.name}
          </Link>
        </p>
      ) : null}
    </header>
  );
}
