/**
 * Issue #616 (epic #609) — pure review-workflow state machine.
 *
 * The single source of truth for `ReviewRequest.status` transitions, reviewer
 * decision aggregation (`all` / `quorum(n)` policies), the
 * `Requirement.reviewStatus` derivation rule, and baseline version pinning.
 * Pure module: no Prisma, no I/O — the review service/API (#617) calls into
 * this and persists the results.
 *
 * State diagram (epic #609):
 *
 *   draft --submit--> in_review --approve--> approved --reopen--> in_review
 *                     in_review --reject---> rejected --revise--> draft
 *                     in_review --withdraw-> draft
 *   any non-closed state --close--> closed (terminal archive/abandon)
 *
 * Illegal transitions throw {@link IllegalReviewTransitionError} (HTTP 409).
 */
import { AppError } from "../../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** `ReviewRequest.status` values (mirrors the schema comment). */
export const REVIEW_STATUSES = ["draft", "in_review", "approved", "rejected", "closed"] as const;
export type ReviewRequestStatus = (typeof REVIEW_STATUSES)[number];

/** Events accepted by {@link transition}. */
export const REVIEW_EVENTS = [
  "submit",
  "approve",
  "reject",
  "withdraw",
  "revise",
  "reopen",
  "close",
] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** `ReviewRequest.policy` values. */
export const REVIEW_POLICIES = ["all", "quorum"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

/** `ReviewerAssignment.decision` values. */
export const REVIEWER_DECISIONS = ["pending", "approved", "rejected"] as const;
export type ReviewerDecision = (typeof REVIEWER_DECISIONS)[number];

/** Aggregate outcome of all reviewer decisions under the review's policy. */
export type AggregateDecision = "pending" | "approved" | "rejected";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when an event is not legal from the current status (HTTP 409). */
export class IllegalReviewTransitionError extends AppError {
  constructor(from: ReviewRequestStatus, event: ReviewEvent) {
    super(409, "ILLEGAL_REVIEW_TRANSITION", `Cannot "${event}" a review in status "${from}"`, {
      from,
      event,
    });
    this.name = "IllegalReviewTransitionError";
  }
}

/** Thrown for an invalid policy/quorum configuration (HTTP 400). */
export class InvalidReviewPolicyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, "INVALID_REVIEW_POLICY", message, details);
    this.name = "InvalidReviewPolicyError";
  }
}

/** Thrown for an invalid baseline pin set (HTTP 400). */
export class InvalidBaselinePinError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, "INVALID_BASELINE_PIN", message, details);
    this.name = "InvalidBaselinePinError";
  }
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Exhaustive transition table: every status maps every LEGAL event to its
 * target status; anything absent is illegal. `closed` is terminal.
 */
export const REVIEW_TRANSITIONS: Readonly<
  Record<ReviewRequestStatus, Readonly<Partial<Record<ReviewEvent, ReviewRequestStatus>>>>
> = {
  draft: { submit: "in_review", close: "closed" },
  in_review: { approve: "approved", reject: "rejected", withdraw: "draft", close: "closed" },
  approved: { reopen: "in_review", close: "closed" },
  rejected: { revise: "draft", close: "closed" },
  closed: {},
};

/** Whether `event` is legal from `from`. */
export function canTransition(from: ReviewRequestStatus, event: ReviewEvent): boolean {
  return REVIEW_TRANSITIONS[from][event] !== undefined;
}

/** The legal events from `from` (empty for terminal statuses). */
export function legalEvents(from: ReviewRequestStatus): ReviewEvent[] {
  return Object.keys(REVIEW_TRANSITIONS[from]) as ReviewEvent[];
}

/**
 * Apply `event` to `from`, returning the next status.
 * @throws {IllegalReviewTransitionError} when the transition is not in the table.
 */
export function transition(from: ReviewRequestStatus, event: ReviewEvent): ReviewRequestStatus {
  const next = REVIEW_TRANSITIONS[from][event];
  if (next === undefined) throw new IllegalReviewTransitionError(from, event);
  return next;
}

// ---------------------------------------------------------------------------
// Decision aggregation (all / quorum policies)
// ---------------------------------------------------------------------------

/**
 * Validate a policy configuration against the reviewer count.
 *
 * - a review requires at least one reviewer;
 * - `all` must not carry a quorum value;
 * - `quorum` requires an integer `1 <= quorum <= reviewerCount` (a quorum
 *   above the reviewer count could never be satisfied).
 *
 * @throws {InvalidReviewPolicyError}
 */
export function assertValidPolicy(
  policy: ReviewPolicy,
  quorum: number | null | undefined,
  reviewerCount: number,
): void {
  if (!REVIEW_POLICIES.includes(policy)) {
    throw new InvalidReviewPolicyError(`Unknown review policy "${String(policy)}"`, { policy });
  }
  if (reviewerCount < 1) {
    throw new InvalidReviewPolicyError("A review requires at least one reviewer", {
      reviewerCount,
    });
  }
  if (policy === "all") {
    if (quorum !== null && quorum !== undefined) {
      throw new InvalidReviewPolicyError('Policy "all" must not specify a quorum', { quorum });
    }
    return;
  }
  // policy === "quorum"
  if (quorum === null || quorum === undefined) {
    throw new InvalidReviewPolicyError('Policy "quorum" requires a quorum value');
  }
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > reviewerCount) {
    throw new InvalidReviewPolicyError(
      `Quorum must be an integer between 1 and the reviewer count (${reviewerCount})`,
      { quorum, reviewerCount },
    );
  }
}

/**
 * Aggregate per-reviewer decisions into the review outcome.
 *
 * The outcome flips to `rejected` exactly when approval has become
 * IMPOSSIBLE under the policy:
 * - `all`: any single rejection (unanimity is no longer reachable);
 * - `quorum(n)`: once `rejections > reviewerCount - n` (fewer than `n`
 *   reviewers could still approve). A lone rejection under a reachable quorum
 *   leaves the review `pending`.
 *
 * Decisions other than `approved`/`rejected` count as pending.
 *
 * @throws {InvalidReviewPolicyError} on an invalid policy configuration.
 */
export function aggregateDecisions(
  decisions: readonly ReviewerDecision[],
  policy: ReviewPolicy,
  quorum?: number | null,
): AggregateDecision {
  assertValidPolicy(policy, quorum, decisions.length);

  const approvals = decisions.filter((d) => d === "approved").length;
  const rejections = decisions.filter((d) => d === "rejected").length;
  const required = policy === "all" ? decisions.length : (quorum as number);

  if (rejections > decisions.length - required) return "rejected";
  if (approvals >= required) return "approved";
  return "pending";
}

// ---------------------------------------------------------------------------
// Requirement.reviewStatus derivation
// ---------------------------------------------------------------------------

/**
 * Derivation rule for the legacy `Requirement.reviewStatus` column (kept for
 * backward compatibility with `review:*` label parsing — see
 * `server/prisma/schema.prisma` on `Requirement.reviewStatus`).
 *
 * When a requirement is in the scope of a formal review, the WORKFLOW owns the
 * column — it must never be hand-set. On every `ReviewRequest.status` change,
 * the service writes the derived value to every requirement in scope:
 *
 * - `draft` / `in_review` → `"draft"` (not yet — or no longer — approved;
 *   covers withdraw, revise, and reopen-on-content-change);
 * - `approved` → `"approved"`;
 * - `rejected` → `"rejected"`;
 * - `closed` → `null` — an archived review carries no verdict, so the
 *   requirement's existing reviewStatus is left untouched.
 */
export function deriveRequirementReviewStatus(
  status: ReviewRequestStatus,
): "draft" | "approved" | "rejected" | null {
  switch (status) {
    case "draft":
    case "in_review":
      return "draft";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "closed":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Baseline version pinning
// ---------------------------------------------------------------------------

/** A review-scope item as stored on `ReviewRequestItem`. */
export interface ReviewScopeItem {
  requirementId: string | null;
  generatedDocumentId: string | null;
  /** Version counter of the artifact captured at submit time. */
  pinnedVersion: number;
}

/** A `(requirementId, version)` pin — one `BaselineItem` row. */
export interface BaselinePin {
  requirementId: string;
  version: number;
}

/**
 * Build the `BaselineItem` pins for an approved review's scope.
 *
 * Baselines pin requirement versions over the `RequirementVersion` substrate
 * (epic #770) — spec-document items are not baseline-pinnable and are skipped.
 * Identical duplicate pins are deduped; conflicting versions for the same
 * requirement are a scope bug and throw.
 *
 * @throws {InvalidBaselinePinError}
 */
export function buildBaselinePins(items: readonly ReviewScopeItem[]): BaselinePin[] {
  const byRequirement = new Map<string, number>();
  for (const item of items) {
    if (item.requirementId !== null && item.generatedDocumentId !== null) {
      throw new InvalidBaselinePinError(
        "A review item must reference exactly one artifact (both requirement and document set)",
        { requirementId: item.requirementId, generatedDocumentId: item.generatedDocumentId },
      );
    }
    if (item.requirementId === null && item.generatedDocumentId === null) {
      throw new InvalidBaselinePinError(
        "A review item must reference exactly one artifact (neither requirement nor document set)",
      );
    }
    if (!Number.isInteger(item.pinnedVersion) || item.pinnedVersion < 0) {
      throw new InvalidBaselinePinError("Pinned version must be a non-negative integer", {
        requirementId: item.requirementId,
        generatedDocumentId: item.generatedDocumentId,
        pinnedVersion: item.pinnedVersion,
      });
    }
    if (item.requirementId === null) continue; // spec docs are not pinnable

    const existing = byRequirement.get(item.requirementId);
    if (existing !== undefined && existing !== item.pinnedVersion) {
      throw new InvalidBaselinePinError(
        `Conflicting pinned versions for requirement "${item.requirementId}"`,
        { requirementId: item.requirementId, versions: [existing, item.pinnedVersion] },
      );
    }
    byRequirement.set(item.requirementId, item.pinnedVersion);
  }
  return [...byRequirement.entries()].map(([requirementId, version]) => ({
    requirementId,
    version,
  }));
}
