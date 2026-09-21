/**
 * Epic #394 (#400) — Structured audit telemetry for the PR-reviewer agent.
 *
 * Wraps the generic `audit()` helper to enforce a stable shape across every
 * PR-review event so downstream queries (`SELECT … WHERE action='pr.reviewed'`)
 * can rely on the metadata keys.
 *
 * Event kinds (single string column, free-form):
 *   - `pr.reviewed`        — full review completed and posted
 *   - `pr.review_skipped`  — short-circuited (no link / too large / budget)
 *   - `pr.review_errored`  — judge / poster threw or returned an unparseable response
 */
import { audit } from "../../audit/audit-service.js";

export type PrReviewSkipReason =
  | "no_linked_issue"
  | "no_published_issue"
  | "no_acceptance_criteria"
  | "diff_too_large"
  | "budget_exceeded"
  /** Epic #394 P2 (#403) — webhook delivery already processed (`X-GitHub-Delivery` dedup hit). */
  | "duplicate_delivery"
  /** Epic #394 P2 (#405) — incremental re-review path determined no AC needs re-judging. */
  | "no_substantive_change"
  /** Epic #394 P2 (#407) — per-repo config `skipAuthors[]` matched the PR author. */
  | "author_filter"
  /** Epic #394 P2 (#407) — per-repo config `skipDraftPrs: true` and PR is in draft state. */
  | "draft_pr_skipped";

export interface PrReviewAuditCommon {
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  installationId: string | null;
  /** Issue numbers that contributed ACs to the review (post-resolution). */
  linkedIssueNumbers: number[];
  /** Initiating actor — webhook installation id, manual user id, or system. */
  actor: { type: "user" | "system" | "webhook"; id: string | null };
  projectId?: string | null;
}

export interface PrReviewedAudit extends PrReviewAuditCommon {
  verdict: "approve" | "request_changes" | "comment";
  acPassRate: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  reviewId: number | null;
  reviewUrl: string | null;
}

export interface PrReviewSkippedAudit extends PrReviewAuditCommon {
  reason: PrReviewSkipReason;
  /** Optional context: bytes when diff_too_large, monthly cap when budget_exceeded. */
  details?: Record<string, unknown>;
}

export interface PrReviewErroredAudit extends PrReviewAuditCommon {
  errorMessage: string;
  latencyMs: number;
  /** Best-effort model id at error time (may be null when failure is upstream). */
  model: string | null;
}

/** Emit a `pr.reviewed` audit row for a successful review. */
export function auditPrReviewed(entry: PrReviewedAudit): void {
  audit({
    actor: entry.actor.id,
    action: "pr.reviewed",
    target: { type: "pull_request", id: targetId(entry) },
    metadata: {
      verdict: entry.verdict,
      acPassRate: round4(entry.acPassRate),
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: round6(entry.costUsd),
      latencyMs: entry.latencyMs,
      reviewId: entry.reviewId,
      reviewUrl: entry.reviewUrl,
      installationId: entry.installationId,
      actorType: entry.actor.type,
      prUrl: entry.prUrl,
      prNumber: entry.prNumber,
      repoOwner: entry.repoOwner,
      repoName: entry.repoName,
      linkedIssueNumbers: [...entry.linkedIssueNumbers],
      projectId: entry.projectId ?? null,
    },
  });
}

/** Emit a `pr.review_skipped` audit row when the agent short-circuits. */
export function auditPrReviewSkipped(entry: PrReviewSkippedAudit): void {
  audit({
    actor: entry.actor.id,
    action: "pr.review_skipped",
    target: { type: "pull_request", id: targetId(entry) },
    metadata: {
      reason: entry.reason,
      installationId: entry.installationId,
      actorType: entry.actor.type,
      prUrl: entry.prUrl,
      prNumber: entry.prNumber,
      repoOwner: entry.repoOwner,
      repoName: entry.repoName,
      linkedIssueNumbers: [...entry.linkedIssueNumbers],
      projectId: entry.projectId ?? null,
      details: entry.details ?? {},
    },
  });
}

/** Emit a `pr.review_errored` audit row when judge/poster fails. */
export function auditPrReviewErrored(entry: PrReviewErroredAudit): void {
  audit({
    actor: entry.actor.id,
    action: "pr.review_errored",
    target: { type: "pull_request", id: targetId(entry) },
    metadata: {
      verdict: "errored",
      errorMessage: entry.errorMessage,
      latencyMs: entry.latencyMs,
      model: entry.model,
      installationId: entry.installationId,
      actorType: entry.actor.type,
      prUrl: entry.prUrl,
      prNumber: entry.prNumber,
      repoOwner: entry.repoOwner,
      repoName: entry.repoName,
      linkedIssueNumbers: [...entry.linkedIssueNumbers],
      projectId: entry.projectId ?? null,
    },
  });
}

function targetId(c: PrReviewAuditCommon): string {
  return `${c.repoOwner}/${c.repoName}#${c.prNumber}`;
}

function round4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : 0;
}

function round6(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1_000_000) / 1_000_000 : 0;
}
