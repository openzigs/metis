/**
 * Epic #475 (Phase 1, #477) — discussion-thread authorization.
 *
 * `canAccessThread` is the SINGLE SOURCE OF TRUTH for "may this actor touch this
 * thread?", shared by every discussions REST endpoint, the socket
 * `subscribe:thread` handler, presence and the Teams bridge.
 *
 * #734 — it delegates to the canonical project-access seam,
 * `assertProjectAccess` (`lib/custom-agents/authz.ts`), the rule behind
 * `requireProjectAccess` and `GET /projects/:id`. It used to delegate to the
 * scheduler's `actorCanAccessProject`, which for a non-admin admits only
 * projects the actor CREATED, so a discussion's audience was "its creator plus
 * admins" while the project itself was visible to its whole workspace. The rule
 * is not restated here; this module only adapts its inputs:
 *
 *   - The workspace claim comes from the caller when it has a verified one
 *     (`req.user.workspaces`, as `requireProjectAccess` uses it); otherwise — socket,
 *     Teams, a mentioned third party — it is read from the database through
 *     `readLiveWorkspaceIds`, the same resolution the search scope uses.
 *   - A soft-deleted project stays closed to non-admins, as it was under the
 *     previous rule (`assertProjectAccess` does not read `deletedAt`).
 *
 * Soft-deleted threads and missing ids are NOT FOUND — no project lookup runs,
 * so a deleted or unknown thread cannot leak project membership. Every denial is
 * audited so security can trace enumeration attempts.
 */
import type { AuthPayload, RoleKey } from "@metis/shared";
import { prisma } from "../prisma.js";
import { assertProjectAccess } from "../custom-agents/authz.js";
import { readLiveWorkspaceIds } from "../auth/live-workspace-ids.js";
import { AppError } from "../../middleware/error-handler.js";
import { audit } from "../audit/audit-service.js";

export interface ThreadActor {
  id: string;
  role: RoleKey;
  /**
   * The caller's verified workspace claim, when it has one. Absent ⇒ read from
   * the database (`readLiveWorkspaceIds`).
   */
  workspaces?: readonly string[];
}

export type ThreadAccessResult =
  { ok: true; projectId: string } | { ok: false; reason: "not_found" | "forbidden" };

/** What a denial is audited as; omitted for a third-party eligibility check. */
export interface AccessAuditContext {
  resource: string;
  resourceId: string;
  action: string;
}

async function asAuthPayload(actor: ThreadActor): Promise<AuthPayload> {
  const workspaces = actor.workspaces
    ? [...actor.workspaces]
    : await readLiveWorkspaceIds(actor.id);
  // `assertProjectAccess` reads only `role`, `userId` and `workspaces`.
  return { userId: actor.id, username: "", role: actor.role, permissions: [], workspaces };
}

/**
 * May `actor` read and post in `projectId`'s discussions? The project-access
 * rule (`assertProjectAccess`) plus "the project is not soft-deleted" for
 * non-admins. Returns `false` (audited when `auditCtx` is given) on denial;
 * rethrows anything that is not a denial.
 */
export async function canAccessProjectDiscussions(
  actor: ThreadActor,
  projectId: string,
  auditCtx?: AccessAuditContext,
): Promise<boolean> {
  if (actor.role === "admin") return true;
  const deny = (): false => {
    if (auditCtx) {
      audit({
        actor: { id: actor.id },
        action: `${auditCtx.action}.denied`,
        target: { type: auditCtx.resource, id: auditCtx.resourceId },
        metadata: { reason: "project-access-denied", projectId },
      });
    }
    return false;
  };

  const live = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!live) return deny();

  try {
    await assertProjectAccess(await asAuthPayload(actor), projectId);
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return deny();
    throw err;
  }
}

/**
 * Resolve the `projectId` of a live (non-soft-deleted) thread, or `null` when
 * the thread is missing or soft-deleted.
 */
export async function resolveThreadProjectId(threadId: string): Promise<string | null> {
  const thread = await prisma.discussionThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true, projectId: true },
  });
  return thread?.projectId ?? null;
}

/**
 * Decide whether `actor` may access `threadId`.
 *
 * - Missing / soft-deleted thread → `{ ok: false, reason: "not_found" }` (audited).
 * - Caller lacks project access     → `{ ok: false, reason: "forbidden" }` (audited).
 * - Otherwise                       → `{ ok: true, projectId }`.
 */
export async function canAccessThread(
  actor: ThreadActor,
  threadId: string,
): Promise<ThreadAccessResult> {
  const thread = await prisma.discussionThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true, projectId: true },
  });

  if (!thread) {
    audit({
      actor: { id: actor.id },
      action: "discussion.thread.access.denied",
      target: { type: "discussion_thread", id: threadId },
      metadata: { reason: "thread-not-found" },
    });
    return { ok: false, reason: "not_found" };
  }

  const allowed = await canAccessProjectDiscussions(actor, thread.projectId, {
    resource: "discussion_thread",
    resourceId: threadId,
    action: "discussion.thread.access",
  });

  if (!allowed) {
    return { ok: false, reason: "forbidden" };
  }

  return { ok: true, projectId: thread.projectId };
}
