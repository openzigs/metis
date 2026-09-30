/**
 * #498 — route-layer branches of `connectors.ts` no other suite reached: the
 * explicit DatabaseResource link/unlink/re-resolve routes and the Atlassian
 * (Confluence / Jira) routes. The services are mocked; these tests pin the
 * route's own validation, argument mapping and error translation.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: { username: string } }) => ({
        id: "user_admin",
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    repoConnection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({
        id: "repo-1",
        projectId: "proj-1",
        label: "test-repo",
        provider: "github",
        ownerOrOrg: "acme",
        repoName: "backend",
        defaultBranch: "main",
        isPrimary: true,
        apiBaseUrl: null,
        secretId: null,
        status: "ready",
        errorMessage: null,
        lastTestedAt: null,
        lastIngestAt: null,
        lastCommitSha: null,
        createdById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      })),
      count: vi.fn(async () => 1),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    databaseConnection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "db.example.com",
    address: "203.0.113.10",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));

vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async () => null),
}));

const h = vi.hoisted(() => ({
  link: vi.fn(),
  unlink: vi.fn(),
  reresolve: vi.fn(),
  resolveServer: vi.fn(),
  confluence: vi.fn(),
  jira: vi.fn(),
}));

vi.mock("../src/lib/cross-project/analysis-database-identity.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  linkConnectionToResourceExplicit: h.link,
  unlinkConnectionFromResource: h.unlink,
  reresolveConnectionResource: h.reresolve,
}));

vi.mock("../src/lib/connectors/atlassian.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveAtlassianMCPServer: h.resolveServer,
  ingestConfluenceSpace: h.confluence,
  ingestJiraQuery: h.jira,
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

let app: ReturnType<typeof createApp>;
let token: string;
const base = "/api/projects/proj-1/connectors";

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(async () => {
  vi.clearAllMocks();
  app = createApp();
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  token = res.body.data.accessToken as string;
});

const post = (path: string, body: unknown = {}) =>
  request(app)
    .post(`${base}${path}`)
    .set("Authorization", `Bearer ${token}`)
    .send(body as object);

describe("DatabaseResource link routes", () => {
  it("links with the trimmed resource id, scoped to the path's project", async () => {
    h.link.mockResolvedValueOnce({ linked: true });
    const res = await post("/dbs/db-1/link", { databaseResourceId: "  res-1 " });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ linked: true });
    expect(h.link).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj-1",
      connectionId: "db-1",
      databaseResourceId: "res-1",
      actorId: expect.any(String),
    });
  });

  it("rejects a link without a resource id before calling the service", async () => {
    const res = await post("/dbs/db-1/link", { databaseResourceId: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(h.link).not.toHaveBeenCalled();
  });

  it("translates a connector error from the service into its status, with safe text", async () => {
    h.link.mockRejectedValueOnce(new ConnectorError(404, "NOT_FOUND", "no such resource"));
    const res = await post("/dbs/db-1/link", { databaseResourceId: "res-x" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it.each([
    ["unlink", h.unlink],
    ["reresolve", h.reresolve],
  ] as const)("%s calls its service for this project's connection", async (route, fn) => {
    fn.mockResolvedValueOnce({ ok: route });
    const res = await post(`/dbs/db-1/${route}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: route });
    expect(fn).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj-1",
      connectionId: "db-1",
      actorId: expect.any(String),
    });
  });

  it.each([
    ["unlink", h.unlink],
    ["reresolve", h.reresolve],
  ] as const)("%s surfaces a connector error's status", async (route, fn) => {
    fn.mockRejectedValueOnce(new ConnectorError(409, "CONFLICT", "busy"));
    const res = await post(`/dbs/db-1/${route}`);
    expect(res.status).toBe(409);
  });
});

describe("Atlassian routes", () => {
  it("reports a configured Atlassian server", async () => {
    h.resolveServer.mockResolvedValueOnce({ id: "mcp-1" });
    const res = await request(app)
      .get(`${base}/atlassian/status`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ configured: true, serverId: "mcp-1" });
    expect(h.resolveServer).toHaveBeenCalledWith("proj-1");
  });

  it("reports an unconfigured Atlassian server", async () => {
    h.resolveServer.mockResolvedValueOnce(null);
    const res = await request(app)
      .get(`${base}/atlassian/status`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.body.data).toEqual({ configured: false, serverId: null });
  });

  it("surfaces a status lookup failure's connector status", async () => {
    h.resolveServer.mockRejectedValueOnce(new ConnectorError(503, "UNAVAILABLE", "down"));
    const res = await request(app)
      .get(`${base}/atlassian/status`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
  });

  it("ingests a Confluence space with a trimmed key and query", async () => {
    h.confluence.mockResolvedValueOnce({ pages: 2 });
    const res = await post("/confluence/ingest", { spaceKey: " ENG ", query: " api " });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ pages: 2 });
    expect(h.confluence).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj-1",
      spaceKey: "ENG",
      query: "api",
      actorId: expect.any(String),
    });
  });

  it.each([
    ["no query", { spaceKey: "ENG" }],
    ["a blank query", { spaceKey: "ENG", query: "  " }],
    ["a non-string query", { spaceKey: "ENG", query: 7 }],
  ])("sends no query for %s", async (_label, body) => {
    h.confluence.mockResolvedValueOnce({ pages: 0 });
    expect((await post("/confluence/ingest", body)).status).toBe(200);
    expect(h.confluence.mock.calls[0][0].query).toBeUndefined();
  });

  it.each([{}, { spaceKey: "  " }])("requires a space key (%j)", async (body) => {
    const res = await post("/confluence/ingest", body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SPACE_REQUIRED");
    expect(h.confluence).not.toHaveBeenCalled();
  });

  it("ingests a Jira query with a trimmed JQL", async () => {
    h.jira.mockResolvedValueOnce({ issues: 4 });
    const res = await post("/jira/ingest", { jql: " project = ENG " });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ issues: 4 });
    expect(h.jira).toHaveBeenCalledExactlyOnceWith({
      projectId: "proj-1",
      jql: "project = ENG",
      actorId: expect.any(String),
    });
  });

  it.each([{}, { jql: "   " }])("requires JQL (%j)", async (body) => {
    const res = await post("/jira/ingest", body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("JQL_REQUIRED");
    expect(h.jira).not.toHaveBeenCalled();
  });

  it("refuses JQL over 4096 characters", async () => {
    const res = await post("/jira/ingest", { jql: "x".repeat(4097) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("JQL_TOO_LONG");
    expect(h.jira).not.toHaveBeenCalled();
  });

  it("surfaces an ingest failure's connector status", async () => {
    h.jira.mockRejectedValueOnce(new ConnectorError(502, "UPSTREAM", "jira down"));
    expect((await post("/jira/ingest", { jql: "a = b" })).status).toBe(502);
    h.confluence.mockRejectedValueOnce(new ConnectorError(502, "UPSTREAM", "wiki down"));
    expect((await post("/confluence/ingest", { spaceKey: "ENG" })).status).toBe(502);
  });
});
