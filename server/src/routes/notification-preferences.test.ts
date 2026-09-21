/**
 * Notification-preferences route tests — Epic #608 (#612).
 *
 * Exercises the route layer together with the real service functions in
 * lib/notifications/preferences.ts (Prisma mocked) so one suite covers:
 * defaults-only resolution, partial overrides, upsert semantics (including
 * duplicate-cell last-wins), validation failures, audit writes, and 401s.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from "@metis/shared";

const mockPrisma = {
  notificationPreference: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};
vi.mock("../lib/prisma.js", () => ({ prisma: mockPrisma }));

const auditMock = vi.fn();
vi.mock("../lib/audit/audit-service.js", () => ({ audit: auditMock }));

// "on" = attach req.user; "reject" = 401 at the middleware (normal requireAuth
// behavior); "passthrough" = call next() WITHOUT req.user, exercising the
// handlers' defensive 401 guard.
let authMode: "on" | "reject" | "passthrough" = "on";
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (authMode === "reject") {
      res.status(401).json({
        success: false,
        error: { code: "AUTH_REQUIRED", message: "Authentication required" },
      });
      return;
    }
    if (authMode === "on") {
      (req as { user?: { userId: string } }).user = { userId: "user-1" };
    }
    next();
  },
}));

const { notificationPreferencesRouter } = await import("./notification-preferences.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/users/me/notification-preferences", notificationPreferencesRouter());
  app.use(errorHandler);
  return app;
}

const PATH = "/users/me/notification-preferences";
const TOTAL_CELLS = NOTIFICATION_CHANNELS.length * NOTIFICATION_EVENTS.length;

interface Entry {
  channel: string;
  event: string;
  enabled: boolean;
  isDefault: boolean;
}

function cell(entries: Entry[], channel: string, event: string): Entry | undefined {
  return entries.find((e) => e.channel === channel && e.event === event);
}

describe("notification-preferences routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    authMode = "on";
    mockPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
    mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
    mockPrisma.notificationPreference.upsert.mockResolvedValue({});
    app = createApp();
  });

  describe("GET /users/me/notification-preferences", () => {
    it("returns the full default matrix for a user with no stored rows", async () => {
      const res = await request(app).get(PATH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const prefs: Entry[] = res.body.data.preferences;
      expect(prefs).toHaveLength(TOTAL_CELLS);
      expect(prefs.every((p) => p.isDefault)).toBe(true);
      // Channel defaults: email/inApp/teams on, webhook off.
      for (const p of prefs) {
        expect(p.enabled).toBe(p.channel !== "webhook");
      }
      expect(mockPrisma.notificationPreference.findMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });

    it("overlays stored rows on defaults and ignores unknown vocabulary", async () => {
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { channel: "email", event: "mention", enabled: false },
        { channel: "webhook", event: "systemAlerts", enabled: true },
        { channel: "carrierPigeon", event: "mention", enabled: true }, // retired vocab — ignored
      ]);

      const res = await request(app).get(PATH);

      expect(res.status).toBe(200);
      const prefs: Entry[] = res.body.data.preferences;
      expect(prefs).toHaveLength(TOTAL_CELLS);
      expect(cell(prefs, "email", "mention")).toMatchObject({ enabled: false, isDefault: false });
      expect(cell(prefs, "webhook", "systemAlerts")).toMatchObject({
        enabled: true,
        isDefault: false,
      });
      // Untouched cell keeps its default.
      expect(cell(prefs, "inApp", "mention")).toMatchObject({ enabled: true, isDefault: true });
      expect(prefs.some((p) => p.channel === "carrierPigeon")).toBe(false);
    });

    it("returns 401 when unauthenticated", async () => {
      authMode = "reject";

      const res = await request(app).get(PATH);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_REQUIRED");
      expect(mockPrisma.notificationPreference.findMany).not.toHaveBeenCalled();
    });

    it("returns 401 from the handler guard when middleware attaches no user", async () => {
      authMode = "passthrough";

      const res = await request(app).get(PATH);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_REQUIRED");
      expect(mockPrisma.notificationPreference.findMany).not.toHaveBeenCalled();
    });
  });

  describe("PUT /users/me/notification-preferences", () => {
    it("upserts rows scoped to the authenticated user and returns the resolved matrix", async () => {
      const stored = [
        { channel: "webhook", event: "systemAlerts", enabled: true },
        { channel: "email", event: "mention", enabled: false },
      ];
      mockPrisma.notificationPreference.findMany.mockResolvedValue(stored);

      const res = await request(app)
        .put(PATH)
        .send({
          preferences: stored.map(({ channel, event, enabled }) => ({ channel, event, enabled })),
        });

      expect(res.status).toBe(200);
      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith({
        where: {
          userId_channel_event: { userId: "user-1", channel: "webhook", event: "systemAlerts" },
        },
        create: { userId: "user-1", channel: "webhook", event: "systemAlerts", enabled: true },
        update: { enabled: true },
      });

      const prefs: Entry[] = res.body.data.preferences;
      expect(prefs).toHaveLength(TOTAL_CELLS);
      expect(cell(prefs, "webhook", "systemAlerts")).toMatchObject({
        enabled: true,
        isDefault: false,
      });
      expect(cell(prefs, "email", "mention")).toMatchObject({ enabled: false, isDefault: false });
    });

    it("audits the write with the acting user as both actor and target", async () => {
      await request(app)
        .put(PATH)
        .send({ preferences: [{ channel: "email", event: "mention", enabled: false }] })
        .expect(200);

      expect(auditMock).toHaveBeenCalledTimes(1);
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: { id: "user-1" },
          action: "notification_preferences.update",
          target: { type: "user", id: "user-1" },
        }),
      );
    });

    it("applies last-wins for duplicate channel/event pairs in one payload", async () => {
      await request(app)
        .put(PATH)
        .send({
          preferences: [
            { channel: "email", event: "mention", enabled: true },
            { channel: "email", event: "mention", enabled: false },
          ],
        })
        .expect(200);

      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { enabled: false } }),
      );
    });

    it("accepts an empty preferences array as a no-op and still returns the matrix", async () => {
      const res = await request(app).put(PATH).send({ preferences: [] });

      expect(res.status).toBe(200);
      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(res.body.data.preferences).toHaveLength(TOTAL_CELLS);
    });

    it.each([
      ["unknown channel", { preferences: [{ channel: "sms", event: "mention", enabled: true }] }],
      [
        "unknown event",
        { preferences: [{ channel: "email", event: "somethingElse", enabled: true }] },
      ],
      [
        "non-boolean enabled",
        { preferences: [{ channel: "email", event: "mention", enabled: "yes" }] },
      ],
      ["missing preferences key", {}],
      ["non-array preferences", { preferences: { channel: "email" } }],
    ])("rejects %s with 400 and writes nothing", async (_label, body) => {
      const res = await request(app).put(PATH).send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it("rejects a bodyless request with 400", async () => {
      // No .send() and no content-type: express.json leaves req.body undefined.
      const res = await request(app).put(PATH);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it("returns 401 when unauthenticated and writes nothing", async () => {
      authMode = "reject";

      const res = await request(app)
        .put(PATH)
        .send({ preferences: [{ channel: "email", event: "mention", enabled: false }] });

      expect(res.status).toBe(401);
      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it("returns 401 from the handler guard when middleware attaches no user", async () => {
      authMode = "passthrough";

      const res = await request(app)
        .put(PATH)
        .send({ preferences: [{ channel: "email", event: "mention", enabled: false }] });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_REQUIRED");
      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  });
});
