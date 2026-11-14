/**
 * #2331 — the projects `metis-index-mcp` serves: the ones the caller may access
 * (`accessibleProjectWhere`, the rule every project-scoped surface uses) that
 * are not archived. `metis_list_projects` lists exactly these, and a
 * project-scoped tool answers any other id as not found, so "a project not
 * listed is not one you can read" holds for an archived or soft-deleted project
 * too — and for an admin, whom the membership check lets through either.
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../../lib/prisma.js";
import { accessibleProjectWhere } from "../../lib/acp/authz.js";

/** The `where` over `prisma.project` for the projects the server lists and serves. */
export function servedProjectWhere(actor: AuthPayload): Record<string, unknown> {
  return { ...accessibleProjectWhere(actor), status: { not: "archived" } };
}

/** Whether `projectId` is one the server lists for `actor`. */
export async function isServedProject(actor: AuthPayload, projectId: string): Promise<boolean> {
  const row = await prisma.project.findFirst({
    where: { ...servedProjectWhere(actor), id: projectId },
    select: { id: true },
  });
  return row !== null;
}
