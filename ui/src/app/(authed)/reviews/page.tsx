"use client";

/**
 * Epic #609 / Issue #618 — /reviews
 *
 * Reviewer queue: reviews assigned to me and reviews I requested, with
 * status + due-date badges. Rows link to the detail view (/reviews/[id]).
 */
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { reviewsApi, type ReviewRequest } from "@/lib/reviews-api";
import { queryKeys } from "@/lib/query-keys";
import { DueDateBadge, ReviewStatusBadge } from "@/components/reviews/review-badges";

const TABS = ["assigned", "requested"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  assigned: "Assigned to me",
  requested: "Requested by me",
};

const EMPTY_MESSAGES: Record<Tab, string> = {
  assigned: "No reviews assigned to you.",
  requested: "You haven't requested any reviews yet.",
};

/** Query filters per tab — identity resolves server-side from the session. */
function tabFilters(tab: Tab): { assignee?: "me"; requester?: "me" } {
  return tab === "assigned" ? { assignee: "me" } : { requester: "me" };
}

export default function ReviewsPage() {
  const [tab, setTab] = useState<Tab>("assigned");

  const list = useQuery({
    queryKey: queryKeys.reviews.list({ tab }),
    queryFn: () => reviewsApi.list({ ...tabFilters(tab), pageSize: 50 }),
  });

  const reviews = list.data?.reviews ?? [];

  return (
    <div className="space-y-6 p-2 md:p-0">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        <p className="text-sm text-muted-foreground">
          Formal review &amp; approval requests for requirements and specs. Approvals of requirement
          scopes create a baseline automatically.
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Review queues">
        {TABS.map((t) => (
          <Button
            key={t}
            variant={t === tab ? "default" : "outline"}
            size="sm"
            onClick={() => setTab(t)}
            data-testid={`reviews-tab-${t}`}
            role="tab"
            aria-selected={t === tab}
          >
            {TAB_LABELS[t]}
          </Button>
        ))}
      </div>

      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading reviews…</p>
      ) : list.isError ? (
        <p className="text-sm text-destructive" role="alert">
          Failed to load reviews. Please try again.
        </p>
      ) : reviews.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">{EMPTY_MESSAGES[tab]}</Card>
      ) : (
        <ul className="space-y-2" aria-label={TAB_LABELS[tab]}>
          {reviews.map((review) => (
            <li key={review.id}>
              <Link
                href={`/reviews/${review.id}`}
                data-testid={`review-row-${review.id}`}
                className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="space-y-1 p-4 transition hover:border-primary/60">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{review.title}</span>
                    <ReviewStatusBadge status={review.status} />
                    <DueDateBadge dueAt={review.dueAt} status={review.status} />
                  </div>
                  <p className="text-xs text-muted-foreground">{summarize(review)}</p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One-line row summary: scope size, decision progress, requester, updated. */
export function summarize(review: ReviewRequest): string {
  const decided = review.assignments.filter((a) => a.decision !== "pending").length;
  const parts = [
    `${review.items.length} item${review.items.length === 1 ? "" : "s"}`,
    `${decided}/${review.assignments.length} decisions`,
    `requested by ${review.requestedBy.displayName}`,
  ];
  const updated = new Date(review.updatedAt);
  if (!Number.isNaN(updated.getTime())) {
    parts.push(`updated ${updated.toLocaleDateString()}`);
  }
  return parts.join(" · ");
}
