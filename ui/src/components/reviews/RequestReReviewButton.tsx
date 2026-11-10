"use client";

/**
 * Issue #2219 — "Request re-review" on an approved review whose requirements
 * were edited after the approval.
 *
 * The approval is of the pinned wording; once a requirement has moved on, the
 * review page says "v2 differs from the approved v1" and this asks the
 * reviewers again (`POST /api/reviews/:id/reopen`): the review goes back to in
 * review on the current versions, every reviewer's decision is reset and they
 * are notified. The earlier baseline is kept.
 *
 * Offered only when the server would accept it (`routes/reviews.ts`,
 * `review-service.ts`): the caller's role holds `review.create`, they requested
 * the review or hold `review.admin`, and the review is `approved` — and only
 * when something actually changed since. The check is a convenience, not the
 * control; a refusal is turned into a sentence and the review is re-read.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hasPermission } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { ApiError } from "@/lib/api-client";
import type { AuthUser } from "@/lib/auth-types";
import { queryKeys } from "@/lib/query-keys";
import { reviewsApi, type ReviewRequest } from "@/lib/reviews-api";
import { resolveErrorMessage, useAppMutation } from "@/lib/use-app-mutation";
import { reviewOutOfDate } from "./ReviewItemCard";

type ReReviewable = Pick<ReviewRequest, "status" | "requestedById" | "items">;

/** Whether the server would accept a re-review of `review` from `user`, and it is needed. */
export function canRequestReReview(
  review: ReReviewable,
  user: Pick<AuthUser, "id" | "role"> | null | undefined,
): boolean {
  if (!user || review.status !== "approved" || !reviewOutOfDate(review)) return false;
  if (!hasPermission(user.role, "review.create")) return false;
  return review.requestedById === user.id || hasPermission(user.role, "review.admin");
}

/** The server's refusal, as a sentence the person can act on. */
export function reReviewErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "ILLEGAL_REVIEW_TRANSITION":
        return "This review is no longer approved, so it cannot be re-reviewed. Its current status is shown now.";
      case "REVIEW_STATE_CHANGED":
        return "The review changed while the re-review was being requested. Check its status and try again.";
      case "REVIEW_SCOPE_STALE":
        return "A requirement in this review no longer exists. Request a new review from the project's Requirements page.";
      case "NOT_REQUESTER":
        return "Only the person who requested this review, or a review administrator, can request a re-review.";
      case "REVIEW_NOT_FOUND":
        return "This review no longer exists, or you no longer have access to it.";
      case "FORBIDDEN":
        return "Your role is not allowed to request reviews.";
    }
  }
  return resolveErrorMessage(error, "Requesting the re-review failed. Try again.");
}

export interface RequestReReviewButtonProps {
  review: ReReviewable & Pick<ReviewRequest, "id" | "title">;
  user: Pick<AuthUser, "id" | "role"> | null | undefined;
}

/** Renders nothing when the caller may not, or need not, request a re-review. */
export function RequestReReviewButton({ review, user }: RequestReReviewButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const qc = useQueryClient();
  const reopen = useAppMutation<ReviewRequest, void>({
    mutationFn: () => reviewsApi.reopen(review.id),
    successMessage: `Re-review requested: "${review.title}". The reviewers have been asked again.`,
    errorMessage: reReviewErrorMessage,
    // Re-pinning moves requirement statuses the requirements hub reads.
    invalidateKeys: [queryKeys.reviews.all, queryKeys.analyses.all],
    onError: () => void qc.invalidateQueries({ queryKey: queryKeys.reviews.all }),
  });

  if (!canRequestReReview(review, user)) return null;

  return (
    <>
      <Button
        size="sm"
        disabled={reopen.isPending}
        onClick={() => setConfirming(true)}
        data-testid={`request-re-review-${review.id}`}
      >
        {reopen.isPending ? "Requesting…" : "Request re-review"}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Request a re-review of "${review.title}"?`}
        description={
          "The review goes back to in review on each requirement's current version. Every " +
          "reviewer's decision is cleared and they are asked again. The baseline created by the " +
          "earlier approval is kept, and the next approval creates a new one."
        }
        confirmLabel="Request re-review"
        onConfirm={() => {
          setConfirming(false);
          reopen.mutate();
        }}
      />
    </>
  );
}
