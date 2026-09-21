/**
 * `requireRole(minRole)` — 403 when the caller's role is below the threshold.
 */
import type { RequestHandler } from "express";
import type { RoleKey } from "@metis/shared";
import { hasMinRole } from "@metis/shared";
import { AppError } from "./error-handler.js";

export function requireRole(minRole: RoleKey): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new AppError(401, "AUTH_REQUIRED", "Authentication required"));
      return;
    }
    if (!hasMinRole(req.user.role, minRole)) {
      next(new AppError(403, "FORBIDDEN", `Requires role ${minRole} or higher`));
      return;
    }
    next();
  };
}
