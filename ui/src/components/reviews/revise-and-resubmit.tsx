"use client";

/**
 * Issue #2347 — after a rejection, the author sees what was rejected and why,
 * and a clear way forward on the review itself (#2330 live: a rejected review
 * page had no action at all for its author).
 *
 * - {@link RejectedReviewNotice}: every requirement in a rejected review is
 *   now rejected (approved ones included), with each rejecting reviewer's
 *   reason.
 * - {@link ReviseReviewButton}: "Revise and resubmit" sends the review back to
 *   draft with the same items and reviewers (`POST /api/reviews/:id/revise`).
 * - {@link ResubmitReviewButton}: on that draft, submits it again
 *   (`POST /api/reviews/:id/submit`), which re-pins the requirements at their
 *   revised versions and asks every reviewer again.
 *
 * Offered only when the server would accept it: the caller's role holds
 * `review.create`, and they requested the review or hold `review.admin`
 * without being one of its reviewers (as withdraw, #1575). The check is a
 * convenience, not the control; a refusal is turned into a sentence.
 */
import { hasPermission } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client";
import type { AuthUser } from "@/lib/auth-types";
import { queryKeys } from "@/lib/query-keys";
import { reviewsApi, type ReviewRequest } from "@/lib/reviews-api";
import { resolveErrorMessage, useAppMutation } from "@/lib/use-app-mutation";

type Revisable = Pick<ReviewRequest, "status" | "requestedById" | "assignments">;

function mayChangeRound(review: Revisable, user: Pick<AuthUser, "id" | "role">): boolean {
  if (!hasPermission(user.role, "review.create")) return false;
  if (review.requestedById === user.id) return true;
  if (review.assignments.some((a) => a.reviewerId === user.id)) return false;
  return hasPermission(user.role, "review.admin");
}

/** Whether the server would accept "Revise and resubmit" of `review` from `user`. */
export function canReviseReview(
  review: Revisable,
  user: Pick<AuthUser, "id" | "role"> | null | undefined,
): boolean {
  return Boolean(user) && review.status === "rejected" && mayChangeRound(review, user!);
}

/** Whether the server would accept a (re)submit of the draft `review` from `user`. */
export function canResubmitReview(
  review: Revisable,
  user: Pick<AuthUser, "id" | "role"> | null | undefined,
): boolean {
  return Boolean(user) && review.status === "draft" && mayChangeRound(review, user!);
}

/** The server's refusal, as a sentence the person can act on. */
export function roundErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "ILLEGAL_REVIEW_TRANSITION":
      case "REVIEW_STATE_CHANGED":
        return "The review changed meanwhile. Its current status is shown now.";
      case "REVIEW_SCOPE_STALE":
        return "A requirement in this review no longer exists. Request a new review from the Requirements tab.";
      case "NOT_REQUESTER":
        return "Only the person who requested this review, or a review administrator, can do this.";
      case "FORBIDDEN":
        return "Your role is not allowed to request reviews.";
    }
  }
  return resolveErrorMessage(error, fallback);
}

export function RejectedReviewNotice({
  review,
}: {
  review: Pick<ReviewRequest, "status" | "items" | "assignments">;
}) {
  if (review.status !== "rejected") return null;
  const reasons = review.assignments.filter((a) => a.decision === "rejected");
  const count = review.items.length;
  return (
    <section
      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
      aria-label="Why this review was rejected"
      data-testid="review-rejected-notice"
    >
      <p className="font-medium">
        This review was rejected, so all {count} item{count === 1 ? "" : "s"} in it{" "}
        {count === 1 ? "is" : "are"} rejected, including any that were already approved.
      </p>
      {reasons.length > 0 ? (
        <ul className="space-y-1">
          {reasons.map((a) => (
            <li key={a.id} data-testid={`review-rejected-reason-${a.reviewerId}`}>
              <span className="font-medium">{a.reviewer.displayName}</span>:{" "}
              {a.note?.trim() ? a.note : "No reason given."}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Revise and resubmit puts the same items back in a draft for the same reviewers: edit the
        requirements, then resubmit.
      </p>
    </section>
  );
}

const INVALIDATE = [queryKeys.reviews.all, queryKeys.analyses.all];

export function ReviseReviewButton({ review }: { review: Pick<ReviewRequest, "id" | "title"> }) {
  const revise = useAppMutation<ReviewRequest, void>({
    mutationFn: () => reviewsApi.revise(review.id),
    successMessage:
      "Back in draft with the same requirements and reviewers. Edit the requirements, then resubmit.",
    errorMessage: (err) => roundErrorMessage(err, "Revising the review failed. Try again."),
    invalidateKeys: INVALIDATE,
  });
  return (
    <Button
      size="sm"
      disabled={revise.isPending}
      onClick={() => revise.mutate()}
      data-testid={`revise-review-${review.id}`}
    >
      {revise.isPending ? "Revising…" : "Revise and resubmit"}
    </Button>
  );
}

export function ResubmitReviewButton({ review }: { review: Pick<ReviewRequest, "id" | "title"> }) {
  const submit = useAppMutation<ReviewRequest, void>({
    mutationFn: () => reviewsApi.submit(review.id),
    successMessage: `Resubmitted "${review.title}". The reviewers have been asked again.`,
    errorMessage: (err) => roundErrorMessage(err, "Resubmitting the review failed. Try again."),
    invalidateKeys: INVALIDATE,
  });
  return (
    <Button
      size="sm"
      disabled={submit.isPending}
      onClick={() => submit.mutate()}
      data-testid={`resubmit-review-${review.id}`}
    >
      {submit.isPending ? "Resubmitting…" : "Resubmit for review"}
    </Button>
  );
}
