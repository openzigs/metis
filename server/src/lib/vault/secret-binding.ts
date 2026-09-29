/**
 * #344 — a vault secret used BY REFERENCE is bound to its destination.
 *
 * #324 made the plaintext admin-only (`vault.reveal`) on the premise that
 * using a secret by reference is safe because the caller never sees the value.
 * That premise fails wherever the caller also chooses where the secret is sent:
 * a coordinator (`connector.write`, `mcp.manage`) could attach any listed secret
 * id to a DB connector, repo connector or MCP server and point it at a host or
 * command they control, receiving the plaintext over the wire.
 *
 * The binding model, for a caller WITHOUT `vault.reveal`:
 *
 *   1. They may attach a secret only if they CREATED it (`Secret.createdById`).
 *      They supplied its plaintext, so sending it anywhere discloses nothing
 *      they did not already hold. Secrets auto-vaulted from their own input
 *      (MCP env/headers, a provisioned password they typed) are theirs.
 *   2. A secret already bound to a resource stays usable there, but only at the
 *      destination it was bound to: a write that changes the resource's
 *      destination (host, port, driver options, base URL, command, env, …)
 *      must leave it bound only to secrets the caller created — i.e. clear or
 *      replace every foreign one in the same write.
 *
 * Admins (`vault.reveal`) can read the plaintext anyway, so the rule does not
 * apply to them. An unknown reference is refused exactly like a foreign one,
 * so the check is not an existence oracle for secret ids or labels.
 *
 * A reference resolves by id first and then by label (`vault-resolver.ts`,
 * `env-manager.ts`) while the repo service resolves by name; the check takes
 * the UNION of every row a reference could reach and requires all of them to be
 * the caller's, so no resolver can pick a row the check did not approve.
 */
import { hasPermission, type AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { AppError } from "../../middleware/error-handler.js";

export const SECRET_BINDING_FORBIDDEN = "SECRET_BINDING_FORBIDDEN";

const WHOLE_REF = /^\$\{vault:([^}]+)\}$/;
const EMBEDDED_REF = /\$\{vault:([^}]+)\}/g;

/** The body of a whole-value `${vault:x}` reference, or null (empty / not a ref). */
export function refBodyOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = WHOLE_REF.exec(ref);
  const body = m?.[1]?.trim();
  return body ? body : null;
}

/** Every `${vault:x}` body embedded in the values of a string map (MCP env / headers). */
export function refBodiesIn(record: Record<string, unknown> | null | undefined): string[] {
  if (!record) return [];
  const out: string[] = [];
  for (const v of Object.values(record)) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(EMBEDDED_REF)) {
      const body = m[1]?.trim();
      if (body) out.push(body);
    }
  }
  return out;
}

interface SecretOwner {
  id: string;
  createdById: string | null;
}

function labelOf(name: string): string {
  return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
}

function scopeOf(name: string): "global" | "project" {
  return name.startsWith("project:") ? "project" : "global";
}

/** Every live secret a reference body could resolve to, by id or by label. */
async function secretsReachableBy(ref: string): Promise<SecretOwner[]> {
  const rows = await prisma.secret.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, createdById: true },
  });
  return rows
    .filter((r) => {
      const label = labelOf(r.name);
      return (
        r.id === ref || r.name === ref || label === ref || `${scopeOf(r.name)}:${label}` === ref
      );
    })
    .map(({ id, createdById }) => ({ id, createdById }));
}

export interface SecretBindingChange {
  /** Reference bodies the resource holds before the write (empty on create). */
  before: string[];
  /** Reference bodies the resource will hold after the write. */
  after: string[];
  /** True when the write changes where the secret is sent (always true on create). */
  destinationChanged: boolean;
}

export interface SecretBindingContext {
  /** Audit target for a refusal, e.g. `{ type: "db_connector", id }`. */
  target: { type: string; id: string };
  metadata?: Record<string, unknown>;
}

/**
 * @throws AppError 403 SECRET_BINDING_FORBIDDEN when a caller without
 *   `vault.reveal` would attach a secret they did not create, or move a
 *   resource holding one to a new destination. The refusal is audited.
 */
export async function assertSecretBindingAllowed(
  user: Pick<AuthPayload, "userId" | "role">,
  change: SecretBindingChange,
  ctx: SecretBindingContext,
): Promise<void> {
  if (hasPermission(user.role, "vault.reveal")) return;
  const after = [...new Set(change.after)];
  if (after.length === 0) return;

  const boundIds = new Set<string>();
  for (const ref of new Set(change.before)) {
    for (const s of await secretsReachableBy(ref)) boundIds.add(s.id);
  }

  for (const ref of after) {
    const reachable = await secretsReachableBy(ref);
    const alreadyBound = reachable.length > 0 && reachable.every((s) => boundIds.has(s.id));
    if (alreadyBound && !change.destinationChanged) continue;
    const owned = reachable.length > 0 && reachable.every((s) => s.createdById === user.userId);
    if (owned) continue;
    audit({
      actor: { id: user.userId },
      action: "vault.binding_refused",
      target: ctx.target,
      metadata: {
        ...(ctx.metadata ?? {}),
        reason: alreadyBound ? "destination_changed" : "secret_not_owned",
      },
    });
    throw new AppError(
      403,
      SECRET_BINDING_FORBIDDEN,
      alreadyBound
        ? "This connection uses a vault secret you did not create, so its destination " +
            "cannot be changed unless the secret is cleared or replaced. Ask an admin."
        : "You can only attach vault secrets you created. Ask an admin to bind this secret.",
    );
  }
}
