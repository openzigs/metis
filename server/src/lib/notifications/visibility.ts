/**
 * #1447 — a stored notification is shown only while its reader can still open
 * the project it is about.
 *
 * A notification is written when its recipient can read the project (each
 * writer checks: #734 comment mentions, #104 discussion mentions and reviews,
 * #1432 SLA alerts), but the row outlives that: the reader can be removed from
 * the workspace, the project can move to another workspace, or the project can
 * be soft-deleted (#1430). Its title, message and link quote the project, so
 * every read path re-checks access before returning a row.
 *
 * ## Rule
 *
 * - The check is the canonical list predicate, `workspaceScopeWhere`
 *   (`lib/auth/project-scope.ts`): an admin sees every project, deleted ones
 *   included; anyone else sees live open projects and live projects in a live
 *   workspace whose membership row they still hold.
 * - ONE `project.findMany` per page, over the page's distinct project ids — never
 *   a lookup per row.
 * - A row the reader can no longer open is REDACTED, not hidden: it keeps its
 *   id, read flag and timestamp, so the unread count still counts exactly the
 *   rows the list can return, and marking it read still works. Its title becomes
 *   {@link REDACTED_TITLE}; its message, link, payload and comment id are
 *   cleared; its type becomes {@link REDACTED_TYPE}, since the type alone can
 *   say "your review was rejected".
 * - Fail closed: a row with no project (written before #1447 and not
 *   recoverable by the backfill, e.g. its target since hard-deleted) is
 *   redacted for everyone, admins included.
 */
import { prisma } from "../prisma.js";
import { workspaceScopeWhere, type ProjectScopeActor } from "../auth/project-scope.js";

/** The neutral title a redacted notification shows. */
export const REDACTED_TITLE = "Notification unavailable";
/** The type a redacted notification reports in place of its own. */
export const REDACTED_TYPE = "unavailable";

/** The columns this module reads and rewrites on a stored notification. */
export interface StoredNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  href: string | null;
  payload: string | null;
  commentId?: string | null;
  projectId: string | null;
}

/** A notification as returned to its reader, with whether it was redacted. */
export type VisibleNotification<T extends StoredNotification> = Omit<T, "projectId"> & {
  redacted: boolean;
};

/**
 * The subset of `projectIds` the actor can open right now — one query.
 */
export async function openableProjectIds(
  actor: ProjectScopeActor,
  projectIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return new Set();
  const rows = await prisma.project.findMany({
    where: { id: { in: ids }, ...workspaceScopeWhere(actor) },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** The redacted form of one row: nothing that names or links the project. */
function redact<T extends StoredNotification>(row: T): VisibleNotification<T> {
  const { projectId: _projectId, ...rest } = row;
  return {
    ...rest,
    type: REDACTED_TYPE,
    title: REDACTED_TITLE,
    message: "",
    href: null,
    payload: null,
    ...("commentId" in row ? { commentId: null } : {}),
    redacted: true,
  };
}

/**
 * Apply the reader's CURRENT project access to a page of their notifications:
 * rows they can still open come back unchanged, the rest redacted. One project
 * query for the whole page. `projectId` is not returned — it is the check's
 * input, not part of the drawer's contract.
 */
export async function applyNotificationAccess<T extends StoredNotification>(
  actor: ProjectScopeActor,
  rows: readonly T[],
): Promise<Array<VisibleNotification<T>>> {
  const open = await openableProjectIds(
    actor,
    rows.flatMap((r) => (r.projectId ? [r.projectId] : [])),
  );
  return rows.map((row) => {
    if (row.projectId && open.has(row.projectId)) {
      const { projectId: _projectId, ...rest } = row;
      return { ...rest, redacted: false };
    }
    return redact(row);
  });
}
