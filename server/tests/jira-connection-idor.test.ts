/**
 * /api/jira — cross-project IDOR regression tests (Issue #1055, epic #1051).
 *
 * `/api/jira` is not mounted under `/projects/:projectId`, so the
 * `requireProjectAccess()` chokepoint cannot be mounted — the owning project is
 * resolved from the connection row and authorized with `assertProjectAccess`.
 * These tests pin that behaviour for every route on the router:
 *
 *   • a workspace-B caller gets 404 for a workspace-A connection id, on read
 *     AND write routes, and the service layer is never reached;
 *   • the caller-supplied `projectId` routes (create / list) are gated too;
 *   • the 404 for an out-of-tenant id is byte-identical to the 404 for an
 *     unknown id, so the error channel is not an existence oracle;
 *   • same-workspace callers still succeed, with the resolved projectId
 *     threaded into the service call so the scope lives in the query;
 *   • system admins bypass, and pre-migration null-workspace projects stay open.
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
    jiraConnection: {
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
  id: "jira_1",
  projectId: "proj_a",
  label: "test",
  edition: "cloud",
  baseUrl: "https://test.atlassian.net",
  username: "u",
  secretMasked: "••••••••",
  proxyUrl: null,
  tlsRejectUnauthorized: true,
  hasTlsCa: false,
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
const mockListProjects = vi.fn(async () => []);
const mockSearch = vi.fn(async () => ({ startAt: 0, maxResults: 20, total: 0, issues: [] }));
const mockGetIssue = vi.fn(async () => ({ id: "1", key: "PROJ-1", self: "u", fields: {} }));
const mockProxyAttachment = vi.fn(async () => ({
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(Buffer.from("PNGDATA")));
      controller.close();
    },
  }),
  contentType: "image/png",
  contentLength: 7,
  contentDisposition: "inline" as const,
}));

vi.mock("../src/lib/connectors/jira/jira-service.js", () => ({
  listJiraConnections: (...args: unknown[]) => mockList(...(args as [])),
  getJiraConnection: (...args: unknown[]) => mockGet(...(args as [])),
  createJiraConnection: (...args: unknown[]) => mockCreate(...(args as [])),
  updateJiraConnection: (...args: unknown[]) => mockUpdate(...(args as [])),
  deleteJiraConnection: (...args: unknown[]) => mockDelete(...(args as [])),
  testJiraConnection: (...args: unknown[]) => mockTest(...(args as [])),
  listJiraProjects: (...args: unknown[]) => mockListProjects(...(args as [])),
  searchJiraIssues: (...args: unknown[]) => mockSearch(...(args as [])),
  getJiraIssue: (...args: unknown[]) => mockGetIssue(...(args as [])),
  proxyJiraAttachment: (...args: unknown[]) => mockProxyAttachment(...(args as [])),
}));

import request from "supertest";
import type { Test } from "supertest";
import { createApp } from "../src/app.js";
import { authorizeJiraConnection } from "../src/lib/connectors/connection-authz.js";
import { AppError } from "../src/middleware/error-handler.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

const ATTACHMENT_URL = "?url=https%3A%2F%2Ftest.atlassian.net%2Fsecure%2Fattachment%2F1%2Fa.png";

/** Every `/connections/:id` route on the router, read and write. */
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
      request(app).get("/api/jira/connections/jira_1").set("Authorization", `Bearer ${t}`),
    service: mockGet,
  },
  {
    name: "PATCH /connections/:id",
    kind: "write",
    send: (t) =>
      request(app)
        .patch("/api/jira/connections/jira_1")
        .set("Authorization", `Bearer ${t}`)
        .send({ label: "renamed" }),
    service: mockUpdate,
  },
  {
    name: "DELETE /connections/:id",
    kind: "write",
    send: (t) =>
      request(app).delete("/api/jira/connections/jira_1").set("Authorization", `Bearer ${t}`),
    service: mockDelete,
  },
  {
    name: "POST /connections/:id/test",
    kind: "write",
    send: (t) =>
      request(app).post("/api/jira/connections/jira_1/test").set("Authorization", `Bearer ${t}`),
    service: mockTest,
  },
  {
    name: "GET /connections/:id/projects",
    kind: "read",
    send: (t) =>
      request(app).get("/api/jira/connections/jira_1/projects").set("Authorization", `Bearer ${t}`),
    service: mockListProjects,
  },
  {
    name: "POST /connections/:id/search",
    kind: "read",
    send: (t) =>
      request(app)
        .post("/api/jira/connections/jira_1/search")
        .set("Authorization", `Bearer ${t}`)
        .send({ jql: "project=PROJ" }),
    service: mockSearch,
  },
  {
    name: "GET /connections/:id/issues/:key",
    kind: "read",
    send: (t) =>
      request(app)
        .get("/api/jira/connections/jira_1/issues/PROJ-1")
        .set("Authorization", `Bearer ${t}`),
    service: mockGetIssue,
  },
  {
    name: "GET /connections/:id/attachment-proxy",
    kind: "read",
    send: (t) =>
      request(app)
        .get(`/api/jira/connections/jira_1/attachment-proxy${ATTACHMENT_URL}`)
        .set("Authorization", `Bearer ${t}`),
    service: mockProxyAttachment,
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
  prismaMock.jiraConnection.findFirst.mockResolvedValue({ projectId: "proj_a" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("cross-tenant access to a Jira connection by id", () => {
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
      .get("/api/jira/connections/jira_1")
      .set("Authorization", `Bearer ${token}`);

    prismaMock.jiraConnection.findFirst.mockResolvedValue(null);
    const unknown = await request(app)
      .get("/api/jira/connections/jira_missing")
      .set("Authorization", `Bearer ${token}`);

    expect(outOfTenant.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(outOfTenant.body.error).toEqual(unknown.body.error);
  });

  it("rejects the attachment proxy before any outbound fetch", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .get(`/api/jira/connections/jira_1/attachment-proxy${ATTACHMENT_URL}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    // The fetch seam lives behind proxyJiraAttachment — it must not be entered.
    expect(mockProxyAttachment).not.toHaveBeenCalled();
    expect(res.headers["content-disposition"]).toBeUndefined();
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
      // The owning projectId is the last argument of every service signature.
      const args = route.service.mock.calls[0];
      expect(args[args.length - 1]).toBe("proj_a");
    });
  }

  it("keeps pre-migration projects with no workspace open", async () => {
    prismaMock.project.findUnique.mockResolvedValue({ workspaceId: null });
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/jira/connections/jira_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith("jira_1", "proj_a");
  });

  it("404s when the owning project row has vanished", async () => {
    prismaMock.project.findUnique.mockResolvedValue(null);
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/jira/connections/jira_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("system admin bypass", () => {
  it("does not resolve the connection and leaves the service call unscoped", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/jira/connections/jira_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(prismaMock.jiraConnection.findFirst).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledWith("jira_1", undefined);
  });
});

describe("authorizeJiraConnection (direct)", () => {
  it("rejects a call with no authenticated user", async () => {
    await expect(authorizeJiraConnection(undefined, "jira_1")).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_REQUIRED",
    });
    expect(prismaMock.jiraConnection.findFirst).not.toHaveBeenCalled();
  });

  it("propagates a non-404 failure from the access seam instead of masking it as 404", async () => {
    prismaMock.project.findUnique.mockRejectedValueOnce(
      new AppError(503, "DB_DOWN", "unavailable"),
    );
    await expect(
      authorizeJiraConnection(
        {
          userId: "user_1",
          username: "u",
          role: "coordinator",
          permissions: [],
          workspaces: ["ws_b"],
        },
        "jira_1",
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "DB_DOWN" });
  });
});

describe("caller-supplied projectId routes", () => {
  it("POST /connections with a foreign projectId → 404, nothing created", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/jira/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({
        projectId: "proj_a",
        label: "new-conn",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u@e.com",
        apiToken: "my-token",
      });
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("GET /connections?projectId=<foreign> → 404, nothing listed", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .get("/api/jira/connections?projectId=proj_a")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("allows create + list for a project in the caller's own workspace", async () => {
    prismaMock.project.findUnique.mockResolvedValue({ workspaceId: "ws_b" });
    const token = await login("coordinator");

    const created = await request(app)
      .post("/api/jira/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({
        projectId: "proj_b",
        label: "new-conn",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u@e.com",
        apiToken: "my-token",
      });
    expect(created.status).toBe(201);
    expect(mockCreate).toHaveBeenCalled();

    const listed = await request(app)
      .get("/api/jira/connections?projectId=proj_b")
      .set("Authorization", `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("proj_b");
  });
});
