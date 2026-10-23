/**
 * Issue #1431 — who a ChatOps identity binding (Teams AAD id, Slack user id) may
 * name, and when an existing binding may still act.
 *
 * A binding is made by an admin of ONE workspace (`requireWorkspaceRole("admin")`
 * on the route's `:workspaceId`) and is resolved by that workspace's bot. Before
 * #1431 the target only had to be an active user, so W's admin could bind their
 * own external id to anyone — a member of another workspace, a system admin —
 * and run commands as them. The rules here close that:
 *
 *   - BINDABLE: the target is an active user who is a member of the binding's
 *     workspace (a live, not soft-deleted workspace). Linking by email searches
 *     only that workspace's members.
 *   - SYSTEM ADMINS: a system admin is bindable only if a member, like anyone —
 *     and, being a member, only when the caller is itself a system admin
 *     (`allowSystemAdminTarget`). A workspace admin must not be able to pick up
 *     platform-wide rights through a chat account. Any assigned `admin` role
 *     counts, not just the first one the command path happens to read.
 *   - ACTING: at command time the bound user must STILL be an active member of
 *     the bot's workspace; a binding to someone who has left (or one written by
 *     the pre-#1431 route naming a non-member) stops resolving.
 *
 * Every refusal is indistinguishable to the caller from "no such user": the
 * functions return `null`/`false`, never a reason.
 */
import type { PrismaClient } from "@prisma/client";

/** The minimal projection a binding is written with. */
export interface BindableUser {
  id: string;
  email: string;
}

/** Live membership filter: active user, live workspace. */
function memberWhere(workspaceId: string) {
  return {
    workspaceId,
    workspace: { deletedAt: null },
    user: { deletedAt: null, status: "active" },
  };
}

/** Does any of the user's assigned roles carry the system `admin` key? */
async function holdsSystemAdminRole(db: PrismaClient, userId: string): Promise<boolean> {
  const row = await db.userRole.findFirst({
    where: { userId, role: { key: "admin" } },
    select: { userId: true },
  });
  return row !== null;
}

/** Is `userId` an active member of the live workspace `workspaceId`? */
export async function isActiveWorkspaceMember(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  if (!workspaceId || !userId) return false;
  const row = await db.workspaceMember.findFirst({
    where: { ...memberWhere(workspaceId), userId },
    select: { userId: true },
  });
  return row !== null;
}

/**
 * The member of `workspaceId` a binding may name, or `null` (refused, or no such
 * user — deliberately the same answer). Exactly one of `userId` / `email` is
 * expected; `email` matches case-insensitively among the workspace's members
 * only, preferring an exact match and refusing an ambiguous one.
 */
export async function findBindableWorkspaceUser(
  db: PrismaClient,
  params: {
    workspaceId: string;
    userId?: string;
    email?: string;
    allowSystemAdminTarget?: boolean;
  },
): Promise<BindableUser | null> {
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) return null;

  let user: BindableUser | null = null;
  if (params.userId) {
    const row = await db.workspaceMember.findFirst({
      where: { ...memberWhere(workspaceId), userId: params.userId },
      select: { user: { select: { id: true, email: true } } },
    });
    user = row?.user ?? null;
  } else if (params.email) {
    const email = params.email.trim().toLowerCase();
    if (!email) return null;
    const rows = await db.workspaceMember.findMany({
      where: memberWhere(workspaceId),
      select: { user: { select: { id: true, email: true } } },
    });
    const matches = rows.map((r) => r.user).filter((u) => u.email.toLowerCase() === email);
    user = matches.find((u) => u.email === email) ?? (matches.length === 1 ? matches[0]! : null);
  }
  if (!user) return null;

  if (!params.allowSystemAdminTarget && (await holdsSystemAdminRole(db, user.id))) return null;
  return user;
}
