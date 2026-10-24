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

import { createChildLogger } from "../logger.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TeamsMsiAllowlist {
  /**
   * Normalised (trimmed, lower-cased) allowed client id → the one workspace it is
   * bound to, or null when any single workspace may use it.
   */
  clientIds: ReadonlyMap<string, string | null>;
  /**
   * Entries that could not be used, by 1-based position among the non-blank
   * entries. The entry text itself is deliberately not kept, so reporting one
   * never echoes configuration into a log.
   */
  invalid: InvalidMsiAllowlistEntry[];
}

export interface InvalidMsiAllowlistEntry {
  position: number;
  reason: "not a client-id GUID" | "empty workspace binding" | "bound to two different workspaces";
}

/** Normalise a client id for comparison (trim + lower-case). */
export function normalizeClientId(clientId: string): string {
  return clientId.trim().toLowerCase();
}

const log = createChildLogger("teams-msi-allowlist");

/** The last `TEAMS_MSI_CLIENT_IDS` value whose unusable entries were logged. */
let lastWarnedValue: string | undefined;

/** Warn about unusable entries, once per distinct configured value. */
function warnOnce(raw: string, invalid: InvalidMsiAllowlistEntry[]): void {
  if (invalid.length === 0 || raw === lastWarnedValue) return;
  lastWarnedValue = raw;
  log.warn("TEAMS_MSI_CLIENT_IDS has unusable entries; they allow nothing", {
    entries: invalid.map((e) => `#${e.position}: ${e.reason}`),
  });
}

/** Test helper — forget which configuration was already warned about. */
export function __resetMsiAllowlistWarnings(): void {
  lastWarnedValue = undefined;
}

/**
 * Parse `TEAMS_MSI_CLIENT_IDS`. Unusable entries allow nothing and are logged
 * once (by position and reason) the first time a given value is parsed.
 */
export function loadTeamsMsiAllowlist(env: NodeJS.ProcessEnv = process.env): TeamsMsiAllowlist {
  const raw = env.TEAMS_MSI_CLIENT_IDS ?? "";
  const clientIds = new Map<string, string | null>();
  const positions = new Map<string, number[]>();
  const conflicted = new Set<string>();
  const invalid: InvalidMsiAllowlistEntry[] = [];
  let position = 0;
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    position += 1;
    const eq = entry.indexOf("=");
    const id = normalizeClientId(eq === -1 ? entry : entry.slice(0, eq));
    const workspaceId = eq === -1 ? null : entry.slice(eq + 1).trim();
    if (!GUID.test(id)) {
      invalid.push({ position, reason: "not a client-id GUID" });
      continue;
    }
    if (workspaceId === "") {
      invalid.push({ position, reason: "empty workspace binding" });
      continue;
    }
    // The same identity listed twice with different bindings is ambiguous:
    // refuse it outright rather than guess which workspace was meant.
    if (clientIds.has(id) && clientIds.get(id) !== workspaceId) conflicted.add(id);
    clientIds.set(id, workspaceId);
    positions.set(id, [...(positions.get(id) ?? []), position]);
  }
  for (const id of conflicted) {
    clientIds.delete(id);
    for (const p of positions.get(id) ?? []) {
      invalid.push({ position: p, reason: "bound to two different workspaces" });
    }
  }
  invalid.sort((a, b) => a.position - b.position);
  warnOnce(raw, invalid);
  return { clientIds, invalid };
}

/** True when the operator bound client id `clientId` to exactly `workspaceId`. */
export function isMsiClientIdBoundTo(
  allowlist: TeamsMsiAllowlist,
  clientId: string,
  workspaceId: string,
): boolean {
  return allowlist.clientIds.get(normalizeClientId(clientId)) === workspaceId;
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
