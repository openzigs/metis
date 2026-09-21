/**
 * Epic #475 (Phase 1, #477) — discussion-thread membership / authorization.
 *
 * `canAccessThread` is the SINGLE SOURCE OF TRUTH for "may this actor touch this
 * thread?", shared by every discussions REST endpoint and the socket
 * `subscribe:thread` handler. It mirrors the project-room authz the socket layer
 * already uses (`server/src/lib/socket/server.ts:134`): resolve the thread's
 * `projectId`, then delegate to `actorCanAccessProject` (member-or-admin), which
 * also writes an `AuditLog` row on denial.
 *
 * Two behaviours beyond a plain project check:
 *   - Soft-deleted threads (`deletedAt != null`) and missing ids are treated as
 *     NOT FOUND — we never run the project lookup for them, so a deleted/unknown
 *     thread cannot leak project membership through a 403-vs-404 distinction.
 *   - A not-found probe is itself audited, so security can trace enumeration
 *     attempts (mirrors the delegate's denial-audit behaviour).
 */
import { prisma } from "../prisma.js";
import { actorCanAccessProject } from "../scheduler/project-access.js";
import { audit } from "../audit/audit-service.js";
import type { RoleKey } from "@metis/shared";

export interface ThreadActor {
  id: string;
  role: RoleKey;
}

export type ThreadAccessResult =
  | { ok: true; projectId: string }
  | { ok: false; reason: "not_found" | "forbidden" };

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
 * - Caller lacks project access     → `{ ok: false, reason: "forbidden" }`
 *   (the delegate audits the denial).
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

  const allowed = await actorCanAccessProject(actor, thread.projectId, {
    resource: "discussion_thread",
    resourceId: threadId,
    action: "discussion.thread.access",
  });

  if (!allowed) {
    return { ok: false, reason: "forbidden" };
  }

  return { ok: true, projectId: thread.projectId };
}
