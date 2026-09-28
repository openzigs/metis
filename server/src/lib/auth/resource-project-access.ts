/**
 * #334 — object-level project check for by-id routes mounted OUTSIDE
 * `/api/projects`.
 *
 * Those routes address a project-scoped row by its own id, so the
 * `requireProjectAccess()` chokepoint (which reads `:projectId` from the path)
 * never runs. The caller resolves the row's project from the row itself and
 * passes it here; this applies the canonical `assertProjectAccess` rule
 * (`lib/custom-agents/authz.ts`) and collapses every refusal into the route's
 * OWN not-found error, so a row in a project the caller cannot reach is
 * indistinguishable from an unknown id.
 *
 * - System admins bypass, as `assertProjectAccess` does.
 * - A row that resolves to no project is refused for non-admins (fail closed —
 *   never widened).
 * - Legacy projects with no workspace stay reachable, exactly as
 *   `assertProjectAccess` rules.
 */
import type { AuthPayload } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { assertProjectAccess } from "../custom-agents/authz.js";

export async function assertResourceProjectAccess(
  user: AuthPayload | undefined,
  projectId: string | null | undefined,
  notFound: () => AppError,
): Promise<void> {
  if (!user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  if (user.role === "admin") return;
  if (!projectId) throw notFound();
  try {
    await assertProjectAccess(user, projectId);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) throw notFound();
    throw err;
  }
}
