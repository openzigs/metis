/**
 * #480 — a vault reference is bound to the secret it resolved to when saved.
 *
 * #344/#358 check a `${vault:x}` reference when a resource is written, but the
 * resolvers used to look the label up again every time the secret was used.
 * One case slipped through #358's "refuse an ambiguous label" rule: a resource
 * bound to the caller's `global:x`; that secret is soft-deleted, someone else
 * creates `project:x`, and the label now resolves — uniquely — to the new
 * secret, which is then sent to a destination the caller chose.
 *
 * So every binding stores the id the reference resolved to at write time (DB
 * and repo connector `secretId`, `MCPServer.secretBindings`, a publish batch's
 * `metadata.secretId`), and the use path reads that id and nothing else
 * (`readBoundSecret` in `connectors/vault-resolver.ts`, `expandVaultRefs` with
 * bindings). When the id no longer names a live secret the resource refuses to
 * use it rather than re-resolving the label.
 *
 * Resolution here uses the same reachability rule as the ownership check
 * (`reaches` in `secret-binding.ts`), so the id bound is always one of the rows
 * the check approved: an id match wins, otherwise the reference must reach
 * exactly one live secret by label.
 */
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { candidateFilters, reaches } from "./secret-binding.js";

export const VAULT_REF_UNRESOLVED = "VAULT_REF_UNRESOLVED";
export const VAULT_REF_AMBIGUOUS = "VAULT_REF_AMBIGUOUS";

/** Reference body → the secret id it is bound to. */
export type SecretBindings = Record<string, string>;

/**
 * Bind every reference body to one live secret id, in one read.
 *
 * `kept` carries the bindings a resource already holds: a reference that is
 * still present keeps the id it was bound to, even if that secret has since
 * been deleted — re-resolving it here is exactly the re-bind #480 closes. To
 * point a resource at a different secret, the reference text must change.
 *
 * @throws AppError 400 VAULT_REF_UNRESOLVED when a reference reaches no live secret.
 * @throws AppError 409 VAULT_REF_AMBIGUOUS when a label reaches more than one.
 */
export async function bindSecretRefs(
  refs: string[],
  kept: SecretBindings | null = null,
): Promise<SecretBindings> {
  // Vault labels may be `constructor`, `toString` or `__proto__`: a plain `{}`
  // would read those from Object.prototype (a "kept" binding that is a
  // function) or drop an `__proto__` key on write. A null-prototype object and
  // an own-property check make every label an ordinary key (PR #499 review).
  const out: SecretBindings = Object.create(null) as SecretBindings;
  const unbound: string[] = [];
  for (const ref of new Set(refs)) {
    const keptId = kept && Object.hasOwn(kept, ref) ? kept[ref] : undefined;
    if (typeof keptId === "string" && keptId.length > 0) out[ref] = keptId;
    else unbound.push(ref);
  }
  if (unbound.length === 0) return out;

  const rows = await prisma.secret.findMany({
    where: { deletedAt: null, OR: unbound.flatMap(candidateFilters) },
    select: { id: true, name: true },
  });
  for (const ref of unbound) {
    const byId = rows.find((r) => r.id === ref);
    if (byId) {
      out[ref] = byId.id;
      continue;
    }
    const matches = rows.filter((r) => reaches(ref, r));
    if (matches.length > 1) {
      throw new AppError(
        409,
        VAULT_REF_AMBIGUOUS,
        `vault reference \${vault:${ref}} matches more than one secret; qualify it as ` +
          "global:<label> or project:<label>, or use the secret id",
      );
    }
    if (matches.length === 0) {
      throw new AppError(
        400,
        VAULT_REF_UNRESOLVED,
        `vault reference \${vault:${ref}} does not name a vault secret`,
      );
    }
    out[ref] = matches[0].id;
  }
  return out;
}

/** The single-reference form of {@link bindSecretRefs}. */
export async function bindSecretRef(ref: string): Promise<string> {
  const bound = await bindSecretRefs([ref]);
  return bound[ref];
}

/**
 * Parse a stored bindings column. `null` means the row predates #480 (never
 * bound); a value that is present but malformed reads as "binds nothing", so a
 * corrupt column fails closed instead of falling back to label resolution.
 */
export function parseSecretBindings(raw: string | null | undefined): SecretBindings | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: SecretBindings = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}
