/**
 * Epic #671 / #674 — object-level project scope for the `/projects/:projectId/*`
 * subtree (OWASP A01 / BOLA).
 *
 * The project-scoped routers (connectors, documents, analyses, generated-docs,
 * templates, and the project sub-resource handlers) previously gated only on
 * role (`requirePermission`). They never verified the caller could actually
 * reach the target project, so an authenticated user could supply another
 * tenant's `projectId` (or a resource id resolvable to one) and the role check
 * alone admitted the request.
 *
 * This middleware routes every such route through the canonical
 * `assertProjectAccess(user, projectId)` seam established by #673 — the SAME
 * object-level check used by `GET/PATCH /projects/:id`, the custom-agents invoke
 * route, and the comments routes. It resolves the target project's workspace and
 * intersects it with the caller's memberships:
 *
 *   • non-member (or unknown project)  → 404 (NOT 403 — no existence oracle)
 *   • system admin                     → bypass
 *   • pre-migration null-workspace     → open to any authenticated user
 *
 * The existing `requirePermission(...)` role layer is retained; this workspace
 * scope is the NEW object-level layer that runs first (so a wrong-tenant caller
 * gets a 404 regardless of role, keeping denials indistinguishable).
 */
import type { Request, Response, NextFunction } from "express";
import { assertProjectAccess } from "../lib/custom-agents/authz.js";
import { AppError } from "./error-handler.js";

/**
 * Build an Express middleware that asserts the caller may access the project
 * identified by `req.params[paramName]`.
 *
 * @param paramName path parameter carrying the project id. Defaults to
 *   `projectId` (the `/projects/:projectId/*` subtree); pass `"id"` for the
 *   `projectsRouter` `/:id` subtree where the project is the primary resource.
 */
export function requireProjectAccess(paramName = "projectId") {
  return function requireProjectAccessMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    if (!req.user) {
      next(new AppError(401, "AUTH_REQUIRED", "Authentication required"));
      return;
    }
    // mergeParams / wildcard `.use` can surface an array param — take the first.
    const raw = req.params[paramName];
    const projectId = Array.isArray(raw) ? raw[0] : raw;
    if (!projectId) {
      next(new AppError(400, "PROJECT_REQUIRED", "projectId path parameter is required"));
      return;
    }
    assertProjectAccess(req.user, String(projectId))
      .then(() => next())
      .catch(next);
  };
}
