/**
 * Issue #549 — the ONE query that turns a user's memberships into the
 * workspace ids that authorize project access.
 *
 * Workspace DELETE is a soft delete (`Workspace.deletedAt`), and the
 * membership rows survive it. Every copy of `workspaceMember.findMany({ where:
 * { userId } })` therefore kept a deleted workspace in the caller's scope, and
 * with it every project inside. There were five copies (the login and SSO
 * token paths, the per-request refresh in `middleware/auth.ts`, the search
 * scope in `accessible-projects.ts` and the ACP actor); they now all filter
 * through this module (login and SSO via the fragment, because their callers
 * tolerate a mocked client without `workspaceMember`).
 */
import { prisma } from "../prisma.js";

/** Membership `where` fragment that drops soft-deleted workspaces. */
export const LIVE_WORKSPACE_MEMBERSHIP = { workspace: { deletedAt: null } } as const;

/**
 * #612 — a SCIM deprovision soft-deletes (or disables) the user but keeps their
 * membership rows, so the user must be live too, or a still-valid access token
 * would re-join the workspace's rooms on reconnect.
 */
const LIVE_MEMBER_USER = { user: { deletedAt: null, status: "active" } } as const;

/**
 * Workspace ids the user is a member of, excluding soft-deleted workspaces —
 * and none at all for a soft-deleted or disabled user (#612).
 */
export async function readLiveWorkspaceIds(userId: string): Promise<string[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, ...LIVE_WORKSPACE_MEMBERSHIP, ...LIVE_MEMBER_USER },
    select: { workspaceId: true },
  });
  return memberships.map((membership) => membership.workspaceId);
}
