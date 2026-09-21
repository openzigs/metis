/**
 * Issue #1118 (epic #1051) — cross-tenant IDOR guard for the requirements
 * collaboration router.
 *
 * `/api/requirements` is mounted with **no `:projectId` segment**
 * (`routes/index.ts`), so the `requireProjectAccess()` chokepoint (#674) cannot
 * be mounted here: the owning project is not known until a row is read. This is
 * the same shape as `/api/jira`, `/api/test-management` (#1055) and `/api/runs`
 * (#1056), and it is resolved the same way — resolve the requirement, walk to
 * its own `projectId`, and authorize through the canonical `assertProjectAccess`
 * seam (`lib/custom-agents/authz.ts`).
 *
 * Two conventions are inherited from that seam and must not drift:
 *   • system admins bypass entirely (and the resolve query is skipped for them);
 *   • pre-migration projects with `workspaceId === null` stay open to any
 *     authenticated caller.
 *
 * An out-of-tenant id and an unknown id produce the *same* 404 envelope
 * (`REQUIREMENT_NOT_FOUND`), so the error channel is not an existence oracle.
 *
 * The resolved projectId is handed back on the request (`requirementProjectId`)
 * so handlers can thread it into their own lookups — that way the scope lives
 * in the query, not only in the router. `undefined` means "system admin, no
 * narrowing".
 */
import type { Request, RequestHandler } from "express";
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { assertProjectAccess } from "../custom-agents/authz.js";

/** A request that has passed {@link requireRequirementAccess}. */
export interface RequirementScopedRequest extends Request {
  /** Owning projectId of `:requirementId`; `undefined` for system admins. */
  requirementProjectId?: string;
}

function requirementNotFound(): AppError {
  return new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
}

/**
 * Authorize `user` against the project that owns requirement `requirementId`.
 *
 * Existence semantics deliberately stay with each route's own loader: this
 * resolver only answers "which project owns this id", so it does not filter on
 * `deletedAt` — a soft-deleted requirement still 404s from the handler that
 * loads it, exactly as before.
 *
 * @returns the owning projectId to narrow the handler's query with, or
 *          `undefined` for system admins.
 * @throws AppError 401 — no authenticated user
 * @throws AppError 404 — unknown requirement OR caller cannot reach its project
 */
export async function assertRequirementAccessible(
  user: AuthPayload | undefined,
  requirementId: string,
): Promise<string | undefined> {
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  if (user.role === "admin") return undefined;

  const row = await prisma.requirement.findUnique({
    where: { id: requirementId },
    select: { projectId: true },
  });
  if (!row) throw requirementNotFound();

  try {
    await assertProjectAccess(user, row.projectId);
  } catch (err) {
    // "project missing" and "caller is not a workspace member" both surface as a
    // 404 from the seam — collapse them into the requirement-level 404 so an
    // out-of-tenant id is byte-identical to a nonexistent one. Non-404 failures
    // (DB faults, etc.) propagate untouched so a real error is never masked.
    if (err instanceof AppError && err.statusCode === 404) throw requirementNotFound();
    throw err;
  }

  return row.projectId;
}

/**
 * Router-level guard for every `/:requirementId` route on the collaboration
 * mount. Mounted ahead of the routes it protects so it also covers the
 * optimistic-lock loader, which would otherwise read a foreign row (and leak
 * its field values through the 409 conflict diff) before any handler runs.
 */
export const requireRequirementAccess: RequestHandler = async (req, _res, next) => {
  try {
    (req as RequirementScopedRequest).requirementProjectId = await assertRequirementAccessible(
      req.user,
      String(req.params.requirementId),
    );
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * The project scope resolved by {@link requireRequirementAccess}, as a Prisma
 * `where` fragment. Empty for system admins (no narrowing), mirroring the
 * bypass inside `assertProjectAccess`.
 */
export function requirementScopeWhere(req: Request): { projectId?: string } {
  const projectId = (req as RequirementScopedRequest).requirementProjectId;
  return projectId ? { projectId } : {};
}
