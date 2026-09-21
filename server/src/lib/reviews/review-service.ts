/**
 * Epic #609 / Issue #617 — review-workflow persistence service.
 *
 * Sits between the REST routes (`server/src/routes/reviews.ts`) and the pure
 * state machine (`./state-machine.ts`). Every status change goes through
 * {@link transition} — no route or service code sets `ReviewRequest.status`
 * ad hoc — and every transition + reviewer decision writes an `AuditLog`
 * entry IN THE SAME TRANSACTION as the change it evidences (append-only:
 * this module exposes no update/delete path for sign-off records, and a
 * failed audit write rolls the change back).
 *
 * Security invariants enforced here:
 * - the requester can never be an assigned reviewer (create) and can never
 *   record a decision (defense in depth at decision time);
 * - a decision is recorded only for the CALLER's own assignment — the
 *   reviewer identity is taken from the session, never from the body;
 * - scope items are resolved project-scoped (cross-project ids 404);
 * - decisions attach to the exact artifact versions pinned at submit time;
 * - concurrency-safe: the aggregate decision is computed from assignment
 *   rows re-read INSIDE the decision transaction, and every status write is
 *   guarded on the expected prior status (`updateMany` + affected-count
 *   check) so two racing requests can never both fire a final transition or
 *   silently overwrite a concurrent withdraw/decision.
 */
import { AppError } from "../../middleware/error-handler.js";
import { buildAuditLogData } from "../audit/audit-service.js";
import { prisma } from "../prisma.js";
import { dispatchReviewDecision, dispatchReviewSubmitted } from "./notify.js";
import {
  REVIEW_STATUSES,
  aggregateDecisions,
  assertValidPolicy,
  buildBaselinePins,
  deriveRequirementReviewStatus,
  transition,
  type ReviewPolicy,
  type ReviewRequestStatus,
  type ReviewerDecision,
} from "./state-machine.js";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const USER_SELECT = { id: true, username: true, displayName: true } as const;

/** Detail include used by every read/mutation response. */
export const REVIEW_DETAIL_INCLUDE = {
  requestedBy: { select: USER_SELECT },
  items: {
    include: {
      requirement: { select: { id: true, title: true, version: true } },
      generatedDocument: { select: { id: true, title: true } },
    },
  },
  assignments: { include: { reviewer: { select: USER_SELECT } } },
  baseline: { select: { id: true, name: true, createdAt: true } },
} as const;

export interface ReviewItemInput {
  requirementId?: string | null;
  generatedDocumentId?: string | null;
}

export interface CreateReviewInput {
  title: string;
  description?: string;
  policy: ReviewPolicy;
  quorum?: number | null;
  dueAt?: string | null;
  reviewerIds: string[];
  items: ReviewItemInput[];
}

interface ReviewItemRow {
  id: string;
  requirementId: string | null;
  generatedDocumentId: string | null;
  pinnedVersion: number;
}

interface ReviewRow {
  id: string;
  projectId: string;
  title: string;
  status: string;
  policy: string;
  quorum: number | null;
  requestedById: string;
  items: ReviewItemRow[];
  assignments: {
    id: string;
    reviewerId: string;
    decision: string;
    /** Present on rows loaded via REVIEW_DETAIL_INCLUDE (#621 notifications). */
    reviewer?: { id: string; username: string | null; displayName: string | null } | null;
  }[];
}

const AUDIT_TARGET = "review_request";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadReviewOr404(reviewId: string): Promise<ReviewRow> {
  const review = await prisma.reviewRequest.findUnique({
    where: { id: reviewId },
    include: REVIEW_DETAIL_INCLUDE,
  });
  if (!review) throw new AppError(404, "REVIEW_NOT_FOUND", "Review request not found");
  return review; // Prisma's include payload structurally satisfies ReviewRow
}

/** 409 for a guarded status write that matched 0 rows (lost a concurrent race). */
function reviewStateChangedError(): AppError {
  return new AppError(
    409,
    "REVIEW_STATE_CHANGED",
    "The review's status changed concurrently — reload and retry",
  );
}

/** 403 unless the caller is the review's requester or holds `review.admin`. */
function assertRequesterOrAdmin(review: ReviewRow, actorId: string, isAdmin: boolean): void {
  if (review.requestedById !== actorId && !isAdmin) {
    throw new AppError(
      403,
      "NOT_REQUESTER",
      "Only the requester (or a review administrator) may perform this action",
    );
  }
}

function requirementIdsInScope(items: ReviewItemRow[]): string[] {
  return items.map((i) => i.requirementId).filter((id): id is string => id !== null);
}

/** Compact pinned-scope snapshot embedded in sign-off audit metadata. */
function pinnedItemsMetadata(items: ReviewItemRow[]) {
  return items.map((i) => ({
    requirementId: i.requirementId,
    generatedDocumentId: i.generatedDocumentId,
    pinnedVersion: i.pinnedVersion,
  }));
}

/**
 * Resolve the CURRENT version pin for every scope item, project-scoped.
 * Requirements pin `Requirement.version` (RequirementVersion history, epic
 * #770); spec documents pin the latest `GeneratedDocumentVersion.version`
 * (0 when the document has never produced a version row).
 */
async function resolveCurrentPins(
  projectId: string,
  items: readonly { requirementId: string | null; generatedDocumentId: string | null }[],
  missingError: () => AppError,
): Promise<Map<string, number>> {
  const requirementIds = [
    ...new Set(items.map((i) => i.requirementId).filter((id): id is string => id != null)),
  ];
  const documentIds = [
    ...new Set(items.map((i) => i.generatedDocumentId).filter((id): id is string => id != null)),
  ];

  const pins = new Map<string, number>();

  if (requirementIds.length > 0) {
    const rows = await prisma.requirement.findMany({
      where: { id: { in: requirementIds }, projectId, deletedAt: null },
      select: { id: true, version: true },
    });
    if (rows.length !== requirementIds.length) throw missingError();
    for (const row of rows) pins.set(row.id, row.version);
  }

  if (documentIds.length > 0) {
    const docs = await prisma.generatedDocument.findMany({
      where: { id: { in: documentIds }, projectId, deletedAt: null },
      select: { id: true },
    });
    if (docs.length !== documentIds.length) throw missingError();
    for (const doc of docs) {
      const latest = await prisma.generatedDocumentVersion.findFirst({
        where: { documentId: doc.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      pins.set(doc.id, latest?.version ?? 0);
    }
  }

  return pins;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createReviewRequest(
  actorId: string,
  projectId: string,
  input: CreateReviewInput,
): Promise<unknown> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

  // Dedupe scope + reviewers.
  const seen = new Set<string>();
  const items = input.items.filter((item) => {
    const key = item.requirementId
      ? `r:${item.requirementId}`
      : `d:${String(item.generatedDocumentId)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const reviewerIds = [...new Set(input.reviewerIds)];

  // Self-review prevention: the requester must not review their own request.
  if (reviewerIds.includes(actorId)) {
    throw new AppError(
      400,
      "SELF_REVIEW_FORBIDDEN",
      "The requester cannot be assigned as a reviewer of their own review request",
    );
  }

  // Throws InvalidReviewPolicyError (400) on a bad all/quorum configuration.
  assertValidPolicy(input.policy, input.quorum ?? null, reviewerIds.length);

  // Reviewers must resolve to active users.
  const users = await prisma.user.findMany({
    where: { id: { in: reviewerIds }, status: "active" },
    select: { id: true },
  });
  if (users.length !== reviewerIds.length) {
    throw new AppError(400, "REVIEWER_NOT_FOUND", "One or more reviewers are not active users");
  }

  // Project-scoped item resolution (cross-project ids are a 404, not a leak).
  const pins = await resolveCurrentPins(
    projectId,
    items.map((i) => ({
      requirementId: i.requirementId ?? null,
      generatedDocumentId: i.generatedDocumentId ?? null,
    })),
    () =>
      new AppError(
        404,
        "REVIEW_ITEM_NOT_FOUND",
        "One or more review items were not found in this project",
      ),
  );

  // The audit row commits atomically with the review it evidences.
  const review = await prisma.$transaction(async (tx) => {
    const created = await tx.reviewRequest.create({
      data: {
        projectId,
        title: input.title,
        description: input.description ?? "",
        policy: input.policy,
        quorum: input.policy === "quorum" ? (input.quorum as number) : null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        requestedById: actorId,
        items: {
          create: items.map((i) => ({
            requirementId: i.requirementId ?? null,
            generatedDocumentId: i.generatedDocumentId ?? null,
            pinnedVersion: pins.get(i.requirementId ?? (i.generatedDocumentId as string)) ?? 0,
          })),
        },
        assignments: { create: reviewerIds.map((reviewerId) => ({ reviewerId })) },
      },
      include: REVIEW_DETAIL_INCLUDE,
    });

    await tx.auditLog.create({
      data: buildAuditLogData({
        actorId,
        action: "review.create",
        targetType: AUDIT_TARGET,
        targetId: (created as { id: string }).id,
        metadata: { projectId, title: input.title, policy: input.policy, reviewerIds },
      }),
    });

    return created;
  });

  return review;
}

// ---------------------------------------------------------------------------
// Submit (draft → in_review, pins versions)
// ---------------------------------------------------------------------------

export async function submitReview(
  actorId: string,
  reviewId: string,
  isAdmin: boolean,
): Promise<unknown> {
  const review = await loadReviewOr404(reviewId);
  assertRequesterOrAdmin(review, actorId, isAdmin);

  // Throws IllegalReviewTransitionError (409) outside `draft`.
  const nextStatus = transition(review.status as ReviewRequestStatus, "submit");

  const currentPins = await resolveCurrentPins(
    review.projectId,
    review.items,
    () =>
      new AppError(
        409,
        "REVIEW_SCOPE_STALE",
        "One or more items in the review scope no longer exist — revise the review before submitting",
      ),
  );

  const requirementIds = requirementIdsInScope(review.items);
  const pinnedItems: ReviewItemRow[] = review.items.map((item) => ({
    ...item,
    pinnedVersion:
      currentPins.get(item.requirementId ?? (item.generatedDocumentId as string)) ??
      item.pinnedVersion,
  }));

  const updated = await prisma.$transaction(async (tx) => {
    // Guarded status write: matches only while the review still holds the
    // status we validated the transition from — a concurrent close/submit
    // in the read-to-write window loses cleanly (409) instead of being
    // silently overwritten.
    const transitioned = await tx.reviewRequest.updateMany({
      where: { id: reviewId, status: review.status },
      data: { status: nextStatus, decidedAt: null },
    });
    if (transitioned.count === 0) throw reviewStateChangedError();

    for (const item of pinnedItems) {
      await tx.reviewRequestItem.update({
        where: { id: item.id },
        data: { pinnedVersion: item.pinnedVersion },
      });
    }
    // A (re-)submission starts a fresh decision round.
    await tx.reviewerAssignment.updateMany({
      where: { reviewRequestId: reviewId },
      data: { decision: "pending", note: null, decidedAt: null },
    });
    if (requirementIds.length > 0) {
      await tx.requirement.updateMany({
        where: { id: { in: requirementIds } },
        data: { reviewStatus: deriveRequirementReviewStatus(nextStatus) },
      });
    }

    await tx.auditLog.create({
      data: buildAuditLogData({
        actorId,
        action: "review.submit",
        targetType: AUDIT_TARGET,
        targetId: reviewId,
        metadata: {
          from: review.status,
          to: nextStatus,
          pinnedItems: pinnedItemsMetadata(pinnedItems),
        },
      }),
    });

    return tx.reviewRequest.findUnique({
      where: { id: reviewId },
      include: REVIEW_DETAIL_INCLUDE,
    });
  });

  // #621 — POST-COMMIT, fire-and-forget: reviewers learn a round awaits them.
  // Runs only after the transaction above committed; never throws.
  dispatchReviewSubmitted({
    reviewId,
    projectId: review.projectId,
    title: review.title,
    actorId,
    reviewerIds: review.assignments.map((a) => a.reviewerId),
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Decision (reviewer approve/reject + atomic aggregate transition)
// ---------------------------------------------------------------------------

export interface DecisionResult {
  reviewId: string;
  decision: ReviewerDecision;
  aggregate: "pending" | "approved" | "rejected";
  status: ReviewRequestStatus;
  /**
   * `null` while the aggregate is still pending, on rejection, AND on an
   * approval whose scope contains only spec documents — documents are not
   * baseline-pinnable (see `buildBaselinePins`), so a docs-only review
   * approves without producing a baseline by design. The `review.approved`
   * audit row records the (possibly null) baselineId for the same reason.
   */
  baselineId: string | null;
}

export async function recordDecision(
  actorId: string,
  reviewId: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<DecisionResult> {
  const review = await loadReviewOr404(reviewId);

  // Only the assigned reviewer THEMSELVES may record their decision; the
  // assignment is resolved from the session identity, never the body. This
  // check runs FIRST so a non-reviewer probing review ids gets a uniform 403
  // and cannot learn the review's current status from the 409 below.
  const assignment = review.assignments.find((a) => a.reviewerId === actorId);
  if (!assignment) {
    throw new AppError(403, "NOT_A_REVIEWER", "You are not an assigned reviewer of this review");
  }

  // Self-approval prevention (defense in depth — create() already refuses to
  // assign the requester as a reviewer).
  if (review.requestedById === actorId) {
    throw new AppError(
      403,
      "SELF_APPROVAL_FORBIDDEN",
      "The requester of a review cannot record a decision on it",
    );
  }

  if (review.status !== "in_review") {
    throw new AppError(
      409,
      "REVIEW_NOT_IN_REVIEW",
      `Decisions can only be recorded while a review is in_review (current: ${review.status})`,
    );
  }

  if (assignment.decision !== "pending") {
    throw new AppError(
      409,
      "DECISION_ALREADY_RECORDED",
      "Your decision for this review round has already been recorded",
    );
  }

  const decidedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    // Guarded write: loses gracefully against a concurrent double-submit.
    const { count } = await tx.reviewerAssignment.updateMany({
      where: { id: assignment.id, decision: "pending" },
      data: { decision, note: note ?? null, decidedAt },
    });
    if (count === 0) {
      throw new AppError(
        409,
        "DECISION_ALREADY_RECORDED",
        "Your decision for this review round has already been recorded",
      );
    }

    // Aggregate over rows re-read INSIDE the transaction (our own guarded
    // write included) — never the pre-transaction snapshot. Two reviewers
    // approving near-simultaneously under the `all` policy would otherwise
    // each see the other as pending and leave the review stuck in_review.
    const freshAssignments = await tx.reviewerAssignment.findMany({
      where: { reviewRequestId: reviewId },
      select: { decision: true },
    });
    const aggregate = aggregateDecisions(
      freshAssignments.map((a) => a.decision as ReviewerDecision),
      review.policy as ReviewPolicy,
      review.quorum,
    );

    let status: ReviewRequestStatus = "in_review";
    let baselineId: string | null = null;

    if (aggregate !== "pending") {
      // Aggregate outcome reached — fire the state transition atomically
      // with the final decision. The write is guarded on `in_review`: if a
      // concurrent final decision or withdraw moved the review first, we
      // match 0 rows and roll this decision back (409) instead of firing a
      // duplicate transition, double-creating the baseline, or overwriting
      // a withdrawn review.
      status = transition("in_review", aggregate === "approved" ? "approve" : "reject");
      const transitioned = await tx.reviewRequest.updateMany({
        where: { id: reviewId, status: "in_review" },
        data: { status, decidedAt },
      });
      if (transitioned.count === 0) throw reviewStateChangedError();

      const requirementIds = requirementIdsInScope(review.items);
      const derived = deriveRequirementReviewStatus(status);
      if (requirementIds.length > 0 && derived !== null) {
        await tx.requirement.updateMany({
          where: { id: { in: requirementIds } },
          data: { reviewStatus: derived },
        });
      }

      if (status === "approved") {
        // Docs-only scopes yield no pins → approved with baselineId null
        // (see DecisionResult.baselineId).
        const pinsForBaseline = buildBaselinePins(review.items);
        if (pinsForBaseline.length > 0) {
          const baseline = await tx.baseline.create({
            data: {
              projectId: review.projectId,
              reviewRequestId: reviewId,
              name: `${review.title} (review ${reviewId.slice(-8)})`,
              description: `Auto-created from approved review "${review.title}"`,
              createdById: actorId,
              items: { create: pinsForBaseline },
            },
          });
          baselineId = (baseline as { id: string }).id;
        }
      }
    }

    // Sign-off evidence: reviewer, decision, and the exact pinned versions —
    // committed in the SAME transaction as the decision, so the audit trail
    // can never silently diverge from the recorded state.
    await tx.auditLog.create({
      data: buildAuditLogData({
        actorId,
        action: "review.decision",
        targetType: AUDIT_TARGET,
        targetId: reviewId,
        metadata: {
          decision,
          note: note ?? null,
          pinnedItems: pinnedItemsMetadata(review.items),
        },
      }),
    });
    if (aggregate !== "pending") {
      await tx.auditLog.create({
        data: buildAuditLogData({
          actorId,
          action: status === "approved" ? "review.approved" : "review.rejected",
          targetType: AUDIT_TARGET,
          targetId: reviewId,
          metadata: {
            policy: review.policy,
            quorum: review.quorum,
            baselineId,
            pinnedItems: pinnedItemsMetadata(review.items),
          },
        }),
      });
    }
    if (baselineId) {
      await tx.auditLog.create({
        data: buildAuditLogData({
          actorId,
          action: "baseline.create",
          targetType: "baseline",
          targetId: baselineId,
          metadata: { reviewRequestId: reviewId, projectId: review.projectId },
        }),
      });
    }

    return { aggregate, status, baselineId };
  });

  // #621 — POST-COMMIT, fire-and-forget: the requester learns of this
  // decision (and of a terminal approve/reject reached with it). Runs only
  // after the transaction above committed; never throws.
  dispatchReviewDecision({
    reviewId,
    projectId: review.projectId,
    title: review.title,
    requestedById: review.requestedById,
    reviewerId: actorId,
    reviewerName: assignment.reviewer?.displayName || assignment.reviewer?.username || "A reviewer",
    decision,
    outcome: result.aggregate === "pending" ? null : (result.status as "approved" | "rejected"),
    baselineId: result.baselineId,
  });

  return { reviewId, decision, ...result };
}

// ---------------------------------------------------------------------------
// Withdraw / close
// ---------------------------------------------------------------------------

async function transitionReview(
  actorId: string,
  reviewId: string,
  isAdmin: boolean,
  event: "withdraw" | "close",
): Promise<unknown> {
  const review = await loadReviewOr404(reviewId);
  assertRequesterOrAdmin(review, actorId, isAdmin);

  const nextStatus = transition(review.status as ReviewRequestStatus, event);
  const derived = deriveRequirementReviewStatus(nextStatus);
  const requirementIds = requirementIdsInScope(review.items);

  const updated = await prisma.$transaction(async (tx) => {
    // Guarded status write (same rationale as recordDecision): a withdraw
    // racing a final decision — or a close racing anything — must not
    // silently overwrite the concurrently committed status.
    const transitioned = await tx.reviewRequest.updateMany({
      where: { id: reviewId, status: review.status },
      data: { status: nextStatus, decidedAt: nextStatus === "draft" ? null : undefined },
    });
    if (transitioned.count === 0) throw reviewStateChangedError();

    if (derived !== null && requirementIds.length > 0) {
      await tx.requirement.updateMany({
        where: { id: { in: requirementIds } },
        data: { reviewStatus: derived },
      });
    }

    await tx.auditLog.create({
      data: buildAuditLogData({
        actorId,
        action: `review.${event}`,
        targetType: AUDIT_TARGET,
        targetId: reviewId,
        metadata: { from: review.status, to: nextStatus },
      }),
    });

    return tx.reviewRequest.findUnique({
      where: { id: reviewId },
      include: REVIEW_DETAIL_INCLUDE,
    });
  });

  return updated;
}

export async function withdrawReview(
  actorId: string,
  reviewId: string,
  isAdmin: boolean,
): Promise<unknown> {
  return transitionReview(actorId, reviewId, isAdmin, "withdraw");
}

export async function closeReview(
  actorId: string,
  reviewId: string,
  isAdmin: boolean,
): Promise<unknown> {
  return transitionReview(actorId, reviewId, isAdmin, "close");
}

// ---------------------------------------------------------------------------
// Queues / detail
// ---------------------------------------------------------------------------

export interface ListReviewsFilters {
  projectId?: string;
  status?: string;
  assignee?: string;
  requester?: string;
  page: number;
  pageSize: number;
}

export async function listReviews(
  actorId: string,
  filters: ListReviewsFilters,
): Promise<{ reviews: unknown[]; total: number; page: number; pageSize: number }> {
  const where: Record<string, unknown> = {};
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.status !== undefined) {
    if (!(REVIEW_STATUSES as readonly string[]).includes(filters.status)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Unknown status filter — expected one of: ${REVIEW_STATUSES.join(", ")}`,
      );
    }
    where.status = filters.status;
  }
  // Identity filters resolve to the SESSION user only — `assignee=me` /
  // `requester=me` cannot be pointed at arbitrary user ids.
  if (filters.assignee === "me") where.assignments = { some: { reviewerId: actorId } };
  if (filters.requester === "me") where.requestedById = actorId;

  const [reviews, total] = await Promise.all([
    prisma.reviewRequest.findMany({
      where,
      include: REVIEW_DETAIL_INCLUDE,
      orderBy: { updatedAt: "desc" },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.reviewRequest.count({ where }),
  ]);

  return { reviews, total, page: filters.page, pageSize: filters.pageSize };
}

export async function getReviewDetail(
  reviewId: string,
): Promise<{ review: unknown; history: unknown[] }> {
  const review = await loadReviewOr404(reviewId);
  const history = await prisma.auditLog.findMany({
    where: { targetType: AUDIT_TARGET, targetId: reviewId },
    orderBy: { ts: "asc" },
    select: { id: true, action: true, actorId: true, metadata: true, ts: true },
  });
  return { review, history };
}
