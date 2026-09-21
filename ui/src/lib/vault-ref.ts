/**
 * Client-side vault-ref shape check — #1094.
 *
 * The server is the authority (`resolveVaultRef` in
 * `server/src/lib/connectors/vault-resolver.ts`), and it now returns a precise,
 * client-safe message. This mirror exists only so the user is told *before*
 * submitting, which is where the friction actually was: the Publish page's
 * placeholder taught `vault:x` and the resulting 400 said nothing useful, so
 * the flow was a dead end for anyone who had not read the server source.
 *
 * Deliberately advisory. It never blocks submission on its own — a purely
 * client-side gate would be both bypassable and liable to drift from the
 * server's regex.
 */

/** The one canonical example, matching the Connections page and the server. */
export const VAULT_REF_EXAMPLE = "${vault:my-token-label}";

const VAULT_REF_PATTERN = /^\$\{vault:([^}]+)\}$/;

/** True when `value` is a well-formed `${vault:label}` reference. */
export function isVaultRefShape(value: string): boolean {
  const m = VAULT_REF_PATTERN.exec(value);
  return Boolean(m && m[1].trim().length > 0);
}

/**
 * A hint to show under the field, or `null` when there is nothing to say.
 *
 * Empty input yields `null`: an untouched field should not look like an error.
 * The hint never echoes the entered value — this field is where a user might
 * paste a real token by mistake, and reflecting it into the DOM would put
 * secret material somewhere it does not belong.
 */
export function vaultRefHint(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (isVaultRefShape(trimmed)) return null;
  if (/^vault:/i.test(trimmed)) {
    // The exact mistake the old placeholder taught.
    return `Missing the \${…} wrapper — use ${VAULT_REF_EXAMPLE}.`;
  }
  if (/^(gh[pousr]_|github_pat_)/.test(trimmed)) {
    // Looks like a raw PAT. Say so without repeating any of it.
    return `This looks like a token, not a vault reference. Store the token in the vault and enter its label as ${VAULT_REF_EXAMPLE}.`;
  }
  return `Must be written as ${VAULT_REF_EXAMPLE}.`;
}
