/**
 * Notification-preference routes — Epic #608 (#612).
 *
 * Endpoints (self-service only — always scoped to the authenticated user;
 * no id parameter is ever accepted):
 *   GET /api/users/me/notification-preferences — full resolved channel × event
 *       matrix (stored rows overlaid on the #611 default matrix).
 *   PUT /api/users/me/notification-preferences — upsert toggles (zod-validated
 *       against the shared channel/event vocabulary), audited, returns the
 *       resolved matrix after the write.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit/audit-service.js";
import {
  getResolvedPreferencesForUser,
  upsertNotificationPreferences,
} from "../lib/notifications/preferences.js";

// The matrix has |channels| × |events| distinct cells; allow a little headroom
// for duplicate cells in one payload (collapsed last-wins) but reject
// unbounded arrays.
const MAX_ENTRIES = NOTIFICATION_CHANNELS.length * NOTIFICATION_EVENTS.length * 2;

const putBodySchema = z.object({
  preferences: z
    .array(
      z.object({
        channel: z.enum(NOTIFICATION_CHANNELS),
        event: z.enum(NOTIFICATION_EVENTS),
        enabled: z.boolean(),
      }),
    )
    .max(MAX_ENTRIES),
});

export function notificationPreferencesRouter(): Router {
  const r = Router();

  /** GET / — resolved preference matrix for the authenticated user. */
  r.get("/", requireAuth, async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");

    const preferences = await getResolvedPreferencesForUser(req.user.userId);
    res.json({ success: true, data: { preferences } });
  });

  /** PUT / — upsert toggles for the authenticated user, return the matrix. */
  r.put("/", requireAuth, async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    const userId = req.user.userId;

    const parsed = putBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid notification preference payload", {
        issues: parsed.error.flatten(),
      });
    }

    await upsertNotificationPreferences(userId, parsed.data.preferences);

    audit({
      actor: { id: userId },
      action: "notification_preferences.update",
      target: { type: "user", id: userId },
      metadata: { entries: parsed.data.preferences.length },
    });

    const preferences = await getResolvedPreferencesForUser(userId);
    res.json({ success: true, data: { preferences } });
  });

  return r;
}
