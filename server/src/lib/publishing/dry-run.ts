/**
 * Dry-run renderer — Phase 9 (#70).
 *
 * Produces the exact list of API calls (label upserts, issue creates,
 * sub-issue attaches) that a publish run *would* execute, WITHOUT touching
 * the network. Returned to the UI for review and stored on the
 * `PublishBatch.dryRunPlan` column for replay.
 */
import { type DryRunAction, type DryRunPlan, type GhLabel } from "./internal-shared.js";
import type { CredentialCheckResult } from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { combineLabels, DEFAULT_PUBLISH_LABELS } from "./label-sync.js";
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
}

export function buildDryRunPlan(input: DryRunInput): DryRunPlan {
  const actions: DryRunAction[] = [];
  // 1. label upserts — one per distinct label name.
  const labels = combineLabels(DEFAULT_PUBLISH_LABELS, input.additionalLabels) as GhLabel[];
  const seen = new Set<string>();
  const draftLabels = new Set<string>();
  for (const d of input.drafts) for (const l of d.labels) draftLabels.add(l);
  for (const l of [
    ...labels,
    ...Array.from(draftLabels).map((n) => ({ name: n, color: "ededed" }) as GhLabel),
  ]) {
    const key = l.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ kind: "label.upsert", labels: [l.name] });
  }
  // 2. epics first then features, mirroring the runtime ordering.
  const epics = input.drafts.filter((d) => d.draftType === "epic");
  const features = input.drafts.filter((d) => d.draftType !== "epic");
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
  };
}

// Prisma re-export for downstream callers without dragging a hard dep.
export type { Prisma };
