/**
 * `requirePermission(permission)` — 403 when the caller's role does not carry
 * the requested permission.
 */
import type { RequestHandler } from "express";
import type { PermissionKey } from "@metis/shared";
import { hasPermission } from "@metis/shared";
import { AppError } from "./error-handler.js";

export function requirePermission(permission: PermissionKey): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new AppError(401, "AUTH_REQUIRED", "Authentication required"));
      return;
    }
    if (!hasPermission(req.user.role, permission)) {
      next(new AppError(403, "FORBIDDEN", `Requires permission ${permission}`));
      return;
    }
    next();
  };
}
