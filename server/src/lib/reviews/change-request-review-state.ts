/**
 * Issue #2343 (epic #2328) — where a change request stands with its formal
 * review, for the change request's own page.
 *
 * Two facts, both read for the caller:
 *
 * - `review`: the LATEST non-closed review covering any of the run's live
 *   requirements (the rule `deriveChangeRequestState` uses for Home, #2348),
 *   with whether the caller requested it. Its `status` says requested (a
 *   draft), in review, approved or rejected;
 * - `assignedToMe`: the most recent review covering the run that is waiting
 *   on the caller's own decision (`awaitingDecisionWhere`, the sidebar's and
 *   Home's predicate), so a reviewer opening the change request sees "Review
 *   assigned to you".
 *
 * Access (OWASP A01): the route checks the caller may open the project and the
 * run belongs to it; every query here is filtered on the project id AND the
 * run id, so a review of another project can never be returned.
 */
import { prisma } from "../prisma.js";
import { awaitingDecisionWhere } from "./awaiting-decision.js";

/** Review statuses that can stand for a change request (a closed review does not). */
const STANDING_STATUSES = ["draft", "in_review", "rejected", "approved"] as const;

export interface ChangeRequestReviewState {
  review: {
    id: string;
    title: string;
    status: (typeof STANDING_STATUSES)[number];
    requestedByMe: boolean;
  } | null;
  assignedToMe: { id: string; title: string } | null;
}

export async function readChangeRequestReviewState(
  projectId: string,
  analysisId: string,
  userId: string,
): Promise<ChangeRequestReviewState> {
  const coversRun = {
    items: {
      some: { requirement: { is: { analysisId, projectId, deletedAt: null } } },
    },
  };
  const [latest, assigned] = await Promise.all([
    prisma.reviewRequest.findFirst({
      where: { projectId, status: { in: [...STANDING_STATUSES] }, ...coversRun },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, title: true, status: true, requestedById: true },
    }),
    prisma.reviewRequest.findFirst({
      where: { projectId, ...awaitingDecisionWhere(userId, {}), ...coversRun },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, title: true },
    }),
  ]);
  return {
    review: latest
      ? {
          id: latest.id,
          title: latest.title,
          status: latest.status as (typeof STANDING_STATUSES)[number],
          requestedByMe: latest.requestedById === userId,
        }
      : null,
    assignedToMe: assigned ? { id: assigned.id, title: assigned.title } : null,
  };
}
