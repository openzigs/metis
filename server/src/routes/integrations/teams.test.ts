/**
 * Epic #547 (Phase 0, #548) — Teams integration route tests.
 *
 * Covers the two surfaces with a stub adapter factory + a stub installation
 * store (the stores have their own unit tests). Proves:
 *   - the PUBLIC bot endpoint refuses an activity when no workspace is routed
 *     (400) or no credentials are installed (403) — it never runs an
 *     auth-disabled adapter that would accept unsigned activities;
 *   - a VALID activity is processed (stub adapter resolves) → 200;
 *   - an INVALID/unauthenticated activity (stub adapter throws, as the real
 *     CloudAdapter does on a bad Bot Framework JWT) → 401;
 *   - the ADMIN install/get/delete/manifest endpoints are wired and return the
 *     store summaries (workspace authz comes from requireWorkspaceRole).
 *
 * Per the repo convention, prisma.js is mocked so the route's workspace-role
 * middleware passes in CI's clean DB; the auth middleware injects an admin user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Admin user so requireWorkspaceRole("admin") short-circuits (system admin bypass).
let currentUser: { userId: string; role: string } = { userId: "admin", role: "admin" };
vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

// Workspace-role middleware reads prisma.workspaceMember; admin bypasses it, but
// mock prisma anyway so a non-admin path would not hit a real DB.
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    workspaceMember: { findUnique: vi.fn(async () => ({ role: "admin" })) },
  },
}));

import { setBotAdapterFactoryForTests, type BotAdapterLike } from "../../lib/teams/bot-adapter.js";
import type { TeamsInstallationStore } from "../../lib/teams/installation-store.js";
import { teamsIntegrationRouter } from "./teams.js";
import { errorHandler } from "../../middleware/error-handler.js";

/** A stub installation store — only the methods the router calls. */
function stubStore(over: Partial<TeamsInstallationStore> = {}): TeamsInstallationStore {
  return {
    install: vi.fn(async () => ({
      id: "inst-1",
      workspaceId: "ws-1",
      appId: "app-1",
      tenantId: null,
      appType: "MultiTenant",
      status: "active",
      label: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    getByWorkspace: vi.fn(async () => null),
    resolveAppPassword: vi.fn(async () => null),
    uninstall: vi.fn(async () => false),
    ...over,
  } as unknown as TeamsInstallationStore;
}

function createApp(store: TeamsInstallationStore) {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations/teams", teamsIntegrationRouter(store));
  app.use(errorHandler);
  return app;
}

const CREDS = {
  appId: "app-1",
  appPassword: "pw",
  appType: "MultiTenant",
  tenantId: null,
};

describe("Teams integration routes (#548)", () => {
  beforeEach(() => {
    currentUser = { userId: "admin", role: "admin" };
    setBotAdapterFactoryForTests(null);
  });

  describe("POST /messages (bot endpoint)", () => {
    it("rejects with 400 when no workspaceId is routed", async () => {
      const app = createApp(stubStore());
      const res = await request(app)
        .post("/api/integrations/teams/messages")
        .send({ type: "message" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("WORKSPACE_REQUIRED");
    });

    it("rejects with 403 when the workspace has no installed credentials", async () => {
      const store = stubStore({ resolveAppPassword: vi.fn(async () => null) });
      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/messages?workspaceId=ws-1")
        .send({ type: "message" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("TEAMS_NOT_INSTALLED");
    });

    it("processes a VALID activity (adapter resolves) → 200", async () => {
      const store = stubStore({
        resolveAppPassword: vi.fn(async () => CREDS),
        getByWorkspace: vi.fn(async () => ({
          id: "inst-1",
          workspaceId: "ws-1",
          appId: "app-1",
          tenantId: null,
          appType: "MultiTenant",
          status: "active",
          label: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      });
      // Stub adapter: a valid JWT → it ends the response 200 itself.
      const adapter: BotAdapterLike = {
        process: vi.fn(async (_req, res) => {
          (res as express.Response).status(200).end();
        }),
      };
      setBotAdapterFactoryForTests(() => adapter);

      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/messages?workspaceId=ws-1")
        .set("Authorization", "Bearer fake.jwt.token")
        .send({ type: "message", text: "hi" });
      expect(res.status).toBe(200);
      expect(adapter.process).toHaveBeenCalledTimes(1);
    });

    it("rejects an INVALID/unauthenticated activity (adapter throws) → 401", async () => {
      const store = stubStore({
        resolveAppPassword: vi.fn(async () => CREDS),
        getByWorkspace: vi.fn(async () => null),
      });
      // Stub adapter mirrors CloudAdapter rejecting a bad Bot Framework JWT.
      const adapter: BotAdapterLike = {
        process: vi.fn(async () => {
          throw new Error("Unauthorized: invalid token");
        }),
      };
      setBotAdapterFactoryForTests(() => adapter);

      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/messages?workspaceId=ws-1")
        .send({ type: "message" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("TEAMS_ACTIVITY_UNAUTHORIZED");
    });

    // #554 — explicit JWT-rejection matrix. The real CloudAdapter
    // (`ConfigurationBotFrameworkAuthentication`) rejects an activity whose Bot
    // Framework JWT is unsigned, forged, expired, or wrongly-audienced by throwing
    // out of `process` BEFORE our turn logic runs. We mirror each failure mode
    // with the adapter stub and assert the route surfaces a 401 and NEVER runs the
    // turn (no message ingested, no AI, no promote).
    it.each([
      ["unsigned (no Authorization header)", "Unauthorized. No valid identity."],
      ["forged signature", "Unauthorized. Invalid AppId passed on token: forged"],
      ["expired token", "Unauthorized. The token is expired."],
      ["wrong audience", "Unauthorized. Token audience mismatch."],
    ])("rejects a %s activity with 401 (turn never runs)", async (_label, message) => {
      const store = stubStore({
        resolveAppPassword: vi.fn(async () => CREDS),
        getByWorkspace: vi.fn(async () => null),
      });
      const process = vi.fn(async () => {
        throw new Error(message);
      });
      setBotAdapterFactoryForTests(() => ({ process }) as BotAdapterLike);

      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/messages?workspaceId=ws-1")
        .send({ type: "message", text: "should never be ingested" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("TEAMS_ACTIVITY_UNAUTHORIZED");
      // The raw SDK auth-failure detail is NEVER leaked back to the caller.
      expect(JSON.stringify(res.body)).not.toContain(message);
    });

    it("does not double-send when the adapter throws after sending headers", async () => {
      const store = stubStore({
        resolveAppPassword: vi.fn(async () => CREDS),
        getByWorkspace: vi.fn(async () => null),
      });
      const adapter: BotAdapterLike = {
        process: vi.fn(async (_req, res) => {
          (res as express.Response).status(202).end();
          throw new Error("late failure after response committed");
        }),
      };
      setBotAdapterFactoryForTests(() => adapter);
      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/messages?workspaceId=ws-1")
        .send({ type: "message" });
      // The 202 already committed; the catch must NOT overwrite it with 401.
      expect(res.status).toBe(202);
    });

    it("returns 500 when credential resolution fails", async () => {
      const store = stubStore({
        resolveAppPassword: vi.fn(async () => {
          throw new Error("vault unreachable");
        }),
      });
      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/messages?workspaceId=ws-1")
        .send({ type: "message" });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("TEAMS_CREDENTIALS_ERROR");
    });
  });

  describe("admin install flow", () => {
    it("POST install → 201 with a secret-free summary", async () => {
      const store = stubStore();
      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/workspaces/ws-1/install")
        .send({ appId: "app-1", appPassword: "super-secret" });
      expect(res.status).toBe(201);
      expect(res.body.data.appId).toBe("app-1");
      // Never echo the password back.
      expect(JSON.stringify(res.body)).not.toContain("super-secret");
      expect(store.install).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", appId: "app-1" }),
      );
    });

    it("POST install validates the payload (400 on missing appPassword)", async () => {
      const app = createApp(stubStore());
      const res = await request(app)
        .post("/api/integrations/teams/workspaces/ws-1/install")
        .send({ appId: "app-1" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("GET installation → 404 when none installed", async () => {
      const app = createApp(stubStore({ getByWorkspace: vi.fn(async () => null) }));
      const res = await request(app).get("/api/integrations/teams/workspaces/ws-1/installation");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("TEAMS_NOT_INSTALLED");
    });

    it("GET installation → 200 when installed", async () => {
      const store = stubStore({
        getByWorkspace: vi.fn(async () => ({
          id: "inst-1",
          workspaceId: "ws-1",
          appId: "app-1",
          tenantId: null,
          appType: "MultiTenant",
          status: "active",
          label: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      });
      const app = createApp(store);
      const res = await request(app).get("/api/integrations/teams/workspaces/ws-1/installation");
      expect(res.status).toBe(200);
      expect(res.body.data.appId).toBe("app-1");
    });

    it("DELETE installation → 200 when removed, 404 when nothing to remove", async () => {
      const app1 = createApp(stubStore({ uninstall: vi.fn(async () => true) }));
      const ok = await request(app1).delete("/api/integrations/teams/workspaces/ws-1/installation");
      expect(ok.status).toBe(200);
      expect(ok.body.data.uninstalled).toBe(true);

      const app2 = createApp(stubStore({ uninstall: vi.fn(async () => false) }));
      const notFound = await request(app2).delete(
        "/api/integrations/teams/workspaces/ws-1/installation",
      );
      expect(notFound.status).toBe(404);
    });

    it("POST install maps a generic store error to a 500", async () => {
      const store = stubStore({
        install: vi.fn(async () => {
          throw new Error("unexpected");
        }),
      });
      const app = createApp(store);
      const res = await request(app)
        .post("/api/integrations/teams/workspaces/ws-1/install")
        .send({ appId: "app-1", appPassword: "pw" });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("TEAMS_ERROR");
    });

    it("GET manifest → 404 when the workspace has no installation", async () => {
      const app = createApp(stubStore({ getByWorkspace: vi.fn(async () => null) }));
      const res = await request(app)
        .get("/api/integrations/teams/workspaces/ws-1/manifest")
        .query({ packageId: "pkg-1", publicHost: "https://metis.example.com" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("TEAMS_NOT_INSTALLED");
    });

    it("GET manifest → builds a manifest for an installed workspace", async () => {
      const store = stubStore({
        getByWorkspace: vi.fn(async () => ({
          id: "inst-1",
          workspaceId: "ws-1",
          appId: "the-bot-app-id",
          tenantId: null,
          appType: "MultiTenant",
          status: "active",
          label: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      });
      const app = createApp(store);
      const res = await request(app)
        .get("/api/integrations/teams/workspaces/ws-1/manifest")
        .query({ packageId: "pkg-1", publicHost: "https://metis.example.com" });
      expect(res.status).toBe(200);
      expect(res.body.data.manifest.bots[0].botId).toBe("the-bot-app-id");
      expect(res.body.data.messagingEndpoint).toContain("workspaceId=ws-1");
    });
  });
});
