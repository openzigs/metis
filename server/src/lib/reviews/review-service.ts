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
import { REQUIREMENT_REVIEW_STATUSES } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { parseRequirementLabels } from "../analysis/requirement-labels.js";
import { buildAuditLogData } from "../audit/audit-service.js";
import { Prisma, prisma, resolveDatabaseProvider } from "../prisma.js";
import { dispatchReviewDecision, dispatchReviewSubmitted } from "./notify.js";
import { noteRequirementsChanged } from "../docs-gen/approved-requirements-staleness.js";
import { attachSharedCriteria } from "./review-shared-criteria.js";
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
  /** #989 — the requirement's reviewStatus captured at submit (null otherwise). */
  priorReviewStatus?: string | null;
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

/**
 * #1575 — 403 when the caller is an assigned reviewer of a review still in
 * review (never its requester: SELF_REVIEW_FORBIDDEN). A reviewer is asked to
 * decide the review; a withdraw or close by them would cancel the sign-off
 * instead (the mirror of SELF_APPROVAL_FORBIDDEN, which stops the requester
 * deciding it). Holding `review.admin` does not lift this: a review
 * administrator who is not one of its reviewers still may. Once the review has
 * a verdict, archiving it is no longer a way round a decision.
 */
function assertNotDecidingReviewer(review: ReviewRow, actorId: string): void {
  if (review.status !== "in_review") return;
  if (review.assignments.some((a) => a.reviewerId === actorId)) {
    throw new AppError(
      403,
      "REVIEWER_CANNOT_WITHDRAW",
      "You are a reviewer of this review: record your decision instead of withdrawing or closing it",
    );
  }
}

function requirementIdsInScope(items: ReviewItemRow[]): string[] {
  return items.map((i) => i.requirementId).filter((id): id is string => id !== null);
}

type ReviewTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// #1162 — every `reviewStatus` write in this module is deliberately outside
// the requirement version history: the status is the verdict on a version,
// not part of it (see `TRACKED_FIELDS`). Versioning it would mint a new
// version straight after the submit pins one. Each transition is recorded by
// this module's `review.*` audit-log entries instead.

/**
 * #1016 — Postgres only: lock the scope's requirement rows (`FOR UPDATE`, in id
 * order so two transactions over overlapping scopes cannot deadlock) before
 * reading which other reviews are open on them.
 *
 * Two reviews of one requirement each decide from "is another review open on
 * it?". Under READ COMMITTED two withdraws racing could each still see the
 * other as open and neither restore, leaving the requirement awaiting a review
 * nobody holds. With the rows locked first, the second transaction waits for
 * the first to commit, and its next statement (a fresh snapshot) sees it.
 *
 * SQLite needs nothing: the driver adapter runs one transaction at a time.
 */
async function lockScopeRequirements(tx: ReviewTx, requirementIds: string[]): Promise<void> {
  if (requirementIds.length === 0 || resolveDatabaseProvider() !== "postgresql") return;
  const ids = [...new Set(requirementIds)].sort();
  await tx.$queryRaw`SELECT 1 FROM "requirements" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
}

/**
 * #1016 — for each requirement in `requirementIds` that ANOTHER review still in
 * `in_review` covers, the status that review captured before it moved the
 * requirement. Read after {@link lockScopeRequirements}.
 */
async function priorsHeldByOtherOpenReviews(
  tx: ReviewTx,
  reviewId: string,
  requirementIds: string[],
): Promise<Map<string, string | null>> {
  const held = new Map<string, string | null>();
  if (requirementIds.length === 0) return held;
  const rows = await tx.reviewRequestItem.findMany({
    where: {
      requirementId: { in: requirementIds },
      reviewRequestId: { not: reviewId },
      reviewRequest: { status: "in_review" },
    },
    select: { requirementId: true, priorReviewStatus: true },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    if (row.requirementId === null) continue;
    // A "draft" capture is what a review opened before #1016 recorded while
    // another review held the requirement; any other capture is the status
    // from before either review, so it wins.
    if (!held.has(row.requirementId) || held.get(row.requirementId) === "draft") {
      held.set(row.requirementId, row.priorReviewStatus ?? null);
    }
  }
  return held;
}

/**
 * #1016 — record `priorById`'s capture on every OTHER `in_review` review item
 * of `requirementIds`, so all open reviews of a requirement agree on the
 * status the last one to leave restores.
 */
async function shareCaptureWithOtherOpenReviews(
  tx: ReviewTx,
  reviewId: string,
  requirementIds: string[],
  priorById: ReadonlyMap<string, string | null>,
): Promise<void> {
  const byPrior = new Map<string | null, string[]>();
  for (const id of requirementIds) {
    const prior = priorById.get(id) ?? null;
    const ids = byPrior.get(prior);
    if (ids) ids.push(id);
    else byPrior.set(prior, [id]);
  }
  for (const [prior, ids] of byPrior) {
    await tx.reviewRequestItem.updateMany({
      where: {
        requirementId: { in: ids },
        reviewRequestId: { not: reviewId },
        reviewRequest: { status: "in_review" },
      },
      data: { priorReviewStatus: prior },
    });
  }
}

/**
 * #1016 — the status a requirement holds for review purposes: the typed column,
 * else a legacy `review:*` label (rows written before the column existed), the
 * precedence every reader uses (`resolveRequirementReviewStatus`). Null when it
 * has neither, or the label is not a known status.
 *
 * Deliberately not `resolveRequirementReviewStatus` itself: that one is for
 * display and reads "nothing recorded" as `draft`, whereas this result is what
 * a submit CAPTURES to restore later. A requirement that never had a status
 * must get null back on withdraw (#989), not a `draft` it never held — and a
 * `draft` capture is skipped by the restore, which would leave the submit's
 * `draft` in the column for good. The precedence (column, then label) is the
 * same; only the empty case differs. An unknown column value is returned as
 * is, so it is restored exactly; readers show it as `draft` either way.
 */
export function heldReviewStatus(column: string | null, labelsRaw: string | null): string | null {
  if (column !== null) return column;
  const label = parseRequirementLabels(labelsRaw).find((l) => l.startsWith("review:"));
  const fromLabel = label ? label.slice("review:".length) : null;
  return fromLabel !== null &&
    (REQUIREMENT_REVIEW_STATUSES as readonly string[]).includes(fromLabel)
    ? fromLabel
    : null;
}

/**
 * #989 — put back the reviewStatus each requirement held before the review was
 * submitted. Used when a review leaves `in_review` without a verdict (withdraw,
 * or close). An approved requirement was never moved by the submit, so it has
 * nothing to restore; for the rest the write is guarded on the `draft` the
 * submit left, so a status someone set since is not overwritten.
 */
async function restorePriorReviewStatuses(
  tx: ReviewTx,
  reviewId: string,
  items: ReviewItemRow[],
): Promise<void> {
  // #1016 — a requirement another open review still covers stays as that
  // review left it; the last open review to leave restores it.
  const ids = requirementIdsInScope(items);
  await lockScopeRequirements(tx, ids);
  const stillCovered = await priorsHeldByOtherOpenReviews(tx, reviewId, ids);
  // #1016 — the captures are re-read under the lock, never taken from the
  // review loaded before the transaction: another review's submit may have
  // shared a newer capture onto this review's items in between (see
  // shareCaptureWithOtherOpenReviews), and restoring the stale one would put
  // back a status that a verdict has since replaced.
  const current = await tx.reviewRequestItem.findMany({
    where: { reviewRequestId: reviewId, requirementId: { not: null } },
    select: { requirementId: true, priorReviewStatus: true },
  });
  const byPrior = new Map<string | null, string[]>();
  for (const item of current) {
    if (item.requirementId === null) continue;
    if (stillCovered.has(item.requirementId)) continue;
    const prior = item.priorReviewStatus ?? null;
    if (prior === "approved" || prior === "draft") continue;
    const ids = byPrior.get(prior);
    if (ids) ids.push(item.requirementId);
    else byPrior.set(prior, [item.requirementId]);
  }
  for (const [prior, ids] of byPrior) {
    await tx.requirement.updateMany({
      where: { id: { in: ids }, reviewStatus: "draft" },
      data: { reviewStatus: prior },
    });
  }
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

    // #989 — capture each requirement's status before the review touches it,
    // so a withdraw (or a close before any verdict) can give it back.
    await lockScopeRequirements(tx, requirementIds);
    const priorRows =
      requirementIds.length > 0
        ? await tx.requirement.findMany({
            where: { id: { in: requirementIds } },
            select: { id: true, reviewStatus: true, labels: true },
          })
        : [];
    // #1016 — a legacy `review:approved` label counts as approved, as it does
    // for every reader (the Requirements counts, the review form's note).
    const currentById = new Map(
      priorRows.map((r) => [r.id, heldReviewStatus(r.reviewStatus, r.labels)]),
    );
    // #1016 — a requirement another open review already moved to "draft"
    // inherits that review's capture, so whichever review leaves last restores
    // the status from before either was requested.
    const heldByOthers = await priorsHeldByOtherOpenReviews(tx, reviewId, requirementIds);
    const priorById = new Map(
      requirementIds.map((id) => {
        const current = currentById.get(id) ?? null;
        const inherit = current === "draft" && heldByOthers.has(id);
        return [id, inherit ? (heldByOthers.get(id) ?? null) : current] as const;
      }),
    );
    // #1016 — and the other way round: a requirement that is NOT as an open
    // review left it (another review's verdict, or someone's edit, set it
    // since) has a newer status than those reviews captured. They take this
    // capture too, so every open review of a requirement restores the same one.
    await shareCaptureWithOtherOpenReviews(
      tx,
      reviewId,
      requirementIds.filter((id) => heldByOthers.has(id) && currentById.get(id) !== "draft"),
      priorById,
    );

    for (const item of pinnedItems) {
      await tx.reviewRequestItem.update({
        where: { id: item.id },
        data: {
          pinnedVersion: item.pinnedVersion,
          priorReviewStatus: item.requirementId
            ? (priorById.get(item.requirementId) ?? null)
            : null,
        },
      });
    }
    // A (re-)submission starts a fresh decision round.
    await tx.reviewerAssignment.updateMany({
      where: { reviewRequestId: reviewId },
      data: { decision: "pending", note: null, decidedAt: null },
    });
    // #989 — an approved requirement stays approved while it is under review;
    // only a rejection changes it. The rest move to the derived in-review
    // status ("draft" — awaiting review).
    const toAwaitReview = requirementIds.filter((id) => currentById.get(id) !== "approved");
    if (toAwaitReview.length > 0) {
      await tx.requirement.updateMany({
        where: { id: { in: toAwaitReview } },
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
        // #1016 — the lock order submit and withdraw use (review row, then the
        // scope's requirements by id), so overlapping reviews cannot deadlock.
        await lockScopeRequirements(tx, requirementIds);
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
  // #1230 — a verdict reached sets the scope's review statuses: a reader BRD
  // listing approved requirements may now be stale. Post-commit; never throws.
  if (result.aggregate !== "pending") {
    void noteRequirementsChanged(requirementIdsInScope(review.items));
  }

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
  assertNotDecidingReviewer(review, actorId);

  const nextStatus = transition(review.status as ReviewRequestStatus, event);
  // #989 — leaving `in_review` with no verdict (withdraw, or close mid-review)
  // restores what the submit captured. A close after a verdict keeps it.
  const restorePrior = review.status === "in_review";

  const updated = await prisma.$transaction(async (tx) => {
    // Guarded status write (same rationale as recordDecision): a withdraw
    // racing a final decision — or a close racing anything — must not
    // silently overwrite the concurrently committed status.
    const transitioned = await tx.reviewRequest.updateMany({
      where: { id: reviewId, status: review.status },
      data: { status: nextStatus, decidedAt: nextStatus === "draft" ? null : undefined },
    });
    if (transitioned.count === 0) throw reviewStateChangedError();

    if (restorePrior) await restorePriorReviewStatuses(tx, reviewId, review.items);

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
  /**
   * #305 — a Prisma `where` fragment over the review's `project` that limits
   * the list to projects the caller can reach (`workspaceScopeWhere`). Empty
   * or absent means no narrowing (system admins).
   */
  projectScope?: Record<string, unknown>;
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
  if (filters.projectScope && Object.keys(filters.projectScope).length > 0) {
    where.project = filters.projectScope;
  }
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
  // #1203 — the review card marks criteria written for several requirements.
  return { review: await attachSharedCriteria(review), history };
}
