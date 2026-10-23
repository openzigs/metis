/**
 * Issue #1437 — a ChatOps command acts only on projects in the workspace that
 * owns the bot (Teams) or the install (Slack).
 *
 * #1431 scoped the SENDER: a binding resolves only to a live member of the
 * bot's workspace. But that user may belong to other workspaces too, and every
 * command then authorized its target project (named explicitly, or reached
 * through a draft or a discussion thread) only through the user's own project
 * access. A dual member bound in W1 could read status for, and approve drafts
 * in, W2's projects through W1's bot; a system admin bound in W1 reached every
 * project. The bot's workspace is the boundary W1's admin vouched for when
 * binding the account, so it is the boundary the command acts within.
 *
 * The rule is strict equality on `Project.workspaceId`, the same one the
 * channel-link route applies when a thread is linked
 * (`routes/integrations/teams.ts`): a legacy workspace-less project is not in
 * any bot's workspace. It is checked at command time even for a target reached
 * through a link, because a project can move workspaces after it was linked
 * (#731, `PUT /projects/:id/workspace`).
 *
 * These are SCOPE checks, not authorization: callers still run the project
 * access rule. Soft deletion is left to that rule (admins keep access to a
 * soft-deleted project, #1430). Callers answer a miss with the refusal an
 * unknown id gets, so the reply is not an existence oracle across workspaces.
 */
import type { PrismaClient } from "@prisma/client";

/** Is `projectId` a project of `workspaceId`? Fails closed on a blank input. */
export async function isProjectInWorkspace(
  db: PrismaClient,
  workspaceId: string,
  projectId: string,
): Promise<boolean> {
  if (!workspaceId || !projectId) return false;
  const row = await db.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true },
  });
  return row !== null;
}

/** Is `threadId` a live discussion thread of a project in `workspaceId`? */
export async function isThreadInWorkspace(
  db: PrismaClient,
  workspaceId: string,
  threadId: string,
): Promise<boolean> {
  if (!workspaceId || !threadId) return false;
  const row = await db.discussionThread.findFirst({
    where: { id: threadId, deletedAt: null, project: { workspaceId } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The Prisma `where` for a live issue draft whose project is in `workspaceId` —
 * for the draft lookups the approve commands already make, so an out-of-scope
 * draft is simply not found.
 */
export function draftInWorkspaceWhere(draftId: string, workspaceId: string) {
  return { id: draftId, deletedAt: null, project: { workspaceId } };
}
