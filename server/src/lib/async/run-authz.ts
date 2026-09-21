/**
 * Epic #1051 / Issue #1056 — cross-tenant guard for the `/api/runs` background
 * runner routes.
 *
 * `backgroundRunsRouter()` is not mounted under `/projects/:projectId`, so the
 * `requireProjectAccess()` chokepoint (#674) cannot be used: every route
 * addresses a run (or run group) by primary key alone. The owning project has
 * to be resolved from the row first, then authorized through the same
 * `assertProjectAccess` seam that #674, #1052, #1053 and #1055 standardized on.
 *
 * The resolved projectId is returned so the caller can thread it into the
 * follow-up query — that way the tenant scope lives in the Prisma `where`, not
 * only at the router. `undefined` means "system admin, no narrowing", mirroring
 * the admin bypass inside `assertProjectAccess` (and keeping the extra query
 * off the admin path).
 *
 * Out-of-tenant ids and unknown ids produce the *same* 404 envelope — including
 * the pre-existing `RUN_NOT_FOUND` / `GROUP_NOT_FOUND` codes — so the error
 * channel cannot be used as an existence oracle.
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { assertProjectAccess } from "../custom-agents/authz.js";

/** Prisma `where` fragment narrowing runs/groups to the caller's projects. */
export type RunProjectScope =
  | Record<string, never>
  | { project: { OR: Array<{ workspaceId: null } | { workspaceId: { in: string[] } }> } };

async function authorizeRow(
  user: AuthPayload | undefined,
  lookup: () => Promise<{ projectId: string } | null>,
  notFound: () => AppError,
): Promise<string | undefined> {
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  if (user.role === "admin") return undefined;

  const row = await lookup();
  if (!row) throw notFound();

  try {
    await assertProjectAccess(user, row.projectId);
  } catch (err) {
    // "project missing" and "caller is not a workspace member" both surface as
    // a 404 from the seam — collapse them into the run-level 404 so an
    // out-of-tenant id is indistinguishable from a nonexistent one.
    if (err instanceof AppError && err.statusCode === 404) throw notFound();
    throw err;
  }

  return row.projectId;
}

/**
 * Authorize `user` against the project that owns background run `runId`.
 *
 * @returns the owning projectId to scope the follow-up query with, or
 *          `undefined` for system admins.
 * @throws AppError 401 — no authenticated user
 * @throws AppError 404 — unknown run OR caller cannot reach its project
 */
export function authorizeBackgroundRun(
  user: AuthPayload | undefined,
  runId: string,
): Promise<string | undefined> {
  return authorizeRow(
    user,
    () => prisma.backgroundRun.findUnique({ where: { id: runId }, select: { projectId: true } }),
    () => new AppError(404, "RUN_NOT_FOUND", "Background run not found"),
  );
}

/**
 * Authorize `user` against the project that owns run group `groupId`. Same
 * contract as {@link authorizeBackgroundRun}.
 */
export function authorizeRunGroup(
  user: AuthPayload | undefined,
  groupId: string,
): Promise<string | undefined> {
  return authorizeRow(
    user,
    () => prisma.runGroup.findUnique({ where: { id: groupId }, select: { projectId: true } }),
    () => new AppError(404, "GROUP_NOT_FOUND", "Run group not found"),
  );
}

/**
 * Assert access to a caller-supplied `projectId` (submit / list filter), so a
 * workspace-B caller cannot queue work under — or enumerate runs of — a
 * workspace-A project id.
 *
 * @throws AppError 401 — no authenticated user
 * @throws AppError 404 — unknown project OR caller cannot reach it
 */
export async function authorizeRunProject(
  user: AuthPayload | undefined,
  projectId: string,
): Promise<void> {
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  await assertProjectAccess(user, projectId);
}

/**
 * Prisma `where` fragment matching every project the caller can reach. `{}`
 * for system admins; otherwise the caller's workspaces plus the pre-migration
 * `workspaceId === null` projects that `assertProjectAccess` leaves open.
 *
 * Used by the unfiltered list route, which would otherwise return every
 * tenant's runs.
 */
export function runProjectScope(user: AuthPayload | undefined): RunProjectScope {
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  if (user.role === "admin") return {};
  return {
    project: { OR: [{ workspaceId: null }, { workspaceId: { in: user.workspaces ?? [] } }] },
  };
}
