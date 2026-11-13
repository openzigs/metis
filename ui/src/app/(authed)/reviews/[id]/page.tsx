"use client";

/**
 * Epic #609 / Issue #618 — /reviews/[id]
 *
 * Review detail: header (status, policy, due date, requester), each scoped
 * item at its pinned version with a field-level diff, the reviewer panel, and
 * — for the caller's own pending assignment — an approve/reject decision bar.
 *
 * Decisions apply optimistically (the caller's assignment flips immediately),
 * roll back on error, and the final state transition is reflected from the
 * server response + a refetch — no reload required.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReviewChangedEvent } from "@metis/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useSocket } from "@/lib/socket-client";
import { keepSubscribed } from "@/lib/socket-subscription";
import { projectJoin } from "@/lib/socket-rooms";
import { queryKeys } from "@/lib/query-keys";
import { reviewGateApi } from "@/lib/publishing-api";
import { reviewGateKey } from "@/lib/query-keys";
import {
  reviewsApi,
  type ReviewDetail,
  type ReviewRequest,
  type ReviewerAssignment,
} from "@/lib/reviews-api";
import { DecisionBar } from "@/components/reviews/DecisionBar";
import { ReviewHeader } from "@/components/reviews/ReviewHeader";
import { ReviewItemCard } from "@/components/reviews/ReviewItemCard";
import { ReviewerPanel } from "@/components/reviews/ReviewerPanel";
import { canWithdrawReview, WithdrawReviewButton } from "@/components/reviews/WithdrawReviewButton";
import {
  canRequestReReview,
  RequestReReviewButton,
} from "@/components/reviews/RequestReReviewButton";
import {
  canResubmitReview,
  canReviseReview,
  RejectedReviewNotice,
  ResubmitReviewButton,
  ReviseReviewButton,
} from "@/components/reviews/revise-and-resubmit";

/**
 * The caller's own assignment, or null. Exported for unit testing.
 */
export function findMyAssignment(
  review: ReviewRequest,
  userId: string | null,
): ReviewerAssignment | null {
  if (!userId) return null;
  return review.assignments.find((a) => a.reviewerId === userId) ?? null;
}

/**
 * True when the caller may record a decision right now: they hold a pending
 * assignment, the review is in_review, and they are not the requester
 * (mirrors the server's SELF_APPROVAL_FORBIDDEN guard). #2436 — the requester
 * may when `selfApprovalAllowed`: the project allows self-approval and they
 * hold `requirement.approve`, as the server requires. Exported for testing.
 */
export function canDecide(
  review: ReviewRequest,
  userId: string | null,
  selfApprovalAllowed = false,
): boolean {
  const mine = findMyAssignment(review, userId);
  return (
    mine !== null &&
    mine.decision === "pending" &&
    review.status === "in_review" &&
    (review.requestedById !== userId || selfApprovalAllowed)
  );
}

export default function ReviewDetailPage() {
  const params = useParams<{ id: string }>();
  const reviewId = String(params?.id ?? "");
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const qc = useQueryClient();
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const detailKey = queryKeys.reviews.detail(reviewId);
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => reviewsApi.get(reviewId),
    enabled: reviewId !== "",
  });

  const review = detail.data?.review;
  const projectId = review?.projectId ?? null;

  // #1574 — while the page is open, re-read the review when anyone submits,
  // decides, withdraws or closes it: the requester watching it sees the
  // decision without a reload. The push goes to the `project:{id}` room and
  // carries identifiers only; the re-read is the permission-checked REST route.
  const socket = useSocket();
  useEffect(() => {
    if (!socket || !projectId || !reviewId) return;
    const key = queryKeys.reviews.detail(reviewId);
    const refresh = () => void qc.invalidateQueries({ queryKey: key });
    // #642 — re-join on reconnect; #646 — and re-read, for a push in the gap.
    const release = keepSubscribed(socket, projectJoin(socket, projectId), refresh);
    const onChanged = (event: ReviewChangedEvent) => {
      if (event.reviewId === reviewId) refresh();
    };
    socket.on("review:changed", onChanged);
    return () => {
      release();
      socket.off("review:changed", onChanged);
    };
  }, [socket, projectId, reviewId, qc]);

  const myAssignment = review ? findMyAssignment(review, userId) : null;

  // #2436 — a requester who is also an assigned reviewer may decide only where
  // the project allows self-approval and they hold `requirement.approve`.
  const canApprove = user?.permissions.includes("requirement.approve") ?? false;
  const ownRequest = review !== undefined && review.requestedById === userId;
  const gate = useQuery({
    queryKey: reviewGateKey(projectId ?? ""),
    queryFn: () => reviewGateApi.get(projectId!),
    enabled: Boolean(projectId) && ownRequest && canApprove && myAssignment !== null,
  });
  const selfApprovalAllowed = canApprove && gate.data?.allowSelfApproval === true;

  const decide = useMutation({
    mutationFn: (vars: { decision: "approved" | "rejected"; note?: string }) =>
      reviewsApi.decide(reviewId, vars.decision, vars.note),
    // Optimistic: flip the caller's own assignment immediately.
    onMutate: async (vars) => {
      setDecisionError(null);
      await qc.cancelQueries({ queryKey: detailKey });
      const previous = qc.getQueryData<ReviewDetail>(detailKey);
      if (previous && myAssignment) {
        qc.setQueryData<ReviewDetail>(detailKey, {
          ...previous,
          review: {
            ...previous.review,
            assignments: previous.review.assignments.map((a) =>
              a.id === myAssignment.id
                ? {
                    ...a,
                    decision: vars.decision,
                    note: vars.note ?? null,
                    decidedAt: new Date().toISOString(),
                  }
                : a,
            ),
          },
        });
      }
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(detailKey, ctx.previous);
      setDecisionError(
        err instanceof ApiError ? err.message : "Recording your decision failed — try again.",
      );
    },
    onSuccess: (result) => {
      // Reflect the aggregate state transition immediately, then refetch for
      // the authoritative assignments + audit history.
      qc.setQueryData<ReviewDetail>(detailKey, (current) =>
        current ? { ...current, review: { ...current.review, status: result.status } } : current,
      );
      void qc.invalidateQueries({ queryKey: queryKeys.reviews.all });
    },
  });

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="review-detail">
      <Link
        href="/reviews"
        className="text-sm text-muted-foreground underline-offset-2 hover:underline"
      >
        ← Back to reviews
      </Link>

      {detail.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading review…</p>
      ) : detail.isError || !review ? (
        <p className="text-sm text-destructive" role="alert">
          Failed to load review. It may have been deleted, or you may lack access.
        </p>
      ) : (
        <>
          {/* #1032 — offered only when the server would accept the withdraw. */}
          <ReviewHeader
            review={review}
            actions={
              canWithdrawReview(review, user) ? (
                <WithdrawReviewButton review={review} user={user} />
              ) : canRequestReReview(review, user) ? (
                <RequestReReviewButton review={review} user={user} />
              ) : canReviseReview(review, user) ? (
                <ReviseReviewButton review={review} />
              ) : canResubmitReview(review, user) ? (
                <ResubmitReviewButton review={review} />
              ) : undefined
            }
          />

          {/* #2347 — what was rejected and why, before the items. */}
          <RejectedReviewNotice review={review} />

          <section className="space-y-3" aria-label="Review scope">
            <h2 className="text-sm font-semibold">
              Scope ({review.items.length} item{review.items.length === 1 ? "" : "s"})
            </h2>
            {review.items.map((item) => (
              <ReviewItemCard key={item.id} item={item} reviewStatus={review.status} />
            ))}
          </section>

          <ReviewerPanel assignments={review.assignments} currentUserId={userId} />

          {canDecide(review, userId, selfApprovalAllowed) ? (
            <DecisionBar
              pending={decide.isPending}
              error={decisionError}
              onDecide={(decision, note) => decide.mutate({ decision, note })}
            />
          ) : review.status === "draft" ? (
            <p className="text-sm text-muted-foreground">
              This review is a draft and has not been submitted for review yet.
              {canResubmitReview(review, user)
                ? " Revise its requirements, then submit it with the button above."
                : ""}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
