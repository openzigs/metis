/**
 * Canonical workspace-visibility predicate — Issue #1066.
 *
 * There is exactly ONE rule for "which projects may this actor see", and this
 * module is it. Everything that scopes a project list must build on
 * `workspaceScopeWhere` rather than hand-rolling the fragment again:
 *
 *   • admin                        → every project (no workspace filter at all)
 *   • workspace-less project       → open to any authenticated user
 *                                    (pre-migration rows, Epic #759)
 *   • everyone else                → projects in workspaces they belong to
 *
 * This mirrors the single-project twin `assertProjectAccess`
 * (`lib/custom-agents/authz.ts`), which the `requireProjectAccess` middleware
 * (`middleware/require-project-access.ts`) applies to every
 * `/projects/:projectId/**` route. Both let workspace-less projects through.
 *
 * ## Why this module exists
 *
 * The rule used to be written out twice, and the two copies disagreed. The
 * now-deleted `workspaceScopeFilter` returned `{ workspaceId: { in: workspaces } }`
 * for a member — silently EXCLUDING workspace-less open projects — while
 * `accessibleProjectWhere` (`lib/acp/authz.ts`) returned the `OR` form that
 * includes them. Worse, the member-less branch returned `{ workspaceId: null }`
 * under a comment claiming it "matched nothing", when as a Prisma `where` that
 * clause matches every open project. The two copies coincided only for a
 * member-less actor, so the wrong one read as confirmation of the right one.
 *
 * `workspaceScopeFilter` was first made an alias of this module (#1066) and
 * then deleted outright (#1083), because the audit that found it wrong also
 * found that NOTHING under `server/src` imported it — it, and the unmounted
 * `requireWorkspaceAccess` middleware it lived beside, only ever described
 * behaviour rather than performing it. `server/tests/unmounted-middleware.test.ts`
 * now fails the build if another guard reaches that state.
 *
 * ## Which helper to reach for
 *
 * | Need                                                  | Use |
 * |-------------------------------------------------------|-----|
 * | A bare workspace predicate to merge into your own `where` | `workspaceScopeWhere` (here) |
 * | A ready `where` for `prisma.project` (adds `deletedAt: null`) | `accessibleProjectWhere` (`lib/acp/authz.ts`) |
 * | The concrete list of ids                              | `listAccessibleProjectIds` (`lib/acp/authz.ts`) |
 * | Guard one project by id on a request                  | `assertProjectAccess` / `requireProjectAccess` |
 *
 * Note that `lib/scheduler/project-access.ts` exports a same-named
 * `listAccessibleProjectIds` that is a DIFFERENT predicate (creator-ownership,
 * not workspace membership) for scheduler/task rows. It is not part of this
 * unification; check the import path before assuming which one you have.
 */

/** Minimal actor shape the visibility rule reads: role + workspace ids. */
export interface ProjectScopeActor {
  role: string;
  workspaces?: string[] | null;
}

/**
 * A Prisma `where` fragment over `Project.workspaceId`. Either empty (admin —
 * imposes no constraint) or a positive `OR` of "open" and "mine".
 */
export type WorkspaceScopeWhere =
  | Record<string, never>
  | { OR: Array<{ workspaceId: null } | { workspaceId: { in: string[] } }> };

/**
 * Build the workspace-visibility fragment for `actor`.
 *
 * Returns `{}` for admins (spread into a larger `where`, this adds nothing and
 * so matches every row). For everyone else it returns the positive `OR`
 * fragment — open projects plus the actor's own workspaces. A member-less
 * actor therefore still sees open projects; the empty `in` list contributes
 * nothing, which is the only branch that can legitimately be described as
 * "matches nothing".
 */
export function workspaceScopeWhere(actor: ProjectScopeActor): WorkspaceScopeWhere {
  // Admins see everything — impose no workspace constraint.
  if (actor.role === "admin") return {};

  const workspaces = actor.workspaces ?? [];
  return { OR: [{ workspaceId: null }, { workspaceId: { in: workspaces } }] };
}
