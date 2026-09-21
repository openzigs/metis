/**
 * Epic #609 / Issue #618 — review-workflow API client (queue, detail, decision).
 *
 * Server surface: `server/src/routes/reviews.ts` (#617). Payload shapes mirror
 * `REVIEW_DETAIL_INCLUDE` in `server/src/lib/reviews/review-service.ts`.
 */
import { apiFetch } from "@/lib/api-client";

// ---- Types ------------------------------------------------------------------

export type ReviewStatus = "draft" | "in_review" | "approved" | "rejected" | "closed";
export type ReviewerDecision = "pending" | "approved" | "rejected";
export type ReviewPolicy = "all" | "quorum";

export interface ReviewUserRef {
  id: string;
  username: string;
  displayName: string;
}

export interface ReviewItem {
  id: string;
  requirementId: string | null;
  generatedDocumentId: string | null;
  /** Artifact version captured at submit time — the reviewed pin. */
  pinnedVersion: number;
  requirement: { id: string; title: string; version: number } | null;
  generatedDocument: { id: string; title: string } | null;
}

export interface ReviewerAssignment {
  id: string;
  reviewerId: string;
  decision: ReviewerDecision;
  note: string | null;
  decidedAt: string | null;
  reviewer: ReviewUserRef;
}

export interface ReviewRequest {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: ReviewStatus;
  policy: ReviewPolicy;
  quorum: number | null;
  requestedById: string;
  dueAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  requestedBy: ReviewUserRef;
  items: ReviewItem[];
  assignments: ReviewerAssignment[];
  baseline: { id: string; name: string; createdAt: string } | null;
}

export interface ReviewListPage {
  reviews: ReviewRequest[];
  total: number;
  page: number;
  pageSize: number;
}

/** One `AuditLog` row from the review's sign-off trail. */
export interface ReviewHistoryEvent {
  id: string;
  action: string;
  actorId: string | null;
  metadata: unknown;
  ts: string;
}

export interface ReviewDetail {
  review: ReviewRequest;
  history: ReviewHistoryEvent[];
}

export interface DecisionResult {
  reviewId: string;
  decision: Exclude<ReviewerDecision, "pending">;
  aggregate: "pending" | "approved" | "rejected";
  status: ReviewStatus;
  baselineId: string | null;
}

export interface ReviewListFilters {
  /** Only `"me"` is supported by the server (session-resolved). */
  assignee?: "me";
  /** Only `"me"` is supported by the server (session-resolved). */
  requester?: "me";
  status?: ReviewStatus;
  projectId?: string;
  page?: number;
  pageSize?: number;
}

// ---- API --------------------------------------------------------------------

export const reviewsApi = {
  /** Reviewer / requester queue (newest activity first). */
  list(filters: ReviewListFilters = {}): Promise<ReviewListPage> {
    return apiFetch<ReviewListPage>("/reviews", {
      params: {
        assignee: filters.assignee,
        requester: filters.requester,
        status: filters.status,
        projectId: filters.projectId,
        page: filters.page,
        pageSize: filters.pageSize,
      },
    });
  },

  /** Review detail including scope items, assignments, and audit history. */
  get(reviewId: string): Promise<ReviewDetail> {
    return apiFetch<ReviewDetail>(`/reviews/${reviewId}`);
  },

  /** Record the caller's approve/reject decision (assigned reviewers only). */
  decide(
    reviewId: string,
    decision: "approved" | "rejected",
    note?: string,
  ): Promise<DecisionResult> {
    return apiFetch<DecisionResult>(`/reviews/${reviewId}/decision`, {
      method: "POST",
      body: note !== undefined && note !== "" ? { decision, note } : { decision },
    });
  },
};
