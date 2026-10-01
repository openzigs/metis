/**
 * The one read that turns a verified access token's user id into the identity
 * that authorization may trust: the user must still be live (`status:
 * "active"`, not soft-deleted), and the role and workspaces come from durable
 * state, never from the token's claims.
 *
 * Shared by the HTTP refresh (`refreshAuthenticatedUser`) and the Socket.IO
 * handshake (#617): the handshake used to trust `verifyAccessToken` alone, so a
 * SCIM-deprovisioned user could reconnect with an unexpired access token and
 * authorize every room gate from the token's `role` claim.
 */
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { prisma } from "../prisma.js";
import { resolveEffectiveRole } from "./durable-roles.js";
import { readLiveWorkspaceIds } from "./live-workspace-ids.js";

function isRecognizedRole(role: string | undefined): role is RoleKey {
  return role === "admin" || role === "coordinator" || role === "developer" || role === "reader";
}

/**
 * The live identity of `userId`, or `null` when the user is soft-deleted, not
 * active, or absent. A lookup failure rejects; callers must fail closed.
 */
export async function loadLiveAuthPayload(userId: string): Promise<AuthPayload | null> {
  const [user, workspaces, effective] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, status: "active", deletedAt: null },
      select: { id: true, username: true, authRolesInitializedAt: true },
    }),
    readLiveWorkspaceIds(userId),
    resolveEffectiveRole(userId),
  ]);
  if (!user) return null;
  const role: RoleKey = isRecognizedRole(effective.role) ? effective.role : "reader";
  return {
    userId: user.id,
    username: user.username,
    role,
    permissions: getPermissionsForRole(role),
    workspaces,
  };
}
