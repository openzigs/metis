/**
 * Epic #609 / Issue #621 — review lifecycle notification fan-out.
 *
 * Notifies participants of the formal review workflow (#617) via in-app
 * `Notification` rows + the per-user `user:{id}` socket room (the same
 * delivery path as discussion mentions, `../discussions/notify.ts`):
 *
 *   - **submit** (draft → in_review) → every assigned reviewer
 *     (`review_requested`);
 *   - **each reviewer decision** → the requester (`review_decided`);
 *   - **terminal approve/reject** → the requester (`review_approved` /
 *     `review_rejected`, carrying the auto-created baselineId when one exists).
 *     #1581 — that row is sent INSTEAD of the decision's `review_decided`: one
 *     decision is one notification.
 *   - #2219 — **an edit of a requirement an approved or in-review review pinned**
 *     → that review's reviewers and requester (`review_item_changed`), once:
 *     only the edit that moves the requirement off the pinned version notifies.
 *
 * PREFERENCES (#614/#608): every send is gated per recipient via
 * `shouldNotify(userId, "inApp", "requirementsApproved")` — review lifecycle
 * notifications are the `requirementsApproved` event family (the Settings →
 * Notifications toggle of the same name; the vocabulary has no more specific
 * review event). The helper fails OPEN and never throws.
 *
 * NON-THROWING CONTRACT: fan-out is a fire-and-forget side effect invoked by
 * `review-service.ts` strictly AFTER its guarded transaction has committed. A
 * failure here (DB, socket) is logged and swallowed — it can never break, and
 * a rollback can never be preceded by, a review state change.
 *
 * SECURITY (OWASP A01): recipients are exclusively the review's OWN
 * participants as recorded in the committed review row (assigned reviewers /
 * the requester) — never derived from request input — and delivery goes to
 * personal socket rooms joined from the verified JWT only.
 *
 * #2394 — every notification here (`review_requested` on a submit or reopen,
 * `review_decided` / `review_approved` / `review_rejected` to the requester,
 * and `review_item_changed`) goes only to the participants who can still open
 * the review's project (`reviewersWhoCanOpenOrNone`): a reviewer's assignment
 * or a requester's request outlives their access, and each carries the
 * review's title. Someone without access gets no row and
 * no socket event, as a mention of a non-member gets neither
 * (`discussions/notify.ts`). The lookup is bounded and fails closed.
 */
import { userRoom } from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";
import { shouldNotify } from "../notifications/preferences.js";
import { emitReviewChanged, reviewersWhoCanOpenOrNone } from "./review-events.js";

const log = createChildLogger("reviews:notify");

/**
 * Preference cell every review lifecycle notification is gated on
 * (see module header — the shared vocabulary's `requirementsApproved` family).
 */
const PREFERENCE_EVENT = "requirementsApproved" as const;

/** Machine-readable `Notification.type` values written by this module. */
export type ReviewNotificationKind =
  | "review_requested"
  | "review_decided"
  | "review_approved"
  | "review_rejected"
  | "review_item_changed";

/** Deep link to the review detail page (`ui/src/app/(authed)/reviews/[id]`). */
export function reviewHref(reviewId: string): string {
  return `/reviews/${encodeURIComponent(reviewId)}`;
}

// ---- Single-recipient persist + emit -----------------------------------------

interface ReviewNotification {
  userId: string;
  kind: ReviewNotificationKind;
  title: string;
  message: string;
  reviewId: string;
  /** #1447 — the review's project, stored so every read re-checks access. */
  projectId: string;
  /** Extra event fields carried on the stored/emitted payload. */
  extra?: Record<string, unknown>;
}

/**
 * Persist one Notification row (so the drawer hydrates it across reloads),
 * then emit to the recipient's personal room. Each step is individually
 * best-effort: a failed persist still emits, and vice versa.
 */
async function persistAndEmit(n: ReviewNotification): Promise<void> {
  const payload = {
    kind: n.kind,
    reviewId: n.reviewId,
    userId: n.userId,
    ts: Date.now(),
    ...n.extra,
  };

  const href = reviewHref(n.reviewId);
  // #104 — the persisted row's id rides on the emit, so the drawer's live item
  // and its hydrated copy are one item. Null when persisting failed.
  let notificationId: string | null = null;

  try {
    const row = await prisma.notification.create({
      data: {
        userId: n.userId,
        type: n.kind,
        title: n.title,
        message: n.message,
        href,
        payload: JSON.stringify(payload),
        projectId: n.projectId,
      },
      select: { id: true },
    });
    notificationId = row?.id ?? null;
  } catch (err) {
    log.warn("Failed to persist review notification", {
      reviewId: n.reviewId,
      userId: n.userId,
      kind: n.kind,
      err,
    });
  }

  try {
    // Personal room joined from the verified JWT only (never client-supplied).
    // Literal event name — the shared socket-contract guard scans for it.
    const io = getSocketServer();
    if (io) {
      io.to(userRoom(n.userId)).emit("review:notification", {
        ...payload,
        notificationId,
        title: n.title,
        message: n.message,
        href,
      });
    }
  } catch (err) {
    log.warn("Failed to emit review notification", {
      reviewId: n.reviewId,
      userId: n.userId,
      kind: n.kind,
      err,
    });
  }
}

// ---- Submit → reviewers --------------------------------------------------------

export interface ReviewSubmittedInput {
  reviewId: string;
  projectId: string;
  title: string;
  /** The submitting actor (requester or review admin) — never self-notified. */
  actorId: string;
  reviewerIds: string[];
  /** #2219 — a re-review of an approved review whose requirements changed. */
  reopened?: boolean;
}

/**
 * Notify every assigned reviewer who can still open the project (#2394) that a
 * review round has been submitted and awaits their decision. Never throws.
 */
export async function notifyReviewSubmitted(input: ReviewSubmittedInput): Promise<void> {
  try {
    // #2394 — only the reviewers who can still open the project.
    const reviewerIds = await reviewersWhoCanOpenOrNone(
      input.projectId,
      input.reviewerIds.filter((id) => id !== input.actorId),
      { event: "review_requested", reviewId: input.reviewId },
    );

    await Promise.allSettled(
      reviewerIds.map(async (reviewerId) => {
        try {
          // #614 — per-recipient preference gate (fail-open, never throws).
          if (!(await shouldNotify(reviewerId, "inApp", PREFERENCE_EVENT))) return;

          await persistAndEmit({
            userId: reviewerId,
            kind: "review_requested",
            title: input.reopened ? "Re-review requested" : "Review requested",
            message: input.reopened
              ? `"${input.title}" changed since it was approved and needs your review again`
              : `You are assigned as a reviewer on "${input.title}"`,
            reviewId: input.reviewId,
            projectId: input.projectId,
            extra: { projectId: input.projectId },
          });
        } catch (err) {
          log.warn("Failed to fan out review_requested notification", {
            reviewId: input.reviewId,
            userId: reviewerId,
            err,
          });
        }
      }),
    );
  } catch (err) {
    log.error("notifyReviewSubmitted top-level error", { reviewId: input.reviewId, err });
  }
}

/** Fire-and-forget wrapper — no throw / rejection can reach the caller. */
export function dispatchReviewSubmitted(input: ReviewSubmittedInput): void {
  try {
    void notifyReviewSubmitted(input).catch((err: unknown) => {
      log.error("dispatchReviewSubmitted: fan-out rejected", { reviewId: input.reviewId, err });
    });
  } catch (err) {
    log.error("dispatchReviewSubmitted: synchronous failure", { reviewId: input.reviewId, err });
  }
}

// ---- Decision → requester ------------------------------------------------------

export interface ReviewDecisionInput {
  reviewId: string;
  projectId: string;
  title: string;
  requestedById: string;
  /** The deciding reviewer (session identity — see recordDecision). */
  reviewerId: string;
  /** Human label for the reviewer (displayName/username fallback). */
  reviewerName: string;
  decision: "approved" | "rejected";
  /** Terminal aggregate outcome this decision produced; null while pending. */
  outcome: "approved" | "rejected" | null;
  /** Baseline auto-created by a terminal approval (null for docs-only scopes). */
  baselineId?: string | null;
}

/**
 * Notify the requester of one reviewer's decision. When that decision completed
 * the aggregate, the one row sent is the terminal approve/reject outcome, and it
 * names the reviewer and their decision as well (#1581: a `review_decided` row
 * beside it said the same thing twice). Never throws.
 */
export async function notifyReviewDecision(input: ReviewDecisionInput): Promise<void> {
  try {
    // #2394 — only a requester who can still open the project (fails closed).
    const [requester] = await reviewersWhoCanOpenOrNone(input.projectId, [input.requestedById], {
      event: "review_decided",
      reviewId: input.reviewId,
    });
    if (!requester) return;
    // #614 — requester preference gate.
    if (!(await shouldNotify(input.requestedById, "inApp", PREFERENCE_EVENT))) return;

    const decided = `${input.reviewerName} ${input.decision} "${input.title}"`;
    const extra = {
      projectId: input.projectId,
      reviewerId: input.reviewerId,
      decision: input.decision,
    };

    if (input.outcome === null) {
      await persistAndEmit({
        userId: input.requestedById,
        kind: "review_decided",
        title: `Reviewer ${input.decision} your review`,
        message: decided,
        reviewId: input.reviewId,
        projectId: input.projectId,
        extra,
      });
      return;
    }

    const approved = input.outcome === "approved";
    const baselineId = input.baselineId ?? null;
    await persistAndEmit({
      userId: input.requestedById,
      kind: approved ? "review_approved" : "review_rejected",
      title: approved ? "Review approved" : "Review rejected",
      message: approved && baselineId ? `${decided} — a baseline was created` : decided,
      reviewId: input.reviewId,
      projectId: input.projectId,
      extra: { ...extra, baselineId },
    });
  } catch (err) {
    log.error("notifyReviewDecision top-level error", { reviewId: input.reviewId, err });
  }
}

/** Fire-and-forget wrapper — no throw / rejection can reach the caller. */
export function dispatchReviewDecision(input: ReviewDecisionInput): void {
  try {
    void notifyReviewDecision(input).catch((err: unknown) => {
      log.error("dispatchReviewDecision: fan-out rejected", { reviewId: input.reviewId, err });
    });
  } catch (err) {
    log.error("dispatchReviewDecision: synchronous failure", { reviewId: input.reviewId, err });
  }
}

// ---- Edit of a pinned requirement → reviewers + requester ----------------------

/** Review statuses whose pinned versions an edit makes out of date (#2219). */
const PINNING_STATUSES = ["approved", "in_review"] as const;

export interface ReviewedRequirementEditInput {
  requirementId: string;
  /** The version the edit replaced. */
  fromVersion: number;
  /** The version the edit wrote. */
  toVersion: number;
  /** The editor — never notified of their own edit. */
  actorId: string;
}

/**
 * #2219 — tell the reviewers and the requester (those who can still open the
 * project, #2394) of every approved or in-review
 * review that pinned the version this edit replaced that the requirement has
 * changed since. Only a review pinned at `fromVersion` qualifies, so the first
 * edit after a sign-off notifies and a second edit (the pin is already out of
 * date) does not: each person is told once. A person in several such reviews
 * gets one notification, for the most recent one. Every affected review's open
 * page re-reads it. Never throws.
 */
export async function notifyReviewedRequirementEdited(
  input: ReviewedRequirementEditInput,
): Promise<void> {
  try {
    const items = await prisma.reviewRequestItem.findMany({
      where: {
        requirementId: input.requirementId,
        pinnedVersion: input.fromVersion,
        reviewRequest: { status: { in: [...PINNING_STATUSES] } },
      },
      select: {
        requirement: { select: { title: true } },
        reviewRequest: {
          select: {
            id: true,
            title: true,
            status: true,
            projectId: true,
            requestedById: true,
            assignments: { select: { reviewerId: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // #2394 — each review's participants who can still open its project. A
    // person who cannot open the most recent review's project may still be
    // told of an older one they can open.
    const audiences = await Promise.all(
      items.map((item) => {
        const review = item.reviewRequest;
        void emitReviewChanged(review.projectId, review.id);
        const participants = [
          review.requestedById,
          ...review.assignments.map((a) => a.reviewerId),
        ].filter((id) => id !== input.actorId);
        return reviewersWhoCanOpenOrNone(review.projectId, participants, {
          event: "review_item_changed",
          reviewId: review.id,
        });
      }),
    );

    const recipients = new Map<string, (typeof items)[number]>();
    items.forEach((item, i) => {
      for (const userId of audiences[i]) {
        if (!recipients.has(userId)) recipients.set(userId, item);
      }
    });

    await Promise.allSettled(
      [...recipients].map(async ([userId, item]) => {
        const review = item.reviewRequest;
        try {
          if (!(await shouldNotify(userId, "inApp", PREFERENCE_EVENT))) return;
          const approved = review.status === "approved";
          const name = item.requirement?.title ?? "A requirement";
          await persistAndEmit({
            userId,
            kind: "review_item_changed",
            title: approved ? "Approved requirement changed" : "Requirement under review changed",
            message: approved
              ? `"${name}" was edited to v${input.toVersion} after "${review.title}" approved v${input.fromVersion}. It needs a re-review.`
              : `"${name}" was edited to v${input.toVersion} while "${review.title}" is reviewing v${input.fromVersion}.`,
            reviewId: review.id,
            projectId: review.projectId,
            extra: {
              projectId: review.projectId,
              requirementId: input.requirementId,
              pinnedVersion: input.fromVersion,
              currentVersion: input.toVersion,
            },
          });
        } catch (err) {
          log.warn("Failed to fan out review_item_changed notification", {
            reviewId: review.id,
            userId,
            err,
          });
        }
      }),
    );
  } catch (err) {
    log.error("notifyReviewedRequirementEdited top-level error", {
      requirementId: input.requirementId,
      err,
    });
  }
}

/** Fire-and-forget wrapper — no throw / rejection can reach the caller. */
export function dispatchReviewedRequirementEdited(input: ReviewedRequirementEditInput): void {
  try {
    void notifyReviewedRequirementEdited(input).catch((err: unknown) => {
      log.error("dispatchReviewedRequirementEdited: fan-out rejected", {
        requirementId: input.requirementId,
        err,
      });
    });
  } catch (err) {
    log.error("dispatchReviewedRequirementEdited: synchronous failure", {
      requirementId: input.requirementId,
      err,
    });
  }
}
