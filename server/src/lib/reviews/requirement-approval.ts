/**
 * Issue #2219 — the approval state an edit of a requirement would reopen, read
 * for the Edit dialog's warning (`GET /api/requirements/:id/approval`).
 *
 * Lists every APPROVED or IN-REVIEW review that pinned the requirement, with
 * the reviewers who approved its current round. Scoped: the requirement is
 * looked up with the caller's project (when the caller is narrowed to one) and
 * only reviews of the requirement's own project are read, so another tenant's
 * review is never listed.
 */
import type { RequirementApproval, RequirementApprovalReview } from "@metis/shared";
import { prisma } from "../prisma.js";
import { heldReviewStatus } from "./review-service.js";

/** Review statuses whose pinned version an edit makes out of date. */
const PINNING_STATUSES = ["approved", "in_review"] as const;

/**
 * The requirement's approval state, or null when it does not exist (or lies
 * outside `projectId`).
 */
export async function readRequirementApproval(
  requirementId: string,
  projectId: string | undefined,
): Promise<RequirementApproval | null> {
  const requirement = await prisma.requirement.findFirst({
    where: { id: requirementId, deletedAt: null, ...(projectId ? { projectId } : {}) },
    select: { id: true, projectId: true, version: true, reviewStatus: true, labels: true },
  });
  if (!requirement) return null;

  const items = await prisma.reviewRequestItem.findMany({
    where: {
      requirementId,
      reviewRequest: {
        projectId: requirement.projectId,
        status: { in: [...PINNING_STATUSES] },
      },
    },
    select: {
      pinnedVersion: true,
      reviewRequest: {
        select: {
          id: true,
          title: true,
          status: true,
          assignments: {
            where: { decision: "approved" },
            select: { reviewer: { select: { displayName: true, username: true } } },
            orderBy: { decidedAt: "asc" },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const reviews: RequirementApprovalReview[] = items.map((item) => ({
    id: item.reviewRequest.id,
    title: item.reviewRequest.title,
    status: item.reviewRequest.status as RequirementApprovalReview["status"],
    pinnedVersion: item.pinnedVersion,
    approvedBy: item.reviewRequest.assignments.map(
      (a) => a.reviewer.displayName || a.reviewer.username,
    ),
  }));

  return {
    requirementId: requirement.id,
    version: requirement.version,
    reviewStatus: heldReviewStatus(requirement.reviewStatus, requirement.labels),
    reviews,
  };
}
