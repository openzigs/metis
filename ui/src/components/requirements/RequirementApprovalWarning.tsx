"use client";

/**
 * Issue #2219 — the Edit dialog's warning that saving reopens an approval.
 *
 * Editing an approved requirement used to save with no word that the approval
 * was of the old wording. This reads the approved and in-review reviews that
 * pinned the requirement (`GET /api/requirements/:id/approval`) and says what
 * the save will do, e.g. "Approved as v1 by Test Coordinator; saving creates v2
 * and reopens review." While that read is loading, or when it fails (a role
 * without `review.read`), it falls back to the requirement's own status, so an
 * approved requirement is never edited without a warning.
 */
import { useQuery } from "@tanstack/react-query";
import { approvalEditWarning, type RequirementApproval } from "@metis/shared";
import { queryKeys } from "@/lib/query-keys";
import { reviewsApi } from "@/lib/reviews-api";

export interface RequirementApprovalWarningProps {
  requirementId: string;
  /** The version the dialog was opened on. */
  version: number;
  /** The requirement's review status as the card shows it. */
  reviewStatus: string | null;
}

export function RequirementApprovalWarning({
  requirementId,
  version,
  reviewStatus,
}: RequirementApprovalWarningProps) {
  const approval = useQuery({
    queryKey: queryKeys.reviews.requirementApproval(requirementId),
    queryFn: () => reviewsApi.requirementApproval(requirementId),
    // A review may have been approved since the page loaded: read it afresh.
    staleTime: 0,
    retry: false,
  });
  const fallback: RequirementApproval = { requirementId, version, reviewStatus, reviews: [] };
  // A body that is not the approval shape (an older server) reads as no answer.
  const read = Array.isArray(approval.data?.reviews) ? approval.data : undefined;
  const warning = approvalEditWarning(read ?? fallback);
  if (!warning) return null;
  return (
    <p
      role="status"
      className="rounded-md border border-warning/40 bg-warning-muted px-3 py-2 text-sm"
      data-testid="req-edit-approval-warning"
    >
      {warning}
    </p>
  );
}
