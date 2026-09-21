/**
 * BOLA / object-level authorization test for the connectors subtree
 * (`/api/projects/:projectId/connectors/*`) — issue #674, epic #671, OWASP A01.
 *
 * Highest-value target of the epic: `GET /repos/:id` leaks another tenant's repo
 * identity + `secretRef` credential config. A caller whose workspaces do not
 * include the project's workspace must get a 404 (no existence oracle) BEFORE
 * the connector service runs, even though the role check (`connector.read`)
 * would otherwise admit them.
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

const projectFindUnique = vi.fn();
vi.mock("../lib/prisma.js", () => ({ prisma: { project: { findUnique: projectFindUnique } } }));

const getRepoConnector = vi.fn();
vi.mock("../lib/connectors/repo/repo-service.js", () => ({ getRepoConnector }));
vi.mock("../lib/connectors/db/db-service.js", () => ({}));
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

const { connectorsRouter } = await import("./connectors.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/connectors", connectorsRouter());
  app.use(errorHandler);
  return app;
}

describe("connectors subtree — workspace scope (#674)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "u1", role: "coordinator", workspaces: ["ws-a"] };
    app = createApp();
  });

  it("404s a role-permitted caller whose workspace excludes the project — no oracle", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const res = await request(app).get("/api/projects/project-b01/connectors/repos/repo-9");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    // The connector service (which would disclose secretRef/repo identity) must
    // never run once access is denied.
    expect(getRepoConnector).not.toHaveBeenCalled();
  });

  it("serves the connector for an in-tenant caller", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    getRepoConnector.mockResolvedValueOnce({ id: "repo-9", label: "app" });
    const res = await request(app).get("/api/projects/project-a01/connectors/repos/repo-9");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("repo-9");
    expect(getRepoConnector).toHaveBeenCalledWith("project-a01", "repo-9");
  });

  it("lets a system admin bypass the workspace scope", async () => {
    currentUser = { userId: "admin-1", username: "admin", role: "admin" };
    getRepoConnector.mockResolvedValueOnce({ id: "repo-9", label: "app" });
    const res = await request(app).get("/api/projects/project-b01/connectors/repos/repo-9");
    expect(res.status).toBe(200);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});
