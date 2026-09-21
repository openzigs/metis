/**
 * /api/jira — route-layer tests — Epic #556 / Issues #560–#561.
 *
 * Tests routing, validation, auth, and permission gating. Service layer
 * is mocked — we test the HTTP surface only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Prisma mock (same pattern as connector-routes.test.ts) ----------------
vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({
          id: "user_admin",
          ...create,
        }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    jiraConnection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
  });
  return { prisma };
});

// Mock the entire jira-service module
const mockList = vi.fn(async () => []);
const mockGet = vi.fn(async () => ({
  id: "jira_1",
  projectId: "proj_1",
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
  createdById: "user_admin",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}));
const mockCreate = vi.fn(async () => ({
  id: "jira_new",
  projectId: "proj_1",
  label: "new-conn",
  edition: "cloud",
  baseUrl: "https://test.atlassian.net",
  username: "u@e.com",
  secretMasked: "••••••••",
  proxyUrl: null,
  tlsRejectUnauthorized: true,
  hasTlsCa: false,
  status: "untested",
  errorMessage: null,
  lastTestedAt: null,
  createdById: "user_admin",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}));
const mockUpdate = vi.fn(async () => ({ ...mockGet(), label: "updated" }));
const mockDelete = vi.fn(async () => undefined);
const mockTest = vi.fn(async () => ({
  ok: true,
  serverInfo: { version: "9.0.0", baseUrl: "https://test.atlassian.net" },
  latencyMs: 42,
}));
const mockListProjects = vi.fn(async () => [
  { id: "10000", key: "PROJ", name: "My Project", projectTypeKey: "software" },
]);
const mockSearch = vi.fn(async () => ({
  startAt: 0,
  maxResults: 20,
  total: 1,
  issues: [{ id: "1", key: "PROJ-1", self: "u", fields: { summary: "Test" } }],
}));
const mockGetIssue = vi.fn(async () => ({
  id: "1",
  key: "PROJ-1",
  self: "u",
  fields: { summary: "Test" },
  renderedFields: {},
}));

const mockProxyAttachment = vi.fn(
  async (): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
    contentLength: number | null;
    contentDisposition: "inline" | "attachment";
  }> => ({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from("PNGDATA")));
        controller.close();
      },
    }),
    contentType: "image/png",
    contentLength: 7,
    contentDisposition: "inline",
  }),
);

vi.mock("../src/lib/connectors/jira/jira-service.js", () => ({
  listJiraConnections: (...args: unknown[]) => mockList(...args),
  getJiraConnection: (...args: unknown[]) => mockGet(...args),
  createJiraConnection: (...args: unknown[]) => mockCreate(...args),
  updateJiraConnection: (...args: unknown[]) => mockUpdate(...args),
  deleteJiraConnection: (...args: unknown[]) => mockDelete(...args),
  testJiraConnection: (...args: unknown[]) => mockTest(...args),
  listJiraProjects: (...args: unknown[]) => mockListProjects(...args),
  searchJiraIssues: (...args: unknown[]) => mockSearch(...args),
  getJiraIssue: (...args: unknown[]) => mockGetIssue(...args),
  proxyJiraAttachment: (...args: unknown[]) => mockProxyAttachment(...(args as [])),
}));

vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async (ref: string | null) => (ref ? `plain-${ref}` : null)),
}));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  app = createApp();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/jira/connections", () => {
  it("rejects unauthenticated GET", async () => {
    const res = await request(app).get("/api/jira/connections?projectId=p1");
    expect(res.status).toBe(401);
  });

  it("GET /connections?projectId=X returns list", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/jira/connections?projectId=proj_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockList).toHaveBeenCalledWith("proj_1");
  });

  it("GET /connections requires projectId", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/jira/connections")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("POST /connections creates a connection", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/jira/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({
        projectId: "proj_1",
        label: "new-conn",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "u@e.com",
        apiToken: "my-token",
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockCreate).toHaveBeenCalled();
  });

  it("POST /connections rejects invalid body", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/jira/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({ projectId: "proj_1" }); // missing required fields
    expect(res.status).toBe(400);
  });

  it("GET /connections/:id returns detail", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/jira/connections/jira_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // `admin` bypasses workspace RBAC, so the project scope stays undefined
    // (#1055). Cross-tenant behaviour is covered in jira-connection-idor.test.ts.
    expect(mockGet).toHaveBeenCalledWith("jira_1", undefined);
  });

  it("PATCH /connections/:id updates", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch("/api/jira/connections/jira_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "updated" });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("DELETE /connections/:id soft-deletes", async () => {
    const token = await login("admin");
    const res = await request(app)
      .delete("/api/jira/connections/jira_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalled();
  });

  it("POST /connections/:id/test tests connectivity", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/jira/connections/jira_1/test")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(mockTest).toHaveBeenCalled();
  });
});

describe("/api/jira/connections/:id/projects", () => {
  it("returns Jira project list", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/jira/connections/jira_1/projects")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].key).toBe("PROJ");
  });
});

describe("/api/jira/connections/:id/search", () => {
  it("searches issues with JQL", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/jira/connections/jira_1/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ jql: "project=PROJ" });
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(mockSearch).toHaveBeenCalled();
  });

  it("rejects invalid search body", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/jira/connections/jira_1/search")
      .set("Authorization", `Bearer ${token}`)
      .send({}); // missing jql
    expect(res.status).toBe(400);
  });
});

describe("/api/jira/connections/:id/issues/:key", () => {
  it("returns issue detail", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/jira/connections/jira_1/issues/PROJ-1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.key).toBe("PROJ-1");
  });
});

// ---- Attachment proxy (#1054) ----------------------------------------------

describe("/api/jira/connections/:id/attachment-proxy", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get(
      "/api/jira/connections/jira_1/attachment-proxy?url=https%3A%2F%2Fx%2Fa.png",
    );
    expect(res.status).toBe(401);
    expect(mockProxyAttachment).not.toHaveBeenCalled();
  });

  it("requires the url query parameter", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/jira/connections/jira_1/attachment-proxy")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("URL_REQUIRED");
    expect(mockProxyAttachment).not.toHaveBeenCalled();
  });

  it("streams the body using the sanitized Content-Type + Content-Disposition", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get(
        "/api/jira/connections/jira_1/attachment-proxy?url=https%3A%2F%2Ftest.atlassian.net%2Fsecure%2Fattachment%2F1%2Fa.png",
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("forces a download when the service classified the body as unsafe to inline", async () => {
    mockProxyAttachment.mockResolvedValueOnce({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from("<script>alert(1)</script>")));
          controller.close();
        },
      }),
      contentType: "application/octet-stream",
      contentLength: 25,
      contentDisposition: "attachment",
    });
    const token = await login("admin");
    const res = await request(app)
      .get(
        "/api/jira/connections/jira_1/attachment-proxy?url=https%3A%2F%2Ftest.atlassian.net%2Fsecure%2Fattachment%2F1%2Fx.html",
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe("attachment");
  });

  it("tears down the connection when the size cap trips mid-stream", async () => {
    // Headers are already committed at that point, so aborting the socket is
    // the only way to signal the failure — the client must not receive a
    // well-formed truncated body.
    mockProxyAttachment.mockResolvedValueOnce({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from("partial")));
        },
        pull(controller) {
          controller.error(new Error("ATTACHMENT_TOO_LARGE"));
        },
      }),
      contentType: "application/octet-stream",
      contentLength: null,
      contentDisposition: "attachment",
    });
    const token = await login("admin");
    const outcome = await request(app)
      .get(
        "/api/jira/connections/jira_1/attachment-proxy?url=https%3A%2F%2Ftest.atlassian.net%2Fa.bin",
      )
      .set("Authorization", `Bearer ${token}`)
      .then(
        () => "completed",
        () => "aborted",
      );
    expect(outcome).toBe("aborted");
  });

  it("surfaces a JiraApiError URL rejection as its own status, not a 500", async () => {
    const { JiraApiError } = await import("../src/lib/connectors/jira/jira-errors.js");
    mockProxyAttachment.mockRejectedValueOnce(
      new JiraApiError(400, "INVALID_URL", "URL does not belong to this Jira instance"),
    );
    const token = await login("admin");
    const res = await request(app)
      .get(
        "/api/jira/connections/jira_1/attachment-proxy?url=https%3A%2F%2Ftest.atlassian.net.attacker.com%2Fcollect",
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_URL");
  });

  it("passes an unrecognized failure through to the generic error handler", async () => {
    mockProxyAttachment.mockRejectedValueOnce(new Error("boom"));
    const token = await login("admin");
    const res = await request(app)
      .get(
        "/api/jira/connections/jira_1/attachment-proxy?url=https%3A%2F%2Ftest.atlassian.net%2Fa.png",
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("collapses an allow-list rejection into a generic 400 that leaks no internal address", async () => {
    const { ConnectorError } = await import("../src/lib/connectors/types.js");
    mockProxyAttachment.mockRejectedValueOnce(
      new ConnectorError(
        403,
        "HOST_NOT_ALLOWED",
        "jira host evil.example resolves to private/loopback address 169.254.169.254 — not on allow-list",
      ),
    );
    const token = await login("admin");
    const res = await request(app)
      .get(
        "/api/jira/connections/jira_1/attachment-proxy?url=https%3A%2F%2Ftest.atlassian.net%2Fa.png",
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("URL_NOT_ALLOWED");
    expect(JSON.stringify(res.body)).not.toContain("169.254.169.254");
  });
});
