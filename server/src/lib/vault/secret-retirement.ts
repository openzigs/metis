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
 * http-webhook `authHeader`, resolved with `vault.read`), and the Jira and
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
import { createChildLogger } from "../logger.js";
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
