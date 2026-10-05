/**
 * Issue #281 / Epic #34 — User search endpoint for @mention autocomplete.
 *
 * Routes:
 *   GET /api/users?search=<q>&limit=<n>  — search ACTIVE users by username or
 *                                          displayName for the mention picker.
 *
 * Requires authentication. Only NON-sensitive fields (id, username,
 * displayName) are ever returned — password hashes, emails, roles and SSO
 * metadata are deliberately excluded. Queries are fully parameterised via
 * Prisma (no raw user input), so the `search` term cannot be used for
 * injection.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import type { Prisma } from "@prisma/client";
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../lib/prisma.js";
import { assertResourceProjectAccess } from "../lib/auth/resource-project-access.js";

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 8;

const searchQuerySchema = z.object({
  search: z.string().trim().max(100).optional().default(""),
  // Page size: default 8 (matches the MentionInput dropdown). An out-of-range
  // or non-numeric value is clamped into [1, 25] rather than rejected, so a
  // generous client `limit` never 400s the autocomplete.
  limit: z.coerce
    .number()
    .optional()
    .transform((n) => {
      if (n === undefined || Number.isNaN(n)) return DEFAULT_LIMIT;
      const floored = Math.floor(n);
      return Math.min(Math.max(floored, 1), MAX_LIMIT);
    }),
  /** #734 — restrict the picker to users who can open this project. */
  projectId: z.string().trim().min(1).max(100).optional(),
});

/** System admins open every project (`assertProjectAccess`'s bypass). */
const SYSTEM_ADMIN: Prisma.UserWhereInput = { roles: { some: { role: { key: "admin" } } } };

/**
 * #734 — the users who can open `projectId`, as a `User` filter. Mirrors who a
 * comment or discussion @mention is delivered to (`assertProjectAccess` plus
 * "not soft-deleted", via `canAccessProjectDiscussions`): system admins, plus
 * the live members of a live workspace — or everyone for a legacy project with
 * no workspace. A soft-deleted project offers system admins only, and only to
 * a system admin.
 *
 * @throws AppError 404 — unknown project, the caller cannot open it, or it is
 *   soft-deleted and the caller is not a system admin
 */
async function mentionAudienceWhere(
  user: AuthPayload | undefined,
  projectId: string,
): Promise<Prisma.UserWhereInput> {
  await assertResourceProjectAccess(user, projectId, projectNotFound);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, deletedAt: true, workspace: { select: { deletedAt: true } } },
  });
  if (!project) throw projectNotFound();
  if (project.deletedAt || project.workspace?.deletedAt) {
    // A soft-deleted project is the unknown-project 404 to everyone but a
    // system admin — the comment routes answer it the same way
    // (`canAccessProjectDiscussions`), and a 200 here would list the admins.
    if (user?.role !== "admin") throw projectNotFound();
    return SYSTEM_ADMIN;
  }
  if (!project.workspaceId) return {};
  return {
    OR: [{ workspaceMemberships: { some: { workspaceId: project.workspaceId } } }, SYSTEM_ADMIN],
  };
}

function projectNotFound(): AppError {
  return new AppError(404, "NOT_FOUND", "Project not found");
}

export function usersRouter(): Router {
  const r = Router();

  /** GET /api/users — search active users for the @mention picker. */
  r.get("/", requireAuth, async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");

    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid user search query", {
        issues: parsed.error.flatten(),
      });
    }

    const { search, limit, projectId } = parsed.data;

    // #734 — scoped to a project, the picker offers only the users who can
    // open it, so an @mention never targets someone it cannot notify. The
    // caller must be able to open the project themselves (the seam's 404
    // otherwise, as for an unknown id), or this would list another tenant's
    // members.
    const audience = projectId ? await mentionAudienceWhere(req.user, projectId) : null;

    // SQLite `LIKE` is case-insensitive for ASCII, so a plain `contains` filter
    // gives prefix/substring matching without the Postgres-only
    // `mode: "insensitive"` option. The term is passed as a bound parameter by
    // Prisma — it is never interpolated into raw SQL.
    // `deletedAt: null` matches mention delivery (`LIVE_MEMBER_USER`): a
    // SCIM soft-deleted user whose status is still active is never notified,
    // so the picker must not offer them either.
    const where: Prisma.UserWhereInput = {
      status: "active",
      deletedAt: null,
      ...(audience ? { AND: [audience] } : {}),
      ...(search
        ? {
            OR: [{ username: { contains: search } }, { displayName: { contains: search } }],
          }
        : {}),
    };

    const users = await prisma.user.findMany({
      where,
      // Never expose passwordHash, email, role, or SSO fields.
      select: { id: true, username: true, displayName: true },
      orderBy: { username: "asc" },
      take: limit,
    });

    res.json({ success: true, data: users });
  });

  return r;
}
