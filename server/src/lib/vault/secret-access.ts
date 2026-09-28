/**
 * #305 — who may point a chat session at a vault secret (`providerSecretRef`).
 *
 * The rule is #305's: a caller may reference a secret they may READ. Reading a
 * secret is `vault.read` (`GET /api/vault`, `routes/vault.ts`), held by
 * `admin`, `coordinator` and `developer` — not `reader`. Seeing its PLAINTEXT
 * is the separate, admin-only `vault.reveal` (#324); using a secret by
 * reference never hands the caller the value, so it stays on `vault.read`. The
 * vault has no finer scoping to respect: a `Secret` row carries no project or
 * workspace column and its `global:` / `project:` name prefix is a display tag
 * bound to no project. So the usable set for a `vault.read` holder is every
 * live secret — `hasPermission(role, "vault.read")` plus liveness.
 *
 * A secret that does not exist, is soft-deleted, or is referenced by a caller
 * without `vault.read` is refused identically, so the check cannot be used to
 * probe which secret ids exist.
 *
 * It is enforced twice: when the session is created (`POST /api/ai/sessions`,
 * 404) and again every time a turn resolves the key (`chatProviderForSession`),
 * against the session OWNER's current role — a session stored before this
 * check, or an owner demoted since, never decrypts a secret it may not read.
 */
import { hasPermission, type AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";

export const SECRET_NOT_FOUND = "SECRET_NOT_FOUND";

export async function canUseSecret(
  user: Pick<AuthPayload, "role">,
  secretId: string,
): Promise<boolean> {
  // The permission the vault list route requires (not `vault.reveal`, #324).
  if (!hasPermission(user.role, "vault.read")) return false;
  // The same liveness filter `VaultService.read` applies.
  const row = await prisma.secret.findFirst({
    where: { id: secretId, deletedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/** @throws AppError 404 SECRET_NOT_FOUND — unknown, deleted, or not readable by the caller. */
export async function assertSecretUsable(
  user: Pick<AuthPayload, "role">,
  secretId: string,
): Promise<void> {
  if (!(await canUseSecret(user, secretId))) {
    throw new AppError(404, SECRET_NOT_FOUND, "Secret not found");
  }
}
