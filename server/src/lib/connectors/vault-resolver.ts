/**
 * Vault reference resolver — Phase 8.
 *
 * Connector secret fields are stored as `${vault:label-or-id}` strings on the
 * Prisma row. At connection time the server resolves the reference back to the
 * raw plaintext via the existing vault service, never persisting plaintext.
 *
 * Mirrors the `expandVaultRefs` helper used by the MCP subsystem but operates
 * on a single scalar (not an env map) so connector code can write:
 *
 *   const token = await resolveVaultRef(connector.secretRef, vault);
 *
 * Returns `null` when the ref is empty (no credential — e.g. a public repo).
 * Throws `ConnectorError(500, "VAULT_REF_UNRESOLVED", ...)` if a non-empty ref
 * fails to resolve — fail-closed semantics so a missing secret never silently
 * connects with an empty value. Throws `ConnectorError(409, "VAULT_REF_AMBIGUOUS")`
 * when a label matches more than one live secret (#358).
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import type { VaultService } from "../vault/vault-service.js";
import { ConnectorError } from "./types.js";

const log = createChildLogger("connector-vault");

const VAULT_REF_PATTERN = /^\$\{vault:([^}]+)\}$/;

/** Encode a label as a `${vault:...}` reference. */
export function asVaultRef(label: string): string {
  return `\${vault:${label}}`;
}

/** True when `ref` is a valid `${vault:...}` token (non-empty body). */
export function isVaultRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const m = VAULT_REF_PATTERN.exec(ref);
  return Boolean(m && m[1].trim().length > 0);
}

/**
 * Resolve a `${vault:label}` reference to its plaintext. Empty/missing refs
 * return `null` (the caller treats that as "no credential supplied").
 */
export async function resolveVaultRef(
  ref: string | null | undefined,
  vault: VaultService,
): Promise<string | null> {
  if (!ref || ref.length === 0) return null;
  const m = VAULT_REF_PATTERN.exec(ref);
  if (!m) {
    throw new ConnectorError(
      400,
      "VAULT_REF_INVALID",
      `connector secret reference must be \${vault:label} or empty (got: ${preview(ref)})`,
    );
  }
  const refBody = m[1].trim();
  if (refBody.length === 0) {
    throw new ConnectorError(400, "VAULT_REF_INVALID", "vault reference body is empty");
  }

  // 1. id lookup
  try {
    const { plaintext } = await vault.read(refBody);
    return plaintext;
  } catch {
    /* fall through */
  }

  // 2. label lookup across scopes
  let matches: Array<{ id: string }> = [];
  try {
    const all = await vault.list();
    matches = all.filter((s) => s.label === refBody || `${s.scope}:${s.label}` === refBody);
  } catch (err) {
    log.warn("Vault list failed during ref resolution", {
      ref: refBody,
      err: (err as Error).message,
    });
  }
  // #358 — a label reaching more than one live secret (`global:x` next to
  // `project:x`) is refused rather than resolved to the newest. The #344
  // binding check approves a reference at write time; if a colliding secret
  // created later could win here, a reference bound to the caller's own
  // secret would silently start sending someone else's.
  if (matches.length > 1) {
    throw new ConnectorError(
      409,
      "VAULT_REF_AMBIGUOUS",
      `vault reference \${vault:${refBody}} matches more than one secret; qualify it as global:<label> or project:<label>, or use the secret id`,
    );
  }
  if (matches.length === 1) {
    try {
      const { plaintext } = await vault.read(matches[0].id);
      return plaintext;
    } catch (err) {
      log.warn("Vault read failed during ref resolution", {
        ref: refBody,
        err: (err as Error).message,
      });
    }
  }

  throw new ConnectorError(
    500,
    "VAULT_REF_UNRESOLVED",
    `vault reference \${vault:${refBody}} could not be resolved`,
  );
}

export const VAULT_BINDING_STALE = "VAULT_BINDING_STALE";

/**
 * #480 — read the secret a resource is BOUND to, by id only.
 *
 * `resolveVaultRef` falls back to a label lookup, so handing it a stored id
 * whose secret was deleted would resolve whatever now holds that string as a
 * label — including a secret someone created under the deleted id's text. A
 * binding follows the secret it was made against, never its label: when the
 * id no longer names a live secret the resource refuses to use it.
 *
 * @throws ConnectorError 409 VAULT_BINDING_STALE when the bound secret is gone.
 */
export async function readBoundSecret(secretId: string, vault: VaultService): Promise<string> {
  const live = await prisma.secret.findFirst({
    where: { id: secretId, deletedAt: null },
    select: { id: true },
  });
  if (!live) {
    throw new ConnectorError(
      409,
      VAULT_BINDING_STALE,
      "the vault secret this resource was bound to has been deleted; select a secret again",
    );
  }
  const { plaintext } = await vault.read(secretId);
  return plaintext;
}

function preview(s: string): string {
  if (s.length <= 32) return s;
  return s.slice(0, 24) + "...";
}
