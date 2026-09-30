/**
 * #481 — retire the secret a non-owner's credential write replaced.
 *
 * Since #358, `rotateOrCreate` never rewrites another principal's secret: a
 * coordinator who re-enters someone else's Jira or test-management credentials
 * gets a FRESH secret, and the connection is repointed at it. The previous
 * secret — the other user's plaintext — then stayed live in the vault with
 * nothing referencing it. {@link retireReplacedSecret} soft-deletes it once the
 * connection row has been updated, but only when no stored reference could
 * still resolve to it.
 *
 * "Could still resolve" is judged by every column a caller can point at an
 * EXISTING secret of their choosing: repo / DB connector `secretId`, MCP server
 * env / headers / env-secret pointer, a publish batch's `secretRef`, a chat
 * session's BYOK `providerSecretRef` (#305), a scheduled job's payload (the
 * http-webhook `authHeader`, resolved with `vault.read`) and the copy held by
 * any http-webhook Task that can still run (#495, bounded by the retry window
 * in #574), and the Jira and
 * test-management connections themselves. Stores that only ever hold
 * a secret they created under their own system label (Slack, Teams, PagerDuty,
 * import sources, suggested-connector passwords) cannot name a connector's
 * secret and are not consulted.
 *
 * A reference names a secret by id or by (scoped) label (`secret-binding.ts`),
 * so the text columns are matched on the id and on the bare label by
 * substring. Both are high-entropy (a cuid; a label ending in a ulid), and an
 * over-broad match only ever keeps a secret alive — never deletes a live one.
 * Soft-deleted referencing rows count too, for the same reason.
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { CONCURRENT_UPDATE } from "../connectors/types.js";
import { createChildLogger } from "../logger.js";
import {
  LIVE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  retryWindowCutoff,
  VAULT_REFERENCING_TASK_TYPE,
} from "../scheduler/task-retry-window.js";
import type { VaultService } from "./vault-service.js";

const log = createChildLogger("secret-retirement");

/** The bare label of a stored secret name (`project:x` → `x`). */
function labelOf(name: string): string {
  return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
}

/** Does any stored reference still name secret `id` (by id or by label)? */
export async function isSecretReferenced(id: string, name: string): Promise<boolean> {
  const needles = [...new Set([id, labelOf(name)])];
  const containsAny = (field: string) => needles.map((n) => ({ [field]: { contains: n } }));
  const cutoff = retryWindowCutoff();
  const counts = await Promise.all([
    prisma.repoConnection.count({ where: { secretId: id } }),
    prisma.databaseConnection.count({ where: { secretId: id } }),
    prisma.jiraConnection.count({ where: { OR: [{ secretId: id }, { tlsCaSecretId: id }] } }),
    prisma.testManagementConnection.count({
      where: { OR: [...containsAny("authConfigJson"), ...containsAny("tlsConfigJson")] },
    }),
    prisma.mCPServer.count({
      where: {
        OR: [
          { envSecretId: id },
          ...containsAny("envJson"),
          ...containsAny("headers"),
          ...containsAny("envSecretRefs"),
        ],
      },
    }),
    prisma.publishBatch.count({ where: { OR: containsAny("metadata") } }),
    prisma.aISession.count({ where: { OR: containsAny("providerSecretRef") } }),
    prisma.scheduledJob.count({ where: { OR: containsAny("payload") } }),
    // #495 — a Task holds its own copy of the job payload, which a retry
    // re-runs (automatic retries go back to `pending`; POST /tasks/:id/retry
    // re-enqueues a failed or cancelled one). #574 — only a Task that can
    // still run counts: a live one, or a failed/cancelled one inside the retry
    // window. Only `http-webhook` resolves a vault reference from its payload,
    // and `type` + `status IN (...)` lets the `[type, status]` index pick the
    // rows instead of scanning every Task's payload.
    prisma.task.count({
      where: {
        type: VAULT_REFERENCING_TASK_TYPE,
        status: { in: [...LIVE_TASK_STATUSES, ...RETRYABLE_TASK_STATUSES] },
        AND: [
          { OR: containsAny("payload") },
          {
            OR: [
              { status: { in: [...LIVE_TASK_STATUSES] } },
              // Measured from when the Task ended, not its last write (#574).
              { completedAt: { gte: cutoff } },
              { completedAt: null, updatedAt: { gte: cutoff } },
            ],
          },
        ],
      },
    }),
  ]);
  return counts.some((n) => n > 0);
}

export interface RetireContext {
  actorId: string;
  /** The resource whose update replaced the secret, e.g. `{ type: "jira_connection", id }`. */
  target: { type: string; id: string };
  projectId: string;
}

/**
 * Soft-delete `secretId` if it is still live and nothing references it.
 * Call AFTER the resource row has been repointed at the replacement secret.
 * Returns true when the secret was retired.
 *
 * Failure here never fails the caller's update, which has already committed:
 * the worst outcome is the pre-#481 state (the old secret stays live), which is
 * logged so it can be cleaned up from the vault page.
 */
export async function retireReplacedSecret(
  vault: Pick<VaultService, "delete">,
  secretId: string,
  ctx: RetireContext,
): Promise<boolean> {
  try {
    const row = await prisma.secret.findFirst({
      where: { id: secretId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!row) return false;
    if (await isSecretReferenced(row.id, row.name)) return false;
    await vault.delete(row.id);
    audit({
      actor: { id: ctx.actorId },
      action: "vault.secret_retired",
      target: ctx.target,
      metadata: { projectId: ctx.projectId, secretId: row.id, reason: "replaced_by_non_owner" },
    });
    return true;
  } catch (err) {
    log.warn("Could not retire a replaced secret; it stays live", {
      secretId,
      target: ctx.target,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface WithdrawContext {
  actorId: string;
  /**
   * The resource whose write created the secrets, e.g. `{ type: "jira_connection", id }`.
   * No `id` on a create that never produced a row (#574).
   */
  resource: { type: string; id?: string };
  projectId?: string | null;
  /** The error that stopped the update from landing. */
  cause: unknown;
}

/**
 * #495 — soft-delete the secrets an update (or, since #574, a create) created
 * when that write did not land, and record each withdrawal as `vault.delete`
 * against the secret — the counterpart of the `vault.write` its creation emitted. Call ONLY when the
 * row was not written: a committed row names these secrets.
 *
 * Never throws: the caller is already on its error path and rethrows its own
 * error. A secret that cannot be withdrawn is logged and stays live.
 */
export async function withdrawCreatedSecrets(
  vault: Pick<VaultService, "delete">,
  secretIds: readonly string[],
  ctx: WithdrawContext,
): Promise<void> {
  const code = (ctx.cause as { code?: unknown } | null)?.code;
  // #574 — a create that never produced a row has no resource id; its
  // withdrawals are recorded as a create, not an update, that did not land.
  const write = ctx.resource.id ? "update" : "create";
  const reason = code === CONCURRENT_UPDATE ? "concurrent_update" : `${write}_failed`;
  for (const secretId of secretIds) {
    try {
      await vault.delete(secretId);
      audit({
        actor: { id: ctx.actorId },
        action: "vault.delete",
        target: { type: "secret", id: secretId },
        metadata: {
          source: `${write}_not_applied`,
          reason,
          resourceType: ctx.resource.type,
          ...(ctx.resource.id ? { resourceId: ctx.resource.id } : {}),
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        },
      });
    } catch (err) {
      log.warn(`Could not withdraw a secret created by a ${write} that did not land`, {
        secretId,
        resource: ctx.resource,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
