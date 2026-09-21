/**
 * Issue #67 — Teams notification-target route tests.
 *
 * Covers the workspace-admin register/list/delete surface with a stub target
 * store (the store has its own unit tests). Proves:
 *   - POST registers a target (201) and maps a store validation error to its
 *     statusCode + code;
 *   - GET lists the workspace's targets;
 *   - DELETE returns 200 when removed and 404 when nothing matched;
 *   - a non-admin caller is rejected by requireWorkspaceRole("admin") (403);
 *   - an unknown event type fails request validation (400).
 *
 * Per the repo convention, prisma.js is mocked so the workspace-role middleware
 * does not hit CI's clean DB; the auth middleware injects a configurable user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUser: { userId: string; role: string } = { userId: "admin", role: "admin" };
vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

// The workspace-role middleware reads prisma.workspaceMember; the membership row
// is driven per-test so we can exercise the non-admin 403 path too.
let membershipRole: string | null = "admin";
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    workspaceMember: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  },
}));

import type { TeamsInstallationStore } from "../../lib/teams/installation-store.js";
import type { TeamsChannelLinkStore } from "../../lib/teams/channel-link-store.js";
import type { TeamsAadIdentityResolver } from "../../lib/teams/aad-identity-resolver.js";
import {
  TeamsNotificationTargetError,
  type TeamsNotificationTargetStore,
} from "../../lib/teams/notification-target-store.js";
import { teamsIntegrationRouter } from "./teams.js";
import { errorHandler } from "../../middleware/error-handler.js";

function stubInstallStore(): TeamsInstallationStore {
  return {
    install: vi.fn(),
    getByWorkspace: vi.fn(async () => null),
    resolveAppPassword: vi.fn(async () => null),
    uninstall: vi.fn(async () => false),
  } as unknown as TeamsInstallationStore;
}

const emptyLinkStore = {} as unknown as TeamsChannelLinkStore;
const emptyResolver = {} as unknown as TeamsAadIdentityResolver;

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "nt-1",
    workspaceId: "ws-1",
    eventType: "analysis-complete",
    conversationId: "convo-1",
    channelId: "msteams",
    tenantId: null,
    status: "active",
    createdById: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function stubTargetStore(
  over: Partial<TeamsNotificationTargetStore> = {},
): TeamsNotificationTargetStore {
  return {
    register: vi.fn(async () => summary()),
    listByWorkspace: vi.fn(async () => [summary()]),
    delete: vi.fn(async () => true),
    getByEvent: vi.fn(async () => null),
    ...over,
  } as unknown as TeamsNotificationTargetStore;
}

function createApp(targetStore: TeamsNotificationTargetStore) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/integrations/teams",
    teamsIntegrationRouter(stubInstallStore(), emptyLinkStore, emptyResolver, targetStore),
  );
  app.use(errorHandler);
  return app;
}

const validBody = {
  eventType: "analysis-complete",
  conversationId: "convo-1",
  channelId: "msteams",
  reference: { conversation: { id: "convo-1" }, serviceUrl: "https://svc" },
};

describe("Teams notification-target routes (#67)", () => {
  beforeEach(() => {
    currentUser = { userId: "admin", role: "admin" };
    membershipRole = "admin";
  });

  describe("POST notification-targets", () => {
    it("registers a target and returns 201 with the summary", async () => {
      const store = stubTargetStore();
      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/workspaces/ws-1/notification-targets")
        .send(validBody);
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.eventType).toBe("analysis-complete");
      expect(store.register).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", eventType: "analysis-complete" }),
      );
    });

    it("rejects an unknown event type with a 400 validation error", async () => {
      const app = createApp(stubTargetStore());
      const res = await request(app)
        .post("/api/integrations/teams/workspaces/ws-1/notification-targets")
        .send({ ...validBody, eventType: "not-an-event" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("maps a store validation error to its statusCode + code", async () => {
      const store = stubTargetStore({
        register: vi.fn(async () => {
          throw new TeamsNotificationTargetError(400, "CONVERSATION_REQUIRED", "bad");
        }),
      });
      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/workspaces/ws-1/notification-targets")
        .send(validBody);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CONVERSATION_REQUIRED");
    });

    it("rejects a non-admin caller with 403", async () => {
      currentUser = { userId: "u-2", role: "member" };
      membershipRole = "member";
      const app = createApp(stubTargetStore());
      const res = await request(app)
        .post("/api/integrations/teams/workspaces/ws-1/notification-targets")
        .send(validBody);
      expect(res.status).toBe(403);
    });
  });

  describe("GET notification-targets", () => {
    it("lists the workspace's targets", async () => {
      const store = stubTargetStore();
      const app = createApp(store);
      const res = await request(app).get(
        "/api/integrations/teams/workspaces/ws-1/notification-targets",
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(store.listByWorkspace).toHaveBeenCalledWith("ws-1");
    });
  });

  describe("DELETE notification-targets/:eventType", () => {
    it("returns 200 when a target was removed", async () => {
      const store = stubTargetStore({ delete: vi.fn(async () => true) });
      const app = createApp(store);
      const res = await request(app).delete(
        "/api/integrations/teams/workspaces/ws-1/notification-targets/analysis-complete",
      );
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
      expect(store.delete).toHaveBeenCalledWith("ws-1", "analysis-complete");
    });

    it("returns 404 when nothing matched", async () => {
      const store = stubTargetStore({ delete: vi.fn(async () => false) });
      const app = createApp(store);
      const res = await request(app).delete(
        "/api/integrations/teams/workspaces/ws-1/notification-targets/budget-exceeded",
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOTIFICATION_TARGET_NOT_FOUND");
    });
  });
});
