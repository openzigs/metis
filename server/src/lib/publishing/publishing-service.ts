/**
 * Publishing service — Phase 9.
 *
 * Stateless wrappers over Prisma + the publisher module. Routes call into
 * this layer and never touch Prisma directly so RBAC and audit stay
 * consolidated.
 */
import {
  publishBatchCancelState,
  type ArchivePublishBatchInput,
  type CreatePublishBatchInput,
  type DryRunPlan,
  type PublishBatch as SharedPublishBatch,
  type PublishedIssue as SharedPublishedIssue,
  type IssueDraft as SharedIssueDraft,
  type RoleKey,
  type PublishDestination,
} from "@metis/shared";
import { audit } from "../audit/audit-service.js";
import { prisma } from "../prisma.js";
import { archiveBatch as archiveBatchImpl, previewBatchPlan, runBatch } from "./publisher.js";
import { generateDrafts as generateDraftsImpl } from "./draft-generator.js";
import { canCreateTickets } from "../analysis/approval-checkpoint.js";
import { assertDraftsPublishable } from "../reviews/approval-gate.js";
import { PublishError } from "./types.js";
import { isVaultRef } from "../connectors/vault-resolver.js";
import { publishBatchToJira } from "./jira-publisher.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("publishing-service");

export interface ListBatchesOptions {
  projectId: string;
  includeArchived?: boolean;
}

export async function listBatches(opts: ListBatchesOptions): Promise<SharedPublishBatch[]> {
  const rows = await prisma.publishBatch.findMany({
    where: {
      projectId: opts.projectId,
      ...(opts.includeArchived ? {} : { archived: false }),
    },
    orderBy: { startedAt: "desc" },
  });
  return rows.map(toBatchApi);
}

/**
 * Fetch one batch, **scoped to its owning project**.
 *
 * #1072 — `projectId` is REQUIRED: the route mounts under
 * `/projects/:projectId/publishing`, and resolving a batch by bare primary key
 * let a legitimate member of project A read project B's batch by putting B's id
 * in the path's id slot. Keeping the scope in the Prisma `where` (rather than a
 * separate check at the router) means a later caller cannot forget it. A batch
 * outside `projectId` is indistinguishable from one that does not exist.
 */
export async function getBatch(
  id: string,
  projectId: string,
): Promise<
  SharedPublishBatch & {
    publishedIssues: SharedPublishedIssue[];
  }
> {
  const row = await prisma.publishBatch.findFirst({
    where: { id, projectId },
    include: { publishedIssues: { orderBy: { issueNumber: "asc" } } },
  });
  if (!row) throw new PublishError(404, "BATCH_NOT_FOUND", "publish batch not found");
  return {
    ...toBatchApi(row),
    publishedIssues: row.publishedIssues.map(toPublishedIssueApi),
  };
}

export interface CreateBatchOptions {
  input: CreatePublishBatchInput;
  actorId: string;
  /**
   * F6: when true, the caller has explicitly acknowledged that the target
   * repo is owned by another project and wants to override the
   * cross-project guard. Defaults to false. Routes set this when the
   * client passes `metadata.confirmCrossProject=true`.
   */
  confirmCrossProject?: boolean;
}

/**
 * #257 — defence-in-depth promotion guard for the publishing layer. Throws a
 * `PublishError(409, "PROMOTION_BLOCKED", ...)` if any of the supplied analyses
 * still has unresolved (pending) or rejected approvals. A no-op for the empty
 * set (drafts not traceable to an analysis fall back to the upstream gate).
 * Exported for unit testing.
 */
export async function assertPromotionAllowed(analysisIds: string[]): Promise<void> {
  for (const analysisId of analysisIds) {
    const ticketStatus = await canCreateTickets(analysisId);
    if (!ticketStatus.allowed) {
      throw new PublishError(
        409,
        "PROMOTION_BLOCKED",
        `promotion blocked for analysis ${analysisId}: ${ticketStatus.pendingCount} pending, ${ticketStatus.rejectedCount} rejected approval(s) must be resolved before publishing`,
      );
    }
  }
}

/**
 * The one client-safe description of the vault-ref contract (#1094).
 *
 * Deliberately names the field and the required shape but **echoes nothing**
 * the user typed: this input is a credential *field*, and a user who pastes a
 * raw PAT into it must not have it reflected back in an error body, a log line
 * or a rendered UI message. That is why this string is a constant rather than
 * a template over the received value — and why the underlying
 * `ConnectorError`, which does embed a preview of the input, is not forwarded.
 *
 * "Wrong format" is a usability failure, not a security control: the caller
 * gets the format, the example and the error code, just never their own secret
 * material back.
 */
export const VAULT_REF_FORMAT_MESSAGE =
  'Vault secret ref must be written as "${vault:label}" — for example "${vault:gh-publish-token}". ' +
  "Enter the label of a secret stored in the vault, not the token itself.";

/**
 * #1092/#1094 — validate the secret ref BEFORE any row is written.
 *
 * Previously `POST /batches` created the `PublishBatch` row and only then hit
 * `resolveVaultRef`, so a rejected request left a `pending` batch behind
 * forever — indistinguishable from one genuinely in flight, and never reaped.
 * Validating here (rather than at the route) keeps internal callers honest too.
 *
 * Live runs additionally require a ref at all: `runBatch` would otherwise
 * throw `TOKEN_REQUIRED` after the row existed, orphaning it the same way.
 * Exported for unit testing.
 */
export function assertValidSecretRef(secretRef: string | undefined, dryRun: boolean): void {
  if (!secretRef) {
    if (dryRun) return; // a preview without a credential is legitimate
    throw new PublishError(
      400,
      "TOKEN_REQUIRED",
      `A live publish requires a GitHub token. ${VAULT_REF_FORMAT_MESSAGE}`,
    );
  }
  if (!isVaultRef(secretRef)) {
    throw new PublishError(400, "VAULT_REF_INVALID", VAULT_REF_FORMAT_MESSAGE);
  }
}

export async function createBatch(opts: CreateBatchOptions): Promise<SharedPublishBatch> {
  const { input, actorId } = opts;
  // #1092/#1094 — reject a malformed/missing credential ref before the batch
  // row is created, so a validation failure leaves no orphaned `pending` row.
  assertValidSecretRef(input.secretRef, input.dryRun);
  // F6: defence in depth — the route also checks this, but the service
  // layer must NEVER accept a cross-project repo without explicit
  // confirmation regardless of how it was called. Internal callers who
  // bypass the route would otherwise be able to write into another
  // project's repo.
  if (!opts.confirmCrossProject) {
    const conflicting = await prisma.repoConnection.findFirst({
      where: {
        ownerOrOrg: input.targetOwner,
        repoName: input.targetRepo,
        projectId: { not: input.projectId },
        deletedAt: null,
      },
      select: { id: true },
    });
    if (conflicting) {
      throw new PublishError(
        409,
        "REPO_CROSS_PROJECT",
        `repo ${input.targetOwner}/${input.targetRepo} is owned by another project; pass confirmCrossProject=true to override`,
      );
    }
  }
  const drafts = await prisma.issueDraft.findMany({
    where: { id: { in: input.draftIds }, projectId: input.projectId, deletedAt: null },
    select: {
      id: true,
      status: true,
      requirementId: true,
      metadata: true,
      requirement: { select: { analysisId: true } },
    },
  });
  if (drafts.length !== input.draftIds.length) {
    throw new PublishError(400, "DRAFT_MISMATCH", "one or more drafts not found in this project");
  }
  const ineligible = drafts.find(
    (d) => d.status !== "draft" && d.status !== "approved" && d.status !== "failed",
  );
  if (ineligible) {
    throw new PublishError(
      400,
      "DRAFT_INELIGIBLE",
      `draft ${ineligible.id} is in status ${ineligible.status}; only draft|approved|failed can publish`,
    );
  }
  // #257 — defence in depth: independently re-check promotion gating at the
  // publishing layer. Promotion is normally gated in the orchestrator
  // (runSynthesisAndPersist) before drafts are ever generated, but a future
  // code path could reach publishing without passing that gate. Resolve every
  // analysis these drafts trace back to (via requirement) and reject the batch
  // if any still has unresolved/rejected approvals.
  await assertPromotionAllowed(
    Array.from(
      new Set(
        drafts
          .map((d) => d.requirement?.analysisId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ),
  );
  // #619 — approval gate (requireApprovedReview). A LIVE batch may only be
  // created when every draft traces to a requirement with an approved,
  // still-current review. Enforced at the service layer so internal callers
  // (test-coverage exporter, future flows) cannot bypass the route. Dry-run
  // previews are exempt: they perform no external writes and previewing the
  // plan is how users discover what still needs review. Fail-closed: any
  // error inside the gate blocks the batch.
  if (!input.dryRun) {
    await assertDraftsPublishable({
      projectId: input.projectId,
      drafts,
      context: "publish.batch.create",
      actorId,
    });
  }
  const batch = await prisma.publishBatch.create({
    data: {
      projectId: input.projectId,
      targetOwner: input.targetOwner,
      targetRepo: input.targetRepo,
      targetBaseUrl: input.targetBaseUrl ?? null,
      provider: input.provider,
      dryRun: input.dryRun,
      status: "pending",
      startedById: actorId,
      totalDrafts: input.draftIds.length,
      metadata: JSON.stringify({
        draftIds: input.draftIds,
        additionalLabels: input.additionalLabels,
        milestone: input.milestone,
        secretRef: input.secretRef ?? null,
        ...(input.metadata ?? {}),
      }),
    },
  });
  audit({
    actor: { id: actorId },
    action: input.dryRun ? "publish.batch.preview" : "publish.batch.start",
    target: { type: "publish_batch", id: batch.id },
    metadata: {
      projectId: input.projectId,
      repo: `${input.targetOwner}/${input.targetRepo}`,
      provider: input.provider,
      dryRun: input.dryRun,
      drafts: input.draftIds.length,
    },
  });
  return toBatchApi(batch);
}

/**
 * #1104 (D) — the plan behind the pre-publish confirmation.
 *
 * Takes the SAME body the caller would POST to create the batch, and answers
 * "what would this write, and where?" without creating anything. Two reasons
 * it is a server call rather than a client-side estimate:
 *
 *  - only the server knows the dedup state, so only the server can say
 *    "14 creates" instead of the materially different "14 updates";
 *  - reusing `buildDryRunPlan` means the confirmation cannot drift from what
 *    the run actually does.
 *
 * Bodies are stripped from the returned actions. The plan the dry run persists
 * carries every stamped issue body — hundreds of KB for a real batch — and the
 * confirmation needs none of it, only kinds, titles and counts.
 *
 * Intentionally NOT gated on the approval/promotion checks that `createBatch`
 * enforces: a preview writes nothing, and answering "what would happen" is not
 * a permission to make it happen. The gates still run on the real request.
 */
export async function previewBatch(opts: {
  input: CreatePublishBatchInput;
  actorId: string;
}): Promise<DryRunPlan> {
  const { input, actorId } = opts;
  const plan = await previewBatchPlan({
    projectId: input.projectId,
    targetOwner: input.targetOwner,
    targetRepo: input.targetRepo,
    targetBaseUrl: input.targetBaseUrl ?? null,
    provider: input.provider,
    draftIds: input.draftIds,
    additionalLabels: input.additionalLabels,
    secretRef: input.secretRef ?? null,
  });
  audit({
    actor: { id: actorId },
    action: "publish.batch.preview_plan",
    target: { type: "project", id: input.projectId },
    metadata: {
      repo: `${input.targetOwner}/${input.targetRepo}`,
      drafts: input.draftIds.length,
      actions: plan.totalActions,
      credentialCheck: plan.credentialCheck,
    },
  });
  return {
    ...plan,
    actions: plan.actions.map(({ body: _body, ...rest }) => rest),
  };
}

/**
 * #1092 — a batch must never be left in `pending` by a throw.
 *
 * `assertValidSecretRef` stops the reported case before a row exists, but any
 * later failure (approval gate, allow-list rejection, an unresolvable vault
 * ref) used to abort mid-flight and strand the row: a `pending` batch is
 * indistinguishable from one genuinely in flight, nothing reaps it, and it
 * would poison any future "is a publish already running?" guard.
 *
 * Best-effort and never masks the original error. Archived batches and batches
 * the publisher already settled are left alone.
 */
async function markBatchFailed(batchId: string, err: unknown): Promise<void> {
  try {
    const current = await prisma.publishBatch.findUnique({ where: { id: batchId } });
    if (!current || current.archived) return;
    if (current.status !== "pending" && current.status !== "running") return;
    const code = (err as { code?: unknown }).code;
    const safeCode =
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "PUBLISH_FAILED";
    await prisma.publishBatch.update({
      where: { id: batchId },
      data: {
        status: "failed",
        completedAt: new Date(),
        // Code only — an upstream message may carry resolved addresses or
        // vault/driver text (#1065).
        errorMessage: current.errorMessage ?? `publish batch aborted (${safeCode})`,
      },
    });
  } catch (updateErr) {
    log.error("Failed to mark aborted publish batch as failed", {
      batchId,
      error: String(updateErr),
    });
  }
}

export async function executeBatch(opts: {
  batchId: string;
  actorId: string;
}): Promise<{ status: string }> {
  try {
    return await executeBatchInner(opts);
  } catch (err) {
    await markBatchFailed(opts.batchId, err);
    throw err;
  }
}

async function executeBatchInner(opts: {
  batchId: string;
  actorId: string;
}): Promise<{ status: string }> {
  const batch = await prisma.publishBatch.findUnique({ where: { id: opts.batchId } });
  if (!batch) throw new PublishError(404, "BATCH_NOT_FOUND", "publish batch not found");
  // #1104 (F) — `cancelled` is terminal, exactly like completed/failed.
  if (batch.status === "completed" || batch.status === "failed" || batch.status === "cancelled") {
    return { status: batch.status };
  }
  const meta = batch.metadata
    ? (JSON.parse(batch.metadata) as { secretRef?: string; draftIds?: string[] })
    : {};
  const secretRef = meta.secretRef ?? null;

  // Determine publish destination from the project settings. Looked up
  // BEFORE the gate: Jira-bound destinations gate a different draft set
  // (see below).
  const project = await prisma.project.findUnique({
    where: { id: batch.projectId },
    select: {
      publishDestination: true,
      jiraConnectionId: true,
      jiraProjectKey: true,
    },
  });
  const destination = (project?.publishDestination ?? "github") as PublishDestination;
  // Mirrors the condition guarding the Jira publish below.
  const jiraBound =
    (destination === "jira" || destination === "both") &&
    Boolean(project?.jiraConnectionId) &&
    Boolean(project?.jiraProjectKey);

  // #619 — approval gate, re-checked at EXECUTION time (defence in depth):
  // the flag may have been enabled — or a requirement revised, staling its
  // approval — after the batch row was created. Covers both the GitHub
  // (runBatch) and Jira (publishBatchToJira) destinations below. Dry-run
  // batches are exempt (no external writes). Fail-closed.
  //
  // PR #638 review (M2): the gate must check exactly the set each leg will
  // publish. runBatch resolves publishable statuses itself (and re-gates
  // that exact set at its own choke point), but publishBatchToJira pushes
  // EVERY id in `meta.draftIds` regardless of status — on a retried,
  // partially completed batch the GitHub leg may already have flipped
  // drafts to `published`, and those must not reach Jira ungated. So:
  // Jira-bound destinations gate the raw draft-id set (no status filter);
  // GitHub-only keeps mirroring runBatch's own draft resolution.
  if (!batch.dryRun) {
    await assertDraftsPublishable({
      projectId: batch.projectId,
      // Lazy loader: only queried when the gate is enforced.
      drafts: () =>
        prisma.issueDraft.findMany({
          where: {
            projectId: batch.projectId,
            deletedAt: null,
            ...(jiraBound ? {} : { status: { in: ["draft", "approved", "publishing", "failed"] } }),
            ...(Array.isArray(meta.draftIds) && meta.draftIds.length > 0
              ? { id: { in: meta.draftIds } }
              : {}),
          },
          select: { id: true, requirementId: true, metadata: true },
        }),
      context: "publish.batch.execute",
      actorId: opts.actorId,
    });
  }

  // GitHub publish (original path)
  let githubResult: { status: string } = { status: "skipped" };
  if (destination === "github" || destination === "both") {
    githubResult = await runBatch({
      batchId: opts.batchId,
      dryRun: batch.dryRun,
      secretRef,
    });
  }

  // Jira publish
  if (
    (destination === "jira" || destination === "both") &&
    !batch.dryRun &&
    project?.jiraConnectionId &&
    project?.jiraProjectKey
  ) {
    try {
      const draftIds =
        meta && "draftIds" in meta ? ((meta as { draftIds?: string[] }).draftIds ?? []) : [];
      if (draftIds.length > 0) {
        const jiraResult = await publishBatchToJira({
          batchId: opts.batchId,
          draftIds,
          connectionId: project.jiraConnectionId,
          projectKey: project.jiraProjectKey,
          actorId: opts.actorId,
        });

        // Record Jira published issues
        for (const r of jiraResult.results) {
          if (r.status === "created") {
            const draftId = draftIds[jiraResult.results.indexOf(r)];
            await prisma.publishedIssue.create({
              data: {
                batchId: opts.batchId,
                draftId,
                issueNumber: 0, // Jira uses keys, not numbers
                issueId: r.issueId,
                htmlUrl: r.htmlUrl,
                status: "created",
                destination: "jira",
                dedupHash: null,
                bodyHash: null,
              },
            });
          }
        }
      }
    } catch (err) {
      log.error("Jira publish failed for batch", {
        batchId: opts.batchId,
        error: String(err),
      });
      // Don't fail the whole batch — Jira is best-effort when destination=both
    }
  }

  // For jira-only destination, update batch status
  if (destination === "jira") {
    await prisma.publishBatch.update({
      where: { id: opts.batchId },
      data: { status: "completed", completedAt: new Date() },
    });
    return { status: "completed" };
  }

  return githubResult;
}

export async function archiveBatch(opts: {
  batchId: string;
  /**
   * #1072: owning project of the batch, taken from the request path. The
   * lookup below is scoped to it, so a member of another project cannot
   * archive/rollback this batch by supplying its bare id.
   */
  projectId: string;
  input: ArchivePublishBatchInput;
  actorId: string;
  /**
   * F5: actor's role. Service-layer authorization MUST verify that the
   * caller is admin OR is the user who originally started the batch. The
   * route layer also enforces this, but service-internal callers must not
   * be able to bypass.
   */
  actorRole: RoleKey;
}): Promise<SharedPublishBatch> {
  const batch = await prisma.publishBatch.findFirst({
    where: { id: opts.batchId, projectId: opts.projectId },
  });
  // Out-of-project and nonexistent produce the SAME 404 — no existence oracle.
  if (!batch) throw new PublishError(404, "BATCH_NOT_FOUND", "publish batch not found");
  // F5: defence in depth — only admin OR the user who started the batch
  // may archive/rollback it.
  if (opts.actorRole !== "admin" && batch.startedById !== opts.actorId) {
    audit({
      actor: { id: opts.actorId },
      action: "publish.batch.archive_denied",
      target: { type: "publish_batch", id: opts.batchId },
      metadata: { reason: "not_owner", role: opts.actorRole },
    });
    throw new PublishError(
      403,
      "PUBLISH_BATCH_FORBIDDEN",
      "only the batch owner or an admin may archive/rollback this batch",
    );
  }
  const meta = batch.metadata ? (JSON.parse(batch.metadata) as { secretRef?: string }) : {};
  await archiveBatchImpl({
    batchId: opts.batchId,
    reason: opts.input.reason,
    closeIssues: opts.input.closeIssues,
    actorId: opts.actorId,
    secretRef: meta.secretRef ?? null,
  });
  const refreshed = await prisma.publishBatch.findUnique({ where: { id: opts.batchId } });
  return toBatchApi(refreshed!);
}

/**
 * #1104 (F) — settle a stranded batch.
 *
 * #1092 stopped *new* rows being orphaned but left every pre-existing one
 * rendering as in-progress forever, with "Watch" as the only offered action.
 * This is the remedy, and it is deliberately a state transition on the local
 * row and nothing else: cancelling **does not** recall anything already
 * written to GitHub, and must never be mistaken for a rollback (that is
 * `archiveBatch` with `closeIssues`).
 *
 * That framing is what makes the in-flight guard load-bearing rather than
 * decorative. A batch runs inside the request that created it with no
 * heartbeat on the row, so "still alive?" can only be answered by age;
 * `publishBatchCancelState` refuses anything younger than the grace window, so
 * a user cannot settle a run that is still creating issues and then watch
 * `publishedCount` climb on a row marked cancelled. The same shared verdict
 * drives the UI, so the button is only ever offered when this will say yes.
 */
export async function cancelBatch(opts: {
  batchId: string;
  /** #1072 — owning project from the request path; the lookup is scoped to it. */
  projectId: string;
  actorId: string;
  /** Mirrors archiveBatch: admin OR the user who started the batch. */
  actorRole: RoleKey;
  /** Injectable clock for tests. */
  now?: number;
}): Promise<SharedPublishBatch> {
  const batch = await prisma.publishBatch.findFirst({
    where: { id: opts.batchId, projectId: opts.projectId },
  });
  // Out-of-project and nonexistent produce the SAME 404 — no existence oracle.
  if (!batch) throw new PublishError(404, "BATCH_NOT_FOUND", "publish batch not found");
  if (opts.actorRole !== "admin" && batch.startedById !== opts.actorId) {
    audit({
      actor: { id: opts.actorId },
      action: "publish.batch.cancel_denied",
      target: { type: "publish_batch", id: opts.batchId },
      metadata: { reason: "not_owner", role: opts.actorRole },
    });
    throw new PublishError(
      403,
      "PUBLISH_BATCH_FORBIDDEN",
      "only the batch owner or an admin may cancel this batch",
    );
  }
  const state = publishBatchCancelState(batch, opts.now ?? Date.now());
  if (!state.cancellable) {
    if (state.reason === "in_flight") {
      throw new PublishError(
        409,
        "BATCH_IN_FLIGHT",
        `this batch may still be running; cancel becomes available ${Math.ceil(
          state.waitMs / 60_000,
        )} minute(s) after it started. Cancelling settles the local record only — it cannot recall issues already created on GitHub.`,
      );
    }
    throw new PublishError(
      409,
      "BATCH_NOT_CANCELLABLE",
      `batch is ${batch.archived ? "archived" : batch.status}; only a pending or running batch can be cancelled`,
    );
  }
  const updated = await prisma.publishBatch.update({
    where: { id: batch.id },
    data: {
      status: "cancelled",
      completedAt: new Date(opts.now ?? Date.now()),
      // Keep whatever diagnosis the run left behind; otherwise record the
      // cancellation in fixed text — never anything the caller supplied (#1065).
      errorMessage: batch.errorMessage ?? "publish batch cancelled by a user",
    },
  });
  audit({
    actor: { id: opts.actorId },
    action: "publish.batch.cancelled",
    target: { type: "publish_batch", id: batch.id },
    metadata: {
      projectId: batch.projectId,
      previousStatus: batch.status,
      startedAt: batch.startedAt.toISOString(),
    },
  });
  return toBatchApi(updated);
}

export async function listDrafts(projectId: string): Promise<SharedIssueDraft[]> {
  const rows = await prisma.issueDraft.findMany({
    where: { projectId, deletedAt: null },
    orderBy: [{ draftType: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toDraftApi);
}

export async function approveDraft(opts: {
  draftId: string;
  actorId: string;
  /**
   * #1072 — REQUIRED, and deliberately not optional: the lookup is scoped to
   * this project so a member of project A cannot approve project B's draft by
   * supplying its bare id.
   *
   * Pass the path project for the REST route (`/projects/:projectId/...`).
   * Pass `null` ONLY where the caller has already resolved the draft's own
   * project and authorized the actor against it — the Slack and Teams ChatOps
   * approve actions do exactly that (`authorizeDraftAccess`), and have no path
   * project to scope by. Making the field required forces every new call site
   * to make that choice explicitly.
   */
  projectId: string | null;
}): Promise<SharedIssueDraft> {
  const draft = await prisma.issueDraft.findFirst({
    where: { id: opts.draftId, ...(opts.projectId ? { projectId: opts.projectId } : {}) },
  });
  // Out-of-project, soft-deleted and nonexistent all produce the SAME 404.
  if (!draft || draft.deletedAt) {
    throw new PublishError(404, "DRAFT_NOT_FOUND", "draft not found");
  }
  if (draft.status === "published") {
    return toDraftApi(draft);
  }
  // #619 — approval gate on the single-draft approval step. Covers the REST
  // route as well as the Slack / Teams approve actions, which call this
  // service directly. Fail-closed.
  await assertDraftsPublishable({
    projectId: draft.projectId,
    drafts: [draft],
    context: "publish.draft.approve",
    actorId: opts.actorId,
  });
  const updated = await prisma.issueDraft.update({
    where: { id: opts.draftId },
    data: { status: "approved" },
  });
  audit({
    actor: { id: opts.actorId },
    action: "publish.draft.approve",
    target: { type: "issue_draft", id: opts.draftId },
    metadata: { projectId: draft.projectId },
  });
  return toDraftApi(updated);
}

export async function generateDrafts(opts: {
  projectId: string;
  analysisId: string;
  targetOwner: string;
  targetRepo: string;
  defaultLabels?: string[];
  actorId: string;
}): Promise<{ summary: ReturnType<typeof toGenerateSummary> }> {
  const summary = await generateDraftsImpl({
    projectId: opts.projectId,
    analysisId: opts.analysisId,
    targetOwner: opts.targetOwner,
    targetRepo: opts.targetRepo,
    defaultLabels: opts.defaultLabels,
  });
  audit({
    actor: { id: opts.actorId },
    action: "publish.drafts.generate",
    target: { type: "analysis", id: opts.analysisId },
    metadata: {
      projectId: opts.projectId,
      target: `${opts.targetOwner}/${opts.targetRepo}`,
      ...summary,
    },
  });
  return { summary: toGenerateSummary(summary) };
}

function toGenerateSummary(s: {
  total: number;
  epics: number;
  features: number;
  upserted: number;
  refreshed: number;
}) {
  return s;
}

// ---- Mappers ---------------------------------------------------------------

type DbBatch = NonNullable<Awaited<ReturnType<typeof prisma.publishBatch.findUnique>>>;
type DbPublishedIssue = NonNullable<Awaited<ReturnType<typeof prisma.publishedIssue.findUnique>>>;
type DbDraft = NonNullable<Awaited<ReturnType<typeof prisma.issueDraft.findUnique>>>;

function toBatchApi(row: DbBatch): SharedPublishBatch {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as SharedPublishBatch["status"],
    targetOwner: row.targetOwner,
    targetRepo: row.targetRepo,
    targetBaseUrl: row.targetBaseUrl,
    provider: row.provider as SharedPublishBatch["provider"],
    dryRun: row.dryRun,
    totalDrafts: row.totalDrafts,
    publishedCount: row.publishedCount,
    failedCount: row.failedCount,
    dedupSkipped: row.dedupSkipped,
    archived: row.archived,
    archivedAt: row.archivedAt,
    archiveReason: row.archiveReason,
    archivedById: row.archivedById,
    dryRunPlan: row.dryRunPlan,
    startedById: row.startedById,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    errorMessage: row.errorMessage,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPublishedIssueApi(row: DbPublishedIssue): SharedPublishedIssue {
  return {
    id: row.id,
    batchId: row.batchId,
    draftId: row.draftId,
    issueNumber: row.issueNumber,
    issueId: row.issueId,
    htmlUrl: row.htmlUrl,
    status: row.status as SharedPublishedIssue["status"],
    destination: (row.destination ?? "github") as SharedPublishedIssue["destination"],
    parentIssueNumber: row.parentIssueNumber,
    dedupHash: row.dedupHash,
    bodyHash: row.bodyHash,
    errorMessage: row.errorMessage,
    publishedAt: row.publishedAt,
  };
}

function toDraftApi(row: DbDraft): SharedIssueDraft {
  return {
    id: row.id,
    projectId: row.projectId,
    requirementId: row.requirementId,
    parentDraftId: row.parentDraftId,
    draftType: row.draftType as SharedIssueDraft["draftType"],
    title: row.title,
    body: row.body,
    labels: row.labels,
    assignees: row.assignees,
    storyPoints: row.storyPoints,
    status: row.status as SharedIssueDraft["status"],
    dedupHash: row.dedupHash,
    metadata: row.metadata,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
