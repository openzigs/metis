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
 *   - the review is `in_review` (the only status with a `withdraw` transition);
 *   - #1575 — the caller is not one of its assigned reviewers (a requester
 *     never is): a reviewer decides the review, and `review.admin` does not let
 *     them cancel it instead.
 * The check here is a convenience, not the control: a review can be decided
 * between the page loading and the click, so every refusal code is turned into
 * a sentence and the review is re-read.
 */
import { useEffect, useRef, useState } from "react";
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
  review: Pick<ReviewRequest, "status" | "requestedById" | "assignments">,
  user: Pick<AuthUser, "id" | "role"> | null | undefined,
): boolean {
  if (!user || review.status !== "in_review") return false;
  if (!hasPermission(user.role, "review.create")) return false;
  if (review.requestedById === user.id) return true;
  // #1575 — an assigned reviewer is asked to decide, not to withdraw.
  if (review.assignments.some((a) => a.reviewerId === user.id)) return false;
  return hasPermission(user.role, "review.admin");
}

/** The server's refusal, as a sentence the person can act on. */
export function withdrawErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "ILLEGAL_REVIEW_TRANSITION":
        return "This review is no longer in review, so there is nothing to withdraw. Its current status is shown now.";
      case "REVIEW_STATE_CHANGED":
        return "The review changed while it was being withdrawn. Check its status and try again.";
      case "REVIEWER_CANNOT_WITHDRAW":
        return "You are a reviewer of this review, so you cannot withdraw it. Approve or reject it instead.";
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
  review: Pick<ReviewRequest, "id" | "title" | "status" | "requestedById" | "assignments">;
  user: Pick<AuthUser, "id" | "role"> | null | undefined;
}

/**
 * Where keyboard focus goes once the withdraw has gone through and the button
 * has unmounted (the review is no longer in review). Focus left on an unmounted
 * element falls to the document body, which loses a keyboard or screen-reader
 * user's place. In a list row the target is the row's own link; on the review
 * page it is the page heading.
 */
export function withdrawFocusTarget(from: HTMLElement | null): HTMLElement | null {
  if (!from) return null;
  return (
    from.closest("li")?.querySelector<HTMLElement>("a[href]") ??
    document.querySelector<HTMLElement>("h1")
  );
}

function focusElement(target: HTMLElement): void {
  if (!target.isConnected) return;
  // A heading is not focusable until it is given a tabindex; -1 keeps it out
  // of the tab order.
  if (target.tagName === "H1" && !target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
  }
  target.focus();
}

/** Renders nothing when the caller may not withdraw this review. */
export function WithdrawReviewButton({ review, user }: WithdrawReviewButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  /** Set when a withdraw succeeds; used once, when the button then goes away. */
  const focusNext = useRef<HTMLElement | null>(null);
  const qc = useQueryClient();
  const withdraw = useAppMutation<ReviewRequest, void>({
    mutationFn: () => reviewsApi.withdraw(review.id),
    successMessage: `Review withdrawn: "${review.title}". Requirement statuses were put back.`,
    errorMessage: withdrawErrorMessage,
    // The withdraw moves requirement statuses, which the requirements hub
    // reads from the analysis (same as the submit, #989).
    invalidateKeys: [queryKeys.reviews.all, queryKeys.analyses.all],
    // Found now, while the button is still in the page to find it from.
    onSuccess: () => {
      focusNext.current = withdrawFocusTarget(anchor.current);
    },
    // A refusal usually means the review is not what this page shows any more,
    // so re-read it: the button then follows the real status.
    onError: () => void qc.invalidateQueries({ queryKey: queryKeys.reviews.all }),
  });

  const offered = canWithdrawReview(review, user);
  // Moved when the button unmounts, not when the request returns: the
  // confirmation dialog hands focus back to the button as it closes, and that
  // can land after the request has returned.
  useEffect(() => {
    if (offered || !focusNext.current) return;
    focusElement(focusNext.current);
    focusNext.current = null;
  }, [offered]);
  // The review page stops rendering this component altogether once the review
  // is not in review, so the same move is made when it unmounts.
  useEffect(
    () => () => {
      if (focusNext.current) focusElement(focusNext.current);
    },
    [],
  );

  if (!offered) return null;

  return (
    <>
      <span ref={anchor} className="inline-flex shrink-0">
        <Button
          variant="outline"
          size="sm"
          disabled={withdraw.isPending}
          onClick={() => setConfirming(true)}
          data-testid={`withdraw-review-${review.id}`}
        >
          {withdraw.isPending ? "Withdrawing…" : "Withdraw review"}
        </Button>
      </span>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Withdraw "${review.title}"?`}
        description={
          "The review goes back to a draft and its reviewers can no longer decide on it. " +
          "Each requirement gets back the review status it had before the review was requested, " +
          "unless someone has changed it since. A requirement another open review still covers " +
          "keeps waiting for that review. To ask again, request a new review from the " +
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
