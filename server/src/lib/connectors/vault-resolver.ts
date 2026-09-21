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
 * connects with an empty value.
 */
import { createChildLogger } from "../logger.js";
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
  try {
    const all = await vault.list();
    const direct = all.find((s) => s.label === refBody || `${s.scope}:${s.label}` === refBody);
    if (direct) {
      const { plaintext } = await vault.read(direct.id);
      return plaintext;
    }
  } catch (err) {
    log.warn("Vault list failed during ref resolution", {
      ref: refBody,
      err: (err as Error).message,
    });
  }

  throw new ConnectorError(
    500,
    "VAULT_REF_UNRESOLVED",
    `vault reference \${vault:${refBody}} could not be resolved`,
  );
}

function preview(s: string): string {
  if (s.length <= 32) return s;
  return s.slice(0, 24) + "...";
}
