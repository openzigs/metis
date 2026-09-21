/**
 * IssueDraft, PublishBatch, PublishedIssue schemas.
 *
 * Phase 9 additions: parent linkage, dedup hash, dry-run + archive metadata
 * on PublishBatch, native sub-issue parentIssueNumber on PublishedIssue.
 */
import { z } from "zod";
import {
  ISSUE_DRAFT_STATUSES,
  MAX_BATCH_ISSUES,
  PUBLISHED_ISSUE_STATUSES,
  PUBLISH_BATCH_STATUSES,
  PUBLISH_DESTINATIONS,
} from "./constants.js";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";

export const ISSUE_DRAFT_TYPES = ["epic", "feature", "bug", "task"] as const;
export type IssueDraftType = (typeof ISSUE_DRAFT_TYPES)[number];

// ---- IssueDraft ------------------------------------------------------------
export const issueDraftSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    requirementId: idSchema.nullable(),
    parentDraftId: idSchema.nullable(),
    draftType: z.enum(ISSUE_DRAFT_TYPES),
    title: z.string().min(1).max(255),
    body: z.string().min(1),
    labels: z.string(), // JSON-encoded array
    assignees: z.string(), // JSON-encoded array
    storyPoints: z.number().int().min(0).max(100).nullable(),
    status: z.enum(ISSUE_DRAFT_STATUSES),
    dedupHash: z.string().nullable(),
    metadata: z.string().nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type IssueDraft = z.infer<typeof issueDraftSchema>;

export const createIssueDraftSchema = z.object({
  projectId: idSchema,
  requirementId: idSchema.optional(),
  parentDraftId: idSchema.optional(),
  draftType: z.enum(ISSUE_DRAFT_TYPES).default("feature"),
  title: z.string().min(1).max(255),
  body: z.string().min(1),
  labels: z.array(z.string().min(1).max(64)).max(32).default([]),
  assignees: z.array(z.string().min(1).max(64)).max(10).default([]),
  storyPoints: z.number().int().min(0).max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateIssueDraftInput = z.infer<typeof createIssueDraftSchema>;

export const updateIssueDraftSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  body: z.string().min(1).optional(),
  labels: z.array(z.string().min(1).max(64)).max(32).optional(),
  assignees: z.array(z.string().min(1).max(64)).max(10).optional(),
  storyPoints: z.number().int().min(0).max(100).nullable().optional(),
  status: z.enum(ISSUE_DRAFT_STATUSES).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type UpdateIssueDraftInput = z.infer<typeof updateIssueDraftSchema>;

// ---- PublishBatch ----------------------------------------------------------
export const PUBLISH_PROVIDERS = ["github", "github_enterprise"] as const;
export type PublishProvider = (typeof PUBLISH_PROVIDERS)[number];

export const publishBatchSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    status: z.enum(PUBLISH_BATCH_STATUSES),
    targetOwner: z.string().min(1).max(128),
    targetRepo: z.string().min(1).max(128),
    targetBaseUrl: z.string().url().nullable(),
    provider: z.enum(PUBLISH_PROVIDERS),
    dryRun: z.boolean(),
    totalDrafts: z.number().int().min(0),
    publishedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    dedupSkipped: z.number().int().min(0),
    archived: z.boolean(),
    archivedAt: dateSchema.nullable(),
    archiveReason: z.string().max(2000).nullable(),
    archivedById: idSchema.nullable(),
    dryRunPlan: z.string().nullable(),
    startedById: idSchema,
    startedAt: dateSchema,
    completedAt: dateSchema.nullable(),
    errorMessage: z.string().max(4096).nullable(),
    metadata: z.string().nullable(),
  })
  .merge(timestampsSchema);
export type PublishBatch = z.infer<typeof publishBatchSchema>;

export const createPublishBatchSchema = z.object({
  projectId: idSchema,
  targetOwner: z.string().min(1).max(128),
  targetRepo: z.string().min(1).max(128),
  targetBaseUrl: z.string().url().optional(),
  provider: z.enum(PUBLISH_PROVIDERS).default("github"),
  draftIds: z.array(idSchema).min(1).max(MAX_BATCH_ISSUES),
  dryRun: z.boolean().default(false),
  additionalLabels: z.array(z.string().min(1).max(64)).max(32).default([]),
  milestone: z.number().int().min(1).optional(),
  secretRef: z.string().min(1).max(256).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreatePublishBatchInput = z.infer<typeof createPublishBatchSchema>;

export const archivePublishBatchSchema = z.object({
  reason: z.string().min(1).max(2000),
  closeIssues: z.boolean().default(true),
});
export type ArchivePublishBatchInput = z.infer<typeof archivePublishBatchSchema>;

// ---- Stranded-batch cancellation (#1104 F) ---------------------------------
/**
 * How long a `pending`/`running` batch is assumed to be genuinely in flight.
 *
 * A publish runs inside the request that created it and there is no heartbeat
 * on the row, so "is this batch alive?" can only be answered by age. Anything
 * still un-settled after this window is either stranded (the process died, or
 * an abort predating #1092 left the row behind) or is a run so long that the
 * user is better served by an explicit remedy than by a row that never clears.
 *
 * The window doubles as the safety guard for cancel: below it, cancel is
 * refused, because cancelling is a *bookkeeping* operation — it settles the
 * local row and never recalls anything the publisher has already written to
 * GitHub. Refusing while a run is plausibly alive is what keeps those two
 * facts from colliding.
 */
export const PUBLISH_BATCH_IN_FLIGHT_GRACE_MS = 15 * 60 * 1000;

export type PublishBatchCancelReason = "ok" | "not_in_progress" | "in_flight";

export interface PublishBatchCancelState {
  cancellable: boolean;
  reason: PublishBatchCancelReason;
  /** Milliseconds until the batch becomes cancellable (0 when it already is). */
  waitMs: number;
}

/**
 * Whether a batch may be cancelled, and if not, why.
 *
 * Deliberately shared: the server enforces this (a client cannot talk its way
 * past the in-flight guard) and the UI renders from the *same* verdict, so the
 * button is never offered for an action the API would reject.
 */
export function publishBatchCancelState(
  batch: { status: string; archived?: boolean; startedAt: string | Date },
  now: number = Date.now(),
): PublishBatchCancelState {
  const inProgress = batch.status === "pending" || batch.status === "running";
  if (!inProgress || batch.archived === true) {
    return { cancellable: false, reason: "not_in_progress", waitMs: 0 };
  }
  const started = new Date(batch.startedAt).getTime();
  if (!Number.isFinite(started)) {
    // Cannot prove the run is stale → refuse. Fail-closed: an unreadable
    // timestamp must not become a licence to settle a live run's row.
    return { cancellable: false, reason: "in_flight", waitMs: PUBLISH_BATCH_IN_FLIGHT_GRACE_MS };
  }
  const age = now - started;
  if (age < PUBLISH_BATCH_IN_FLIGHT_GRACE_MS) {
    return {
      cancellable: false,
      reason: "in_flight",
      waitMs: PUBLISH_BATCH_IN_FLIGHT_GRACE_MS - age,
    };
  }
  return { cancellable: true, reason: "ok", waitMs: 0 };
}

// ---- Approval gate (Epic #609, #619) ----------------------------------------
/**
 * Per-project publish/export approval gate config
 * (`GET|PATCH /api/projects/:id/review-gate`). When `requireApprovedReview`
 * is true, publishing IssueDrafts and exporting requirements / generated
 * documents require an APPROVED review pinned to the artifact's current
 * version. Toggling requires the `review.admin` permission.
 */
export const reviewGateConfigSchema = z
  .object({
    requireApprovedReview: z.boolean(),
  })
  // PR #638 review nit — reject typo'd/unknown keys instead of silently
  // ignoring them (the PATCH handler only ever writes the parsed boolean,
  // but a strict parse surfaces client mistakes instead of no-oping).
  .strict();
export type ReviewGateConfig = z.infer<typeof reviewGateConfigSchema>;

// ---- PublishedIssue --------------------------------------------------------
export const publishedIssueSchema = z.object({
  id: idSchema,
  batchId: idSchema,
  draftId: idSchema,
  issueNumber: z.number().int().min(0),
  issueId: z.string().min(1).max(128),
  htmlUrl: z.string().url(),
  status: z.enum(PUBLISHED_ISSUE_STATUSES),
  destination: z.enum(PUBLISH_DESTINATIONS).default("github"),
  parentIssueNumber: z.number().int().min(1).nullable(),
  dedupHash: z.string().nullable(),
  bodyHash: z.string().nullable(),
  errorMessage: z.string().max(4096).nullable(),
  publishedAt: dateSchema,
});
export type PublishedIssue = z.infer<typeof publishedIssueSchema>;

export const createPublishedIssueSchema = publishedIssueSchema
  .pick({
    batchId: true,
    draftId: true,
    issueNumber: true,
    issueId: true,
    htmlUrl: true,
    status: true,
    parentIssueNumber: true,
    dedupHash: true,
    bodyHash: true,
    errorMessage: true,
  })
  .partial({ errorMessage: true, parentIssueNumber: true, dedupHash: true, bodyHash: true });
export type CreatePublishedIssueInput = z.infer<typeof createPublishedIssueSchema>;

// ---- Generation request ----------------------------------------------------
export const generateDraftsSchema = z.object({
  analysisId: idSchema,
  defaultLabels: z.array(z.string().min(1).max(64)).max(16).default([]),
});
export type GenerateDraftsInput = z.infer<typeof generateDraftsSchema>;

// ---- Dry-run plan shape (returned to UI when dryRun=true) -----------------
export const dryRunActionSchema = z.object({
  kind: z.enum([
    "label.upsert",
    "issue.create",
    "issue.update",
    "issue.skipDuplicate",
    "subIssue.attach",
    "issue.close",
  ]),
  draftId: idSchema.optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  parentDraftId: idSchema.optional(),
  parentIssueNumber: z.number().int().optional(),
  existingIssueNumber: z.number().int().optional(),
  reason: z.string().optional(),
});
export type DryRunAction = z.infer<typeof dryRunActionSchema>;

/**
 * #1093 — whether the batch's vault secret ref actually resolved during the
 * preview. A dry run that cannot predict the live run's single most common
 * failure (a credential that will not resolve) is worse than no dry run, so
 * the plan carries the verdict explicitly:
 *
 *   - `resolved`   — the ref resolved to a token; the live run gets as far as
 *                    the network.
 *   - `missing`    — no ref was supplied. Legitimate for a preview, but the
 *                    live run WILL be rejected.
 *   - `unresolved` — a ref was supplied and could not be resolved.
 *
 * The token itself is never resolved into the plan — only this verdict.
 */
export const CREDENTIAL_CHECK_RESULTS = ["resolved", "missing", "unresolved"] as const;
export type CredentialCheckResult = (typeof CREDENTIAL_CHECK_RESULTS)[number];

export const dryRunPlanSchema = z.object({
  batchId: idSchema,
  targetOwner: z.string(),
  targetRepo: z.string(),
  targetBaseUrl: z.string().nullable(),
  provider: z.enum(PUBLISH_PROVIDERS),
  totalActions: z.number().int().min(0),
  estimatedDurationMs: z.number().int().min(0),
  actions: z.array(dryRunActionSchema),
  /** #1093 — true only when the vault ref resolved to a usable token. */
  credentialResolved: z.boolean().default(false),
  credentialCheck: z.enum(CREDENTIAL_CHECK_RESULTS).default("missing"),
  /**
   * Machine-readable reason when `credentialResolved` is false. A bare
   * SCREAMING_SNAKE code only — never vault contents or upstream text.
   */
  credentialErrorCode: z.string().max(64).nullable().default(null),
});
export type DryRunPlan = z.infer<typeof dryRunPlanSchema>;
