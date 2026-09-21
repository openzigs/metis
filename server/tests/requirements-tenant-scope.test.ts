/**
 * /api/requirements — cross-tenant IDOR regression tests (Issue #1118, epic #1051).
 *
 * The requirements collaboration router is mounted with no `:projectId`
 * segment, so `requireProjectAccess()` cannot be mounted — the owning project is
 * resolved from the requirement row and authorized through `assertProjectAccess`
 * (`lib/requirements/requirement-authz.ts`). These tests pin that behaviour for
 * every route on the mount:
 *
 *   • a workspace-B `coordinator` gets 404 for a workspace-A requirement on
 *     every read AND write route, and the service layer is never reached;
 *   • the optimistic-lock loader never runs for a foreign row, so the 409
 *     conflict diff cannot be used to read another tenant's field values;
 *   • the 404 for an out-of-tenant id is byte-identical to the 404 for an
 *     unknown id, so the error channel is not an existence oracle;
 *   • same-workspace callers still succeed, with the resolved projectId threaded
 *     into the query so the scope lives in the query, not only in the router;
 *   • system admins bypass, and pre-migration null-workspace projects stay open.
 *
 * The principal under test is `coordinator`, NOT `admin`: `project.update` is
 * held by coordinator (`packages/shared/src/rbac.ts`), and `assertProjectAccess`
 * short-circuits for admins — an admin-only suite would prove nothing (#1058).
 * `requireAuth` and `requirePermission` are deliberately NOT stubbed, so these
 * tests run the real role gate and prove the 404 comes from the object-level
 * check rather than from the permission matrix.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const REQUIREMENT_ROW = {
  id: "req_1",
  projectId: "proj_a",
  version: 2,
  title: "Old title",
  body: "Old body",
  priority: "low",
  type: "feature",
  labels: "[]",
  storyPoints: null,
  reviewStatus: null,
};

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRawUnsafe: vi.fn(async () => 1),
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(null)),
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
    // The requirement under test is owned by a workspace-A project.
    project: {
      findUnique: vi.fn(
        async () => ({ workspaceId: "ws_a" }) as { workspaceId: string | null } | null,
      ),
    },
    requirement: {
      findUnique: vi.fn(async () => ({ ...REQUIREMENT_ROW }) as Record<string, unknown> | null),
      update: vi.fn(async () => ({ id: "req_1", version: 3, updatedAt: new Date() })),
    },
    requirementVersion: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    assignment: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ id: "assign_1" }) as { id: string } | null),
      upsert: vi.fn(async () => ({ id: "assign_1" })),
      delete: vi.fn(async () => ({})),
    },
    commentThread: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
  },
}));

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  return {
    prisma: withRouteAuth(prismaMock),
    resolveDatabaseProvider: () => "sqlite",
  };
});

// The approval gate is orthogonal to tenancy — keep the export happy path open.
vi.mock("../src/lib/reviews/approval-gate.js", () => ({
  assertRequirementsExportable: vi.fn(async () => undefined),
}));

const mockUpdateWithHistory = vi.fn(async () => ({
  id: "req_1",
  version: 3,
  updatedAt: new Date("2026-07-28T00:00:00Z"),
  changed: true,
  changedFields: {},
}));
const mockRestoreVersion = vi.fn(async () => ({
  id: "req_1",
  version: 4,
  updatedAt: new Date("2026-07-28T00:00:00Z"),
  restoredFrom: 1,
  changedFields: {},
}));

vi.mock("../src/lib/requirements/requirement-version-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/requirements/requirement-version-service.js")>();
  return {
    ...actual,
    updateRequirementWithHistory: (...args: unknown[]) => mockUpdateWithHistory(...(args as [])),
    restoreRequirementVersion: (...args: unknown[]) => mockRestoreVersion(...(args as [])),
  };
});

import request from "supertest";
import type { Test } from "supertest";
import { createApp } from "../src/app.js";
import { assertRequirementAccessible } from "../src/lib/requirements/requirement-authz.js";
import { AppError } from "../src/middleware/error-handler.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

/**
 * Every id-addressed route on the mount, read and write. `sideEffect` is the
 * mock that must NOT be reached when the caller is out of tenant.
 */
const idRoutes: ReadonlyArray<{
  name: string;
  kind: "read" | "write";
  send: (token: string) => Test;
  sideEffect: () => ReturnType<typeof vi.fn>;
}> = [
  {
    name: "PUT /:requirementId",
    kind: "write",
    send: (t) =>
      request(app)
        .put("/api/requirements/req_1")
        .set("Authorization", `Bearer ${t}`)
        .send({ title: "Hijacked" }),
    sideEffect: () => mockUpdateWithHistory,
  },
  {
    name: "PUT /:requirementId (with optimistic-lock version)",
    kind: "write",
    send: (t) =>
      request(app)
        .put("/api/requirements/req_1")
        .set("Authorization", `Bearer ${t}`)
        // A version MATCHING the server row: without the guard this is a
        // successful cross-tenant write, not a 409.
        .send({ version: REQUIREMENT_ROW.version, title: "Hijacked" }),
    sideEffect: () => mockUpdateWithHistory,
  },
  {
    name: "GET /:requirementId/assignments",
    kind: "read",
    send: (t) =>
      request(app).get("/api/requirements/req_1/assignments").set("Authorization", `Bearer ${t}`),
    sideEffect: () => prismaMock.assignment.findMany,
  },
  {
    name: "POST /:requirementId/assignments",
    kind: "write",
    send: (t) =>
      request(app)
        .post("/api/requirements/req_1/assignments")
        .set("Authorization", `Bearer ${t}`)
        .send({ assigneeId: "user_2" }),
    sideEffect: () => prismaMock.assignment.upsert,
  },
  {
    name: "DELETE /:requirementId/assignments/:assigneeId",
    kind: "write",
    send: (t) =>
      request(app)
        .delete("/api/requirements/req_1/assignments/user_2")
        .set("Authorization", `Bearer ${t}`),
    sideEffect: () => prismaMock.assignment.delete,
  },
  {
    name: "GET /:requirementId/history",
    kind: "read",
    send: (t) =>
      request(app).get("/api/requirements/req_1/history").set("Authorization", `Bearer ${t}`),
    sideEffect: () => prismaMock.requirementVersion.findMany,
  },
  {
    name: "GET /:requirementId/history/export",
    kind: "read",
    send: (t) =>
      request(app)
        .get("/api/requirements/req_1/history/export")
        .set("Authorization", `Bearer ${t}`),
    sideEffect: () => prismaMock.requirementVersion.findMany,
  },
  {
    name: "POST /:requirementId/restore/:version",
    kind: "write",
    send: (t) =>
      request(app)
        .post("/api/requirements/req_1/restore/1")
        .set("Authorization", `Bearer ${t}`)
        .send({ reason: "hijack" }),
    sideEffect: () => mockRestoreVersion,
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
  prismaMock.requirement.findUnique.mockResolvedValue({ ...REQUIREMENT_ROW });
  prismaMock.assignment.findUnique.mockResolvedValue({ id: "assign_1" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("cross-tenant access to a requirement by id (coordinator, not admin)", () => {
  for (const route of idRoutes) {
    it(`${route.name} (${route.kind}) → 404 and never reaches the service`, async () => {
      const token = await login("coordinator");
      const res = await route.send(token);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
      expect(route.sideEffect()).not.toHaveBeenCalled();
    });
  }

  it("does not leak field values through the optimistic-lock conflict diff", async () => {
    // A stale `version` on a foreign requirement would otherwise return 409 with
    // a field-level server/client diff — a read primitive over another tenant.
    const token = await login("coordinator");
    const res = await request(app)
      .put("/api/requirements/req_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ version: 1, title: "probe" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toContain("Old title");
  });

  it("returns the same 404 body for an out-of-tenant id and an unknown id", async () => {
    const token = await login("coordinator");

    const outOfTenant = await request(app)
      .put("/api/requirements/req_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x" });

    prismaMock.requirement.findUnique.mockResolvedValue(null);
    const unknown = await request(app)
      .put("/api/requirements/req_missing")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x" });

    expect(outOfTenant.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(outOfTenant.body.error).toEqual(unknown.body.error);
  });

  it("404s when the owning project row has vanished", async () => {
    prismaMock.project.findUnique.mockResolvedValue(null);
    const token = await login("coordinator");
    const res = await request(app)
      .put("/api/requirements/req_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "x" });
    expect(res.status).toBe(404);
    expect(mockUpdateWithHistory).not.toHaveBeenCalled();
  });
});

describe("same-workspace access still works", () => {
  beforeEach(() => {
    prismaMock.project.findUnique.mockResolvedValue({ workspaceId: "ws_b" });
  });

  for (const route of idRoutes) {
    it(`${route.name} succeeds for a member of the owning workspace`, async () => {
      const token = await login("coordinator");
      const res = await route.send(token);
      expect(res.status).toBeLessThan(400);
    });
  }

  it("threads the resolved projectId into the update query", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .put("/api/requirements/req_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "New title" });
    expect(res.status).toBe(200);
    expect(mockUpdateWithHistory).toHaveBeenCalled();
    const params = mockUpdateWithHistory.mock.calls[0][1] as { projectId?: string };
    expect(params.projectId).toBe("proj_a");
  });

  it("threads the resolved projectId into the restore query", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/requirements/req_1/restore/1")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    const params = mockRestoreVersion.mock.calls[0][1] as { projectId?: string };
    expect(params.projectId).toBe("proj_a");
  });

  it("scopes the optimistic-lock loader to the caller's own project", async () => {
    const token = await login("coordinator");
    await request(app)
      .put("/api/requirements/req_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ version: 2, title: "New title" });
    // The last requirement lookup is the lock loader — it must carry the scope.
    const calls = prismaMock.requirement.findUnique.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    const loaderCall = calls[calls.length - 1][0];
    expect(loaderCall.where.projectId).toBe("proj_a");
  });

  it("keeps pre-migration projects with no workspace open", async () => {
    prismaMock.project.findUnique.mockResolvedValue({ workspaceId: null });
    const token = await login("coordinator");
    const res = await request(app)
      .put("/api/requirements/req_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "New title" });
    expect(res.status).toBe(200);
    expect(mockUpdateWithHistory).toHaveBeenCalled();
  });
});

describe("system admin bypass", () => {
  it("does not resolve the project and leaves the query unscoped", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/requirements/req_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "New title" });
    expect(res.status).toBe(200);
    expect(prismaMock.project.findUnique).not.toHaveBeenCalled();
    const params = mockUpdateWithHistory.mock.calls[0][1] as { projectId?: string };
    expect(params.projectId).toBeUndefined();
  });
});

describe("assertRequirementAccessible (direct)", () => {
  const coordinator = {
    userId: "user_1",
    username: "coordinator",
    role: "coordinator",
    permissions: [],
    workspaces: ["ws_b"],
  };

  it("rejects a call with no authenticated user", async () => {
    await expect(assertRequirementAccessible(undefined, "req_1")).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_REQUIRED",
    });
    expect(prismaMock.requirement.findUnique).not.toHaveBeenCalled();
  });

  it("propagates a non-404 failure from the access seam instead of masking it as 404", async () => {
    prismaMock.project.findUnique.mockRejectedValueOnce(
      new AppError(503, "DB_DOWN", "unavailable"),
    );
    await expect(assertRequirementAccessible(coordinator, "req_1")).rejects.toMatchObject({
      statusCode: 503,
      code: "DB_DOWN",
    });
  });

  it("returns the owning projectId for a member of the workspace", async () => {
    prismaMock.project.findUnique.mockResolvedValue({ workspaceId: "ws_b" });
    await expect(assertRequirementAccessible(coordinator, "req_1")).resolves.toBe("proj_a");
  });
});
