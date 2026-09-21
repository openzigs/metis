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
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { queryKeys } from "@/lib/query-keys";
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
 * (mirrors the server's SELF_APPROVAL_FORBIDDEN guard). Exported for testing.
 */
export function canDecide(review: ReviewRequest, userId: string | null): boolean {
  const mine = findMyAssignment(review, userId);
  return (
    mine !== null &&
    mine.decision === "pending" &&
    review.status === "in_review" &&
    review.requestedById !== userId
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
  const myAssignment = review ? findMyAssignment(review, userId) : null;

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
          <ReviewHeader review={review} />

          <section className="space-y-3" aria-label="Review scope">
            <h2 className="text-sm font-semibold">
              Scope ({review.items.length} item{review.items.length === 1 ? "" : "s"})
            </h2>
            {review.items.map((item) => (
              <ReviewItemCard key={item.id} item={item} />
            ))}
          </section>

          <ReviewerPanel assignments={review.assignments} currentUserId={userId} />

          {canDecide(review, userId) ? (
            <DecisionBar
              pending={decide.isPending}
              error={decisionError}
              onDecide={(decision, note) => decide.mutate({ decision, note })}
            />
          ) : review.status === "draft" ? (
            <p className="text-sm text-muted-foreground">
              This review is a draft and has not been submitted for review yet.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
