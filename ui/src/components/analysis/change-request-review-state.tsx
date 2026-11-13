"use client";

/**
 * Issue #2343 (epic #2328) — the change request's formal review as a state on
 * the change request itself: "Review assigned to you" for a reviewer whose
 * decision it waits on, "Your review request was rejected" for the analyst
 * who asked for it, and otherwise where the review stands. Each links to the
 * review, the page where it is acted on.
 *
 * The facts come from `GET …/analyses/:id/review-state`, which reads them for
 * the caller and filters on the project and run. A failed or refused read
 * shows nothing: this is a signpost, not a claim that there is no review.
 * Titles render as React text, never markup. It re-reads when a review is
 * decided or changes (`review:changed`, `review:notification`), so a
 * rejection shows without a reload.
 */
import { useEffect } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ClipboardCheck } from "lucide-react";
import { analysisApi, type ChangeRequestReviewState } from "@/lib/analysis-api";
import { useSocket } from "@/lib/socket-client";

/** Each standing review status in words, for the analyst who asked for it. */
export const REVIEW_STATUS_LABELS: Record<
  NonNullable<ChangeRequestReviewState["review"]>["status"],
  string
> = {
  draft: "Review requested (not sent yet)",
  in_review: "In review",
  approved: "Review approved",
  rejected: "Review rejected",
};

export function reviewHref(reviewId: string): string {
  return `/reviews/${encodeURIComponent(reviewId)}`;
}

interface Signal {
  key: string;
  label: string;
  title: string;
  reviewId: string;
  needsYou: boolean;
}

/** What the change request says about its review, most pressing first. */
export function reviewSignals(state: ChangeRequestReviewState): Signal[] {
  const out: Signal[] = [];
  if (state.assignedToMe) {
    out.push({
      key: "assigned",
      label: "Review assigned to you",
      title: state.assignedToMe.title,
      reviewId: state.assignedToMe.id,
      needsYou: true,
    });
  }
  // The caller's own rejected request, even when someone else's review of the
  // change request is newer (`review` is the latest of anyone's) — unless that
  // newer review was approved: the change request is settled, as Home reads it
  // (latest review wins, #2348), and no longer needs the analyst.
  const mine = state.mine;
  const settledSince = state.review?.status === "approved" && state.review.id !== mine?.id;
  const mineRejected =
    mine && mine.status === "rejected" && mine.id !== state.assignedToMe?.id && !settledSince
      ? mine
      : null;
  if (mineRejected) {
    out.push({
      key: "rejected",
      label: "Your review request was rejected",
      title: mineRejected.title,
      reviewId: mineRejected.id,
      needsYou: true,
    });
  }
  const review = state.review;
  if (review && review.id !== state.assignedToMe?.id && review.id !== mineRejected?.id) {
    const rejectedMine = review.status === "rejected" && review.requestedByMe;
    const key = rejectedMine ? "rejected" : review.status;
    out.push({
      // Someone else's rejected review beside my own rejection: a key of its own.
      key: out.some((s) => s.key === key) ? `${key}-latest` : key,
      label: rejectedMine
        ? "Your review request was rejected"
        : REVIEW_STATUS_LABELS[review.status],
      title: review.title,
      reviewId: review.id,
      needsYou: rejectedMine,
    });
  }
  return out;
}

interface Props {
  projectId: string;
  analysisId: string;
}

export function ChangeRequestReviewState({ projectId, analysisId }: Props) {
  const query = useQuery({
    queryKey: ["analyses", analysisId, "review-state", projectId],
    queryFn: () => analysisApi.reviewState(projectId, analysisId),
    retry: false,
  });
  // A review decided or changed elsewhere (a rejection of my request, a new
  // assignment) re-reads the state, so it shows without a reload.
  const qc = useQueryClient();
  const socket = useSocket();
  useEffect(() => {
    if (!socket) return;
    const refresh = () =>
      void qc.invalidateQueries({ queryKey: ["analyses", analysisId, "review-state", projectId] });
    socket.on("review:notification", refresh);
    socket.on("review:changed", refresh);
    return () => {
      socket.off("review:notification", refresh);
      socket.off("review:changed", refresh);
    };
  }, [socket, qc, analysisId, projectId]);
  if (!query.isSuccess || !query.data) return null;
  const signals = reviewSignals(query.data);
  if (signals.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="change-request-review-state">
      {signals.map((s) => {
        const Icon = s.needsYou ? AlertCircle : ClipboardCheck;
        return (
          <li
            key={s.key}
            data-testid={`change-request-review-${s.key}`}
            className={
              "flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-xs " +
              (s.needsYou
                ? "border-warning/60 text-warning"
                : "border-border text-muted-foreground")
            }
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span className="font-medium">{s.label}</span>
            <span className="min-w-0 break-words text-foreground">{s.title}</span>
            <Link
              href={reviewHref(s.reviewId)}
              className="text-primary underline-offset-2 hover:underline"
            >
              Open review
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
