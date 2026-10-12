"use client";

/**
 * #1032 — withdraw a review from the UI.
 *
 * The Request review form says "Withdrawing the review puts every status back",
 * and the server has done that since #989 (`POST /api/reviews/:id/withdraw`),
 * but nothing in the UI called it. This is the one control, used on the review
 * page and on each /reviews row.
 *
 * It is shown only when the server would accept the request. The server's rule
 * (`routes/reviews.ts`, `review-service.ts`, `state-machine.ts`) is:
 *   - the caller's role holds `review.create`;
 *   - the caller requested the review, or their role holds `review.admin`;
 *   - the review is `in_review` (the only status with a `withdraw` transition).
 * The check here is a convenience, not the control: a review can be decided
 * between the page loading and the click, so every refusal code is turned into
 * a sentence and the review is re-read.
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

/** Whether the server would accept a withdraw of `review` from `user` right now. */
export function canWithdrawReview(
  review: Pick<ReviewRequest, "status" | "requestedById">,
  user: Pick<AuthUser, "id" | "role"> | null | undefined,
): boolean {
  if (!user || review.status !== "in_review") return false;
  if (!hasPermission(user.role, "review.create")) return false;
  return review.requestedById === user.id || hasPermission(user.role, "review.admin");
}

/** The server's refusal, as a sentence the person can act on. */
export function withdrawErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "ILLEGAL_REVIEW_TRANSITION":
        return "This review is no longer in review, so there is nothing to withdraw. Its current status is shown now.";
      case "REVIEW_STATE_CHANGED":
        return "The review changed while it was being withdrawn. Check its status and try again.";
      case "NOT_REQUESTER":
        return "Only the person who requested this review, or a review administrator, can withdraw it.";
      case "REVIEW_NOT_FOUND":
        return "This review no longer exists, or you no longer have access to it.";
      case "FORBIDDEN":
        return "Your role is not allowed to withdraw reviews.";
    }
  }
  return resolveErrorMessage(error, "Withdrawing the review failed. Try again.");
}

export interface WithdrawReviewButtonProps {
  review: Pick<ReviewRequest, "id" | "title" | "status" | "requestedById">;
  user: Pick<AuthUser, "id" | "role"> | null | undefined;
}

/** Renders nothing when the caller may not withdraw this review. */
export function WithdrawReviewButton({ review, user }: WithdrawReviewButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const qc = useQueryClient();
  const withdraw = useAppMutation<ReviewRequest, void>({
    mutationFn: () => reviewsApi.withdraw(review.id),
    successMessage: `Review withdrawn: "${review.title}". Requirement statuses were put back.`,
    errorMessage: withdrawErrorMessage,
    // The withdraw moves requirement statuses, which the requirements hub
    // reads from the analysis (same as the submit, #989).
    invalidateKeys: [queryKeys.reviews.all, queryKeys.analyses.all],
    // A refusal usually means the review is not what this page shows any more,
    // so re-read it: the button then follows the real status.
    onError: () => void qc.invalidateQueries({ queryKey: queryKeys.reviews.all }),
  });

  if (!canWithdrawReview(review, user)) return null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={withdraw.isPending}
        onClick={() => setConfirming(true)}
        data-testid={`withdraw-review-${review.id}`}
      >
        {withdraw.isPending ? "Withdrawing…" : "Withdraw review"}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Withdraw "${review.title}"?`}
        description={
          "The review goes back to a draft and its reviewers can no longer decide on it. " +
          "Each requirement gets back the review status it had before the review was requested, " +
          "unless someone has changed it since. To ask again, request a new review from the " +
          "project's Requirements page."
        }
        confirmLabel="Withdraw review"
        onConfirm={() => {
          setConfirming(false);
          withdraw.mutate();
        }}
      />
    </>
  );
}
