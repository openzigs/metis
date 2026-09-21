/**
 * Issue #580 — PagerDuty config route tests.
 *
 * Covers the workspace-admin register/list/delete surface with a stub config
 * store (the store has its own unit tests). Proves:
 *   - POST registers a config (201) and never echoes the routing key back;
 *   - a store validation error maps to its statusCode + code;
 *   - GET lists the workspace's configs;
 *   - DELETE returns 200 when removed and 404 when nothing matched;
 *   - a non-admin caller is rejected by requireWorkspaceRole("admin") (403);
 *   - a missing routing key fails request validation (400).
 *
 * Per repo convention, prisma.js is mocked so the workspace-role middleware does
 * not hit CI's clean DB; the auth middleware injects a configurable user.
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

let membershipRole: string | null = "admin";
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    workspaceMember: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  },
}));

import {
  PagerDutyServiceConfigError,
  type PagerDutyServiceConfigStore,
} from "../../lib/pagerduty/service-config-store.js";
import { pagerDutyIntegrationRouter } from "./pagerduty.js";
import { errorHandler } from "../../middleware/error-handler.js";

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "cfg-1",
    workspaceId: "ws-1",
    serviceKey: "default",
    label: null,
    status: "active",
    createdById: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function stubStore(over: Partial<PagerDutyServiceConfigStore> = {}): PagerDutyServiceConfigStore {
  return {
    register: vi.fn(async () => summary()),
    listByWorkspace: vi.fn(async () => [summary()]),
    delete: vi.fn(async () => true),
    resolveRoutingKey: vi.fn(async () => "rk"),
    ...over,
  } as unknown as PagerDutyServiceConfigStore;
}

function createApp(store: PagerDutyServiceConfigStore) {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations/pagerduty", pagerDutyIntegrationRouter(store));
  app.use(errorHandler);
  return app;
}

describe("PagerDuty config routes", () => {
  beforeEach(() => {
    currentUser = { userId: "admin", role: "admin" };
    membershipRole = "admin";
  });

  it("POST registers a config (201) and never echoes the routing key", async () => {
    const store = stubStore();
    const res = await request(createApp(store))
      .post("/api/integrations/pagerduty/workspaces/ws-1/service-configs")
      .send({ serviceKey: "default", routingKey: "SUPER-SECRET-KEY", label: "Prod" });
    expect(res.status).toBe(201);
    expect(res.body.data.serviceKey).toBe("default");
    expect(JSON.stringify(res.body)).not.toContain("SUPER-SECRET-KEY");
    expect(store.register).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        serviceKey: "default",
        routingKey: "SUPER-SECRET-KEY",
      }),
    );
  });

  it("maps a store validation error to its statusCode + code", async () => {
    const store = stubStore({
      register: vi.fn(async () => {
        throw new PagerDutyServiceConfigError(
          400,
          "ROUTING_KEY_REQUIRED",
          "routingKey is required",
        );
      }),
    });
    const res = await request(createApp(store))
      .post("/api/integrations/pagerduty/workspaces/ws-1/service-configs")
      .send({ routingKey: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ROUTING_KEY_REQUIRED");
  });

  it("maps an unexpected store error to 500 PAGERDUTY_ERROR", async () => {
    const store = stubStore({
      register: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const res = await request(createApp(store))
      .post("/api/integrations/pagerduty/workspaces/ws-1/service-configs")
      .send({ routingKey: "rk" });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("PAGERDUTY_ERROR");
  });

  it("400s when routingKey is missing", async () => {
    const store = stubStore();
    const res = await request(createApp(store))
      .post("/api/integrations/pagerduty/workspaces/ws-1/service-configs")
      .send({ serviceKey: "default" });
    expect(res.status).toBe(400);
    expect(store.register).not.toHaveBeenCalled();
  });

  it("GET lists the workspace's configs", async () => {
    const store = stubStore();
    const res = await request(createApp(store)).get(
      "/api/integrations/pagerduty/workspaces/ws-1/service-configs",
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(store.listByWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("DELETE returns 200 when removed", async () => {
    const store = stubStore();
    const res = await request(createApp(store)).delete(
      "/api/integrations/pagerduty/workspaces/ws-1/service-configs/default",
    );
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it("DELETE returns 404 when nothing matched", async () => {
    const store = stubStore({ delete: vi.fn(async () => false) });
    const res = await request(createApp(store)).delete(
      "/api/integrations/pagerduty/workspaces/ws-1/service-configs/missing",
    );
    expect(res.status).toBe(404);
  });

  it("rejects a non-admin caller (403)", async () => {
    // A non-system-admin falls through to the workspace-membership check; a
    // member (below admin) is rejected by requireWorkspaceRole("admin").
    currentUser = { userId: "u-member", role: "member" };
    membershipRole = "member";
    const store = stubStore();
    const res = await request(createApp(store))
      .post("/api/integrations/pagerduty/workspaces/ws-1/service-configs")
      .send({ routingKey: "rk" });
    expect(res.status).toBe(403);
    expect(store.register).not.toHaveBeenCalled();
  });
});
