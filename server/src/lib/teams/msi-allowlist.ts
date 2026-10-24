/**
 * #1466 — which user-assigned managed identities a Teams installation may use.
 *
 * A password install proves ownership: the admin has to know the app's secret.
 * A managed-identity install names only a client id, which is not a secret, and
 * botframework then obtains tokens for ANY identity attached to the METIS host
 * with that id. So a workspace admin must not be able to pick one: the operator
 * lists the identities this deployment's bots may use in `TEAMS_MSI_CLIENT_IDS`.
 *
 * Each comma-separated entry is either
 *   - `<client-id>=<workspace-id>` — that identity, for that workspace only; or
 *   - `<client-id>`                — that identity, for any ONE workspace at a
 *                                    time (the store refuses a second). Fine for a
 *                                    single-workspace deployment; in a multi-
 *                                    workspace one, bind it, or any workspace admin
 *                                    can claim it while its owner does not hold it.
 * Unset or empty ⇒ no managed-identity bot is allowed, and both install and
 * credential resolution refuse.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TeamsMsiAllowlist {
  /**
   * Normalised (trimmed, lower-cased) allowed client id → the one workspace it is
   * bound to, or null when any single workspace may use it.
   */
  clientIds: ReadonlyMap<string, string | null>;
  /** Entries that could not be used: not a client-id GUID, or bound inconsistently. */
  invalid: string[];
}

/** Normalise a client id for comparison (trim + lower-case). */
export function normalizeClientId(clientId: string): string {
  return clientId.trim().toLowerCase();
}

/** Parse `TEAMS_MSI_CLIENT_IDS`. Unusable entries are reported and allow nothing. */
export function loadTeamsMsiAllowlist(env: NodeJS.ProcessEnv = process.env): TeamsMsiAllowlist {
  const clientIds = new Map<string, string | null>();
  const conflicted = new Set<string>();
  const invalid: string[] = [];
  for (const part of (env.TEAMS_MSI_CLIENT_IDS ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const id = normalizeClientId(eq === -1 ? entry : entry.slice(0, eq));
    const workspaceId = eq === -1 ? null : entry.slice(eq + 1).trim();
    if (!GUID.test(id) || workspaceId === "") {
      invalid.push(entry);
      continue;
    }
    // The same identity listed twice with different bindings is ambiguous:
    // refuse it outright rather than guess which workspace was meant.
    if (clientIds.has(id) && clientIds.get(id) !== workspaceId) conflicted.add(id);
    clientIds.set(id, workspaceId);
  }
  for (const id of conflicted) {
    clientIds.delete(id);
    invalid.push(id);
  }
  return { clientIds, invalid };
}

/** True when the operator has allowed client id `clientId` for `workspaceId`. */
export function isMsiClientIdAllowed(
  allowlist: TeamsMsiAllowlist,
  clientId: string,
  workspaceId: string,
): boolean {
  const id = normalizeClientId(clientId);
  if (!allowlist.clientIds.has(id)) return false;
  const bound = allowlist.clientIds.get(id);
  return bound === null || bound === workspaceId;
}
