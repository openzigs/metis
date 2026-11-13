import { ROLE_HIERARCHY, ROLE_PERMISSIONS, type PermissionKey, type RoleKey } from "@metis/shared";

/**
 * Hints shown on a write control the viewer cannot use. The server gates the
 * write (#789, #1566); the control is disabled with this reason instead of
 * ending in a 403. One string, so every surface says the same thing (#1588).
 */
export const REQUIRES_PROJECT_UPDATE = "Requires project.update";

/**
 * #2436 — a requirement's verdict (Approve, Reject) is a `requirement.approve`
 * write server-side, separate from editing it (`project.update`).
 */
export const REQUIRES_REQUIREMENT_APPROVE = "Requires requirement.approve";

/**
 * #1591 — a requirement's data mappings (add, remove, suggest, accept) are
 * `connector.write` writes server-side (`server/src/routes/data-mappings.ts`),
 * not `project.update` ones: a developer holds neither.
 */
export const REQUIRES_CONNECTOR_WRITE = "Requires connector.write";

/**
 * #2450 — starting a change request (`POST /api/projects/:id/analyses`) is an
 * `analysis.run` write. A viewer without it is told why there is no form,
 * rather than being offered one that ends in a 403.
 */
export const START_CHANGE_REQUEST_HINT = `Starting a change request needs the analysis.run permission (${defaultRolesHolding("analysis.run")} by default). You can still read this project's change requests.`;

/**
 * The default roles that hold `permission`, least privileged first, as prose
 * ("developer, coordinator or admin"). Derived from `ROLE_PERMISSIONS` so a
 * hint naming the roles cannot drift from the table the seed and server use.
 */
export function defaultRolesHolding(permission: PermissionKey): string {
  const roles = (Object.keys(ROLE_PERMISSIONS) as RoleKey[])
    .filter((role) => ROLE_PERMISSIONS[role].includes(permission))
    .sort((a, b) => ROLE_HIERARCHY[a] - ROLE_HIERARCHY[b]);
  if (roles.length <= 1) return roles.join("");
  return `${roles.slice(0, -1).join(", ")} or ${roles[roles.length - 1]}`;
}
