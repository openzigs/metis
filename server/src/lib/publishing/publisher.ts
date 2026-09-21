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
 * new issues. The marker comment in each issue body provides recovery if
 * the local PublishedIssue rows are wiped.
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
import { GITHUB_API_VERSION, type CredentialCheckResult, type DryRunPlan } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { assertDraftsPublishable } from "../reviews/approval-gate.js";
import { createChildLogger } from "../logger.js";
import { getVaultService } from "../vault/vault-service.js";
import { resolveVaultRef } from "../connectors/vault-resolver.js";
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
  computeDedupHash,
  injectMarker,
  parseMarker,
  stripMarker,
} from "./dedup.js";
import { combineLabels, DEFAULT_PUBLISH_LABELS, syncLabels } from "./label-sync.js";
import { buildDryRunPlan } from "./dry-run.js";
import { notifyPublishRolledBack } from "../teams/notification-hooks.js";
import { pagerDutyPublishRollback } from "../pagerduty/alerting-hooks.js";
import {
  NOOP_PUBLISH_EMITTER,
  PublishError,
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
  const existingByHash = await loadExistingByHash(
    input.projectId,
    input.targetOwner,
    input.targetRepo,
  );
  const credential = await preflightCredential(input.secretRef);
  return buildDryRunPlan({
    batchId: PREVIEW_PLAN_BATCH_ID,
    targetOwner: input.targetOwner,
    targetRepo: input.targetRepo,
    targetBaseUrl: input.targetBaseUrl ?? "https://api.github.com",
    provider: input.provider,
    drafts: drafts.map((d) => ({
      id: d.id,
      title: d.title,
      body: d.body,
      labels: parseLabels(d.labels),
      parentDraftId: d.parentDraftId,
      draftType: d.draftType,
    })),
    additionalLabels: input.additionalLabels,
    existingByHash,
    perCallMs: rateLimit.delayMs,
    credential,
  });
}

export interface RunBatchInput {
  batchId: string;
  /** When true, no API calls are made; a plan is computed and persisted. */
  dryRun: boolean;
  /** Vault ref for the GitHub PAT — `${vault:label}` or null. */
  secretRef: string | null;
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
  const drafts = await prisma.issueDraft.findMany({
    where: {
      projectId: batch.projectId,
      status: { in: ["draft", "approved", "publishing", "failed"] },
      deletedAt: null,
      ...(batch.metadata ? safeWhereFromMetadata(batch.metadata) : {}),
    },
    orderBy: [{ draftType: "asc" }, { createdAt: "asc" }],
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
    );
    // #1093 — pre-flight the credential. This is the one thing an operator
    // most wants a preview to predict, and previously the dry run reported
    // `completed` for exactly the ref the live run rejects with a 400.
    //
    // M1 is preserved: the vault is a local secret store, so this touches no
    // DNS, no host allow-list and no GitHub endpoint. The token is resolved
    // and immediately discarded — only the verdict reaches the plan.
    const credential = await preflightCredential(input.secretRef);
    const plan = buildDryRunPlan({
      batchId: batch.id,
      targetOwner: dryTarget.owner,
      targetRepo: dryTarget.repo,
      targetBaseUrl: dryTarget.baseUrl,
      provider: batch.provider as "github" | "github_enterprise",
      drafts: drafts.map((d) => ({
        id: d.id,
        title: d.title,
        body: d.body,
        labels: parseLabels(d.labels),
        parentDraftId: d.parentDraftId,
        draftType: d.draftType,
      })),
      additionalLabels: extractAdditionalLabels(batch.metadata),
      existingByHash,
      perCallMs: rateLimit.delayMs,
      credential,
    });
    await prisma.publishBatch.update({
      where: { id: batch.id },
      data: {
        status: "completed",
        dryRunPlan: JSON.stringify(plan),
        completedAt: new Date(),
        totalDrafts: drafts.length,
        // #1093 — a preview whose credential would not resolve still yields a
        // useful plan, but it must not read as an unqualified success in the
        // batch list.
        errorMessage: plan.credentialResolved
          ? null
          : `dry run completed, but the GitHub credential did not resolve (${plan.credentialCheck}) — a live publish would be rejected`,
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
  const token = input.secretRef ? await resolveVaultRef(input.secretRef, getVaultService()) : null;
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

  emitter().progress({
    batchId: batch.id,
    phase: "sync-labels",
    step: "starting",
  });
  const labels = combineLabels(DEFAULT_PUBLISH_LABELS, extractAdditionalLabels(batch.metadata));
  await syncLabels(client, { owner: target.owner, repo: target.repo }, labels);

  emitter().progress({
    batchId: batch.id,
    phase: "dedup-scan",
    step: "loading-existing-issues",
  });
  const existingByHash = await loadExistingByHash(batch.projectId, target.owner, target.repo);

  // Recover lost PublishedIssue rows by parsing marker comments on remote issues.
  await reconcileFromRemote({
    client,
    target,
    drafts,
    existingByHash,
    batchId: batch.id,
    projectId: batch.projectId,
  });

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
    const stampedBody = injectMarker(draft.body, {
      batchId: batch.id,
      draftId: draft.id,
      hash,
    });
    // Hash the user-supplied body (without the per-batch marker) so that
    // re-running an identical draft in a fresh batch dedup-skips instead of
    // appearing to "change" because the marker batchId differs.
    const bodyHash = computeBodyHash(draft.body);
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
          // Refresh draft → published linkage in case caller lost it.
          await prisma.publishedIssue.upsert({
            where: {
              batchId_draftId_destination: {
                batchId: batch.id,
                draftId: draft.id,
                destination: "github",
              },
            },
            update: { issueNumber: existing.issueNumber, status: "updated" },
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
            labels: parseLabels(draft.labels),
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
            labels: parseLabels(draft.labels),
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
          ...(remoteCreated
            ? {
                issueNumber: remoteCreated.issueNumber,
                issueId: remoteCreated.nodeId,
                htmlUrl: remoteCreated.htmlUrl,
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
): Promise<{ check: CredentialCheckResult; errorCode: string | null }> {
  if (!secretRef) return { check: "missing", errorCode: "TOKEN_REQUIRED" };
  try {
    const token = await resolveVaultRef(secretRef, getVaultService());
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

export async function archiveBatch(input: {
  batchId: string;
  reason: string;
  closeIssues: boolean;
  actorId: string;
  secretRef: string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = input.sleep ?? defaultSleep;
  const batch = await prisma.publishBatch.findUnique({ where: { id: input.batchId } });
  if (!batch) throw new PublishError(404, "BATCH_NOT_FOUND", "batch not found");
  if (batch.archived) {
    return;
  }
  if (input.closeIssues && !batch.dryRun) {
    if (!input.secretRef) {
      throw new PublishError(400, "TOKEN_REQUIRED", "closing issues requires a vault token");
    }
    const token = await resolveVaultRef(input.secretRef, getVaultService());
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
}

async function loadExistingByHash(
  projectId: string,
  owner: string,
  repo: string,
): Promise<Map<string, ExistingMatch>> {
  const out = new Map<string, ExistingMatch>();
  const rows = await prisma.publishedIssue.findMany({
    where: {
      batch: { projectId, targetOwner: owner, targetRepo: repo, archived: false },
      status: { in: ["created", "updated"] },
      dedupHash: { not: null },
    },
  });
  for (const row of rows) {
    if (!row.dedupHash) continue;
    out.set(row.dedupHash, {
      issueNumber: row.issueNumber,
      issueId: row.issueId,
      htmlUrl: row.htmlUrl,
      bodyHash: row.bodyHash,
      parentIssueNumber: row.parentIssueNumber,
    });
  }
  return out;
}

interface ReconcileArgs {
  client: PublishOctokitLike;
  target: { owner: string; repo: string };
  drafts: Array<{ id: string; title: string; body: string }>;
  existingByHash: Map<string, ExistingMatch>;
  batchId: string;
  projectId: string;
}

async function reconcileFromRemote(args: ReconcileArgs): Promise<void> {
  const { client, target, drafts, existingByHash, projectId } = args;
  // Only run if there are drafts whose dedup hash is NOT in our local map —
  // saves a round-trip when everything is already known.
  const missing = drafts.filter((d) => {
    const h = computeDedupHash(target.owner, target.repo, d.title);
    return !existingByHash.has(h);
  });
  if (missing.length === 0) return;
  // Single page sweep — issues with our marker comment.
  let resp;
  try {
    resp = await client.request<GhIssue[]>({
      method: "GET",
      url: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues?state=all&per_page=100&labels=metis-generated`,
    });
  } catch {
    return;
  }
  const remote = Array.isArray(resp.data) ? resp.data : [];
  for (const issue of remote) {
    const marker = parseMarker(issue.body ?? "");
    if (!marker) continue;
    if (existingByHash.has(marker.hash)) continue;
    // F3: marker is a HINT ONLY. Cross-check the DB to confirm the linkage
    // is real — an attacker-controlled requirement body could ship a fake
    // marker pointing at any draft/batch in the world. Authoritative
    // mapping lives in the PublishedIssue table; if the marker disagrees
    // with the DB (or the referenced batch is for a different project),
    // reject the linkage and log a warning instead of trusting it.
    const dbRow = await prisma.publishedIssue.findFirst({
      where: {
        draftId: marker.draftId,
        batch: { projectId },
      },
      include: { batch: true },
    });
    if (!dbRow) {
      log.warn("publish.reconcile.marker_not_in_db", {
        batchId: args.batchId,
        markerBatchId: marker.batchId,
        markerDraftId: marker.draftId,
        issueNumber: issue.number,
      });
      continue;
    }
    if (dbRow.batch.projectId !== projectId) {
      log.warn("publish.reconcile.marker_cross_project", {
        batchId: args.batchId,
        markerBatchId: marker.batchId,
        markerDraftId: marker.draftId,
        issueNumber: issue.number,
      });
      continue;
    }
    if (dbRow.issueNumber !== issue.number) {
      // Marker points at a real draft we own, but the DB has a different
      // canonical issue for it. DB wins — log the discrepancy and audit.
      log.warn("publish.reconcile.marker_db_mismatch", {
        batchId: args.batchId,
        markerDraftId: marker.draftId,
        markerIssueNumber: issue.number,
        dbIssueNumber: dbRow.issueNumber,
      });
      audit({
        actor: { id: "system" },
        action: "publish.reconcile.marker_mismatch",
        target: {
          type: "github_issue",
          id: `${target.owner}/${target.repo}#${issue.number}`,
        },
        metadata: {
          batchId: args.batchId,
          markerBatchId: marker.batchId,
          markerDraftId: marker.draftId,
          dbIssueNumber: dbRow.issueNumber,
        },
      });
      continue;
    }
    // Strip the marker before hashing so the recovered bodyHash matches the
    // hash format used at write time (raw user-supplied body).
    const stripped = stripMarker(issue.body ?? "").trimEnd();
    // #1091 — `issue.id` here is the numeric REST id; `PublishedIssue.issueId`
    // stores the node id. Reading the wrong one poisoned the dedup map, so a
    // retry re-failed on the very rows recovery had just repaired.
    let identity;
    try {
      identity = readIssueIdentity(issue);
    } catch {
      log.warn("publish.reconcile.malformed_issue", {
        batchId: args.batchId,
        issueNumber: issue.number,
      });
      continue;
    }
    existingByHash.set(marker.hash, {
      issueNumber: identity.number,
      issueId: identity.nodeId,
      htmlUrl: identity.htmlUrl,
      bodyHash: computeBodyHash(stripped),
      parentIssueNumber: dbRow.parentIssueNumber ?? null,
    });
    log.info("publish.reconcile.recovered", {
      batchId: args.batchId,
      issueNumber: issue.number,
      hash: marker.hash,
    });
  }
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

function extractAdditionalLabels(meta: string | null): string[] {
  if (!meta) return [];
  try {
    const parsed = JSON.parse(meta) as { additionalLabels?: string[] };
    if (Array.isArray(parsed.additionalLabels)) {
      return parsed.additionalLabels.filter((s): s is string => typeof s === "string");
    }
  } catch {
    /* ignore */
  }
  return [];
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
  extractAdditionalLabels,
  buildMarkerComment,
  loadExistingByHash,
  reconcileFromRemote,
  attachSubIssueWithRetry,
  rollbackBatch,
};

export type { DryRunPlan };
