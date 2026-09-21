/**
 * Issue #642 — shared client-facing user mapper.
 *
 * Both `/auth/login` and `/auth/me` must return an identically-shaped `user`
 * object so the UI `AuthUser` contract (ui/src/lib/auth-types.ts) holds after a
 * fresh login AND after a hard reload (which re-hydrates via `/auth/me`).
 *
 * The JWT access-token payload keys the id as `userId` (load-bearing across the
 * server middleware). The client contract keys it as `id`. This mapper is the
 * single translation point, so the two responses cannot drift again: it maps
 * `userId` -> `id` and never leaks the server-side `userId` key.
 */
import type { PermissionKey, RoleKey } from "@metis/shared";

/**
 * Client-facing authenticated-user shape. Mirrors the UI `AuthUser` interface
 * exactly (id, username, displayName, email, role, permissions).
 */
export interface ClientAuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: RoleKey;
  permissions: readonly PermissionKey[];
}

/**
 * Build the client-facing user object from the stable identity fields (from the
 * JWT payload or the login result) plus the enriched profile row.
 *
 * `id` is mapped from `userId`. `displayName`/`email` default to empty strings
 * so the returned object always satisfies the non-optional `AuthUser` contract
 * even when the profile row could not be resolved.
 */
export function toAuthUser(
  identity: {
    userId: string;
    username: string;
    role: RoleKey;
    permissions: readonly PermissionKey[];
  },
  profile: { displayName?: string | null; email?: string | null } = {},
): ClientAuthUser {
  return {
    id: identity.userId,
    username: identity.username,
    displayName: profile.displayName ?? "",
    email: profile.email ?? "",
    role: identity.role,
    permissions: identity.permissions,
  };
}
