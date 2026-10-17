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
 * Write time — `assertWebhookSecretBinding`, run by `SchedulerService.createJob`
 * and `updateJob` after the project-access check: a caller without
 * `vault.reveal` may name only a secret they created, and may not move a job
 * that names someone else's secret to another URL, project or task type. An
 * unknown reference and a foreign one are refused identically (403
 * SECRET_BINDING_FORBIDDEN, audited as `vault.binding_refused`).
 *
 * Fire time — `authorizeWebhookSecretRef`, run by the webhook handler before it
 * reads the vault: the job's creator, at their CURRENT role, must still reach
 * the job's project and must still be allowed the secret under the same rule.
 * So a job saved before this check, or whose owner has since been demoted or
 * removed from the workspace, sends nothing. The handler reads the secret by
 * the id approved here, never by label again.
 */
import { hasPermission, type AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { resolveDurableRole } from "../auth/durable-roles.js";
import {
  assertSecretBindingAllowed,
  reaches,
  readCandidateSecrets,
  refBodyOf,
} from "../vault/secret-binding.js";
import { actorHasProjectAccess } from "./project-access.js";
import type { TaskRecord } from "./types.js";

export const WEBHOOK_TASK_TYPE = "http-webhook";

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

/** The parts of a job that decide which secret it sends, and where. */
export interface WebhookJobShape {
  taskType: string;
  payload: Record<string, unknown> | null | undefined;
  projectId: string | null;
}

/** The `${vault:x}` body a job's `authHeader` names, as a list (empty when none). */
export function webhookSecretRefs(job: WebhookJobShape): string[] {
  if (job.taskType !== WEBHOOK_TASK_TYPE) return [];
  const header = job.payload?.authHeader;
  const body = typeof header === "string" ? refBodyOf(header) : null;
  return body ? [body] : [];
}

function urlOf(job: WebhookJobShape): string {
  const url = job.payload?.url;
  return typeof url === "string" ? url.trim() : "";
}

/**
 * Does `after` send the header somewhere `before` did not? A task-type change
 * needs no term here: only an `http-webhook` job names a secret, so it either
 * leaves `after` with no reference or makes every reference in `after` new.
 */
export function webhookDestinationChanged(
  before: WebhookJobShape,
  after: WebhookJobShape,
): boolean {
  return before.projectId !== after.projectId || urlOf(before) !== urlOf(after);
}

/**
 * The #344 check for a job write. `before === null` is a create.
 *
 * @returns the #552 binding-write window end (`null` when nothing was stamped),
 *   for `assertBindingWriteWindowOpen` immediately before the write.
 * @throws AppError 403 SECRET_BINDING_FORBIDDEN (audited) — see the module comment.
 */
export async function assertWebhookSecretBinding(
  user: Pick<AuthPayload, "userId" | "role">,
  before: WebhookJobShape | null,
  after: WebhookJobShape,
  target: { id: string; projectId: string | null },
): Promise<Date | null> {
  return assertSecretBindingAllowed(
    user,
    {
      before: before ? webhookSecretRefs(before) : [],
      after: webhookSecretRefs(after),
      destinationChanged: before === null || webhookDestinationChanged(before, after),
    },
    {
      target: { type: "scheduled-job", id: target.id },
      metadata: { projectId: target.projectId },
    },
  );
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

/**
 * Fire-time re-check of a webhook task's vault reference against the job it
 * belongs to. Returns the id of the ONE live secret the reference may send.
 *
 * @throws WebhookSecretRefusedError — no job, no owner, the owner no longer
 *   reaches the job's project, the reference names no live secret or more than
 *   one, or the owner may not use it. Audited as `scheduler.webhook.secret_refused`.
 */
export async function authorizeWebhookSecretRef(ref: string, task: TaskRecord): Promise<string> {
  if (!task.scheduledJobId) refuse(task, null, "no-job");
  const job = await prisma.scheduledJob.findUnique({
    where: { id: task.scheduledJobId },
    select: { id: true, projectId: true, createdById: true, deletedAt: true },
  });
  if (!job || job.deletedAt) refuse(task, task.scheduledJobId, "no-job");
  if (!job.createdById) refuse(task, job.id, "no-owner");

  const owner = job.createdById;
  const role = await resolveDurableRole(owner);
  const reachesProject = await actorHasProjectAccess({ id: owner, role }, job.projectId, {
    resource: "scheduled-job",
    resourceId: job.id,
    action: "scheduler.webhook.secret",
  });
  if (!reachesProject) refuse(task, job.id, "project-access");

  const reachable = (await readCandidateSecrets([ref])).filter((row) => reaches(ref, row));
  const target = reachable.find((row) => row.id === ref) ?? reachable[0];
  if (!target || (reachable.length > 1 && target.id !== ref)) {
    refuse(task, job.id, "unresolved");
  }
  // #344 rule 1, on the owner's current role: every row the reference could
  // reach must be theirs unless they hold `vault.reveal`.
  if (
    !hasPermission(role, "vault.reveal") &&
    !reachable.every((row) => row.createdById === owner)
  ) {
    refuse(task, job.id, "secret-not-owned");
  }
  return target.id;
}
