/**
 * #258 — the one pattern every vault caller uses to write a secret it owns.
 *
 * `Secret.name` is `@unique` and vault deletes are soft, so a name derived only
 * from the owning entity (project + label, host + port, ...) can already be
 * taken — by a soft-deleted secret, or by a secret whose owner is gone. Creating
 * under it fails on the index. Two rules follow (first applied to Jira in #106):
 *
 *  1. A NEW secret gets a label no earlier secret can hold ({@link freshSecretLabel}).
 *  2. Rewriting an entity's EXISTING secret goes by id ({@link rotateOrCreate}):
 *     `rotate` is itself the liveness check — it refuses a missing or
 *     soft-deleted row with `SecretNotFoundError` — and only then is a fresh
 *     secret created. Any other vault error propagates; nothing is swallowed.
 */
import { ulid } from "ulid";
import { SecretNotFoundError, type SecretScope, type VaultService } from "./vault-service.js";

/** `base` plus a per-secret suffix, so a create cannot collide with any earlier row. */
export function freshSecretLabel(base: string): string {
  return `${base}-${ulid()}`;
}

export interface FreshSecret {
  /** Label base; {@link freshSecretLabel} appends the unique suffix. */
  label: string;
  scope: SecretScope;
  description: string;
  createdById?: string | null;
}

/**
 * Write `value` into the live secret `secretId` in place; when there is none
 * (null, missing or soft-deleted) create a new secret under a fresh label.
 * Returns the id now holding `value` and whether it was newly created — a
 * created id is one the caller MUST store in place of the old reference.
 */
export async function rotateOrCreate(
  vault: Pick<VaultService, "rotate" | "create">,
  secretId: string | null | undefined,
  value: string,
  fresh: FreshSecret,
): Promise<{ id: string; created: boolean }> {
  if (secretId) {
    try {
      await vault.rotate(secretId, value);
      return { id: secretId, created: false };
    } catch (err) {
      if (!(err instanceof SecretNotFoundError)) throw err;
    }
  }
  const created = await vault.create(freshSecretLabel(fresh.label), value, fresh.scope, {
    description: fresh.description,
    createdById: fresh.createdById ?? null,
  });
  return { id: created.id, created: true };
}
