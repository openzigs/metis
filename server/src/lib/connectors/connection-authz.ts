/**
 * Epic #1051 / Issue #1055 — cross-project IDOR guard for the connection
 * routers that are **not** mounted under `/projects/:projectId`.
 *
 * `/api/jira` and `/api/test-management` address connections by primary key
 * alone, so the `requireProjectAccess()` chokepoint (#674) cannot simply be
 * mounted: the owning project has to be resolved from the connection row
 * first, then authorized through the same `assertProjectAccess` seam that
 * #674, #1052 and #1053 standardized on.
 *
 * The resolved projectId is returned so the caller can thread it into the
 * service lookup — that way the scope lives in the query, not only in the
 * router. `undefined` means "system admin, no narrowing", mirroring the admin
 * bypass inside `assertProjectAccess` (and keeping the extra query off the
 * admin path).
 *
 * Out-of-tenant ids and unknown ids produce the *same* 404 envelope, so the
 * error channel cannot be used as an existence oracle.
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { assertProjectAccess } from "../custom-agents/authz.js";

async function authorizeConnection(
  user: AuthPayload | undefined,
  lookup: () => Promise<{ projectId: string } | null>,
  notFoundMessage: string,
): Promise<string | undefined> {
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  if (user.role === "admin") return undefined;

  const notFound = (): AppError => new AppError(404, "NOT_FOUND", notFoundMessage);

  const row = await lookup();
  if (!row) throw notFound();

  try {
    await assertProjectAccess(user, row.projectId);
  } catch (err) {
    // "project missing" and "caller is not a workspace member" both surface as
    // a 404 from the seam — collapse them into the connection-level 404 so an
    // out-of-tenant id is indistinguishable from a nonexistent one.
    if (err instanceof AppError && err.statusCode === 404) throw notFound();
    throw err;
  }

  return row.projectId;
}

/**
 * Authorize `user` against the project that owns Jira connection
 * `connectionId`.
 *
 * @returns the owning projectId to scope the service lookup with, or
 *          `undefined` for system admins.
 * @throws AppError 401 — no authenticated user
 * @throws AppError 404 — unknown connection OR caller cannot reach its project
 */
export function authorizeJiraConnection(
  user: AuthPayload | undefined,
  connectionId: string,
): Promise<string | undefined> {
  return authorizeConnection(
    user,
    () =>
      prisma.jiraConnection.findFirst({
        where: { id: connectionId, deletedAt: null },
        select: { projectId: true },
      }),
    "Jira connection not found",
  );
}

/**
 * Authorize `user` against the project that owns test-management connection
 * `connectionId`. Same contract as {@link authorizeJiraConnection}.
 */
export function authorizeTestManagementConnection(
  user: AuthPayload | undefined,
  connectionId: string,
): Promise<string | undefined> {
  return authorizeConnection(
    user,
    () =>
      prisma.testManagementConnection.findFirst({
        where: { id: connectionId, deletedAt: null },
        select: { projectId: true },
      }),
    "Test management connection not found",
  );
}
