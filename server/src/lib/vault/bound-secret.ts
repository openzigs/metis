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
import { hasPermission, type AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  candidateFilters,
  judgeSecretBinding,
  reaches,
  readCandidateSecrets,
  stampBindingWrite,
  type SecretBindingChange,
  type SecretBindingContext,
} from "./secret-binding.js";

export const VAULT_REF_UNRESOLVED = "VAULT_REF_UNRESOLVED";
export const VAULT_REF_AMBIGUOUS = "VAULT_REF_AMBIGUOUS";
/** #577 — a write reached with a reference its binding check never approved. */
export const SECRET_BINDING_UNCHECKED = "SECRET_BINDING_UNCHECKED";

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
  const unbound = unkeptRefs(refs, kept);
  if (unbound.length === 0) return bindFromRows(refs, kept, []);
  const rows = await prisma.secret.findMany({
    where: { deletedAt: null, OR: unbound.flatMap(candidateFilters) },
    select: { id: true, name: true },
  });
  return bindFromRows(refs, kept, rows);
}

/** The references `kept` does not already bind — the only ones that need a read. */
function unkeptRefs(refs: string[], kept: SecretBindings | null): string[] {
  return [...new Set(refs)].filter((ref) => keptIdOf(kept, ref) === undefined);
}

function keptIdOf(kept: SecretBindings | null, ref: string): string | undefined {
  const id = kept && Object.hasOwn(kept, ref) ? kept[ref] : undefined;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Bind each reference from rows already read: a kept binding wins, then an id
 * match, then exactly one label match. Pure, so a caller that has just judged
 * these rows binds exactly the ids it judged (#577).
 */
function bindFromRows(
  refs: string[],
  kept: SecretBindings | null,
  rows: Array<{ id: string; name: string }>,
): SecretBindings {
  // Vault labels may be `constructor`, `toString` or `__proto__`: a plain `{}`
  // would read those from Object.prototype (a "kept" binding that is a
  // function) or drop an `__proto__` key on write. A null-prototype object and
  // an own-property check make every label an ordinary key (PR #499 review).
  const out: SecretBindings = Object.create(null) as SecretBindings;
  for (const ref of new Set(refs)) {
    const keptId = keptIdOf(kept, ref);
    if (keptId !== undefined) {
      out[ref] = keptId;
      continue;
    }
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

/**
 * #577 — the #344 ownership check and the #480 binding over ONE read of the
 * secret table: the references in `change.after` are resolved once, judged
 * (unless the caller holds `vault.reveal`), and bound to exactly the ids that
 * were judged. Checking and binding in separate reads let a secret deleted and
 * re-created under the same label between them be bound unchecked.
 *
 * #552 — like `assertSecretBindingAllowed`, it stamps every secret the write
 * binds anew BEFORE that read (`stampBindingWrite`), admins included, so a
 * confirmed foreign-owner rotation cannot interleave with the write.
 *
 * Pass the returned bindings to the write as its pre-resolved ids, and the
 * returned `until` to `assertBindingWriteWindowOpen` immediately before the
 * write; `kept` is as for {@link bindSecretRefs}.
 *
 * @throws AppError 403 SECRET_BINDING_FORBIDDEN (audited), 409
 *   VAULT_REF_AMBIGUOUS, 409 SECRET_BINDING_CHANGED, 400 VAULT_REF_UNRESOLVED.
 */
export async function authorizeAndBindSecretRefs(
  user: Pick<AuthPayload, "userId" | "role">,
  change: SecretBindingChange,
  ctx: SecretBindingContext,
  kept: SecretBindings | null = null,
): Promise<AuthorizedSecretBindings> {
  const after = [...new Set(change.after)];
  if (after.length === 0) return { bindings: Object.create(null) as SecretBindings, until: null };
  const until = await stampBindingWrite(user, change);
  if (hasPermission(user.role, "vault.reveal")) {
    const rows = await readCandidateSecrets(unkeptRefs(after, kept));
    return { bindings: bindFromRows(after, kept, rows), until };
  }
  const rows = await readCandidateSecrets([...new Set([...change.before, ...after])]);
  judgeSecretBinding(user, change, ctx, rows, until);
  return { bindings: bindFromRows(after, kept, rows), until };
}

/** What {@link authorizeAndBindSecretRefs} approved. */
export interface AuthorizedSecretBindings {
  /** Reference body → the id the check approved, for the write to bind. */
  bindings: SecretBindings;
  /**
   * #552 — the binding-write stamp's window end, or `null` when nothing was
   * stamped; the write must land before it (`assertBindingWriteWindowOpen`).
   */
  until: Date | null;
}

/**
 * #577 — bind `refs` from the ids a write was handed, and nothing else: no read
 * of the secret table. `covered` is what the route's binding check approved
 * (plus any secret the request itself vaulted, and on an existing server the
 * bindings it already holds). A reference outside it is refused, never resolved
 * by label here — resolving it again is the TOCTOU the check-and-bind read
 * closes, so a route that forgot to pass the checked ids fails closed.
 *
 * A write with no references binds nothing and needs no `covered` set (registry
 * and federation installs).
 *
 * @throws AppError 500 SECRET_BINDING_UNCHECKED
 */
export function bindCheckedSecretRefs(
  refs: string[],
  covered: SecretBindings | null | undefined,
): SecretBindings {
  const out: SecretBindings = Object.create(null) as SecretBindings;
  const unchecked: string[] = [];
  for (const ref of new Set(refs)) {
    const id = keptIdOf(covered ?? null, ref);
    if (id === undefined) unchecked.push(ref);
    else out[ref] = id;
  }
  if (unchecked.length > 0) {
    throw new AppError(
      500,
      SECRET_BINDING_UNCHECKED,
      `internal error: ${unchecked.length} vault reference(s) reached the write without ` +
        "passing the binding check; refusing to resolve them by label",
    );
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
