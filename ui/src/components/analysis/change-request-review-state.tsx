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
 * Titles render as React text, never markup.
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ClipboardCheck } from "lucide-react";
import { analysisApi, type ChangeRequestReviewState } from "@/lib/analysis-api";

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
  const review = state.review;
  if (review && review.id !== state.assignedToMe?.id) {
    const rejectedMine = review.status === "rejected" && review.requestedByMe;
    out.push({
      key: rejectedMine ? "rejected" : review.status,
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
              {/* #2347 — a rejection of your own request is revised on the review. */}
              {s.key === "rejected" ? "Revise and resubmit" : "Open review"}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
