/**
 * Approval Checkpoint Service (Epic #597 / Issue #626).
 *
 * Manages human approval checkpoints for the requirements enhancement
 * pipeline. Each evidence digest, clarification resolution, or enhanced
 * requirement can require explicit approval before ticket creation proceeds.
 */
import { createChildLogger } from "../logger.js";
import { AppError } from "../../middleware/error-handler.js";
import { prisma } from "../prisma.js";
import type { ApprovalReview, ApprovalStatus, ApprovalType } from "./types/requirements.js";

const log = createChildLogger("approval-checkpoint");

export interface ApprovalRequestRow {
  id: string;
  analysisId: string;
  type: string;
  itemId: string;
  status: string;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}

export interface ApprovalPolicy {
  /** Whether evidence digests require approval. */
  requireEvidenceApproval: boolean;
  /** Whether clarification resolutions require approval. */
  requireClarificationApproval: boolean;
  /** Whether the final enhanced requirements require approval. */
  requireRequirementApproval: boolean;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  requireEvidenceApproval: true,
  requireClarificationApproval: false,
  requireRequirementApproval: true,
};

/**
 * Create approval requests for items that need review.
 */
export async function createApprovalRequests(
  analysisId: string,
  items: Array<{ type: ApprovalType; itemId: string }>,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): Promise<ApprovalRequestRow[]> {
  const filtered = items.filter((item) => {
    if (item.type === "evidence" && !policy.requireEvidenceApproval) return false;
    if (item.type === "clarification" && !policy.requireClarificationApproval) return false;
    if (item.type === "requirement" && !policy.requireRequirementApproval) return false;
    return true;
  });

  if (filtered.length === 0) return [];

  log.info("Creating approval requests", { count: filtered.length, analysisId });

  const created: ApprovalRequestRow[] = [];
  for (const item of filtered) {
    const row = await prisma.approvalRequest.create({
      data: {
        analysisId,
        type: item.type,
        itemId: item.itemId,
        status: "pending",
      },
    });
    created.push(row as ApprovalRequestRow);
  }

  return created;
}

/**
 * List approval requests for an analysis.
 */
export async function listApprovalRequests(
  analysisId: string,
  statusFilter?: ApprovalStatus,
): Promise<ApprovalRequestRow[]> {
  const where: Record<string, unknown> = { analysisId };
  if (statusFilter) where.status = statusFilter;

  const rows = await prisma.approvalRequest.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  return rows as ApprovalRequestRow[];
}

/**
 * Review (approve/reject) an approval request.
 *
 * @param analysisId - The analysis session that owns the approval. Used to
 *   scope the lookup and prevent cross-analysis access (IDOR mitigation).
 */
export async function reviewApprovalRequest(
  analysisId: string,
  requestId: string,
  review: ApprovalReview,
): Promise<ApprovalRequestRow> {
  const existing = await prisma.approvalRequest.findFirst({
    where: { id: requestId, analysisId },
  });

  // Typed errors: a bare `Error` here reached the client as a 500 for a plain
  // unknown-id request, which is both the wrong status and an internal-error
  // signal for ordinary caller input.
  if (!existing) {
    throw new AppError(404, "APPROVAL_NOT_FOUND", `Approval request ${requestId} not found`);
  }

  if (existing.status !== "pending") {
    throw new AppError(
      409,
      "APPROVAL_ALREADY_REVIEWED",
      `Approval request ${requestId} is already ${existing.status}`,
    );
  }

  log.info("Reviewing approval request", {
    requestId,
    status: review.status,
    reviewerId: review.reviewerId,
  });

  const updated = await prisma.approvalRequest.update({
    where: { id: requestId },
    data: {
      status: review.status,
      reviewerId: review.reviewerId,
      reviewNote: review.reviewNote ?? null,
      reviewedAt: new Date(),
    },
  });

  return updated as ApprovalRequestRow;
}

/**
 * Check if all approvals for an analysis are resolved (approved/rejected).
 */
export async function areAllApprovalsResolved(analysisId: string): Promise<boolean> {
  const pendingCount = await prisma.approvalRequest.count({
    where: { analysisId, status: "pending" },
  });
  return pendingCount === 0;
}

/**
 * Issue #723 — reopen a REJECTED approval so it can be reviewed again.
 *
 * A rejection used to be final, and because the gate also treated it as
 * unresolved, one rejected requirement dead-ended the whole run. Rejections are
 * now resolutions (see {@link canCreateTickets}); reopening is how a reviewer
 * takes one back. Only `rejected` reopens: an `approved` requirement may
 * already be a promoted row, and withdrawing it is a requirement edit, not an
 * approval state change.
 */
export async function reopenApprovalRequest(
  analysisId: string,
  requestId: string,
): Promise<ApprovalRequestRow> {
  // Issue #909 — the status predicate rides the WRITE, so a reopen racing an
  // approval (or another reopen) cannot act on a status it read earlier.
  const { count } = await prisma.approvalRequest.updateMany({
    where: { id: requestId, analysisId, status: "rejected" },
    data: { status: "pending", reviewerId: null, reviewNote: null, reviewedAt: null },
  });
  const current = await prisma.approvalRequest.findFirst({
    where: { id: requestId, analysisId },
  });
  if (!current) {
    throw new AppError(404, "APPROVAL_NOT_FOUND", `Approval request ${requestId} not found`);
  }
  if (count === 0) {
    throw new AppError(
      409,
      "APPROVAL_NOT_REOPENABLE",
      `Approval request ${requestId} is ${current.status}; only a rejected approval can be reopened`,
    );
  }

  log.info("Reopened approval request", { requestId, analysisId });
  return current as ApprovalRequestRow;
}

/**
 * Check if ticket creation is allowed: every approval is resolved.
 *
 * Issue #723 — a REJECTED approval is a resolution, exactly as
 * {@link areAllApprovalsResolved} counts it. What it EXCLUDES depends on its
 * type: a rejected `requirement` approval is left out of the promoted set
 * (`buildApprovedRequirementSet`); a rejected `evidence` or `clarification`
 * approval is recorded but changes no promoted requirement — surfaces must not
 * claim it was "left out". Counting it as outstanding made one rejection block promotion,
 * publishing and Deep Dive forever, with nothing in the product able to clear
 * it. `rejectedCount` is still reported so surfaces can say what was dropped.
 */
export async function canCreateTickets(analysisId: string): Promise<{
  allowed: boolean;
  pendingCount: number;
  rejectedCount: number;
}> {
  const [pendingCount, rejectedCount] = await Promise.all([
    prisma.approvalRequest.count({ where: { analysisId, status: "pending" } }),
    prisma.approvalRequest.count({ where: { analysisId, status: "rejected" } }),
  ]);

  return {
    allowed: pendingCount === 0,
    pendingCount,
    rejectedCount,
  };
}
