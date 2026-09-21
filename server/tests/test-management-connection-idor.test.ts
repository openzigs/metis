/**
 * /api/test-management — cross-project IDOR regression tests (Issue #1055,
 * epic #1051). Mirrors `jira-connection-idor.test.ts`: the router addresses
 * connections by primary key alone, so the owning project is resolved from the
 * connection row and authorized with `assertProjectAccess` before anything is
 * read or mutated.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRawUnsafe: vi.fn(async () => 1),
    // The caller belongs to workspace B.
    workspaceMember: { findMany: vi.fn(async () => [{ workspaceId: "ws_b" }]) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "user_1",
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    // The connection under test is owned by a workspace-A project.
    project: {
      findUnique: vi.fn(
        async () => ({ workspaceId: "ws_a" }) as { workspaceId: string | null } | null,
      ),
    },
    testManagementConnection: {
      findFirst: vi.fn(async () => ({ projectId: "proj_a" }) as { projectId: string } | null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
  },
}));

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  return { prisma: withRouteAuth(prismaMock) };
});

const detail = {
  id: "tm_1",
  projectId: "proj_a",
  label: "z",
  kind: "zephyr",
  baseUrl: "https://api.zephyrscale.smartbear.com",
  authConfig: { kind: "zephyr", bearerTokenRef: "${vault:s1}" },
  proxyConfig: null,
  tlsConfig: null,
  status: "untested",
  errorMessage: null,
  lastTestedAt: null,
  createdById: "user_1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockList = vi.fn(async () => []);
const mockGet = vi.fn(async () => detail);
const mockCreate = vi.fn(async () => detail);
const mockUpdate = vi.fn(async () => detail);
const mockDelete = vi.fn(async () => undefined);
const mockTest = vi.fn(async () => ({ ok: true, latencyMs: 1 }));

vi.mock("../src/lib/connectors/testmgmt/connection-service.js", () => ({
  listTestManagementConnections: (...args: unknown[]) => mockList(...(args as [])),
  getTestManagementConnection: (...args: unknown[]) => mockGet(...(args as [])),
  createTestManagementConnection: (...args: unknown[]) => mockCreate(...(args as [])),
  updateTestManagementConnection: (...args: unknown[]) => mockUpdate(...(args as [])),
  deleteTestManagementConnection: (...args: unknown[]) => mockDelete(...(args as [])),
  testTestManagementConnection: (...args: unknown[]) => mockTest(...(args as [])),
}));

import request from "supertest";
import type { Test } from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

const createPayload = {
  label: "z",
  kind: "zephyr",
  baseUrl: "https://api.zephyrscale.smartbear.com",
  auth: { kind: "zephyr", bearerToken: "tok" },
};

const idRoutes: ReadonlyArray<{
  name: string;
  kind: "read" | "write";
  send: (token: string) => Test;
  service: ReturnType<typeof vi.fn>;
}> = [
  {
    name: "GET /connections/:id",
    kind: "read",
    send: (t) =>
      request(app).get("/api/test-management/connections/tm_1").set("Authorization", `Bearer ${t}`),
    service: mockGet,
  },
  {
    name: "PATCH /connections/:id",
    kind: "write",
    send: (t) =>
      request(app)
        .patch("/api/test-management/connections/tm_1")
        .set("Authorization", `Bearer ${t}`)
        .send({ label: "renamed" }),
    service: mockUpdate,
  },
  {
    name: "DELETE /connections/:id",
    kind: "write",
    send: (t) =>
      request(app)
        .delete("/api/test-management/connections/tm_1")
        .set("Authorization", `Bearer ${t}`),
    service: mockDelete,
  },
  {
    name: "POST /connections/:id/test",
    kind: "write",
    send: (t) =>
      request(app)
        .post("/api/test-management/connections/tm_1/test")
        .set("Authorization", `Bearer ${t}`),
    service: mockTest,
  },
];

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
  prismaMock.workspaceMember.findMany.mockResolvedValue([{ workspaceId: "ws_b" }]);
  prismaMock.project.findUnique.mockResolvedValue({ workspaceId: "ws_a" });
  prismaMock.testManagementConnection.findFirst.mockResolvedValue({ projectId: "proj_a" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("cross-tenant access to a test-management connection by id", () => {
  for (const route of idRoutes) {
    it(`${route.name} (${route.kind}) → 404 and never reaches the service`, async () => {
      const token = await login("coordinator");
      const res = await route.send(token);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(route.service).not.toHaveBeenCalled();
    });
  }

  it("returns the same 404 body for an out-of-tenant id and an unknown id", async () => {
    const token = await login("coordinator");

    const outOfTenant = await request(app)
      .get("/api/test-management/connections/tm_1")
      .set("Authorization", `Bearer ${token}`);

    prismaMock.testManagementConnection.findFirst.mockResolvedValue(null);
    const unknown = await request(app)
      .get("/api/test-management/connections/tm_missing")
      .set("Authorization", `Bearer ${token}`);

    expect(outOfTenant.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(outOfTenant.body.error).toEqual(unknown.body.error);
  });
});

describe("same-workspace access still works", () => {
  beforeEach(() => {
    prismaMock.project.findUnique.mockResolvedValue({ workspaceId: "ws_b" });
  });

  for (const route of idRoutes) {
    it(`${route.name} succeeds and threads the resolved projectId`, async () => {
      const token = await login("coordinator");
      const res = await route.send(token);
      expect(res.status).toBeLessThan(400);
      expect(route.service).toHaveBeenCalled();
      const args = route.service.mock.calls[0];
      expect(args[args.length - 1]).toBe("proj_a");
    });
  }

  it("keeps pre-migration projects with no workspace open", async () => {
    prismaMock.project.findUnique.mockResolvedValue({ workspaceId: null });
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/test-management/connections/tm_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith("tm_1", "proj_a");
  });
});

describe("system admin bypass", () => {
  it("does not resolve the connection and leaves the service call unscoped", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/test-management/connections/tm_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(prismaMock.testManagementConnection.findFirst).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledWith("tm_1", undefined);
  });
});

describe("caller-supplied projectId routes", () => {
  it("POST /connections with a foreign projectId → 404, nothing created", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/test-management/connections?projectId=proj_a")
      .set("Authorization", `Bearer ${token}`)
      .send(createPayload);
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("GET /connections?projectId=<foreign> → 404, nothing listed", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/test-management/connections?projectId=proj_a")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("allows create + list for a project in the caller's own workspace", async () => {
    prismaMock.project.findUnique.mockResolvedValue({ workspaceId: "ws_b" });
    const token = await login("coordinator");

    const created = await request(app)
      .post("/api/test-management/connections?projectId=proj_b")
      .set("Authorization", `Bearer ${token}`)
      .send(createPayload);
    expect(created.status).toBe(201);
    expect(mockCreate).toHaveBeenCalled();

    const listed = await request(app)
      .get("/api/test-management/connections?projectId=proj_b")
      .set("Authorization", `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("proj_b");
  });
});
