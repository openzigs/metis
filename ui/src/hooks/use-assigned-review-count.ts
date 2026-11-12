"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reviewsApi } from "@/lib/reviews-api";
import { queryKeys } from "@/lib/query-keys";
import { useSocket } from "@/lib/socket-client";

/** The sidebar's count query; under `reviews.all`, so every review mutation refreshes it. */
export const ASSIGNED_REVIEW_COUNT_KEY = queryKeys.reviews.list({
  assignee: "me",
  status: "in_review",
  countOnly: true,
});

/** Fallback for a decision this user's socket does not hear (another reviewer's, elsewhere). */
const REFRESH_MS = 60_000;

/**
 * #2332 — how many reviews are waiting on me: in review, with me among the
 * assigned reviewers. The same filter the Reviews page's "Assigned to me" tab
 * uses, plus the in-review status, so a decided or withdrawn review drops off.
 * Reads the list's `total` with a page of one, so it costs one row.
 *
 * Refreshes when this user is assigned (`review:notification`, sent to their
 * own room), when a review in a project room they have joined changes state
 * (`review:changed`), on any review mutation in this tab (they invalidate
 * `reviews.all`), and every minute otherwise. `undefined` until it first loads
 * and on an error, so the caller shows no number rather than a wrong one.
 */
export function useAssignedReviewCount(): number | undefined {
  const qc = useQueryClient();
  const socket = useSocket();

  const query = useQuery({
    queryKey: ASSIGNED_REVIEW_COUNT_KEY,
    queryFn: async () =>
      (await reviewsApi.list({ assignee: "me", status: "in_review", pageSize: 1 })).total,
    refetchInterval: REFRESH_MS,
  });

  useEffect(() => {
    if (!socket) return;
    const refresh = () => void qc.invalidateQueries({ queryKey: ASSIGNED_REVIEW_COUNT_KEY });
    socket.on("review:notification", refresh);
    socket.on("review:changed", refresh);
    return () => {
      socket.off("review:notification", refresh);
      socket.off("review:changed", refresh);
    };
  }, [socket, qc]);

  return query.isError ? undefined : query.data;
}
