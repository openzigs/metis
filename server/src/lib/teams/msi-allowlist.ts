/**
 * #1466 — which user-assigned managed identities a Teams installation may use.
 *
 * A password install proves ownership: the admin has to know the app's secret.
 * A managed-identity install names only a client id, which is not a secret, and
 * botframework then obtains tokens for ANY identity attached to the METIS host
 * with that id. So a workspace admin must not be able to pick one: the operator
 * lists the identities this deployment's bots may use in `TEAMS_MSI_CLIENT_IDS`
 * (comma-separated client-id GUIDs). Unset or empty ⇒ no managed-identity bot is
 * allowed, and both install and credential resolution refuse.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TeamsMsiAllowlist {
  /** Normalised (trimmed, lower-cased) allowed client ids. */
  clientIds: ReadonlySet<string>;
  /** Entries that are not client-id GUIDs. They allow nothing. */
  invalid: string[];
}

/** Normalise a client id for comparison (trim + lower-case). */
export function normalizeClientId(clientId: string): string {
  return clientId.trim().toLowerCase();
}

/** Parse `TEAMS_MSI_CLIENT_IDS`. Non-GUID entries are reported and allow nothing. */
export function loadTeamsMsiAllowlist(env: NodeJS.ProcessEnv = process.env): TeamsMsiAllowlist {
  const clientIds = new Set<string>();
  const invalid: string[] = [];
  for (const part of (env.TEAMS_MSI_CLIENT_IDS ?? "").split(",")) {
    const id = normalizeClientId(part);
    if (!id) continue;
    if (GUID.test(id)) clientIds.add(id);
    else invalid.push(part.trim());
  }
  return { clientIds, invalid };
}

/** True when the operator has allowed managed-identity client id `clientId`. */
export function isMsiClientIdAllowed(allowlist: TeamsMsiAllowlist, clientId: string): boolean {
  return allowlist.clientIds.has(normalizeClientId(clientId));
}
