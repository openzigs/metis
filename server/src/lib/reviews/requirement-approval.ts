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
import type {
  RequirementApproval,
  RequirementApprovalReopened,
  RequirementApprovalReview,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { heldReviewStatus } from "./review-service.js";

/** Review statuses whose pinned version an edit makes out of date. */
const PINNING_STATUSES = ["approved", "in_review"] as const;

/**
 * #2224 — `rows` with `approvalReopened` set on each one that an APPROVED
 * review of `projectId` pinned at an older version and that is not approved
 * now: the edit since returned it to awaiting review, and its card says so
 * (with a link to the review) instead of reading "draft" like a requirement
 * nobody reviewed. The most recent such review is named. One read, filtered on
 * the project as well as the ids. Rows that do not qualify come back unchanged.
 */
export async function flagApprovalReopened<
  T extends { id: string; version: number; reviewStatus: string },
>(
  projectId: string,
  rows: T[],
): Promise<Array<T & { approvalReopened?: RequirementApprovalReopened }>> {
  const candidates = rows.filter((r) => r.reviewStatus !== "approved");
  if (candidates.length === 0) return rows;
  const items = await prisma.reviewRequestItem.findMany({
    where: {
      requirementId: { in: candidates.map((r) => r.id) },
      reviewRequest: { projectId, status: "approved" },
    },
    select: {
      requirementId: true,
      pinnedVersion: true,
      reviewRequest: { select: { id: true, title: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const versionById = new Map(candidates.map((r) => [r.id, r.version]));
  const reopened = new Map<string, RequirementApprovalReopened>();
  for (const item of items) {
    const id = item.requirementId;
    if (id === null || reopened.has(id)) continue;
    const version = versionById.get(id);
    if (version === undefined || item.pinnedVersion >= version) continue;
    reopened.set(id, {
      reviewId: item.reviewRequest.id,
      reviewTitle: item.reviewRequest.title,
      approvedVersion: item.pinnedVersion,
    });
  }
  if (reopened.size === 0) return rows;
  return rows.map((r) => {
    const flag = reopened.get(r.id);
    return flag ? { ...r, approvalReopened: flag } : r;
  });
}

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
