/**
 * Route tests for the Epic #820 (#821) database-identity endpoints on the
 * connectors subtree: GET /dbs/identities and POST /dbs/:id/{link,unlink,
 * reresolve}. The service layer is mocked (covered by its own unit tests); here
 * we prove route wiring, input validation, error propagation, and that the
 * subtree's project-access guard (OWASP A01 / BOLA) gates these routes too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUser: { userId: string; username: string; role: string; workspaces?: string[] } = {
  userId: "user-1",
  username: "u1",
  role: "coordinator",
  workspaces: ["ws-a"],
};

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));
vi.mock("../middleware/connector-rate-limit.js", () => ({
  connectorMetadataRateLimiter: (_r: unknown, _s: unknown, n: () => void) => n(),
  connectorQueryRateLimiter: (_r: unknown, _s: unknown, n: () => void) => n(),
  connectorTestRateLimiter: (_r: unknown, _s: unknown, n: () => void) => n(),
}));

// Real require-project-access runs; it reads project.workspaceId to enforce BOLA.
const projectFindUnique = vi.fn();
vi.mock("../lib/prisma.js", () => ({ prisma: { project: { findUnique: projectFindUnique } } }));

// Heavy connector imports are not exercised here.
vi.mock("../lib/connectors/db/db-service.js", () => ({}));
vi.mock("../lib/connectors/repo/repo-service.js", () => ({}));
vi.mock("../lib/connectors/connector-ingest.js", () => ({}));
vi.mock("../lib/code-graph/ingest.js", () => ({ ingestCodeGraph: vi.fn() }));
vi.mock("../lib/connectors/repo/connection-discovery.js", () => ({
  discoverAndUpsertConnections: vi.fn(),
}));
vi.mock("../lib/connectors/atlassian.js", () => ({
  ingestConfluenceSpace: vi.fn(),
  ingestJiraQuery: vi.fn(),
  resolveAtlassianMCPServer: vi.fn(),
}));

const resolveProjectDatabaseIdentities = vi.fn();
const linkConnectionToResourceExplicit = vi.fn();
const unlinkConnectionFromResource = vi.fn();
const reresolveConnectionResource = vi.fn();
vi.mock("../lib/cross-project/analysis-database-identity.js", () => ({
  resolveProjectDatabaseIdentities,
  linkConnectionToResourceExplicit,
  unlinkConnectionFromResource,
  reresolveConnectionResource,
}));

const { connectorsRouter } = await import("./connectors.js");
const { errorHandler, AppError } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/connectors", connectorsRouter());
  app.use(errorHandler);
  return app;
}

const BASE = "/api/projects/proj-a/connectors";

describe("connectors — database identity routes (#821)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
    projectFindUnique.mockResolvedValue({ workspaceId: "ws-a" });
  });

  describe("GET /dbs/identities", () => {
    it("returns the project's resolved identities", async () => {
      const payload = [
        {
          connectionId: "c1",
          databaseResourceId: "res-1",
          insufficientIdentity: false,
          sharingProjects: [],
        },
      ];
      resolveProjectDatabaseIdentities.mockResolvedValueOnce(payload);
      const res = await request(app).get(`${BASE}/dbs/identities`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(payload);
      expect(resolveProjectDatabaseIdentities).toHaveBeenCalledWith("proj-a");
    });

    it("is not shadowed by the /dbs/:id detail route", async () => {
      resolveProjectDatabaseIdentities.mockResolvedValueOnce([]);
      const res = await request(app).get(`${BASE}/dbs/identities`);
      expect(res.status).toBe(200);
      expect(resolveProjectDatabaseIdentities).toHaveBeenCalledTimes(1);
    });

    it("404s a caller whose workspace excludes the project — no oracle", async () => {
      projectFindUnique.mockResolvedValue({ workspaceId: "ws-other" });
      const res = await request(app).get(`${BASE}/dbs/identities`);
      expect(res.status).toBe(404);
      expect(resolveProjectDatabaseIdentities).not.toHaveBeenCalled();
    });

    it("propagates a service error", async () => {
      resolveProjectDatabaseIdentities.mockRejectedValueOnce(new AppError(500, "BOOM", "boom"));
      const res = await request(app).get(`${BASE}/dbs/identities`);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("BOOM");
    });
  });

  describe("POST /dbs/:id/link", () => {
    it("links a connection to a resource", async () => {
      linkConnectionToResourceExplicit.mockResolvedValueOnce({
        connectionId: "c1",
        databaseResourceId: "res-1",
        changed: true,
      });
      const res = await request(app)
        .post(`${BASE}/dbs/c1/link`)
        .send({ databaseResourceId: "res-1" });
      expect(res.status).toBe(200);
      expect(res.body.data.changed).toBe(true);
      expect(linkConnectionToResourceExplicit).toHaveBeenCalledWith({
        projectId: "proj-a",
        connectionId: "c1",
        databaseResourceId: "res-1",
        actorId: "user-1",
      });
    });

    it("400s a missing databaseResourceId without touching the service", async () => {
      const res = await request(app).post(`${BASE}/dbs/c1/link`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(linkConnectionToResourceExplicit).not.toHaveBeenCalled();
    });

    it("400s an empty databaseResourceId", async () => {
      const res = await request(app)
        .post(`${BASE}/dbs/c1/link`)
        .send({ databaseResourceId: "   " });
      expect(res.status).toBe(400);
      expect(linkConnectionToResourceExplicit).not.toHaveBeenCalled();
    });

    it("propagates a service AppError (e.g. cross-workspace 404)", async () => {
      linkConnectionToResourceExplicit.mockRejectedValueOnce(
        new AppError(404, "DB_RESOURCE_NOT_FOUND", "database resource not found"),
      );
      const res = await request(app)
        .post(`${BASE}/dbs/c1/link`)
        .send({ databaseResourceId: "res-x" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DB_RESOURCE_NOT_FOUND");
    });
  });

  describe("POST /dbs/:id/unlink", () => {
    it("unlinks a connection", async () => {
      unlinkConnectionFromResource.mockResolvedValueOnce({
        connectionId: "c1",
        databaseResourceId: null,
        changed: true,
      });
      const res = await request(app).post(`${BASE}/dbs/c1/unlink`).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.databaseResourceId).toBeNull();
      expect(unlinkConnectionFromResource).toHaveBeenCalledWith({
        projectId: "proj-a",
        connectionId: "c1",
        actorId: "user-1",
      });
    });

    it("propagates a service AppError (e.g. connection not found)", async () => {
      unlinkConnectionFromResource.mockRejectedValueOnce(
        new AppError(404, "DB_CONNECTOR_NOT_FOUND", "database connection not found"),
      );
      const res = await request(app).post(`${BASE}/dbs/c1/unlink`).send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DB_CONNECTOR_NOT_FOUND");
    });
  });

  describe("POST /dbs/:id/reresolve", () => {
    it("re-resolves a connection", async () => {
      reresolveConnectionResource.mockResolvedValueOnce({
        connectionId: "c1",
        databaseResourceId: "res-1",
        changed: true,
      });
      const res = await request(app).post(`${BASE}/dbs/c1/reresolve`).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.databaseResourceId).toBe("res-1");
      expect(reresolveConnectionResource).toHaveBeenCalledWith({
        projectId: "proj-a",
        connectionId: "c1",
        actorId: "user-1",
      });
    });

    it("404s a caller outside the project's workspace before the service runs", async () => {
      projectFindUnique.mockResolvedValue({ workspaceId: "ws-other" });
      const res = await request(app).post(`${BASE}/dbs/c1/reresolve`).send({});
      expect(res.status).toBe(404);
      expect(reresolveConnectionResource).not.toHaveBeenCalled();
    });

    it("propagates a service AppError", async () => {
      reresolveConnectionResource.mockRejectedValueOnce(
        new AppError(404, "DB_CONNECTOR_NOT_FOUND", "database connection not found"),
      );
      const res = await request(app).post(`${BASE}/dbs/c1/reresolve`).send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DB_CONNECTOR_NOT_FOUND");
    });
  });
});
