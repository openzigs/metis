/**
 * Batch publisher — Phase 9 (#66/#68/#69).
 *
 * Pipeline:
 *
 *   1. Pre-checks: resolve target, allow-list host, verify auth scope.
 *   2. Optional GraphQL-style dedup pre-scan (REST list+filter for now;
 *      compatible with the shared dedup hash + marker contract). Existing
 *      issue numbers are loaded into memory before any mutation runs.
 *   3. Sync labels via `PUT /repos/.../labels/{name}` (idempotent).
 *   4. Order drafts: epics first, then features.
 *   5. For each draft:
 *      a. compute dedup hash; if found, update the existing issue body if
 *         body hash changed, otherwise skip (`dedupSkipped++`).
 *      b. otherwise create the issue, persist `PublishedIssue`, attach to the
 *         parent epic via the native sub-issue API (`POST /sub_issues`) with
 *         3x retry & exponential backoff.
 *      c. honour the inter-mutation delay (≥1s ± jitter).
 *   6. If `failedCount / totalDrafts > 0.5`, automatically rollback (close
 *      every PublishedIssue created in this batch with a clear comment).
 *   7. Always emit progress + final status events.
 *
 * Idempotency contract: re-running a batch with the same drafts produces no
 * new issues. A draft whose PublishedIssue row the dedup map does not use
 * (archived batch, no recorded hash, a failed row naming its issue) is matched
 * from that row and confirmed by the marker comment in the issue body (#1106);
 * the marker alone never starts a match.
 *
 * ## Which identifier `PublishedIssue.issueId` stores (#1091)
 *
 * The **GraphQL node id** (`node_id`), not the numeric REST `id`. Two existing
 * consumers make that the only correct choice:
 *
 *   - `publish-extensions.ts` passes `issueId` as `contentId` to
 *     `addProjectV2ItemById(contentId: ID!)`, which only accepts a node id.
 *   - `lib/sync/reconcile-service.ts` looks issues up by
 *     `issueId === event.externalId`, and the issue webhook sets `externalId`
 *     from `issue.node_id`.
 *
 * Storing the numeric id would break both, and the column is already `String`
 * (documented "remote node id"). The numeric REST `id` is still needed — the
 * sub-issue API's `sub_issue_id` field takes it — so it is carried through the
 * loop as a local, never persisted; it is re-derivable from any issue fetch.
 *
 * No data migration was required: because the numeric id could never satisfy
 * the `String` column, every write that would have stored one threw instead.
 * No row can hold a bad value.
 */
import { SYSTEM_ACTOR_ID } from "../audit/system-actor.js";
import { GITHUB_API_VERSION, type CredentialCheckResult, type DryRunPlan } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { assertDraftsPublishable, previewDraftsGate } from "../reviews/approval-gate.js";
import { createChildLogger } from "../logger.js";
import { getVaultService } from "../vault/vault-service.js";
import { readBoundSecret, resolveVaultRef } from "../connectors/vault-resolver.js";
import { resolvePublishTarget } from "./host-allowlist.js";
import {
  acquirePublishOctokit,
  currentPublishMaxRetries,
  nextDelayMs,
  rateLimitConfigFromEnv,
  verifyAuthScope,
} from "./octokit-factory.js";
import {
  buildMarkerComment,
  computeBodyHash,
  computeDraftBodyHash,
  computeDedupHash,
  injectMarker,
  parseMarkers,
  sourceMarkerForDraft,
  stripMarker,
} from "./dedup.js";
import {
  batchAdditionalLabels,
  issueLabels,
  labelsSentBefore,
  labelsToSync,
  parseSentLabels,
  sameLabels,
  syncLabels,
} from "./label-sync.js";
import { publishedDraftBody, type ParentEpicIssue } from "./published-body.js";
import { namesRepository, type NamedRepository } from "../docs-gen/approved-requirements-scope.js";
import { assertCodeLinksMatchTarget } from "./draft-code-links.js";
import { buildDryRunPlan, dryRunWarning } from "./dry-run.js";
import { notifyPublishRolledBack } from "../teams/notification-hooks.js";
import { pagerDutyPublishRollback } from "../pagerduty/alerting-hooks.js";
import {
  NOOP_PUBLISH_EMITTER,
  PublishError,
  isRedirectRefusal,
  readIssueIdentity,
  type AddSubIssueBody,
  type GhIssue,
  type PublishEmitter,
  type PublishOctokitLike,
  type PublishRateLimitConfig,
} from "./types.js";
import {
  addPublishedIssuesToProject,
  commitCopilotWorkspaceBrief,
  parseExtensionFlags,
} from "./publish-extensions.js";

const log = createChildLogger("publisher");

let emitterRef: PublishEmitter = NOOP_PUBLISH_EMITTER;
export function configurePublisher(deps: { emitter?: PublishEmitter }): void {
  emitterRef = deps.emitter ?? NOOP_PUBLISH_EMITTER;
}
function emitter(): PublishEmitter {
  return emitterRef;
}

/**
 * Synthetic batch id used by {@link previewBatchPlan}.
 *
 * A preview deliberately has no `PublishBatch` row — the whole point is that
 * opening a confirmation dialog writes nothing. The id only ever reaches the
 * dedup marker embedded in issue bodies, and the service strips those bodies
 * before the plan leaves the process.
 */
export const PREVIEW_PLAN_BATCH_ID = "preview-unsaved";

export interface PreviewBatchPlanInput {
  projectId: string;
  targetOwner: string;
  targetRepo: string;
  targetBaseUrl: string | null;
  provider: "github" | "github_enterprise";
  draftIds: string[];
  additionalLabels: string[];
  /** Vault ref for the GitHub PAT — `${vault:label}` or null. */
  secretRef: string | null;
  /** Optional override for testing. */
  rateLimit?: PublishRateLimitConfig;
}

/**
 * #1104 (D) — compute what a live publish *would* write, without a batch row.
 *
 * This exists so the pre-publish confirmation can state the destination and
 * the exact action counts. It reuses `buildDryRunPlan` — the same builder the
 * dry-run path uses — rather than growing a second, drifting summary.
 *
 * Cost, deliberately: two indexed queries (the drafts, the project's already
 * published issues for dedup) plus the local vault lookup. It inherits the
 * dry-run path's M1 purity guarantee — no DNS, no host allow-list, no GitHub
 * endpoint — so a confirmation dialog can never itself be the thing that
 * writes something.
 *
 * Draft resolution mirrors `runBatch` exactly (same project scope, same
 * publishable-status filter), so ids that are ineligible or belong to another
 * project simply contribute no actions — the preview under-promises rather
 * than describing writes that will not happen.
 */
export async function previewBatchPlan(input: PreviewBatchPlanInput): Promise<DryRunPlan> {
  const rateLimit = input.rateLimit ?? rateLimitConfigFromEnv();
  const drafts = await prisma.issueDraft.findMany({
    where: {
      projectId: input.projectId,
      status: { in: ["draft", "approved", "publishing", "failed"] },
      deletedAt: null,
      ...(input.draftIds.length > 0 ? { id: { in: input.draftIds } } : {}),
    },
    orderBy: [{ draftType: "asc" }, { createdAt: "asc" }],
  });
  // #1064 — the confirmation must not describe a publish `createBatch` refuses.
  assertCodeLinksMatchTarget(drafts, {
    owner: input.targetOwner,
    repo: input.targetRepo,
    baseUrl: input.targetBaseUrl,
  });
  const existingByHash = await loadExistingByHash(
    input.projectId,
    input.targetOwner,
    input.targetRepo,
    drafts.map((d) => d.id),
  );
  const credential = await preflightCredential(input.secretRef);
  // Predicts the GitHub path (publishable-status drafts). A retried, partly
  // published Jira batch is gated on its raw draftIds at run time, so it can
  // preview `passed` and still be refused.
  const approvalGate = await previewDraftsGate(input.projectId, drafts);
  const bodies = await publishedBodies(
    input.projectId,
    { owner: input.targetOwner, repo: input.targetRepo, baseUrl: input.targetBaseUrl },
    drafts,
    existingByHash,
  );
  // #1106 — DB-only: the drafts the live run checks against the tracker.
  const recoverable = await loadRecoverableIssues(
    input.projectId,
    { owner: input.targetOwner, repo: input.targetRepo, baseUrl: input.targetBaseUrl ?? null },
    drafts,
    existingByHash,
  );
  return buildDryRunPlan({
    batchId: PREVIEW_PLAN_BATCH_ID,
    targetOwner: input.targetOwner,
    targetRepo: input.targetRepo,
    targetBaseUrl: input.targetBaseUrl ?? "https://api.github.com",
    provider: input.provider,
    drafts: drafts.map((d) => ({
      id: d.id,
      title: d.title,
      body: bodies.get(d.id) ?? d.body,
      labels: parseLabels(d.labels),
      parentDraftId: d.parentDraftId,
      draftType: d.draftType,
      source: sourceMarkerForDraft(d),
    })),
    additionalLabels: input.additionalLabels,
    existingByHash,
    mayMatch: mayMatchIssues(recoverable),
    perCallMs: rateLimit.delayMs,
    credential,
    approvalGate,
  });
}

export interface RunBatchInput {
  batchId: string;
  /** When true, no API calls are made; a plan is computed and persisted. */
  dryRun: boolean;
  /** Vault ref for the GitHub PAT — `${vault:label}` or null. */
  secretRef: string | null;
  /**
   * #480 — the secret id `secretRef` was bound to when the batch was created.
   * When set, the token is read by this id only and `secretRef` is ignored.
   * Null only on batches created before #480 and on dry runs whose reference
   * did not resolve.
   */
  boundSecretId?: string | null;
  /** Optional override for testing. */
  rateLimit?: PublishRateLimitConfig;
  /** Sleep implementation (test injectable). */
  sleep?: (ms: number) => Promise<void>;
}

export async function runBatch(input: RunBatchInput): Promise<{ status: string }> {
  const sleep = input.sleep ?? defaultSleep;
  const rateLimit = input.rateLimit ?? rateLimitConfigFromEnv();

  const batch = await prisma.publishBatch.findUnique({ where: { id: input.batchId } });
  if (!batch) throw new PublishError(404, "BATCH_NOT_FOUND", `batch not found: ${input.batchId}`);
  if (batch.archived) {
    throw new PublishError(409, "BATCH_ARCHIVED", "batch has been archived; nothing to do");
  }
  // #1104 (F) — a cancelled batch must never publish. Cancel is only granted
  // past the in-flight grace window, so this is the belt to that braces: any
  // path that reaches the publisher with a settled-as-cancelled row stops here
  // instead of writing issues nobody is watching for.
  if (batch.status === "cancelled") {
    throw new PublishError(409, "BATCH_CANCELLED", "batch was cancelled; nothing to do");
  }
  // #1171 — the batch ROW decides whether a run may write, not the caller.
  // A dry run is exempt from the cross-project confirmation and the approval
  // gate at creation because it writes nothing, so a batch created as a dry
  // run must never be run live afterwards — e.g. by the scheduler's
  // `publish-batch` handler, which always passes `dryRun: false`. Before this
  // guard, only that handler's lack of a credential stood in the way.
  if (!input.dryRun && batch.dryRun) {
    throw new PublishError(
      409,
      "BATCH_IS_DRY_RUN",
      "this batch was created as a dry run and cannot be published; start a live batch instead",
    );
  }
  const drafts = await prisma.issueDraft.findMany({
    where: {
      projectId: batch.projectId,
      status: { in: ["draft", "approved", "publishing", "failed"] },
      deletedAt: null,
      ...(batch.metadata ? safeWhereFromMetadata(batch.metadata) : {}),
    },
    orderBy: [{ draftType: "asc" }, { createdAt: "asc" }],
  });

  // #1064 — the lowest layer for this rule too (`createBatch` checks it first):
  // a body that links into the analysed repository never reaches another one,
  // whichever caller got here. Local comparison only, so a dry run stays pure.
  assertCodeLinksMatchTarget(drafts, {
    owner: batch.targetOwner,
    repo: batch.targetRepo,
    baseUrl: batch.targetBaseUrl,
  });

  // #619 — approval gate at the LOWEST publishing layer. This is the choke
  // point for every live GitHub publish, including the scheduler's
  // republish/retry handler which calls runBatch directly and would
  // otherwise bypass the createBatch/executeBatch gates. Dry-run previews
  // are exempt (pure, no external writes). Fail-closed: gate errors block.
  if (!input.dryRun) {
    await assertDraftsPublishable({
      projectId: batch.projectId,
      drafts,
      context: "publish.batch.run",
    });
  }

  emitter().status({
    batchId: batch.id,
    status: "running",
    dryRun: input.dryRun,
    message: "starting publish",
    errorMessage: null,
  });

  // ----- Dry run path -----
  // M1: dry-run MUST short-circuit before any external resolution (DNS,
  // allow-list lookup, vault) so a preview is a guaranteed-pure operation.
  if (input.dryRun) {
    const dryTarget = {
      owner: batch.targetOwner,
      repo: batch.targetRepo,
      baseUrl: batch.targetBaseUrl ?? "https://api.github.com",
    };
    const existingByHash = await loadExistingByHash(
      batch.projectId,
      dryTarget.owner,
      dryTarget.repo,
      drafts.map((d) => d.id),
    );
    // #1093 — pre-flight the credential. This is the one thing an operator
    // most wants a preview to predict, and previously the dry run reported
    // `completed` for exactly the ref the live run rejects with a 400.
    //
    // M1 is preserved: the vault is a local secret store, so this touches no
    // DNS, no host allow-list and no GitHub endpoint. The token is resolved
    // and immediately discarded — only the verdict reaches the plan.
    const credential = await preflightCredential(input.secretRef, input.boundSecretId);
    // #744 — predict the approval gate the live run enforces above, so the
    // plan does not list creates a live run would refuse with 409. DB-only:
    // M1 still holds.
    const approvalGate = await previewDraftsGate(batch.projectId, drafts);
    // #1276 — DB-only, so M1 holds: the bodies the live run would send.
    const bodies = await publishedBodies(
      batch.projectId,
      { owner: batch.targetOwner, repo: batch.targetRepo, baseUrl: batch.targetBaseUrl },
      drafts,
      existingByHash,
    );
    // #1106 — DB-only, so M1 holds: the drafts whose issue the live run looks
    // up on the tracker. The plan names each one; it cannot know the answer.
    const recoverable = await loadRecoverableIssues(
      batch.projectId,
      { owner: batch.targetOwner, repo: batch.targetRepo, baseUrl: batch.targetBaseUrl },
      drafts,
      existingByHash,
    );
    const plan = buildDryRunPlan({
      batchId: batch.id,
      targetOwner: dryTarget.owner,
      targetRepo: dryTarget.repo,
      targetBaseUrl: dryTarget.baseUrl,
      provider: batch.provider as "github" | "github_enterprise",
      drafts: drafts.map((d) => ({
        id: d.id,
        title: d.title,
        body: bodies.get(d.id) ?? d.body,
        labels: parseLabels(d.labels),
        parentDraftId: d.parentDraftId,
        draftType: d.draftType,
        source: sourceMarkerForDraft(d),
      })),
      additionalLabels: batchAdditionalLabels(batch.metadata),
      existingByHash,
      mayMatch: mayMatchIssues(recoverable),
      perCallMs: rateLimit.delayMs,
      credential,
      approvalGate,
    });
    await prisma.publishBatch.update({
      where: { id: batch.id },
      data: {
        status: "completed",
        dryRunPlan: JSON.stringify(plan),
        completedAt: new Date(),
        totalDrafts: drafts.length,
        // #1093 / #744 — a preview the live run would refuse still yields a
        // useful plan, but it must not read as an unqualified success in the
        // batch list.
        errorMessage: dryRunWarning(plan),
      },
    });
    audit({
      actor: { id: batch.startedById },
      action: "publish.dry_run",
      target: { type: "publish_batch", id: batch.id },
      metadata: {
        projectId: batch.projectId,
        targetOwner: dryTarget.owner,
        targetRepo: dryTarget.repo,
        actions: plan.totalActions,
        dryRun: true,
        credentialCheck: plan.credentialCheck,
        approvalGateCheck: approvalGate.check,
      },
    });
    emitter().completed({
      batchId: batch.id,
      status: "completed",
      publishedCount: 0,
      failedCount: 0,
      dedupSkipped: 0,
      dryRun: true,
    });
    return { status: "completed" };
  }

  // ----- Real publish path -----
  // Resolve target only AFTER the dry-run short-circuit (M1) so a preview
  // never triggers DNS or allow-list lookups.
  const target = await resolvePublishTarget({
    owner: batch.targetOwner,
    repo: batch.targetRepo,
    baseUrl: batch.targetBaseUrl,
  });
  const token = await resolvePublishToken(input.secretRef, input.boundSecretId);
  if (!token) {
    throw new PublishError(400, "TOKEN_REQUIRED", "publish requires a vault-resolved GitHub token");
  }
  const client = await acquirePublishOctokit({
    owner: target.owner,
    baseUrl: target.baseUrl,
    token,
    pinnedAddress: target.pinnedAddress,
    pinnedFamily: target.pinnedFamily,
    rateLimit,
  });
  await verifyAuthScope(client, { owner: target.owner, repo: target.repo });

  // #1106 review — the dedup scan and the remote check run BEFORE the label
  // sync, so a batch the check stops has written nothing at all.
  emitter().progress({
    batchId: batch.id,
    phase: "dedup-scan",
    step: "loading-existing-issues",
  });
  const existingByHash = await loadExistingByHash(
    batch.projectId,
    target.owner,
    target.repo,
    drafts.map((d) => d.id),
  );

  // #1106 — recover issues the dedup map cannot see (archived batch, no
  // recorded hash, a failed row naming its issue): matched from METIS's own
  // rows, each confirmed against its issue on the tracker. The dry run planned
  // from the same `loadRecoverableIssues` call.
  const recoverable = await loadRecoverableIssues(
    batch.projectId,
    { owner: target.owner, repo: target.repo, baseUrl: batch.targetBaseUrl },
    drafts,
    existingByHash,
  );
  const sweep = await reconcileFromRemote({
    client,
    target,
    drafts,
    existingByHash,
    recoverable,
    batchId: batch.id,
  });
  // #1106 review — an issue that could not be read may be a draft's existing
  // issue: creating that draft could file a duplicate, and counting it as a
  // failed draft would let the >50% auto-rollback close issues unrelated to
  // it. So the batch stops here, before ANY write (labels included): nothing
  // created, nothing rolled back, the drafts left as they were. A retry
  // checks again.
  if (sweep.note !== null) {
    await prisma.publishBatch.update({
      where: { id: batch.id },
      data: {
        status: "failed",
        totalDrafts: drafts.length,
        publishedCount: 0,
        failedCount: 0,
        dedupSkipped: 0,
        errorMessage: sweep.note,
        completedAt: new Date(),
      },
    });
    audit({
      actor: { id: batch.startedById },
      action: "publish.batch.stopped",
      target: { type: "publish_batch", id: batch.id },
      metadata: {
        projectId: batch.projectId,
        repo: `${target.owner}/${target.repo}`,
        unreadIssueNumbers: sweep.unreadNumbers,
      },
    });
    emitter().completed({
      batchId: batch.id,
      status: "failed",
      publishedCount: 0,
      failedCount: 0,
      dedupSkipped: 0,
      dryRun: false,
    });
    return { status: "failed" };
  }

  emitter().progress({
    batchId: batch.id,
    phase: "sync-labels",
    step: "starting",
  });
  // #744 — only labels some draft carries (plus the batch's requested ones);
  // the dry-run plan lists exactly these. #1049 — the batch's requested ones
  // are then applied to every issue this run creates or updates.
  const additionalLabels = batchAdditionalLabels(batch.metadata);
  const labels = labelsToSync(
    drafts.map((d) => parseLabels(d.labels)),
    additionalLabels,
  );
  await syncLabels(client, { owner: target.owner, repo: target.repo }, labels);

  // #1276 — what each draft is published as: its body, plus the number of a
  // parent epic that already has an issue, plus the `unverified` sentence.
  // After the remote sweep, so an epic it recovered counts as existing.
  const bodies = await publishedBodies(
    batch.projectId,
    { owner: batch.targetOwner, repo: batch.targetRepo, baseUrl: batch.targetBaseUrl },
    drafts,
    existingByHash,
  );

  // Order: epics first.
  const epics = drafts.filter((d) => d.draftType === "epic");
  const features = drafts.filter((d) => d.draftType !== "epic");
  const ordered = [...epics, ...features];

  await prisma.publishBatch.update({
    where: { id: batch.id },
    data: { status: "running", totalDrafts: ordered.length },
  });

  let publishedCount = 0;
  let failedCount = 0;
  let dedupSkipped = 0;
  const epicIssueNumbers = new Map<string, number>();
  // #1091 — every issue this run actually created on GitHub, tracked in
  // memory so a rollback closes them even if persisting the PublishedIssue
  // row is what failed. The DB is not a reliable record of remote side
  // effects precisely in the situation that triggers a rollback.
  const createdRemoteIssueNumbers: number[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const draft = ordered[i];
    const hash = computeDedupHash(target.owner, target.repo, draft.title);
    const existing = existingByHash.get(hash);
    // #1064 — the project, analysis and requirement ids ride a hidden source
    // marker beside the publish marker, not the visible body.
    const body = bodies.get(draft.id) ?? draft.body;
    const stampedBody = injectMarker(
      body,
      { batchId: batch.id, draftId: draft.id, hash },
      sourceMarkerForDraft(draft),
    );
    // Hash the published body (without the per-batch marker) so that
    // re-running an identical draft in a fresh batch dedup-skips instead of
    // appearing to "change" because the marker batchId differs. #1276 — the
    // body as published: an issue sent before its epic's number was known, or
    // with the `unverified` label, is updated once to carry the new text.
    const bodyHash = computeDraftBodyHash(body);
    // What the issue carries once this draft is published: its own labels,
    // then the batch's (#1049). #1311 — recorded on the row as `sentLabels`.
    const labels = issueLabels(parseLabels(draft.labels), additionalLabels);
    const sentLabels = JSON.stringify(labels);
    // #1091 — set as soon as the remote issue provably exists, so the catch
    // block can record the divergence and the rollback can actually close it
    // even when the local write is what failed.
    let remoteCreated: { issueNumber: number; nodeId: string; htmlUrl: string } | null = null;
    try {
      let issueNumber: number;
      let issueId: string;
      let restIssueId: number;
      let htmlUrl: string;
      let action: "created" | "updated" = "created";
      if (existing) {
        if (existing.bodyHash === bodyHash) {
          dedupSkipped += 1;
          // #1049 review — the row upserted below says this batch published the
          // issue, and drift detection reads this batch's labels off the newest
          // row. So the issue must carry them: when they differ from the ones
          // METIS last sent it, PATCH the labels only. #1311 — "last sent" is
          // the set the matched row recorded, so a change to the draft's own
          // labels relabels the issue too. The PATCH replaces the issue's whole
          // label set, as the update below does (docs/USER_GUIDE.md).
          const sentBefore = labelsSentBefore(existing, parseLabels(draft.labels));
          if (!sameLabels(labels, sentBefore)) {
            await client.request<GhIssue>({
              method: "PATCH",
              url: issuePath(target, existing.issueNumber),
              data: { labels },
            });
            audit({
              actor: { id: batch.startedById },
              action: "publish.issue.labels_update",
              target: {
                type: "github_issue",
                id: `${target.owner}/${target.repo}#${existing.issueNumber}`,
              },
              args: { draftId: draft.id },
              metadata: { batchId: batch.id, projectId: batch.projectId },
            });
          }
          existingByHash.set(hash, { ...existing, additionalLabels, sentLabels: labels });
          // Refresh draft → published linkage in case caller lost it.
          await prisma.publishedIssue.upsert({
            where: {
              batchId_draftId_destination: {
                batchId: batch.id,
                draftId: draft.id,
                destination: "github",
              },
            },
            // `existing` was found under `hash` with this body: record both
            // with the issue, so a row left by an earlier failed run (another
            // title's hash, no issue) describes the issue it now names.
            // #1106 review — and the issue's identifiers and link, with no stale
            // error: a row an earlier failed run left holds `""` for both and
            // that run's message, and drift detection finds a row by `issueId`.
            update: {
              issueNumber: existing.issueNumber,
              issueId: existing.issueId,
              htmlUrl: existing.htmlUrl,
              status: "updated",
              dedupHash: hash,
              bodyHash,
              sentLabels,
              errorMessage: null,
            },
            create: {
              batchId: batch.id,
              draftId: draft.id,
              issueNumber: existing.issueNumber,
              issueId: existing.issueId,
              htmlUrl: existing.htmlUrl,
              status: "updated",
              destination: "github",
              dedupHash: hash,
              bodyHash,
              sentLabels,
              parentIssueNumber: existing.parentIssueNumber ?? null,
            },
          });
          if (draft.draftType === "epic") epicIssueNumbers.set(draft.id, existing.issueNumber);
          emitter().progress({
            batchId: batch.id,
            phase: "create-issue",
            step: "deduped",
            current: i + 1,
            total: ordered.length,
            draftId: draft.id,
            issueNumber: existing.issueNumber,
          });
          await sleep(nextDelayMs(rateLimit));
          continue;
        }
        // Update existing issue body/labels.
        const updated = await client.request<GhIssue>({
          method: "PATCH",
          url: issuePath(target, existing.issueNumber),
          data: {
            title: draft.title,
            body: stampedBody,
            labels,
          },
        });
        const identity = readIssueIdentity(updated.data);
        issueNumber = identity.number;
        issueId = identity.nodeId;
        restIssueId = identity.restId;
        htmlUrl = identity.htmlUrl;
        action = "updated";
      } else {
        emitter().progress({
          batchId: batch.id,
          phase: "create-issue",
          step: "creating",
          current: i + 1,
          total: ordered.length,
          draftId: draft.id,
        });
        const created = await client.request<GhIssue>({
          method: "POST",
          url: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues`,
          data: {
            title: draft.title,
            body: stampedBody,
            labels,
            assignees: parseLabels(draft.assignees),
          },
        });
        const identity = readIssueIdentity(created.data);
        issueNumber = identity.number;
        issueId = identity.nodeId;
        restIssueId = identity.restId;
        htmlUrl = identity.htmlUrl;
        // F2 still holds: only issues this batch CREATED are eligible for
        // rollback closure. Dedup-matched updates never reach this branch.
        remoteCreated = { issueNumber, nodeId: issueId, htmlUrl };
        createdRemoteIssueNumbers.push(issueNumber);
      }
      // Sub-issue attach (#69).
      let parentIssueNumber: number | null = null;
      if (draft.parentDraftId && epicIssueNumbers.has(draft.parentDraftId)) {
        parentIssueNumber = epicIssueNumbers.get(draft.parentDraftId)!;
        if (isSubIssueApiKnownUnsupported(target)) {
          // M2: target GHE has previously returned 404/410 for the sub-issue
          // API in this process. Don't waste retries.
          log.debug("publish.sub_issue.skip", {
            owner: target.owner,
            repo: target.repo,
            childIssueNumber: issueNumber,
          });
        } else {
          emitter().progress({
            batchId: batch.id,
            phase: "link-sub-issue",
            step: "attaching",
            draftId: draft.id,
            issueNumber,
          });
          await attachSubIssueWithRetry({
            client,
            target,
            parentNumber: parentIssueNumber,
            childRestId: restIssueId,
            childNumber: issueNumber,
            rateLimit,
            sleep,
          });
        }
      }
      if (draft.draftType === "epic") epicIssueNumbers.set(draft.id, issueNumber);

      await prisma.publishedIssue.upsert({
        where: {
          batchId_draftId_destination: {
            batchId: batch.id,
            draftId: draft.id,
            destination: "github",
          },
        },
        update: {
          issueNumber,
          issueId,
          htmlUrl,
          status: action,
          parentIssueNumber,
          dedupHash: hash,
          bodyHash,
          sentLabels,
          errorMessage: null,
        },
        create: {
          batchId: batch.id,
          draftId: draft.id,
          issueNumber,
          issueId,
          htmlUrl,
          status: action,
          destination: "github",
          parentIssueNumber,
          dedupHash: hash,
          bodyHash,
          sentLabels,
        },
      });
      await prisma.issueDraft.update({
        where: { id: draft.id },
        data: { status: "published" },
      });
      existingByHash.set(hash, {
        issueNumber,
        bodyHash,
        issueId,
        htmlUrl,
        parentIssueNumber,
        additionalLabels,
        sentLabels: labels,
      });
      publishedCount += 1;
      audit({
        actor: { id: batch.startedById },
        action: action === "updated" ? "publish.issue.update" : "publish.issue.create",
        target: { type: "github_issue", id: `${target.owner}/${target.repo}#${issueNumber}` },
        args: { draftId: draft.id, dedupHash: hash },
        metadata: {
          batchId: batch.id,
          projectId: batch.projectId,
          repo: `${target.owner}/${target.repo}`,
          parentIssueNumber,
          bodyHash,
        },
      });
      await sleep(nextDelayMs(rateLimit));
    } catch (err) {
      failedCount += 1;
      const e = err as { message?: string; status?: number };
      const message = e.message ?? "unknown publish error";
      log.error("publish.draft.failed", {
        batchId: batch.id,
        draftId: draft.id,
        message,
        status: e.status,
        // #1091 — make the divergence explicit in the logs: the issue may
        // already exist on GitHub even though this draft is being recorded
        // as failed.
        remoteIssueNumber: remoteCreated?.issueNumber ?? null,
      });
      await prisma.issueDraft.update({
        where: { id: draft.id },
        data: { status: "failed" },
      });
      await prisma.publishedIssue.upsert({
        where: {
          batchId_draftId_destination: {
            batchId: batch.id,
            draftId: draft.id,
            destination: "github",
          },
        },
        update: {
          status: "failed",
          errorMessage: message,
          // The hashes move WITH the issue, and only with it: the row must hold
          // the hash stamped in the marker of the issue it names, or the next
          // run's remote sweep reads its own marker as a forged one and files
          // a second issue (a draft retitled after an earlier failed run). A
          // failure before any write leaves the recorded issue and its hash
          // as they are — they still describe each other.
          ...(remoteCreated
            ? {
                issueNumber: remoteCreated.issueNumber,
                issueId: remoteCreated.nodeId,
                htmlUrl: remoteCreated.htmlUrl,
                dedupHash: hash,
                bodyHash,
                sentLabels,
              }
            : {}),
        },
        create: {
          batchId: batch.id,
          draftId: draft.id,
          // #1091 — when the GitHub write succeeded and something *after* it
          // failed, record the real issue rather than 0/"" so the operator
          // can see (and reach) what actually exists remotely.
          issueNumber: remoteCreated?.issueNumber ?? 0,
          issueId: remoteCreated?.nodeId ?? "",
          htmlUrl: remoteCreated?.htmlUrl ?? "",
          status: "failed",
          destination: "github",
          dedupHash: hash,
          bodyHash,
          // #1311 — what the issue was created with, when it was.
          sentLabels: remoteCreated ? sentLabels : null,
          errorMessage: message,
        },
      });
      audit({
        actor: { id: batch.startedById },
        action: "publish.issue.failed",
        target: { type: "issue_draft", id: draft.id },
        metadata: {
          batchId: batch.id,
          projectId: batch.projectId,
          repo: `${target.owner}/${target.repo}`,
          status: e.status,
        },
      });
      // Auto-rollback when more than half the drafts fail.
      if (failedCount * 2 > ordered.length) {
        log.warn("publish.rollback.threshold", {
          batchId: batch.id,
          failed: failedCount,
          total: ordered.length,
        });
        const rollbackReason = `auto-rollback: ${failedCount}/${ordered.length} drafts failed`;
        const rollback = await rollbackBatch({
          batchId: batch.id,
          client,
          target,
          reason: rollbackReason,
          actorId: batch.startedById,
          sleep,
          rateLimit,
          // #1091 — issues this run created remotely, from memory rather than
          // from the DB. When the local write is what failed, the DB has no
          // "created" row for them and the old rollback silently left them
          // open on GitHub while reporting publishedCount = 0.
          alsoCloseIssueNumbers: createdRemoteIssueNumbers,
        });
        await prisma.publishBatch.update({
          where: { id: batch.id },
          data: {
            status: "failed",
            failedCount,
            publishedCount,
            dedupSkipped,
            // #1091 — say plainly what the rollback did and did NOT manage to
            // undo. "auto-rollback after >50% failures" read as if GitHub had
            // been left clean when 8 issues were in fact still open.
            errorMessage: rollbackOutcomeMessage(failedCount, ordered.length, rollback),
            completedAt: new Date(),
          },
        });
        // Issue #67 — best-effort one-way Teams notification card for the publish
        // rollback. Fire-and-forget off the critical path: a notification failure
        // (or no configured target) must never affect the rollback outcome. The
        // hook derives the workspace from the batch's project and no-ops when none
        // is registered/installed. (Independent of #580 PagerDuty sev-1 alerting.)
        void notifyPublishRolledBack({
          batchId: batch.id,
          projectId: batch.projectId,
          reason: rollbackReason,
          repo: `${target.owner}/${target.repo}`,
        });
        // Issue #580 — best-effort PagerDuty sev-1 incident for the same publish
        // rollback. Independent of the #67 Teams card above: both fire (one is a
        // notification card, the other a paging incident). Trigger-only — a
        // rollback is a one-shot event with no automatic "cleared" signal.
        // Fire-and-forget; a PagerDuty failure must never affect the rollback.
        void pagerDutyPublishRollback({
          batchId: batch.id,
          projectId: batch.projectId,
          reason: rollbackReason,
          repo: `${target.owner}/${target.repo}`,
        });
        emitter().completed({
          batchId: batch.id,
          status: "failed",
          publishedCount,
          failedCount,
          dedupSkipped,
          dryRun: false,
        });
        return { status: "failed" };
      }
    }
  }

  // Epic #163: optional post-publish extensions (Projects v2 + .copilot-workspace.md).
  const extensions = parseExtensionFlags(batch.metadata);
  if (extensions.projectsV2 || extensions.copilotWorkspace) {
    await runPublishExtensions({
      client,
      batch,
      target,
      extensions,
    });
  }

  await prisma.publishBatch.update({
    where: { id: batch.id },
    data: {
      status: "completed",
      publishedCount,
      failedCount,
      dedupSkipped,
      completedAt: new Date(),
      errorMessage:
        failedCount > 0 ? `${failedCount} drafts failed (within rollback threshold)` : null,
    },
  });
  audit({
    actor: { id: batch.startedById },
    action: "publish.batch.completed",
    target: { type: "publish_batch", id: batch.id },
    metadata: {
      projectId: batch.projectId,
      repo: `${target.owner}/${target.repo}`,
      publishedCount,
      failedCount,
      dedupSkipped,
    },
  });
  emitter().completed({
    batchId: batch.id,
    status: "completed",
    publishedCount,
    failedCount,
    dedupSkipped,
    dryRun: false,
  });
  return { status: "completed" };
}

interface RunExtensionsArgs {
  client: PublishOctokitLike;
  batch: { id: string; projectId: string; startedById: string };
  target: { owner: string; repo: string };
  extensions: { copilotWorkspace: boolean; projectsV2: boolean };
}

async function runPublishExtensions(args: RunExtensionsArgs): Promise<void> {
  if (args.extensions.projectsV2) {
    try {
      await addPublishedIssuesToProject({
        client: args.client,
        batchId: args.batch.id,
        projectId: args.batch.projectId,
        actorId: args.batch.startedById,
      });
    } catch (err) {
      // The helper already logs + audits per-item failures; only catch
      // catastrophic ones (lookup failure etc.). Swallow so the batch
      // completion isn't blocked.
      log.warn("publish.projects_v2.batch_failed", {
        batchId: args.batch.id,
        message: (err as Error).message,
      });
    }
  }
  if (args.extensions.copilotWorkspace) {
    try {
      await commitCopilotWorkspaceBrief({
        client: args.client,
        batchId: args.batch.id,
        projectId: args.batch.projectId,
        target: args.target,
        actorId: args.batch.startedById,
      });
    } catch (err) {
      log.warn("publish.copilot_workspace.failed", {
        batchId: args.batch.id,
        message: (err as Error).message,
      });
    }
  }
}

// ---- Dry-run credential pre-flight (#1093) --------------------------------

/**
 * Resolve the batch's vault ref so a preview can state whether the live run's
 * credential will work, then discard the token.
 *
 * A *malformed* ref never reaches here — `createBatch` rejects it with a 400
 * before the batch row is written (#1092/#1094), which is the loudest possible
 * failure and matches the live path exactly. What is left is the
 * supplied-but-unresolvable case, and there the plan is still worth having:
 * the run is marked with an explicit `unresolved` verdict rather than
 * discarding a preview the operator asked for.
 *
 * Never throws, and never returns anything derived from the secret.
 */
async function preflightCredential(
  secretRef: string | null,
  boundSecretId?: string | null,
): Promise<{ check: CredentialCheckResult; errorCode: string | null }> {
  if (!secretRef && !boundSecretId) return { check: "missing", errorCode: "TOKEN_REQUIRED" };
  try {
    const token = await resolvePublishToken(secretRef, boundSecretId);
    if (token) return { check: "resolved", errorCode: null };
    return { check: "unresolved", errorCode: "TOKEN_REQUIRED" };
  } catch (err) {
    // Only the bare code is retained — a vault/connector message may embed
    // resolved addresses or upstream text (#1065).
    const code = (err as { code?: unknown }).code;
    return {
      check: "unresolved",
      errorCode: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNKNOWN",
    };
  }
}

// ---- Sub-issue attach with retry (#69) ------------------------------------

interface AttachArgs {
  client: PublishOctokitLike;
  target: { owner: string; repo: string };
  /** Parent epic's issue NUMBER — it addresses the REST URL path. */
  parentNumber: number;
  /**
   * #1091 — the child's numeric REST **database id**. The sub-issue API's
   * `sub_issue_id` body field takes the `id`, not the `number` and not the
   * node id. Passing the number made GitHub 404 (no issue has that database
   * id), which this function treats as "endpoint unsupported": it cached that
   * verdict for the whole repo and silently skipped every remaining attach —
   * which is why the epic ended up with zero children and nothing was logged
   * as a failure.
   */
  childRestId: number;
  /** Child's issue number — for logging/diagnostics only. */
  childNumber: number;
  rateLimit: PublishRateLimitConfig;
  sleep: (ms: number) => Promise<void>;
}

async function attachSubIssueWithRetry(args: AttachArgs): Promise<void> {
  const { client, target, parentNumber, childRestId, childNumber, rateLimit, sleep } = args;
  let attempt = 0;
  let lastErr: unknown;
  // Issue #261 — `currentPublishMaxRetries()` is re-read on every iteration
  // so an admin lowering the cap mid-batch shrinks the budget for the very
  // next attempt rather than waiting for the next batch.
  while (attempt < currentPublishMaxRetries()) {
    try {
      await client.request({
        method: "POST",
        url: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${parentNumber}/sub_issues`,
        headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION },
        data: { sub_issue_id: childRestId } satisfies AddSubIssueBody,
      });
      return;
    } catch (err) {
      lastErr = err;
      // #1478 — a refused redirect fails the same way every time: never spend
      // the backoff budget retrying it. #1486 — any other error still retries.
      if (isRedirectRefusal(err)) throw err;
      const status = (err as { status?: number }).status;
      // M2: capability-detect older GHE that doesn't expose the sub-issue
      // API. Cache the verdict per-process per-baseUrl so a single batch
      // doesn't drain its retry budget on a known-unsupported endpoint and
      // unnecessarily trip the >50% rollback threshold.
      if (status === 404 || status === 410) {
        markSubIssueApiUnsupported(target);
        log.warn("publish.sub_issue.unsupported", {
          owner: target.owner,
          repo: target.repo,
          parentNumber,
          childNumber,
          status,
        });
        return;
      }
      attempt += 1;
      if (attempt >= currentPublishMaxRetries()) break;
      const backoff = Math.min(
        rateLimit.secondaryBackoffBaseMs * 2 ** (attempt - 1),
        rateLimit.secondaryBackoffMaxMs,
      );
      // F1: production must use the documented backoff. Tests inject a
      // no-op `sleep` to fast-forward; never divide here.
      await sleep(backoff);
    }
  }
  throw (
    lastErr ??
    new PublishError(502, "SUB_ISSUE_ATTACH_FAILED", "sub-issue attach exhausted retries")
  );
}

// Per-process cache of GHE hosts that do not expose the sub-issue API.
const subIssueApiUnsupported = new Set<string>();
function subIssueApiKey(target: { owner: string; repo: string }): string {
  return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
}
function markSubIssueApiUnsupported(target: { owner: string; repo: string }): void {
  subIssueApiUnsupported.add(subIssueApiKey(target));
}
export function __resetSubIssueCapabilityCache(): void {
  subIssueApiUnsupported.clear();
}
function isSubIssueApiKnownUnsupported(target: { owner: string; repo: string }): boolean {
  return subIssueApiUnsupported.has(subIssueApiKey(target));
}

// ---- Rollback --------------------------------------------------------------

interface RollbackArgs {
  batchId: string;
  client: PublishOctokitLike;
  target: { owner: string; repo: string };
  reason: string;
  actorId: string;
  sleep: (ms: number) => Promise<void>;
  rateLimit: PublishRateLimitConfig;
  /**
   * #1091 — extra issue numbers this run is known to have created remotely,
   * supplied from memory. Needed because the DB is unreliable in exactly the
   * failure mode that triggers a rollback: if persisting the PublishedIssue
   * row is what failed, no `status: "created"` row exists for a live issue.
   * Still F2-safe — only issues this batch created are ever passed in.
   */
  alsoCloseIssueNumbers?: number[];
}

/** What a rollback managed to do, so callers can report it honestly. */
interface RollbackOutcome {
  attempted: number;
  closed: number;
  failed: number;
}

async function rollbackBatch(args: RollbackArgs): Promise<RollbackOutcome> {
  const { batchId, client, target, reason, actorId, sleep, rateLimit } = args;
  // F2: only close issues this batch ACTUALLY CREATED. Pre-existing issues
  // that were merely dedup-matched and updated are not ours to close.
  const rows = await prisma.publishedIssue.findMany({
    where: { batchId, status: "created" },
  });
  const numbers = new Set<number>();
  for (const row of rows) if (row.issueNumber > 0) numbers.add(row.issueNumber);
  for (const n of args.alsoCloseIssueNumbers ?? []) if (n > 0) numbers.add(n);
  const issues = [...numbers].map((issueNumber) => ({ issueNumber }));
  const outcome: RollbackOutcome = { attempted: issues.length, closed: 0, failed: 0 };
  for (const issue of issues) {
    try {
      await client.request({
        method: "POST",
        url: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${issue.issueNumber}/comments`,
        data: { body: `:no_entry: METIS rollback for batch \`${batchId}\` — ${reason}` },
      });
      await client.request({
        method: "PATCH",
        url: issuePath(target, issue.issueNumber),
        data: { state: "closed", state_reason: "not_planned" },
      });
      audit({
        actor: { id: actorId },
        action: "publish.issue.closed",
        target: { type: "github_issue", id: `${target.owner}/${target.repo}#${issue.issueNumber}` },
        metadata: { batchId, reason },
      });
      outcome.closed += 1;
    } catch (err) {
      const e = err as { message?: string };
      outcome.failed += 1;
      log.error("rollback.close.failed", {
        batchId,
        issueNumber: issue.issueNumber,
        message: e.message,
      });
    }
    await sleep(nextDelayMs(rateLimit));
  }
  return outcome;
}

/**
 * #1091 — describe what the auto-rollback actually achieved.
 *
 * The old fixed string ("auto-rollback after >50% failures") implied GitHub
 * had been returned to a clean state. It had not: with the issueId bug, every
 * created issue was recorded as `failed`, so the rollback found nothing to
 * close and left them all open while the batch reported `publishedCount = 0`.
 * Exported for direct unit testing.
 */
export function rollbackOutcomeMessage(
  failedCount: number,
  total: number,
  outcome: RollbackOutcome,
): string {
  const head = `auto-rollback after >50% failures (${failedCount}/${total} drafts failed)`;
  if (outcome.attempted === 0) return `${head}; no issues had been created on GitHub`;
  if (outcome.failed === 0) return `${head}; closed ${outcome.closed} created issue(s) on GitHub`;
  return (
    `${head}; closed ${outcome.closed} of ${outcome.attempted} created issue(s) — ` +
    `${outcome.failed} could NOT be closed and remain open on GitHub`
  );
}

/**
 * #480 — a batch's token: the secret it was bound to at creation, by id and
 * never re-resolved by label; only a batch with no binding (created before
 * #480, or a dry run whose reference did not resolve) resolves `secretRef`.
 */
async function resolvePublishToken(
  secretRef: string | null,
  boundSecretId: string | null | undefined,
): Promise<string | null> {
  if (boundSecretId) return readBoundSecret(boundSecretId, getVaultService());
  return secretRef ? resolveVaultRef(secretRef, getVaultService()) : null;
}

export async function archiveBatch(input: {
  batchId: string;
  reason: string;
  closeIssues: boolean;
  actorId: string;
  secretRef: string | null;
  /** #480 — see {@link RunBatchInput.boundSecretId}. */
  boundSecretId?: string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = input.sleep ?? defaultSleep;
  const batch = await prisma.publishBatch.findUnique({ where: { id: input.batchId } });
  if (!batch) throw new PublishError(404, "BATCH_NOT_FOUND", "batch not found");
  if (batch.archived) {
    return;
  }
  if (input.closeIssues && !batch.dryRun) {
    if (!input.secretRef && !input.boundSecretId) {
      throw new PublishError(400, "TOKEN_REQUIRED", "closing issues requires a vault token");
    }
    const token = await resolvePublishToken(input.secretRef, input.boundSecretId);
    if (!token) {
      throw new PublishError(400, "TOKEN_REQUIRED", "vault returned no token");
    }
    const target = await resolvePublishTarget({
      owner: batch.targetOwner,
      repo: batch.targetRepo,
      baseUrl: batch.targetBaseUrl,
    });
    const client = await acquirePublishOctokit({
      owner: target.owner,
      baseUrl: target.baseUrl,
      token,
      pinnedAddress: target.pinnedAddress,
      pinnedFamily: target.pinnedFamily,
    });
    await rollbackBatch({
      batchId: batch.id,
      client,
      target,
      reason: input.reason,
      actorId: input.actorId,
      sleep,
      rateLimit: rateLimitConfigFromEnv(),
    });
  }
  await prisma.publishBatch.update({
    where: { id: batch.id },
    data: {
      archived: true,
      archivedAt: new Date(),
      archiveReason: input.reason,
      archivedById: input.actorId,
    },
  });
  audit({
    actor: { id: input.actorId },
    action: "publish.batch.archived",
    target: { type: "publish_batch", id: batch.id },
    metadata: { projectId: batch.projectId, reason: input.reason, closeIssues: input.closeIssues },
  });
}

// ---- Helpers ---------------------------------------------------------------

interface ExistingMatch {
  issueNumber: number;
  issueId: string;
  htmlUrl: string;
  bodyHash: string | null;
  parentIssueNumber: number | null;
  /**
   * #1049 — the Additional labels of the batch the matched row belongs to, so
   * a dedup skip can tell whether the issue carries this batch's labels.
   * `null` when unknown.
   */
  additionalLabels: string[] | null;
  /**
   * #1311 — the labels the matched row recorded sending the issue
   * (`labelsSentBefore` prefers them); `null` on a row from before #1311.
   */
  sentLabels: string[] | null;
}

/**
 * The published issue a draft's title dedup-matches, keyed on `dedupHash`.
 *
 * #528 — more than one row can share a hash (two published drafts of one
 * group before #369's unique index, or any older duplicate publish). The pick
 * must not depend on the database's row order, or a later publish updates —
 * and overwrites — whichever issue happened to come back last. So, per hash:
 * a row whose `draftId` is one of `preferDraftIds` (the drafts being
 * published) beats one that is not; then the most recent `publishedAt`; then
 * the greater row `id`, so even an exact timestamp tie is settled the same way
 * on every run.
 */
async function loadExistingByHash(
  projectId: string,
  owner: string,
  repo: string,
  preferDraftIds: ReadonlyArray<string> = [],
): Promise<Map<string, ExistingMatch>> {
  const preferred = new Set(preferDraftIds);
  const rows = await prisma.publishedIssue.findMany({
    where: {
      batch: { projectId, targetOwner: owner, targetRepo: repo, archived: false },
      status: { in: ["created", "updated"] },
      dedupHash: { not: null },
    },
    include: { batch: { select: { metadata: true } } },
  });
  const best = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!row.dedupHash) continue;
    const current = best.get(row.dedupHash);
    if (!current || outranks(row, current, preferred)) best.set(row.dedupHash, row);
  }
  const out = new Map<string, ExistingMatch>();
  for (const [hash, row] of best) {
    out.set(hash, {
      issueNumber: row.issueNumber,
      issueId: row.issueId,
      htmlUrl: row.htmlUrl,
      bodyHash: row.bodyHash,
      parentIssueNumber: row.parentIssueNumber,
      additionalLabels: row.batch ? batchAdditionalLabels(row.batch.metadata) : null,
      sentLabels: parseSentLabels(row.sentLabels),
    });
  }
  return out;
}

/**
 * #1276 — the body each draft is published with (`publishedDraftBody`): the
 * parent line of a sub-issue whose epic ALREADY has an issue names it, and a
 * draft labelled `unverified` carries the sentence that stands in for the label.
 *
 * "Already has an issue" is decided the same way whatever the batch holds, so a
 * sub-issue's body (and its body hash) does not change with the batch's shape:
 *  - an epic in this batch that the run will update or dedup-skip
 *    (`existingByHash` holds its title's hash) — that issue;
 *  - an epic not in this batch — the issue an earlier batch published it as
 *    (`loadEarlierEpicIssues`; one query, only when some epic is outside).
 * An epic this run creates has no number yet: its sub-issues keep the plain
 * parent line and are attached to it through the sub-issues API, as before.
 */
async function publishedBodies(
  projectId: string,
  target: { owner: string; repo: string; baseUrl: string | null },
  drafts: ReadonlyArray<{
    id: string;
    title: string;
    body: string;
    labels: string;
    parentDraftId: string | null;
  }>,
  existingByHash: ReadonlyMap<string, { issueNumber: number; htmlUrl: string }>,
): Promise<Map<string, string>> {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const parents = [
    ...new Set(drafts.map((d) => d.parentDraftId).filter((id): id is string => id !== null)),
  ];
  const outside = parents.filter((id) => !byId.has(id));
  const epics =
    outside.length > 0
      ? await loadEarlierEpicIssues(projectId, target, outside)
      : new Map<string, ParentEpicIssue>();
  for (const id of parents) {
    const epic = byId.get(id);
    if (!epic) continue;
    const existing = existingByHash.get(computeDedupHash(target.owner, target.repo, epic.title));
    if (existing && existing.issueNumber > 0) {
      epics.set(id, { issueNumber: existing.issueNumber, htmlUrl: existing.htmlUrl });
    }
  }
  return new Map(
    drafts.map((d) => [
      d.id,
      publishedDraftBody(
        { body: d.body, labels: parseLabels(d.labels) },
        d.parentDraftId ? epics.get(d.parentDraftId) : null,
      ),
    ]),
  );
}

/** The API base a batch targets, compared as a host identity (public GitHub when unset). */
function apiBaseKey(baseUrl: string | null | undefined): string {
  return (baseUrl ?? "").trim().toLowerCase().replace(/\/+$/, "") || "https://api.github.com";
}

/**
 * #1276 — for each epic draft id, the GitHub issue an earlier, unarchived batch
 * of this project published it as in THIS repository: owner and name compared
 * case-insensitively (`namesRepository`, as GitHub does), on the same API host.
 * The most recent publish wins; an exact tie is settled on the row id.
 */
async function loadEarlierEpicIssues(
  projectId: string,
  target: { owner: string; repo: string; baseUrl: string | null },
  epicDraftIds: readonly string[],
): Promise<Map<string, ParentEpicIssue>> {
  const rows = await prisma.publishedIssue.findMany({
    where: {
      draftId: { in: [...epicDraftIds] },
      destination: "github",
      status: { in: ["created", "updated"] },
      issueNumber: { gt: 0 },
      batch: { projectId, archived: false },
    },
    include: { batch: { select: { targetOwner: true, targetRepo: true, targetBaseUrl: true } } },
  });
  const repository: NamedRepository = {
    owner: target.owner.trim().toLowerCase(),
    name: target.repo
      .trim()
      .toLowerCase()
      .replace(/\.git$/, ""),
  };
  const host = apiBaseKey(target.baseUrl);
  const best = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const b = row.batch;
    if (!b || !namesRepository(repository, b.targetOwner, b.targetRepo)) continue;
    if (apiBaseKey(b.targetBaseUrl) !== host) continue;
    const current = best.get(row.draftId);
    if (!current || outranks(row, current, new Set())) best.set(row.draftId, row);
  }
  return new Map(
    [...best].map(([draftId, row]) => [
      draftId,
      { issueNumber: row.issueNumber, htmlUrl: row.htmlUrl },
    ]),
  );
}

/** #528 — a total order over rows sharing a hash; see `loadExistingByHash`. */
function outranks(
  a: { id: string; draftId: string; publishedAt: Date },
  b: { id: string; draftId: string; publishedAt: Date },
  preferred: ReadonlySet<string>,
): boolean {
  const aPreferred = preferred.has(a.draftId);
  if (aPreferred !== preferred.has(b.draftId)) return aPreferred;
  const dt = a.publishedAt.getTime() - b.publishedAt.getTime();
  if (dt !== 0) return dt > 0;
  return a.id > b.id;
}

/**
 * #1106 — a draft whose issue METIS can name only from a `PublishedIssue` row
 * the dedup map does not use: a row of an archived batch, one that recorded no
 * dedup hash, or a `failed` row that still names the issue it created.
 */
interface RecoverableIssue {
  issueNumber: number;
  dedupHash: string | null;
  parentIssueNumber: number | null;
  additionalLabels: string[] | null;
  /** #1311 — as {@link ExistingMatch.sentLabels}, from the same (newest) row. */
  sentLabels: string[] | null;
}

/**
 * #1106 — which drafts of a batch the publish will look for on the tracker,
 * and under which issue number. DATABASE ONLY, so the dry run and the preview
 * (M1: no network) compute exactly the set the live run checks, and the plan
 * can say so per draft.
 *
 * The match KEY is METIS's own record — draft id → issue number — never text
 * on the tracker. For each draft whose title hash is not already in the dedup
 * map, the row used is:
 *   - a GitHub row of this project (a Jira row holds issue number 0);
 *   - for THIS target: the same repository (owner and name compared
 *     case-insensitively, as GitHub does) on the same API host;
 *   - one that names an issue (`issueNumber > 0`), so a newer failed row that
 *     recorded none never shadows the older one that did;
 *   - the newest of those: `publishedAt` desc, then row `id` desc, so the pick
 *     never depends on the order the database returns rows in.
 * An issue number the dedup map, or an earlier draft of this batch, already
 * claims is not offered again: two drafts are never filed onto one issue.
 */
async function loadRecoverableIssues(
  projectId: string,
  target: { owner: string; repo: string; baseUrl: string | null },
  drafts: ReadonlyArray<{ id: string; title: string }>,
  existingByHash: ReadonlyMap<string, { issueNumber: number }>,
): Promise<Map<string, RecoverableIssue>> {
  const missing = drafts.filter(
    (d) => !existingByHash.has(computeDedupHash(target.owner, target.repo, d.title)),
  );
  const out = new Map<string, RecoverableIssue>();
  if (missing.length === 0) return out;
  const ids = new Set(missing.map((d) => d.id));
  const rows = await prisma.publishedIssue.findMany({
    where: {
      draftId: { in: [...ids] },
      destination: "github",
      issueNumber: { gt: 0 },
      batch: { projectId },
    },
    include: {
      batch: {
        select: {
          projectId: true,
          targetOwner: true,
          targetRepo: true,
          targetBaseUrl: true,
          metadata: true,
        },
      },
    },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
  });
  const repository: NamedRepository = {
    owner: target.owner.trim().toLowerCase(),
    name: target.repo
      .trim()
      .toLowerCase()
      .replace(/\.git$/, ""),
  };
  const host = apiBaseKey(target.baseUrl);
  const best = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    // The query says most of this; it is checked again here so the pick does
    // not rest on a filter or an order the caller cannot see.
    const b = row.batch;
    if (!ids.has(row.draftId) || !(row.issueNumber > 0)) continue;
    if (!b || b.projectId !== projectId) continue;
    if (!namesRepository(repository, b.targetOwner, b.targetRepo)) continue;
    if (apiBaseKey(b.targetBaseUrl) !== host) continue;
    const current = best.get(row.draftId);
    if (!current || outranks(row, current, new Set())) best.set(row.draftId, row);
  }
  const claimed = new Set([...existingByHash.values()].map((e) => e.issueNumber));
  for (const d of missing) {
    const row = best.get(d.id);
    if (!row || claimed.has(row.issueNumber)) continue;
    claimed.add(row.issueNumber);
    out.set(d.id, {
      issueNumber: row.issueNumber,
      dedupHash: row.dedupHash,
      parentIssueNumber: row.parentIssueNumber ?? null,
      additionalLabels: batchAdditionalLabels(row.batch.metadata),
      sentLabels: parseSentLabels(row.sentLabels),
    });
  }
  return out;
}

/** #1106 — the dry-run view of {@link loadRecoverableIssues}: draft id → issue number. */
function mayMatchIssues(recoverable: ReadonlyMap<string, RecoverableIssue>): Map<string, number> {
  return new Map([...recoverable].map(([draftId, r]) => [draftId, r.issueNumber]));
}

interface ReconcileArgs {
  client: PublishOctokitLike;
  target: { owner: string; repo: string };
  drafts: Array<{ id: string; title: string; body: string }>;
  existingByHash: Map<string, ExistingMatch>;
  recoverable: ReadonlyMap<string, RecoverableIssue>;
  batchId: string;
}

/** #1106 — what the remote check could not settle, for the run and the batch row. */
interface ReconcileOutcome {
  /** Issues a read failed for (not gone): the run stops before any write. */
  unreadNumbers: number[];
  /** One line for the batch's `errorMessage`, or `null` when every read settled. */
  note: string | null;
}

/** HTTP statuses that mean "this issue is not here any more": moved, missing, deleted. */
const ISSUE_GONE_STATUSES = new Set([301, 404, 410]);

/**
 * Recover the issue of each draft {@link loadRecoverableIssues} named, by
 * reading THAT issue by number and confirming it.
 *
 * #1106, item 3 — the decision: the match comes from METIS's `PublishedIssue`
 * row; the tracker-side marker is a consistency check only. Text on the
 * tracker can stop a match, never start one: an issue METIS has no row for is
 * never read, and no marker can point a draft at an issue its own row does not
 * name. The issue is confirmed when one of its publish markers alone on its line
 * — any of them, last first (item 2) — names this draft with a hash METIS can
 * vouch for: the hash recorded on the row, or the hash the draft has now (a
 * draft retitled after a failed run, #1102 cycle 3). Otherwise it is no match,
 * the draft is created, and the conflict is audited.
 *
 * Reads are one `GET` per named issue, so there is no listing and no page limit
 * (item 5); they are bounded by the drafts in the batch. A read that fails for
 * any reason other than the issue being gone is logged and audited, and the
 * caller stops the whole batch before any write (item 6): creating that draft
 * could file a duplicate of the issue that could not be read. A retry checks
 * again. Each read emits a `dedup-scan` progress event.
 */
async function reconcileFromRemote(args: ReconcileArgs): Promise<ReconcileOutcome> {
  const { client, target, drafts, existingByHash, recoverable } = args;
  const unreadNumbers: number[] = [];
  const toRead = drafts.filter((d) => recoverable.has(d.id));
  for (let i = 0; i < toRead.length; i += 1) {
    const draft = toRead[i]!;
    const candidate = recoverable.get(draft.id)!;
    const hash = computeDedupHash(target.owner, target.repo, draft.title);
    const issueRef = `${target.owner}/${target.repo}#${candidate.issueNumber}`;
    emitter().progress({
      batchId: args.batchId,
      phase: "dedup-scan",
      step: "reading-issue",
      current: i + 1,
      total: toRead.length,
      draftId: draft.id,
      issueNumber: candidate.issueNumber,
    });
    let issue: GhIssue;
    try {
      const resp = await client.request<GhIssue>({
        method: "GET",
        url: issuePath(target, candidate.issueNumber),
      });
      issue = resp.data;
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status !== undefined && ISSUE_GONE_STATUSES.has(e.status)) {
        log.info("publish.reconcile.issue_gone", {
          batchId: args.batchId,
          draftId: draft.id,
          issueNumber: candidate.issueNumber,
          status: e.status,
        });
        continue;
      }
      log.warn("publish.reconcile.read_failed", {
        batchId: args.batchId,
        draftId: draft.id,
        issueNumber: candidate.issueNumber,
        status: e.status ?? null,
        message: e.message,
      });
      audit({
        actor: { id: SYSTEM_ACTOR_ID },
        action: "publish.reconcile.read_failed",
        target: { type: "github_issue", id: issueRef },
        metadata: {
          batchId: args.batchId,
          draftId: draft.id,
          status: e.status ?? null,
        },
      });
      unreadNumbers.push(candidate.issueNumber);
      continue;
    }
    let identity;
    try {
      identity = readIssueIdentity(issue);
    } catch {
      log.warn("publish.reconcile.malformed_issue", {
        batchId: args.batchId,
        issueNumber: candidate.issueNumber,
      });
      continue;
    }
    // Answered with another issue: a redirect followed to a transferred one,
    // which can keep its number in another repository. So the answer must
    // name this number AND this repository.
    if (identity.number !== candidate.issueNumber || !issueIsInRepository(issue, target)) {
      log.warn("publish.reconcile.issue_moved", {
        batchId: args.batchId,
        draftId: draft.id,
        issueNumber: candidate.issueNumber,
        answeredNumber: identity.number,
      });
      continue;
    }
    const markers = parseMarkers(issue.body ?? "");
    const own = markers.filter((m) => m.draftId === draft.id);
    const confirmed = own.find(
      (m) => (candidate.dedupHash !== null && m.hash === candidate.dedupHash) || m.hash === hash,
    );
    if (!confirmed) {
      const action =
        own.length > 0
          ? "publish.reconcile.marker_hash_mismatch"
          : "publish.reconcile.marker_mismatch";
      log.warn(action, {
        batchId: args.batchId,
        draftId: draft.id,
        issueNumber: candidate.issueNumber,
        markersRead: markers.length,
      });
      audit({
        actor: { id: SYSTEM_ACTOR_ID },
        action,
        target: { type: "github_issue", id: issueRef },
        metadata: {
          batchId: args.batchId,
          draftId: draft.id,
          markerDraftIds: [...new Set(markers.map((m) => m.draftId))].slice(0, 10),
        },
      });
      continue;
    }
    // Strip the marker before hashing so the recovered bodyHash matches the
    // hash format used at write time (raw user-supplied body).
    const stripped = stripMarker(issue.body ?? "").trimEnd();
    existingByHash.set(hash, {
      issueNumber: identity.number,
      // #1091 — the node id, never the numeric REST id.
      issueId: identity.nodeId,
      htmlUrl: identity.htmlUrl,
      bodyHash: computeBodyHash(stripped),
      parentIssueNumber: candidate.parentIssueNumber,
      additionalLabels: candidate.additionalLabels,
      sentLabels: candidate.sentLabels,
    });
    log.info("publish.reconcile.recovered", {
      batchId: args.batchId,
      draftId: draft.id,
      issueNumber: identity.number,
      hash,
    });
  }
  const note =
    unreadNumbers.length === 0
      ? null
      : `could not read issue ${unreadNumbers.map((n) => `#${n}`).join(", ")} on GitHub to ` +
        `check whether ${unreadNumbers.length === 1 ? "it is a draft's" : "they are drafts'"} ` +
        "existing issue; nothing was published, retry the batch";
  return { unreadNumbers, note };
}
/** The non-empty, decoded path segments of a URL, or `null` when it is not one. */
function urlSegments(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).pathname
      .split("/")
      .filter((s) => s !== "")
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/**
 * #1106 review — whether an issue GitHub answered with lives in `target`. A
 * redirect followed to a transferred issue answers from the NEW repository,
 * possibly under the same number. Every repository URL the payload carries —
 * `repository_url` (`…/repos/{owner}/{repo}`) and `html_url`
 * (`…/{owner}/{repo}/issues/{n}`) — must name the target (case-insensitive,
 * `namesRepository`), and it must carry at least one.
 */
function issueIsInRepository(issue: GhIssue, target: { owner: string; repo: string }): boolean {
  const repository: NamedRepository = {
    owner: target.owner.trim().toLowerCase(),
    name: target.repo.trim().toLowerCase(),
  };
  const named: Array<[string, string] | null> = [];
  const api = urlSegments((issue as { repository_url?: unknown }).repository_url);
  if (api) {
    const i = api.lastIndexOf("repos");
    named.push(i >= 0 && i + 3 === api.length ? [api[i + 1]!, api[i + 2]!] : null);
  }
  const html = urlSegments(issue.html_url);
  if (html) {
    const n = html.length;
    named.push(n >= 4 && html[n - 2] === "issues" ? [html[n - 4]!, html[n - 3]!] : null);
  }
  return (
    named.length > 0 &&
    named.every((pair) => pair !== null && namesRepository(repository, pair[0], pair[1]))
  );
}

function safeWhereFromMetadata(meta: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(meta) as { draftIds?: string[] };
    if (Array.isArray(parsed.draftIds) && parsed.draftIds.length > 0) {
      return { id: { in: parsed.draftIds } };
    }
  } catch {
    /* ignore */
  }
  return {};
}

function parseLabels(json: string): string[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  return [];
}

function issuePath(target: { owner: string; repo: string }, number: number): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${number}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __testing = {
  parseLabels,
  extractAdditionalLabels: batchAdditionalLabels,
  buildMarkerComment,
  loadExistingByHash,
  reconcileFromRemote,
  attachSubIssueWithRetry,
  rollbackBatch,
};

export type { DryRunPlan };
