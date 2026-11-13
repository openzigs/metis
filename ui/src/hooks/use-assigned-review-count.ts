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
  decision: "pending",
  countOnly: true,
});

/**
 * Fallback for a change this user's socket does not hear: a dropped
 * connection, and count changes no event announces (their removal from a
 * project's workspace, a project soft-delete).
 */
const REFRESH_MS = 60_000;

/**
 * #2332 — how many reviews are waiting on me: in review, with my own decision
 * on it still pending (#2370). In a multi-reviewer review, deciding takes it
 * off my count while the others have not decided. The server builds that
 * filter from the predicate Home's "My work" uses (`awaitingDecisionWhere`,
 * #2348), so the two counts agree. Reads the list's `total` with a page of
 * one, so it costs one row.
 *
 * Refreshes when this user is assigned (`review:notification`, sent to their
 * own room), when a review they are a reviewer of changes state
 * (`review:changed`, sent to each reviewer's own room as well as the
 * project's, #2370), on any review mutation in this tab (they invalidate
 * `reviews.all`), and every minute otherwise. `undefined` until it first loads
 * and on an error, so the caller shows no number rather than a wrong one.
 */
export function useAssignedReviewCount(): number | undefined {
  const qc = useQueryClient();
  const socket = useSocket();

  const query = useQuery({
    queryKey: ASSIGNED_REVIEW_COUNT_KEY,
    queryFn: async () =>
      (
        await reviewsApi.list({
          assignee: "me",
          status: "in_review",
          decision: "pending",
          pageSize: 1,
        })
      ).total,
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

  // After a failed re-read `data` still holds the last number: show none.
  return query.isError ? undefined : query.data;
}
