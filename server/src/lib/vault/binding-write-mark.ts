/**
 * #552 — a binding write and a confirmed foreign-owner rotation of the same
 * secret cannot interleave.
 *
 * `POST /api/vault/:id/rotate` on another user's secret lists the secret's
 * bindings, checks them against the ones the admin confirmed (#502), and then
 * writes the admin's value (transferring ownership) as a separate statement.
 * A binding write is itself a check (`assertSecretBindingAllowed`) followed by
 * a separate write. Without coordination the owner's check could pass, the
 * admin could read the bindings, and then both writes could land: the admin's
 * value reaches a destination the admin never saw.
 *
 * The two sides meet on one column of the secret row, `bindingWriteUntil`:
 *
 *   - A binding write stamps it (now + {@link BINDING_WRITE_WINDOW_MS}) on
 *     every secret it is about to bind somewhere new, BEFORE its ownership
 *     check reads the row. For a caller without `vault.reveal` the stamp is
 *     conditional on that caller owning the secret, so it cannot be used to
 *     hold up rotations of secrets they could not bind anyway.
 *   - The rotation reads the column with the owner, before listing bindings,
 *     refuses up front while a window is open, and makes its UPDATE
 *     conditional on the value it read (`VaultService.rotate`'s
 *     `onlyIfBindingWriteUntil`).
 *
 * Both are single-row writes to the same row, so one lands first. Stamp first:
 * the rotation's UPDATE sees a different value and is refused. Rotation first:
 * the stamp's ownership condition no longer holds and the check that follows
 * reads the new owner, so rule 1 refuses the binding.
 *
 * The window must outlast a binding write's check-to-write span (a guard and
 * one service write, plus any auto-vaulting in between); it is generous
 * because the only cost of a long one is that a foreign-owner rotation right
 * after the owner rebinds is refused until it closes. It is also ENFORCED on
 * the write side: every caller of the guard runs
 * {@link assertBindingWriteWindowOpen} immediately before its write, so a write
 * that outlasts its window (a slow mcp.json import) is refused rather than
 * landing after a rotation it no longer holds off.
 *
 * An owner who keeps sending binding requests keeps re-opening the window and
 * so holds off a foreign-owner rotation for as long as they do. The workaround
 * is to disable the user first (SCIM `active: false`, which revokes their
 * sessions) and rotate once the access token they already hold has expired
 * (`JWT_ACCESS_EXPIRY`) and the last window has closed — documented in
 * docs/USER_GUIDE.md and in the VAULT_ROTATE_BINDING_IN_PROGRESS message.
 *
 * The stamp is written with raw SQL so it leaves `updatedAt` alone: the vault
 * page shows that column as "Updated", and a binding check changes neither the
 * value nor anything a user edits.
 */
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";

/** How long a binding write holds off a confirmed foreign-owner rotation. */
export const BINDING_WRITE_WINDOW_MS = 60_000;

/** #552 — a binding write that did not land inside its window. */
export const SECRET_BINDING_WINDOW_EXPIRED = "SECRET_BINDING_WINDOW_EXPIRED";

/**
 * Stamp `bindingWriteUntil` on every live secret matching any of `filters`
 * (the candidate rows of the references being bound, `candidateFilters` in
 * `secret-binding.ts`; a superset only stamps more of the caller's own rows).
 * `ownerId` limits it to secrets that user created; `null` (a `vault.reveal`
 * caller) stamps all. Returns the window end written, or null when there was
 * nothing to stamp, so the caller can tell a row it stamped from one that
 * appeared afterwards.
 *
 * The candidate ids are read first and each is stamped by a single-row UPDATE
 * that re-states the live and owner conditions, so a row whose owner changed
 * in between (a rotation that landed first) is not stamped, exactly as one
 * conditional `updateMany` would behave. Only `bindingWriteUntil` is written:
 * Prisma's `@updatedAt` is not applied to raw statements.
 */
export async function markBindingWrite(
  filters: Array<Record<string, unknown>>,
  ownerId: string | null,
  now: Date = new Date(),
): Promise<Date | null> {
  if (filters.length === 0) return null;
  const until = new Date(now.getTime() + BINDING_WRITE_WINDOW_MS);
  const rows = await prisma.secret.findMany({
    where: {
      deletedAt: null,
      OR: filters,
      ...(ownerId !== null ? { createdById: ownerId } : {}),
    },
    select: { id: true },
  });
  for (const { id } of rows) {
    if (ownerId === null) {
      await prisma.$executeRaw`UPDATE "secrets" SET "bindingWriteUntil" = ${until} WHERE "id" = ${id} AND "deletedAt" IS NULL`;
    } else {
      await prisma.$executeRaw`UPDATE "secrets" SET "bindingWriteUntil" = ${until} WHERE "id" = ${id} AND "deletedAt" IS NULL AND "createdById" = ${ownerId}`;
    }
  }
  return until;
}

/** True when `stamp` covers a binding write that stamped at `until` (a later one may extend it). */
export function stampedFor(stamp: Date | null, until: Date | null): boolean {
  return stamp !== null && until !== null && stamp.getTime() >= until.getTime();
}

/** True while a binding write stamped at `until` may still be landing. */
export function bindingWriteInProgress(until: Date | null, now: Date = new Date()): boolean {
  return until !== null && until.getTime() > now.getTime();
}

/**
 * #552 — refuse a binding write whose window has closed. A confirmed
 * foreign-owner rotation is held off only while `now < until`
 * ({@link bindingWriteInProgress}), so a write landing at or after `until`
 * could follow a rotation the admin confirmed without it. Call immediately
 * before the write, with the `until` the binding check returned; `null`
 * (nothing was stamped) always passes.
 *
 * @throws AppError 409 SECRET_BINDING_WINDOW_EXPIRED
 */
export function assertBindingWriteWindowOpen(until: Date | null, now: Date = new Date()): void {
  if (bindingWriteInProgress(until, now)) return;
  if (until === null) return;
  throw new AppError(
    409,
    SECRET_BINDING_WINDOW_EXPIRED,
    "This change took too long between checking its vault secrets and saving, so it was " +
      "not saved. Retry it.",
  );
}
