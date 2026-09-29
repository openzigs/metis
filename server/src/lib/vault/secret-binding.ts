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
 *      This holds only while `createdById` names whoever supplied the CURRENT
 *      plaintext, so `rotateOrCreate` rewrites a secret in place only for its
 *      owner (`VaultService.rotate`'s `onlyIfCreatedBy`); credential discovery
 *      (a system writer) never rotates a user's secret (PR #359 review).
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
 * Because the check runs at write time, a secret created LATER under a
 * colliding label could otherwise win at resolution time; both resolvers
 * therefore refuse a label that matches more than one live secret (#358).
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

/** Does a reference body resolve to this row, by id or by (scoped) label? */
function reaches(ref: string, row: { id: string; name: string }): boolean {
  const label = labelOf(row.name);
  return (
    row.id === ref || row.name === ref || label === ref || `${scopeOf(row.name)}:${label}` === ref
  );
}

/**
 * Row filters that together select a SUPERSET of the rows `reaches(ref, row)`
 * accepts, so the table is read for the referenced ids and labels only (#358)
 * rather than in full. A row named `<anything>:<label>` reaches `label`, and
 * `global:<label>` also reaches a bare-named row `label` (its scope defaults to
 * global), so both suffix and bare-name candidates are included; `reaches`
 * then refines in memory. An over-broad filter costs rows, never correctness.
 */
function candidateFilters(ref: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    { id: ref },
    { name: ref },
    { name: { endsWith: `:${ref}` } },
  ];
  const scoped = /^(global|project):(.+)$/.exec(ref);
  if (scoped) {
    const label = scoped[2];
    out.push({ name: label }, { name: { endsWith: `:${label}` } });
  }
  return out;
}

/**
 * Every live secret each reference body could resolve to, by id or by label —
 * one read of the secret table per write, however many references it names,
 * filtered to the rows those references could name.
 */
async function secretsReachableBy(refs: string[]): Promise<Map<string, SecretOwner[]>> {
  const out = new Map<string, SecretOwner[]>();
  if (refs.length === 0) return out;
  const rows = await prisma.secret.findMany({
    where: { deletedAt: null, OR: refs.flatMap(candidateFilters) },
    select: { id: true, name: true, createdById: true },
  });
  for (const ref of refs) {
    out.set(
      ref,
      rows.filter((r) => reaches(ref, r)).map(({ id, createdById }) => ({ id, createdById })),
    );
  }
  return out;
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

  const before = [...new Set(change.before)];
  const reachableBy = await secretsReachableBy([...new Set([...before, ...after])]);
  const boundIds = new Set<string>();
  for (const ref of before) {
    for (const s of reachableBy.get(ref) ?? []) boundIds.add(s.id);
  }

  const keptRefs = new Set(before);
  for (const ref of after) {
    // A reference the resource already holds, kept verbatim, while nothing moves:
    // nothing is attached and nothing is sent anywhere new. This also covers a
    // reference to a since-deleted secret, which reaches no live row and would
    // otherwise read as a foreign attach (PR #359 panel).
    if (!change.destinationChanged && keptRefs.has(ref)) continue;
    const reachable = reachableBy.get(ref) ?? [];
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
