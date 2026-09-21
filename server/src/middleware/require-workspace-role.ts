/**
 * Workspace role-based access control middleware (Epic #759, Issue #764).
 *
 * Enforces that the requesting user has a specific role (owner, admin, or
 * member) within the target workspace.
 */
import type { RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { AppError } from "./error-handler.js";

export type WorkspaceRole = "owner" | "admin" | "member";

const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  member: 10,
  admin: 20,
  owner: 30,
};

/**
 * Middleware factory that requires the caller to have at minimum the specified
 * workspace role. Checks `req.params.workspaceId` (or `req.params.id` on
 * workspace routes).
 *
 * System admins (role === "admin") bypass workspace role checks.
 */
export function requireWorkspaceRole(minRole: WorkspaceRole): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!req.user) {
        throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      }

      // System admins bypass workspace RBAC
      if (req.user.role === "admin") {
        return next();
      }

      const workspaceId = (req.params.workspaceId ?? req.params.id) as string | undefined;
      if (!workspaceId) {
        throw new AppError(400, "BAD_REQUEST", "Workspace ID required");
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: req.user.userId,
          },
        },
      });

      if (!membership) {
        throw new AppError(404, "NOT_FOUND", "Workspace not found");
      }

      const userLevel = ROLE_HIERARCHY[membership.role as WorkspaceRole] ?? 0;
      const requiredLevel = ROLE_HIERARCHY[minRole];

      if (userLevel < requiredLevel) {
        throw new AppError(403, "FORBIDDEN", `Requires workspace role ${minRole} or higher`);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
