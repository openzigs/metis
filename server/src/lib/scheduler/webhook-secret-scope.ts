/**
 * #1235 — which vault secret a scheduled `http-webhook` job may send.
 *
 * A webhook job's `payload.authHeader` may be a `${vault:x}` reference, and the
 * handler sends the plaintext it resolves to as the `Authorization` header to
 * the job's URL. The URL is the caller's choice, so naming a secret there is
 * exactly the "use by reference, at a destination I chose" case #344 closed for
 * connectors, MCP servers and the publishing paths. This module applies that
 * SAME rule (`lib/vault/secret-binding.ts`) to the scheduler; it does not
 * introduce a second scope concept.
 *
 * Why the #344 ownership rule and not "the secret belongs to the job's
 * project": a `Secret` row has no project or workspace column, and its
 * `global:` / `project:` name prefix is a display tag bound to no project
 * (`lib/vault/secret-access.ts`). The `ws:<workspaceId>:` label helpers in
 * `lib/vault/workspace-vault.ts` are not written by any code path, so no live
 * secret carries one. The one ownership concept the vault enforces is
 * `Secret.createdById`, judged by #344.
 *
 * A job's BINDING is what decides which secret goes where: its task type, URL,
 * project and `authHeader` reference. A write that changes any of them is a
 * binding write, and the principal who made it is a BINDER.
 *
 * Write time — `assertWebhookSecretBinding`, run by `SchedulerService.createJob`
 * and `updateJob` after the project-access check. A binding write judges the
 * caller against the whole resulting binding: without `vault.reveal` they may
 * name only a secret they created, and the reference must resolve to exactly
 * one live secret, as it must when the job fires. A write that moves nothing
 * (rename, pause, a body edit) judges nothing. Every refusal is the same 403
 * SECRET_BINDING_FORBIDDEN body, audited as `vault.binding_refused`. The
 * judged caller is stored on the job (`webhookBinderId`, `webhookBoundAt`) in
 * the same UPDATE as the binding, so a lost audit row cannot change who is
 * judged later.
 *
 * Fire time — `resolveWebhookSecret`, run by the webhook handler. First, the
 * task must carry the job's CURRENT binding: a task is a snapshot of the job
 * taken when it was enqueued, and a retry or a later attempt replays it, so a
 * task enqueued before a rebind is refused (`binding_stale`) rather than sent
 * to the URL the rebind replaced. Then it judges every principal that binding
 * rests on: the stored binder; or, for a job never bound since #1235
 * (`bindersOf`), its author plus everyone its audit trail shows may have
 * bound it, since no write was judged. Each of them, at their CURRENT role,
 * must be an active user, reach the job's project, and be allowed the secret
 * under the #344 rule. So a job created or tampered with before this check, or
 * whose binder has since been demoted, deprovisioned or removed from the
 * workspace, sends nothing. The plaintext is decrypted from the same row whose
 * owner was judged, re-read by id, and every failure maps to one fixed
 * message, so the task row never names a secret.
 */
import { hasPermission, type AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { AppError } from "../../middleware/error-handler.js";
import { resolveDurableRole } from "../auth/durable-roles.js";
import { getVaultService } from "../vault/vault-service.js";
import {
  SECRET_BINDING_FORBIDDEN,
  assertSecretBindingAllowed,
  reaches,
  readCandidateSecrets,
  refBodyOf,
  type CandidateSecret,
} from "../vault/secret-binding.js";
import { actorHasProjectAccess } from "./project-access.js";
import { VAULT_REFERENCING_TASK_TYPE } from "./task-retry-window.js";
import type { TaskRecord } from "./types.js";

/**
 * The error a refused fire-time resolution records on the task. Fixed text: it
 * names no label, id, owner or value, so a task row cannot be used to learn
 * which secrets exist.
 */
export const WEBHOOK_SECRET_REFUSED_MESSAGE =
  "webhook authHeader names a vault secret this job may not use; no request was sent";

export class WebhookSecretRefusedError extends Error {
  constructor() {
    super(WEBHOOK_SECRET_REFUSED_MESSAGE);
    this.name = "WebhookSecretRefusedError";
  }
}

/** The audit action of a `SchedulerService.updateJob` write. */
export const JOB_UPDATE_ACTION = "scheduled-job.update";

/**
 * The fields an update named before #1235 that could have changed the binding.
 * Such a row carries only `changes: Object.keys(opts)`, so `payload` cannot be
 * told apart from a body-only edit and counts as a binding write.
 */
const LEGACY_BINDING_FIELDS = new Set(["payload", "projectId", "taskType"]);

/** The parts of a job that decide which secret it sends, and where. */
export interface WebhookJobShape {
  taskType: string;
  payload: Record<string, unknown> | null | undefined;
  projectId: string | null;
}

/** The `${vault:x}` body a job's `authHeader` names, as a list (empty when none). */
export function webhookSecretRefs(job: WebhookJobShape): string[] {
  if (job.taskType !== VAULT_REFERENCING_TASK_TYPE) return [];
  const header = job.payload?.authHeader;
  const body = typeof header === "string" ? refBodyOf(header) : null;
  return body ? [body] : [];
}

function urlOf(job: WebhookJobShape): string {
  const url = job.payload?.url;
  return typeof url === "string" ? url.trim() : "";
}

/** Does `after` send the header somewhere `before` did not? */
export function webhookDestinationChanged(
  before: WebhookJobShape,
  after: WebhookJobShape,
): boolean {
  return before.projectId !== after.projectId || urlOf(before) !== urlOf(after);
}

/**
 * Is this write a binding write: does it change which secret the job sends, or
 * where? `before === null` is a create.
 */
export function webhookBindingChanged(
  before: WebhookJobShape | null,
  after: WebhookJobShape,
): boolean {
  if (before === null) return true;
  return (
    before.taskType !== after.taskType ||
    webhookDestinationChanged(before, after) ||
    webhookSecretRefs(before).join("\n") !== webhookSecretRefs(after).join("\n")
  );
}

/**
 * The ONE live secret `ref` sends, as the handler would resolve it: the row
 * with that id, else the only row the label reaches. Null when it reaches none,
 * or several by label (#358).
 */
function resolvedTarget(ref: string, reachable: CandidateSecret[]): CandidateSecret | null {
  const byId = reachable.find((row) => row.id === ref);
  if (byId) return byId;
  return reachable.length === 1 ? reachable[0] : null;
}

/** Live rows the reference body reaches. */
async function reachableBy(ref: string): Promise<CandidateSecret[]> {
  return (await readCandidateSecrets([ref])).filter((row) => reaches(ref, row));
}

export interface WebhookBindingVerdict {
  /** The #552 window end, for `assertBindingWriteWindowOpen` before the write. */
  until: Date | null;
  /** True when the write is a binding write, recorded on the update's audit row. */
  bindingChanged: boolean;
}

/**
 * The #344 check for a job write. `before === null` is a create.
 *
 * A binding write judges the caller against every reference the job will hold
 * (`destinationChanged: true`), so the caller is a binder whose authority the
 * fire-time check may rely on. A reference that resolves to no live secret, or
 * to several by label, is refused here too, so a job is not saved only to fail
 * on every run.
 *
 * @throws AppError 403 SECRET_BINDING_FORBIDDEN (audited) — see the module comment.
 */
export async function assertWebhookSecretBinding(
  user: Pick<AuthPayload, "userId" | "role">,
  before: WebhookJobShape | null,
  after: WebhookJobShape,
  target: { id: string; projectId: string | null },
): Promise<WebhookBindingVerdict> {
  const bindingChanged = webhookBindingChanged(before, after);
  if (!bindingChanged) return { until: null, bindingChanged };
  const refs = webhookSecretRefs(after);
  const auditTarget = { type: "scheduled-job", id: target.id };
  const until = await assertSecretBindingAllowed(
    user,
    { before: before ? webhookSecretRefs(before) : [], after: refs, destinationChanged: true },
    { target: auditTarget, metadata: { projectId: target.projectId } },
  );
  for (const ref of refs) {
    if (resolvedTarget(ref, await reachableBy(ref))) continue;
    audit({
      actor: { id: user.userId },
      action: "vault.binding_refused",
      target: auditTarget,
      metadata: { projectId: target.projectId, reason: "unresolved_reference" },
    });
    // The body every #344 attach refusal answers, so this is no oracle either.
    throw new AppError(
      403,
      SECRET_BINDING_FORBIDDEN,
      "You can only attach vault secrets you created. Ask an admin to bind this secret.",
    );
  }
  return { until, bindingChanged };
}

function refuse(task: TaskRecord, jobId: string | null, reason: string): never {
  audit({
    action: "scheduler.webhook.secret_refused",
    actor: null,
    target: { type: "scheduled-job", id: jobId ?? task.scheduledJobId ?? task.id },
    metadata: { taskId: task.id, reason },
  });
  throw new WebhookSecretRefusedError();
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/**
 * The principals a job NEVER bound since #1235 rests on (its `webhookBoundAt`
 * is NULL), from its `scheduled-job.update` audit trail: its author plus the
 * actor of every row that may have bound it. Nobody was judged, so the set only
 * ever grows: a pre-#1235 row (no `webhookBinding`) counts when it names a
 * binding field or no field list; a row marking `webhookBinding: true` counts
 * too (it sits beside a NULL `webhookBoundAt` only when a write from a stale
 * read carried the old pair back over it). A null entry is a binder nobody can
 * be judged as, and is refused.
 *
 * The read is bounded by the `[targetType, targetId, action]` index: the
 * per-fire rows sharing the job's target carry other actions.
 *
 * @throws whatever the audit read throws; the caller fails closed on it.
 */
async function bindersOf(jobId: string, author: string | null): Promise<Array<string | null>> {
  const rows = await prisma.auditLog.findMany({
    where: { targetType: "scheduled-job", targetId: jobId, action: JOB_UPDATE_ACTION },
    select: { actorId: true, metadata: true },
  });
  const binders = new Set<string | null>([author]);
  for (const row of rows) {
    const meta = parseJsonObject(row.metadata);
    const changes = meta.changes;
    const mayHaveBound =
      typeof meta.webhookBinding === "boolean"
        ? meta.webhookBinding
        : !Array.isArray(changes) ||
          changes.some((field) => LEGACY_BINDING_FIELDS.has(String(field)));
    if (mayHaveBound) binders.add(row.actorId);
  }
  return [...binders];
}

/** Is this principal still allowed to send `reachable` from the job's project? */
async function judgePrincipal(
  principal: string,
  job: { id: string; projectId: string | null },
  reachable: CandidateSecret[],
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: principal },
    select: { status: true, deletedAt: true },
  });
  // `resolveDurableRole` does not consider deprovisioning: SCIM delete keeps a
  // local or SCIM `admin` row, so a deleted admin would still resolve to admin.
  if (!user || user.deletedAt || user.status !== "active") return "principal_inactive";
  const role = await resolveDurableRole(principal);
  const reachesProject = await actorHasProjectAccess({ id: principal, role }, job.projectId, {
    resource: "scheduled-job",
    resourceId: job.id,
    action: "scheduler.webhook.secret",
  });
  if (!reachesProject) return "project_access";
  // #344 rule 1 on the principal's current role: every row the reference could
  // reach must be theirs unless they hold `vault.reveal`.
  if (
    !hasPermission(role, "vault.reveal") &&
    !reachable.every((r) => r.createdById === principal)
  ) {
    return "secret_not_owned";
  }
  return null;
}

async function authorizeAndRead(ref: string, task: TaskRecord): Promise<string> {
  if (!task.scheduledJobId) refuse(task, null, "no_job");
  const job = await prisma.scheduledJob.findUnique({
    where: { id: task.scheduledJobId },
    select: {
      id: true,
      projectId: true,
      taskType: true,
      payload: true,
      createdById: true,
      webhookBinderId: true,
      webhookBoundAt: true,
      deletedAt: true,
    },
  });
  if (!job || job.deletedAt) refuse(task, task.scheduledJobId, "no_job");

  // The URL and reference sent are the TASK's: a snapshot of the job taken at
  // enqueue, which a retry or a later attempt replays. The principals judged
  // below are those of the JOB's binding, so the two must be one binding, or a
  // task enqueued before a rebind would carry the new binder's standing to the
  // URL that rebind replaced.
  const jobShape = {
    taskType: job.taskType,
    payload: parseJsonObject(job.payload),
    projectId: job.projectId,
  };
  const taskShape = { taskType: task.type, payload: task.payload, projectId: task.projectId };
  if (webhookBindingChanged(jobShape, taskShape)) refuse(task, job.id, "binding_stale");

  let binders: Array<string | null>;
  if (job.webhookBoundAt) {
    binders = [job.webhookBinderId];
  } else {
    try {
      binders = await bindersOf(job.id, job.createdById);
    } catch {
      refuse(task, job.id, "audit_unreadable");
    }
  }

  const reachable = await reachableBy(ref);
  const target = resolvedTarget(ref, reachable);
  if (!target) refuse(task, job.id, "unresolved_reference");

  for (const principal of binders) {
    if (principal === null) refuse(task, job.id, "no_owner");
    const reason = await judgePrincipal(principal, job, reachable);
    if (reason) refuse(task, job.id, reason);
  }

  // Decrypt the row as it is NOW, and only if its owner is still the one judged
  // above. An admin's confirmed "Rotate anyway" moves `createdById` to that
  // admin (#502), so a value supplied by someone not judged is never sent; a
  // secret deleted since reads as no row. Either way: refused, nothing named.
  const row = await prisma.secret.findFirst({
    where: { id: target.id, deletedAt: null },
    select: { createdById: true, ciphertext: true, algorithm: true, keyVersion: true },
  });
  if (!row || row.createdById !== target.createdById) refuse(task, job.id, "secret_changed");
  return getVaultService().decrypt({
    ciphertext: row.ciphertext,
    algorithm: row.algorithm,
    keyVersion: row.keyVersion,
  });
}

/**
 * Fire-time re-check of a webhook task's vault reference against the job it
 * belongs to, then the plaintext of the ONE live secret it may send.
 *
 * @throws WebhookSecretRefusedError — for every failure, including a database
 *   or decryption error, so the task's error never names a secret. Audited as
 *   `scheduler.webhook.secret_refused` with a reason code.
 */
export async function resolveWebhookSecret(ref: string, task: TaskRecord): Promise<string> {
  try {
    return await authorizeAndRead(ref, task);
  } catch (err) {
    if (err instanceof WebhookSecretRefusedError) throw err;
    refuse(task, task.scheduledJobId, "check_failed");
  }
}
