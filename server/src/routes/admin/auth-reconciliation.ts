import { Router, json, type RequestHandler } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  confirmRolesForAdmin,
  inspectRolesForAdmin,
  reconciliationSchema,
  reconciliationTargetSchema,
} from "../../lib/auth/role-reconciliation.js";

const parseJson = json({ limit: "4kb" });
/** Also mounted ahead of the application's larger global parser for chunked bodies. */
export const reconciliationJson: RequestHandler = (req, res, next) => {
  const tooLarge = () =>
    new AppError(413, "PAYLOAD_TOO_LARGE", "Reconciliation payload exceeds 4 KB");
  if (
    Number(req.headers["content-length"] ?? 0) > 4096 ||
    (req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body)) > 4096)
  ) {
    return next(tooLarge());
  }
  parseJson(req, res, (error?: { type?: string }) =>
    next(error?.type === "entity.too.large" ? tooLarge() : error),
  );
};

export function authReconciliationRouter(): Router {
  const router = Router();
  router.use(
    (req, _res, next) => {
      if (!/^Bearer \S+$/.test(req.headers.authorization ?? "")) {
        return next(new AppError(401, "BEARER_REQUIRED", "Bearer authentication is required"));
      }
      next();
    },
    requireAuth,
    reconciliationJson,
  );
  router.post("/inspect", async (req, res) => {
    const target = reconciliationTargetSchema.parse(req.body);
    res.json({ success: true, data: await inspectRolesForAdmin(req.user!.userId, target) });
  });
  router.post("/confirm", async (req, res) => {
    const input = reconciliationSchema.parse(req.body);
    res.json({ success: true, data: await confirmRolesForAdmin(req.user!.userId, input) });
  });
  return router;
}
