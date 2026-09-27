/**
 * #305 — who may point a chat session at a vault secret (`providerSecretRef`).
 *
 * A `Secret` row carries no project or workspace column — the only ownership
 * it records is `createdById`. So the rule is the narrowest one the schema can
 * express: a system admin may use any live secret; anyone else only a secret
 * they created. A secret that does not exist, is soft-deleted, or belongs to
 * someone else is refused identically, so the check cannot be used to probe
 * which secret ids exist.
 *
 * It is enforced twice: when the session is created (`POST /api/ai/sessions`,
 * 404) and again every time a turn resolves the key (`chatProviderForSession`),
 * against the session OWNER's current role — a session stored before this
 * check, or an owner demoted since, never decrypts a secret it may not use.
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";

export const SECRET_NOT_FOUND = "SECRET_NOT_FOUND";

export async function canUseSecret(
  user: Pick<AuthPayload, "userId" | "role">,
  secretId: string,
): Promise<boolean> {
  const row = await prisma.secret.findFirst({
    where: { id: secretId, deletedAt: null },
    select: { createdById: true },
  });
  if (!row) return false;
  if (user.role === "admin") return true;
  return row.createdById !== null && row.createdById === user.userId;
}

/** @throws AppError 404 SECRET_NOT_FOUND — unknown, deleted, or not the caller's. */
export async function assertSecretUsable(
  user: Pick<AuthPayload, "userId" | "role">,
  secretId: string,
): Promise<void> {
  if (!(await canUseSecret(user, secretId))) {
    throw new AppError(404, SECRET_NOT_FOUND, "Secret not found");
  }
}
