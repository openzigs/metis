/**
 * Issue #416 — Persisted notification REST API.
 *
 * Routes:
 *   GET    /api/notifications            — list caller's notifications (newest first)
 *   PATCH  /api/notifications/:id/read  — mark a single notification read
 *   POST   /api/notifications/read-all  — mark all as read
 *
 * All routes are scoped to `req.user.userId` from the verified JWT — a user
 * can NEVER read or mutate another user's notifications (OWASP A01).
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";

const PAGE_SIZE = 50;

export function notificationsRouter(): Router {
  const r = Router();

  /**
   * GET /notifications
   * Returns the authenticated user's notifications, newest first.
   * Response: { notifications: Notification[], unreadCount: number }
   */
  r.get("/", requireAuth, async (req: Request, res: Response, next) => {
    try {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const userId = req.user.userId;

      const [notifications, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: PAGE_SIZE,
        }),
        prisma.notification.count({
          where: { userId, read: false },
        }),
      ]);

      // Standard { success, data } envelope so the UI's apiFetch (which returns
      // `payload.data`) hydrates the drawer correctly — a bare body resolves to
      // `undefined` client-side and silently drops persisted history (#416 fix).
      res.json({ success: true, data: { notifications, unreadCount } });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /notifications/:id/read
   * Marks a single notification as read.
   * Only acts on notifications that belong to the authenticated user.
   * Returns 404 if the notification is not found or belongs to another user.
   */
  r.patch("/:id/read", requireAuth, async (req: Request, res: Response, next) => {
    try {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const userId = req.user.userId;
      const id = String(req.params.id);

      const existing = await prisma.notification.findFirst({
        where: { id, userId },
      });
      if (!existing) {
        throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification not found");
      }

      const updated = await prisma.notification.update({
        where: { id },
        data: { read: true },
      });

      const unreadCount = await prisma.notification.count({
        where: { userId, read: false },
      });

      res.json({ success: true, data: { notification: updated, unreadCount } });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /notifications/read-all
   * Marks all of the authenticated user's notifications as read.
   * Returns { updated: number, unreadCount: 0 }
   */
  r.post("/read-all", requireAuth, async (req: Request, res: Response, next) => {
    try {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const userId = req.user.userId;

      const result = await prisma.notification.updateMany({
        where: { userId, read: false },
        data: { read: true },
      });

      res.json({ success: true, data: { updated: result.count, unreadCount: 0 } });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
