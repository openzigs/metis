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
 *      The one exception, an admin's confirmed "Rotate anyway" on another
 *      user's secret (`routes/vault.ts`, #482), moves `createdById` to that
 *      admin in the same write (#502), so it still names who supplied the
 *      current value and the previous owner loses rule 1 on it.
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
 * A reference is also bound to the secret id it resolved to when it was saved
 * (#480, `bound-secret.ts`), so a later delete + re-create under the same label
 * cannot re-bind it.
 */
import { hasPermission, type AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { AppError } from "../../middleware/error-handler.js";
import { markBindingWrite, stampedFor } from "./binding-write-mark.js";

export const SECRET_BINDING_FORBIDDEN = "SECRET_BINDING_FORBIDDEN";
/** #552 — the referenced secrets changed between the stamp and the check. */
export const SECRET_BINDING_CHANGED = "SECRET_BINDING_CHANGED";

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
  /** #552 — the binding-write stamp (`binding-write-mark.ts`). */
  bindingWriteUntil: Date | null;
}

function labelOf(name: string): string {
  return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
}

function scopeOf(name: string): "global" | "project" {
  return name.startsWith("project:") ? "project" : "global";
}

/** Does a reference body resolve to this row, by id or by (scoped) label? */
export function reaches(ref: string, row: { id: string; name: string }): boolean {
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
 *
 * The superset claim does not depend on how Prisma escapes `endsWith`: an
 * unescaped LIKE `%` or `_` only widens the match, and the one character that
 * could narrow it (a `\`, Postgres's default LIKE escape) cannot occur in a
 * reachable label — vault names are `[a-zA-Z0-9_.\-/]` (`createSecretSchema`)
 * and connector labels `[A-Za-z0-9 _.\-]`, so a ref containing `\` reaches no
 * row by label in `reaches` either (PR #392 review).
 */
export function candidateFilters(ref: string): Array<Record<string, unknown>> {
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

/** A live secret row as the check and the binding read it. */
export interface CandidateSecret {
  id: string;
  name: string;
  createdById: string | null;
  /** #552 — the binding-write stamp (`binding-write-mark.ts`). */
  bindingWriteUntil: Date | null;
}

/**
 * Every live secret any of `refs` could resolve to, by id or by label — one
 * read of the secret table, filtered to the rows those references could name.
 * The ownership check and the #480 binding both judge these rows, so a caller
 * that needs both reads once (#577).
 */
export async function readCandidateSecrets(refs: string[]): Promise<CandidateSecret[]> {
  if (refs.length === 0) return [];
  return prisma.secret.findMany({
    where: { deletedAt: null, OR: refs.flatMap(candidateFilters) },
    select: { id: true, name: true, createdById: true, bindingWriteUntil: true },
  });
}

/** Each reference body → the rows it reaches among `rows`. */
function reachableIn(refs: string[], rows: CandidateSecret[]): Map<string, SecretOwner[]> {
  const out = new Map<string, SecretOwner[]>();
  for (const ref of refs) {
    out.set(
      ref,
      rows
        .filter((r) => reaches(ref, r))
        .map(({ id, createdById, bindingWriteUntil }) => ({ id, createdById, bindingWriteUntil })),
    );
  }
  return out;
}

/** One read of the secret table per write, however many references it names. */
async function secretsReachableBy(refs: string[]): Promise<Map<string, SecretOwner[]>> {
  return reachableIn(refs, await readCandidateSecrets(refs));
}

/**
 * #344 rule 1: a user may attach a reference only if EVERY live secret it can
 * reach was created by them. An unknown reference reaches nothing and so is
 * never owned.
 */
function ownedBy(reachable: SecretOwner[], userId: string | null): boolean {
  return (
    userId !== null && reachable.length > 0 && reachable.every((s) => s.createdById === userId)
  );
}

/**
 * #504 — the references `userId` could have attached under rule 1, for a
 * write made without a caller (the pre-#480 backfill). The `vault.reveal`
 * exemption is the caller's to decide; this checks ownership only.
 */
export async function refsOwnedBy(userId: string | null, refs: string[]): Promise<Set<string>> {
  const unique = [...new Set(refs)];
  if (userId === null || unique.length === 0) return new Set();
  const reachableBy = await secretsReachableBy(unique);
  return new Set(unique.filter((ref) => ownedBy(reachableBy.get(ref) ?? [], userId)));
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
 * #552 — stamp every secret `change` may bind somewhere new, BEFORE the
 * ownership read that judges it, so a confirmed foreign-owner rotation of it
 * cannot land between that check and the caller's write
 * (`binding-write-mark.ts`). A reference kept verbatim while nothing moves
 * binds nothing new. A caller without `vault.reveal` stamps only secrets they
 * created. Returns the window end, before which the caller must write
 * (`assertBindingWriteWindowOpen`); `null` when nothing was stamped.
 *
 * Every binding check runs this first — {@link assertSecretBindingAllowed} and
 * `authorizeAndBindSecretRefs` (#577) — and {@link judgeSecretBinding} takes
 * its result, so a check cannot judge rows it did not stamp first.
 */
export async function stampBindingWrite(
  user: Pick<AuthPayload, "userId" | "role">,
  change: SecretBindingChange,
): Promise<Date | null> {
  const before = new Set(change.before);
  const moving = [...new Set(change.after)].filter(
    (ref) => change.destinationChanged || !before.has(ref),
  );
  return markBindingWrite(
    moving.flatMap(candidateFilters),
    hasPermission(user.role, "vault.reveal") ? null : user.userId,
  );
}

/**
 * #552 — before the check, every secret the write may bind somewhere new is
 * stamped ({@link stampBindingWrite}), for admins too, so a confirmed
 * foreign-owner rotation cannot interleave with the caller's write. Returns the
 * stamp's window end; the caller passes it to `assertBindingWriteWindowOpen`
 * immediately before its write.
 *
 * @throws AppError 403 SECRET_BINDING_FORBIDDEN when a caller without
 *   `vault.reveal` would attach a secret they did not create, or move a
 *   resource holding one to a new destination. The refusal is audited.
 * @throws AppError 409 SECRET_BINDING_CHANGED when a reference reaches an
 *   owned secret that was not there when the secrets were stamped.
 */
export async function assertSecretBindingAllowed(
  user: Pick<AuthPayload, "userId" | "role">,
  change: SecretBindingChange,
  ctx: SecretBindingContext,
): Promise<Date | null> {
  if (change.after.length === 0) return null;
  const until = await stampBindingWrite(user, change);
  if (hasPermission(user.role, "vault.reveal")) return until;
  const refs = [...new Set([...change.before, ...change.after])];
  judgeSecretBinding(user, change, ctx, await readCandidateSecrets(refs), until);
  return until;
}

/**
 * The #344 rule of {@link assertSecretBindingAllowed}, judged against rows the
 * caller has already read ({@link readCandidateSecrets} over `before` ∪
 * `after`), so the same rows can then be bound (#577). The `vault.reveal`
 * exemption is the caller's to apply. `until` is what
 * {@link stampBindingWrite} returned for this change, BEFORE `rows` were read
 * (#552).
 *
 * @throws AppError 403 SECRET_BINDING_FORBIDDEN, audited.
 * @throws AppError 409 SECRET_BINDING_CHANGED when an owned row was not stamped.
 */
export function judgeSecretBinding(
  user: Pick<AuthPayload, "userId">,
  change: SecretBindingChange,
  ctx: SecretBindingContext,
  rows: CandidateSecret[],
  until: Date | null,
): void {
  const after = [...new Set(change.after)];
  if (after.length === 0) return;
  const before = [...new Set(change.before)];
  const reachableBy = reachableIn([...new Set([...before, ...after])], rows);
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
    if (ownedBy(reachable, user.userId)) {
      // A secret that appeared under this label after the stamp was not
      // stamped, so a rotation of it would not see this write (#552).
      if (reachable.every((s) => stampedFor(s.bindingWriteUntil, until))) continue;
      throw new AppError(
        409,
        SECRET_BINDING_CHANGED,
        "The vault secrets this write references changed while it was being checked. Retry.",
      );
    }
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
