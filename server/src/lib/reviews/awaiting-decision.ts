/**
 * #2348 / #2370 — "a review waiting on my decision", as ONE predicate.
 *
 * Home's "Reviews assigned to me" (`GET /api/me/work`) and the review queue's
 * `GET /api/reviews?assignee=me&status=in_review&decision=pending` (the
 * sidebar's count, #2332) both build their `where` here, so the two counts
 * cannot drift apart:
 *
 * - the review is `in_review` (a draft, a verdict or a closed review asks
 *   nothing of anyone);
 * - the caller holds an assignment on it whose decision is still `pending`
 *   (in a multi-reviewer review, deciding takes it off your list even while
 *   the others have not);
 * - its project is one the caller can open (`projectScope`, the
 *   `workspaceScopeWhere` rule) and is not deleted, admins included.
 */
export function awaitingDecisionWhere(actorId: string, projectScope: Record<string, unknown>) {
  return {
    status: "in_review",
    project: { ...projectScope, deletedAt: null },
    assignments: { some: { reviewerId: actorId, decision: "pending" } },
  };
}
