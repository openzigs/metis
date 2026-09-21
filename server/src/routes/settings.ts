/**
 * /api/settings — Phase 12 Settings page backend.
 *
 * Currently exposes a single read-only endpoint that surfaces a curated
 * allow-list of runtime environment variables with secret values redacted.
 * Restricted to callers with `admin.read` so analysts cannot peek at
 * provider hostnames or feature-flag state.
 *
 * Provider preferences are stored client-side (per-user) — there is no
 * server-side mutation here on purpose. The actual provider credentials
 * live in the encrypted vault (Phase 1) and continue to be managed via
 * `/api/auth` + the existing AI config loader.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { listRedactedEnv } from "../lib/settings/env-vars.js";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

export function settingsRouter(): Router {
  const r = Router();

  r.get("/env", requireAuth, requirePermission("admin.read"), (_req: Request, res: Response) => {
    res.json(ok({ items: listRedactedEnv() }));
  });

  return r;
}
