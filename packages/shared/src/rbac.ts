/**
 * Role-Based Access Control — role hierarchy and permission registry.
 *
 * The registry is the source of truth for every authorization decision in the
 * platform. Server middleware imports `hasPermission` / `hasMinRole`. The seed
 * script imports `ROLE_PERMISSIONS` to populate the database. UI feature gates
 * read from the same constants so the matrix never drifts.
 */
import { PERMISSION_KEYS, ROLE_KEYS, type PermissionKey, type RoleKey } from "./constants.js";

/**
 * Numeric ordering for role-level checks.
 * Higher numbers are strictly more privileged.
 */
export const ROLE_HIERARCHY: Record<RoleKey, number> = {
  reader: 10,
  developer: 20,
  coordinator: 30,
  admin: 99,
};

/**
 * Default role → permissions map.
 *
 * - `admin` gets every permission — and is the ONLY role holding
 *   `vault.reveal` (#324): the other roles may list and use vault secrets by
 *   reference (`vault.read`), but no HTTP response returns them the plaintext.
 *   Wherever the caller also chooses where a secret is sent, using it by
 *   reference is bound to its destination (#344, #358): a non-admin may attach
 *   only secrets they created, and may not move a resource while it holds
 *   someone else's (lib/vault/secret-binding.ts). That covers DB and repo
 *   connectors, MCP servers, Jira connections, Projects v2 board listing and
 *   live publishing to a non-github.com base URL.
 * - `coordinator` runs project lifecycle + publishes issues.
 * - `developer` runs analyses, drafts issues, reads vault.
 * - `reader` is read-only on projects/documents/analyses.
 *
 * Tests assert that `reader` has no `*.write` / `*.publish` / `*.delete` /
 * `*.manage` permissions and that `admin` carries the full set.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  admin: PERMISSION_KEYS,
  coordinator: [
    "project.create",
    "project.read",
    "project.update",
    "document.upload",
    "document.read",
    "analysis.run",
    "analysis.read",
    "issue.draft",
    "issue.preview",
    "issue.publish",
    "vault.read",
    "mcp.manage",
    "mcp.read",
    "mcp.write",
    "audit.read",
    "connector.read",
    "connector.write",
    "connector.test",
    "connector.query",
    "scheduler.read",
    "scheduler.manage",
    "task.read",
    "task.cancel",
    "task.retry",
    "sync.read",
    "sync.resolve",
    "review.create",
    "review.read",
    "review.decide",
    "review.admin",
  ],
  developer: [
    "project.read",
    "document.upload",
    "document.read",
    "analysis.run",
    "analysis.read",
    "issue.draft",
    "issue.preview",
    "vault.read",
    "mcp.read",
    "connector.read",
    "connector.test",
    "connector.query",
    "scheduler.read",
    "task.read",
    "task.retry",
    "sync.read",
    "review.create",
    "review.read",
    "review.decide",
  ],
  reader: [
    "project.read",
    "document.read",
    "analysis.read",
    "connector.read",
    "scheduler.read",
    "task.read",
    "sync.read",
    "review.read",
  ],
};

/**
 * Returns true if the given role carries the requested permission.
 */
export function hasPermission(role: RoleKey, permission: PermissionKey): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/**
 * Returns true if `role` meets or exceeds the privilege level of `minRole`.
 */
export function hasMinRole(role: RoleKey, minRole: RoleKey): boolean {
  return (ROLE_HIERARCHY[role] ?? 0) >= (ROLE_HIERARCHY[minRole] ?? 0);
}

/**
 * Returns the (frozen) set of permissions granted to a role.
 */
export function getPermissionsForRole(role: RoleKey): readonly PermissionKey[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export { PERMISSION_KEYS, ROLE_KEYS };
export type { PermissionKey, RoleKey };
