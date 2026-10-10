/**
 * Dry-run renderer — Phase 9 (#70).
 *
 * Produces the exact list of API calls (label upserts, issue creates,
 * sub-issue attaches) that a publish run *would* execute, WITHOUT touching
 * the network. Returned to the UI for review and stored on the
 * `PublishBatch.dryRunPlan` column for replay.
 */
import { type DryRunAction, type DryRunPlan } from "./internal-shared.js";
import type { ApprovalGateCheckResult, CredentialCheckResult } from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { labelsToSync, publishableLabels } from "./label-sync.js";
import { computeBodyHash, computeDedupHash, injectMarker } from "./dedup.js";

export interface DryRunInput {
  batchId: string;
  targetOwner: string;
  targetRepo: string;
  targetBaseUrl: string | null;
  provider: "github" | "github_enterprise";
  drafts: Array<{
    id: string;
    title: string;
    body: string;
    labels: string[];
    parentDraftId: string | null;
    draftType: string;
  }>;
  additionalLabels: string[];
  /** dedupHash → existing issue number (from PublishedIssue rows). */
  existingByHash: Map<string, { issueNumber: number; bodyHash: string | null }>;
  /** Estimated cost per API call (ms). */
  perCallMs: number;
  /**
   * #1093 — verdict from pre-flighting the batch's vault secret ref. The
   * caller resolves it (the plan builder stays pure); only the verdict and a
   * bare error code are recorded, never the token.
   */
  credential?: { check: CredentialCheckResult; errorCode: string | null };
  /**
   * #744 — the approval gate's verdict on these drafts, resolved by the
   * caller (`previewDraftsGate`) so the builder stays pure. Omitted → the
   * plan carries no verdict (`approvalGate: null`).
   */
  approvalGate?: { check: ApprovalGateCheckResult; blockedDraftIds: string[] };
}

export function buildDryRunPlan(input: DryRunInput): DryRunPlan {
  const actions: DryRunAction[] = [];
  // 1. label upserts — one per label some draft carries, plus the batch's
  // requested labels (#744: never a hidden `finding:<id>` label, never an
  // unused base label). Mirrors the live run's `syncLabels` call.
  const drafts = input.drafts.map((d) => ({ ...d, labels: publishableLabels(d.labels) }));
  for (const l of labelsToSync(
    drafts.map((d) => d.labels),
    input.additionalLabels,
  )) {
    actions.push({ kind: "label.upsert", labels: [l.name] });
  }
  const blocked = new Set(input.approvalGate?.blockedDraftIds ?? []);
  const gateMark = (draftId: string) =>
    blocked.has(draftId) ? { blockedByApprovalGate: true } : {};
  // 2. epics first then features, mirroring the runtime ordering.
  const epics = drafts.filter((d) => d.draftType === "epic");
  const features = drafts.filter((d) => d.draftType !== "epic");
  const ordered = [...epics, ...features];
  const epicNumbers = new Map<string, number>();
  let nextSyntheticNumber = 1000;
  for (const d of ordered) {
    const hash = computeDedupHash(input.targetOwner, input.targetRepo, d.title);
    const existing = input.existingByHash.get(hash);
    const stampedBody = injectMarker(d.body, { batchId: input.batchId, draftId: d.id, hash });
    // bodyHash is computed on the raw user-supplied body (no marker) so dry
    // runs match the live publisher's dedup semantics.
    const bodyHash = computeBodyHash(d.body);
    if (existing) {
      if (existing.bodyHash === bodyHash) {
        actions.push({
          kind: "issue.skipDuplicate",
          draftId: d.id,
          existingIssueNumber: existing.issueNumber,
          reason: "body unchanged",
        });
      } else {
        actions.push({
          kind: "issue.update",
          draftId: d.id,
          existingIssueNumber: existing.issueNumber,
          title: d.title,
          body: stampedBody,
          labels: d.labels,
          ...gateMark(d.id),
        });
      }
      if (d.draftType === "epic") epicNumbers.set(d.id, existing.issueNumber);
      continue;
    }
    actions.push({
      kind: "issue.create",
      draftId: d.id,
      title: d.title,
      body: stampedBody,
      labels: d.labels,
      parentDraftId: d.parentDraftId ?? undefined,
      ...gateMark(d.id),
    });
    const synthetic = nextSyntheticNumber++;
    if (d.draftType === "epic") epicNumbers.set(d.id, synthetic);
    if (d.parentDraftId && epicNumbers.has(d.parentDraftId)) {
      actions.push({
        kind: "subIssue.attach",
        draftId: d.id,
        parentDraftId: d.parentDraftId,
        parentIssueNumber: epicNumbers.get(d.parentDraftId),
      });
    }
  }
  const credential = input.credential ?? { check: "missing" as const, errorCode: null };
  return {
    batchId: input.batchId,
    targetOwner: input.targetOwner,
    targetRepo: input.targetRepo,
    targetBaseUrl: input.targetBaseUrl,
    provider: input.provider,
    totalActions: actions.length,
    estimatedDurationMs: actions.length * input.perCallMs,
    actions,
    credentialResolved: credential.check === "resolved",
    credentialCheck: credential.check,
    credentialErrorCode: credential.errorCode,
    approvalGate: input.approvalGate
      ? {
          check: input.approvalGate.check,
          blockedDraftIds: [...input.approvalGate.blockedDraftIds],
        }
      : null,
  };
}

/**
 * The warning a completed dry run records on its batch row, or `null` when a
 * live run of the same batch would get as far as GitHub. #1093 covers the
 * credential; #744 adds the approval gate, which refuses the live run (409)
 * when it blocks and fails closed (503) when it cannot be checked.
 */
export function dryRunWarning(plan: DryRunPlan): string | null {
  const reasons: string[] = [];
  if (!plan.credentialResolved) {
    reasons.push(`the GitHub credential did not resolve (${plan.credentialCheck})`);
  }
  const gate = plan.approvalGate;
  if (gate?.check === "blocked") {
    reasons.push(
      `the approval gate would block ${gate.blockedDraftIds.length} draft(s) (APPROVAL_REQUIRED)`,
    );
  } else if (gate?.check === "unavailable") {
    reasons.push("the approval gate could not be checked (APPROVAL_GATE_UNAVAILABLE)");
  }
  if (reasons.length === 0) return null;
  return `dry run completed, but ${reasons.join(" and ")} — a live publish would be rejected`;
}

// Prisma re-export for downstream callers without dragging a hard dep.
export type { Prisma };
