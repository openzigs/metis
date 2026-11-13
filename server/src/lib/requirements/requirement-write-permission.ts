/**
 * Issue #2436 — what a requirement write needs, decided by what its body
 * changes, for the two routes that write a requirement's verdict:
 * `PUT /api/requirements/:id` (the Requirements list and the requirement card)
 * and `PATCH /api/analyses/:id/requirements/:reqId` (the API).
 *
 * - the verdict (`reviewStatus`: Approve, Reject, …) needs `requirement.approve`;
 * - any other field (title, body, criteria, …) is an edit and needs
 *   `project.update`, as before;
 * - a body with neither is an (empty) edit and needs `project.update`.
 *
 * So an organisation can let an analyst approve without granting the right to
 * edit project settings, and the roles that held `project.update` when this was
 * split out (coordinator, admin) hold both, so nothing changed for them.
 */
import type { RequestHandler } from "express";
import { hasPermission, type PermissionKey } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { tagAuthorization } from "../../middleware/authorization-tag.js";

/** The body key that carries the verdict. */
const VERDICT_KEY = "reviewStatus";
/** Keys that change nothing on their own: the lock token and the version-row reason. */
const NEUTRAL_KEYS: ReadonlySet<string> = new Set(["version", "reason"]);

/** The permissions a requirement write with this body needs, verdict first. */
export function requirementWritePermissions(body: unknown): PermissionKey[] {
  const keys = body !== null && typeof body === "object" ? Object.keys(body) : [];
  const verdict = keys.includes(VERDICT_KEY);
  const edit = keys.some((k) => k !== VERDICT_KEY && !NEUTRAL_KEYS.has(k));
  const needed: PermissionKey[] = [];
  if (verdict) needed.push("requirement.approve");
  if (edit || !verdict) needed.push("project.update");
  return needed;
}

/**
 * 403 `FORBIDDEN` naming the first permission the caller's role lacks, the
 * same answer `requirePermission` gives. Runs after `requireAuth`.
 */
export function requireRequirementWritePermission(): RequestHandler {
  return tagAuthorization(
    (req, _res, next) => {
      if (!req.user) {
        next(new AppError(401, "AUTH_REQUIRED", "Authentication required"));
        return;
      }
      const role = req.user.role;
      const missing = requirementWritePermissions(req.body).find((p) => !hasPermission(role, p));
      if (missing) {
        next(new AppError(403, "FORBIDDEN", `Requires permission ${missing}`));
        return;
      }
      next();
    },
    { kind: "permission", value: "requirement.approve|project.update" },
  );
}
