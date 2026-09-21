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
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";
import { shouldNotify } from "../notifications/preferences.js";

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
  | "review_rejected";

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

  try {
    await prisma.notification.create({
      data: {
        userId: n.userId,
        type: n.kind,
        title: n.title,
        message: n.message,
        href: reviewHref(n.reviewId),
        payload: JSON.stringify(payload),
      },
    });
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
    if (io) io.to(`user:${n.userId}`).emit("review:notification", payload);
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
}

/**
 * Notify every assigned reviewer that a review round has been submitted and
 * awaits their decision. Never throws.
 */
export async function notifyReviewSubmitted(input: ReviewSubmittedInput): Promise<void> {
  try {
    const reviewerIds = [...new Set(input.reviewerIds)].filter((id) => id !== input.actorId);

    await Promise.allSettled(
      reviewerIds.map(async (reviewerId) => {
        try {
          // #614 — per-recipient preference gate (fail-open, never throws).
          if (!(await shouldNotify(reviewerId, "inApp", PREFERENCE_EVENT))) return;

          await persistAndEmit({
            userId: reviewerId,
            kind: "review_requested",
            title: "Review requested",
            message: `You are assigned as a reviewer on "${input.title}"`,
            reviewId: input.reviewId,
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
 * Notify the requester of one reviewer's decision — plus, when that decision
 * completed the aggregate, of the terminal approve/reject outcome. Never
 * throws.
 */
export async function notifyReviewDecision(input: ReviewDecisionInput): Promise<void> {
  try {
    // #614 — requester preference gate; one check covers both rows (same cell).
    if (!(await shouldNotify(input.requestedById, "inApp", PREFERENCE_EVENT))) return;

    await persistAndEmit({
      userId: input.requestedById,
      kind: "review_decided",
      title: `Reviewer ${input.decision} your review`,
      message: `${input.reviewerName} ${input.decision} "${input.title}"`,
      reviewId: input.reviewId,
      extra: { projectId: input.projectId, reviewerId: input.reviewerId, decision: input.decision },
    });

    if (input.outcome !== null) {
      const approved = input.outcome === "approved";
      const baselineId = input.baselineId ?? null;
      await persistAndEmit({
        userId: input.requestedById,
        kind: approved ? "review_approved" : "review_rejected",
        title: approved ? "Review approved" : "Review rejected",
        message: approved
          ? `"${input.title}" was approved${baselineId ? " — a baseline was created" : ""}`
          : `"${input.title}" was rejected`,
        reviewId: input.reviewId,
        extra: { projectId: input.projectId, baselineId },
      });
    }
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
