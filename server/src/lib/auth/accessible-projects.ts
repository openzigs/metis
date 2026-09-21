/**
 * Issue #533 — accessible-projects helper for cross-project federated search.
 * Issue #1052 (finding F4, epic #1051) — workspace scoping.
 *
 * This helper resolves which projects a caller may search. It is the SOLE
 * authorization gate for `/api/search/projects` and `/api/search/federated`
 * (and for the `search-knowledge-global` AI tool), so whatever it returns is
 * exactly what the caller can read RAG chunk text out of.
 *
 * It previously ignored its `userId` argument and returned every non-archived
 * project in the deployment, on the stated grounds that "the schema has no
 * per-project membership table". That is no longer true: `Project.workspaceId`
 * and `WorkspaceMember` exist (Epic #759), and every other project-scoped
 * surface already intersects against them. The scope rule below is therefore
 * the SAME one `assertProjectAccess` / `requireProjectAccess` enforce:
 *
 *   • system admin                    → sees every non-deleted project
 *   • pre-migration null-workspace    → open to any authenticated user
 *   • everyone else                   → only their own workspaces' projects
 *
 * Cross-tenant projects are simply ABSENT from the result — search never
 * signals that another tenant's project exists (no existence oracle), matching
 * the 404-not-403 posture of the route-level middleware.
 */
import type { AuthPayload, RoleKey } from "@metis/shared";
import { prisma } from "../prisma.js";
import { accessibleProjectWhere } from "../acp/authz.js";

export interface AccessibleProject {
  id: string;
  name: string;
}

/**
 * Resolve the caller's role + workspace memberships from the database.
 *
 * Deliberately DB-sourced rather than JWT-sourced: this helper is reached both
 * from an HTTP route (which has `req.user`) and from the `search-knowledge-global`
 * AI tool (whose `ToolContext` carries only a `userId`), so a single
 * authoritative resolution keeps one code path for both. It mirrors the login
 * path in `routes/auth.ts` and `resolveAcpActor` in `lib/acp/authz.ts`: an
 * unassigned user falls back to the least-privileged `reader` so a missing role
 * row can never confer the admin bypass.
 */
async function resolveActor(userId: string): Promise<AuthPayload> {
  const [userRole, memberships] = await Promise.all([
    prisma.userRole.findFirst({ where: { userId }, include: { role: true } }),
    prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } }),
  ]);
  return {
    userId,
    username: "",
    role: (userRole?.role.key as RoleKey | undefined) ?? "reader",
    // Only `role` + `workspaces` are read by the scope rule.
    permissions: [],
    workspaces: memberships.map((m) => m.workspaceId),
  };
}

/**
 * Returns the non-deleted, non-archived projects the given user may access,
 * scoped to their workspace memberships (admins bypass; workspace-less projects
 * stay open).
 */
export async function getUserAccessibleProjects(userId: string): Promise<AccessibleProject[]> {
  if (!userId) return [];

  const actor = await resolveActor(userId);

  const projects = await prisma.project.findMany({
    where: {
      ...accessibleProjectWhere(actor),
      status: { not: "archived" },
    },
    select: { id: true, name: true },
    orderBy: { updatedAt: "desc" },
  });

  return projects;
}
