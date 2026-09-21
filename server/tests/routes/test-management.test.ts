/**
 * Tests for /api/test-management/connections routes (Epic #856 / Issue #871).
 *
 * Exercises the Express layer to ensure validation, projectId plumbing and
 * permission middleware are wired up correctly. The connection service is
 * mocked so this stays a routing-layer test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("../../src/lib/connectors/testmgmt/connection-service.js", () => ({
  createTestManagementConnection: vi.fn(),
  listTestManagementConnections: vi.fn(),
  getTestManagementConnection: vi.fn(),
  updateTestManagementConnection: vi.fn(),
  deleteTestManagementConnection: vi.fn(),
  testTestManagementConnection: vi.fn(),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// #1055 — the router now resolves the connection's owning project and asserts
// caller access. The stub user below is not a system admin, so both lookups
// run; a null-workspace project keeps the pre-migration "open" convention and
// leaves this suite focused on routing/validation.
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: vi.fn(async () => ({ workspaceId: null })) },
    testManagementConnection: { findFirst: vi.fn(async () => ({ projectId: "p1" })) },
  },
}));

vi.mock("../../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {
  createTestManagementConnection,
  listTestManagementConnections,
  getTestManagementConnection,
  updateTestManagementConnection,
  deleteTestManagementConnection,
  testTestManagementConnection,
} from "../../src/lib/connectors/testmgmt/connection-service.js";
import { testManagementRouter } from "../../src/routes/test-management.js";
import { AppError } from "../../src/middleware/error-handler.js";

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { userId: string } }).user = { userId: "user-1" };
    next();
  });
  app.use("/api/test-management", testManagementRouter());
  app.use(
    (
      err: AppError | Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err instanceof AppError ? err.statusCode : 500;
      const code = err instanceof AppError ? err.code : "INTERNAL";
      res.status(status).json({
        success: false,
        error: { code, message: err.message, details: (err as AppError).details },
      });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const validZephyrPayload = {
  label: "z",
  kind: "zephyr",
  baseUrl: "https://api.zephyrscale.smartbear.com",
  auth: { kind: "zephyr", bearerToken: "tok" },
};

describe("POST /api/test-management/connections", () => {
  it("creates a connection and returns 201 with the detail body", async () => {
    vi.mocked(createTestManagementConnection).mockResolvedValueOnce({
      id: "c1",
      projectId: "p1",
      label: "z",
      kind: "zephyr",
      baseUrl: "https://api.zephyrscale.smartbear.com",
      authConfig: { kind: "zephyr", bearerTokenRef: "${vault:s1}" },
      proxyConfig: null,
      tlsConfig: null,
      status: "untested",
      errorMessage: null,
      lastTestedAt: null,
      createdById: "user-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await request(createApp())
      .post("/api/test-management/connections?projectId=p1")
      .send(validZephyrPayload);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("c1");
    expect(createTestManagementConnection).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ label: "z" }),
      "user-1",
    );
  });

  it("returns 400 when projectId is missing", async () => {
    const res = await request(createApp())
      .post("/api/test-management/connections")
      .send(validZephyrPayload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PROJECT_REQUIRED");
  });

  it("returns 400 on invalid payload (validation)", async () => {
    const res = await request(createApp())
      .post("/api/test-management/connections?projectId=p1")
      .send({ label: "z", kind: "zephyr", baseUrl: "not-a-url", auth: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/test-management/connections", () => {
  it("lists by projectId query param", async () => {
    vi.mocked(listTestManagementConnections).mockResolvedValueOnce([]);
    const res = await request(createApp()).get("/api/test-management/connections?projectId=p1");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(listTestManagementConnections).toHaveBeenCalledWith("p1");
  });

  it("requires projectId query param", async () => {
    const res = await request(createApp()).get("/api/test-management/connections");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PROJECT_REQUIRED");
  });
});

describe("GET /api/test-management/connections/:id", () => {
  it("returns the connection detail", async () => {
    vi.mocked(getTestManagementConnection).mockResolvedValueOnce({
      id: "c1",
      projectId: "p1",
      label: "z",
      kind: "zephyr",
      baseUrl: "https://x",
      authConfig: {},
      proxyConfig: null,
      tlsConfig: null,
      status: "ok",
      errorMessage: null,
      lastTestedAt: null,
      createdById: "u",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await request(createApp()).get("/api/test-management/connections/c1");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("c1");
    // The resolved owning projectId is threaded into the service lookup (#1055).
    expect(getTestManagementConnection).toHaveBeenCalledWith("c1", "p1");
  });
});

describe("PATCH /api/test-management/connections/:id", () => {
  it("validates payload before dispatching", async () => {
    const res = await request(createApp())
      .patch("/api/test-management/connections/c1")
      .send({ baseUrl: "not-a-url" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(updateTestManagementConnection).not.toHaveBeenCalled();
  });

  it("dispatches valid update", async () => {
    vi.mocked(updateTestManagementConnection).mockResolvedValueOnce({
      id: "c1",
      projectId: "p1",
      label: "renamed",
      kind: "zephyr",
      baseUrl: "https://x",
      authConfig: {},
      proxyConfig: null,
      tlsConfig: null,
      status: "untested",
      errorMessage: null,
      lastTestedAt: null,
      createdById: "u",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await request(createApp())
      .patch("/api/test-management/connections/c1")
      .send({ label: "renamed" });
    expect(res.status).toBe(200);
    expect(updateTestManagementConnection).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ label: "renamed" }),
      "user-1",
      "p1",
    );
  });
});

describe("DELETE /api/test-management/connections/:id", () => {
  it("returns 204 on soft-delete", async () => {
    vi.mocked(deleteTestManagementConnection).mockResolvedValueOnce(undefined);
    const res = await request(createApp()).delete("/api/test-management/connections/c1");
    expect(res.status).toBe(204);
    expect(deleteTestManagementConnection).toHaveBeenCalledWith("c1", "user-1", "p1");
  });
});

describe("POST /api/test-management/connections/:id/test", () => {
  it("returns the connectivity test result", async () => {
    vi.mocked(testTestManagementConnection).mockResolvedValueOnce({
      ok: true,
      latencyMs: 12,
    });
    const res = await request(createApp()).post("/api/test-management/connections/c1/test");
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(testTestManagementConnection).toHaveBeenCalledWith("c1", "user-1", "p1");
  });
});
