/**
 * #2348 — the session user's own views.
 *
 *   GET /api/me/work — "My work" for Home: the caller's change requests by
 *                      state and the reviews waiting on their decision.
 *
 * The user is taken from the session only; no route here accepts a user id
 * (OWASP A01). Project visibility is applied in the query
 * (`lib/my-work/my-work-service.ts`).
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { getMyWork } from "../lib/my-work/my-work-service.js";

export function meRouter(): Router {
  const r = Router();

  r.get(
    "/work",
    requireAuth,
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const data = await getMyWork(req.user);
      res.json({ success: true, data });
    },
  );

  return r;
}
