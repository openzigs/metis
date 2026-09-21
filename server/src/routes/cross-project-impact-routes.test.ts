/**
 * /api/impact-analyses cross-project route tests — Epic #295 Phase 4 (#309).
 *
 * Covers the two cross-project endpoints (which-projects-use-object +
 * cross-project-impact): permission gating, input validation, the happy path,
 * and — the critical concern — cross-workspace denial surfaced as 404 through
 * the HTTP layer. The service is mocked (it has its own exhaustive tenant-
 * isolation unit tests); Prisma is mocked so no real DB (the #289 lesson).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUser: { userId: string; role: string } = { userId: "user-1", role: "member" };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

let permitRead = true;
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (perm: string) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (perm === "analysis.read" && !permitRead) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } });
        return;
      }
      next();
    },
}));

vi.mock("../lib/scheduler/project-access.js", () => ({
  isAdminActor: () => false,
  listAccessibleProjectIds: vi.fn(async () => ["pA1"]),
}));

const whichProjectsUseObject = vi.fn();
const crossProjectImpact = vi.fn();
vi.mock("../lib/cross-project/cross-project-impact.js", () => ({
  whichProjectsUseObject,
  crossProjectImpact,
}));

// The route module imports prisma + db-service; mock both so the clean-CI DB is
// never touched (services are mocked anyway).
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../lib/connectors/db/db-service.js", () => ({
  listDbConnectors: vi.fn(),
  inspectDbConnector: vi.fn(),
}));
// Other services the router wires but these tests don't exercise.
vi.mock("../lib/impact-analysis/used-schema-classifier.js", () => ({
  readUsageClassification: vi.fn(),
}));
vi.mock("../lib/impact-analysis/schema-usage-override.js", () => ({
  listManualOverrides: vi.fn(),
  applyOverrides: vi.fn(),
  upsertManualOverride: vi.fn(),
  deleteManualOverride: vi.fn(),
}));
vi.mock("../lib/impact-analysis/used-schema-service.js", () => ({
  computeUsageClassification: vi.fn(),
}));

const { AppError } = await import("../middleware/error-handler.js");
const { impactAnalysisRouter } = await import("./impact-analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/impact-analyses", impactAnalysisRouter());
  app.use(errorHandler);
  return app;
}

describe("cross-project impact routes", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    permitRead = true;
    app = createApp();
  });

  describe("GET /workspaces/:workspaceId/objects/usage", () => {
    it("returns the projects that use the object", async () => {
      whichProjectsUseObject.mockResolvedValueOnce({
        identity: {
          id: "idA",
          databaseResourceId: "resA",
          schemaName: "public",
          objectName: "orders",
          objectType: "table",
          usageClass: "used",
        },
        projects: [
          { projectId: "pA1", projectName: "Alpha", usageClass: "used", evidenceCount: 2 },
        ],
        rollupUsageClass: "used",
      });
      const res = await request(app)
        .get("/impact-analyses/workspaces/wsA/objects/usage")
        .query({ objectName: "orders", schemaName: "public", objectType: "table" });
      expect(res.status).toBe(200);
      expect(res.body.data.projects).toHaveLength(1);
      expect(whichProjectsUseObject).toHaveBeenCalledWith({ id: "user-1", role: "member" }, "wsA", {
        objectName: "orders",
        schemaName: "public",
        objectType: "table",
      });
    });

    it("400 when objectName is missing", async () => {
      const res = await request(app).get("/impact-analyses/workspaces/wsA/objects/usage");
      expect(res.status).toBe(400);
      expect(whichProjectsUseObject).not.toHaveBeenCalled();
    });

    it("400 for an invalid objectType", async () => {
      const res = await request(app)
        .get("/impact-analyses/workspaces/wsA/objects/usage")
        .query({ objectName: "orders", objectType: "bogus" });
      expect(res.status).toBe(400);
    });

    it("CROSS-WORKSPACE DENIAL surfaces as 404 (service throws)", async () => {
      whichProjectsUseObject.mockRejectedValueOnce(
        new AppError(404, "NOT_FOUND", "Workspace not found"),
      );
      const res = await request(app)
        .get("/impact-analyses/workspaces/wsB/objects/usage")
        .query({ objectName: "orders" });
      expect(res.status).toBe(404);
    });

    it("403 without analysis.read", async () => {
      permitRead = false;
      const res = await request(app)
        .get("/impact-analyses/workspaces/wsA/objects/usage")
        .query({ objectName: "orders" });
      expect(res.status).toBe(403);
      expect(whichProjectsUseObject).not.toHaveBeenCalled();
    });
  });

  describe("GET /projects/:projectId/cross-project-impact", () => {
    it("returns the aggregated cross-project impact", async () => {
      crossProjectImpact.mockResolvedValueOnce({
        sourceProjectId: "pA1",
        workspaceId: "wsA",
        affectedObjects: [
          {
            objectName: "orders",
            schemaName: "public",
            objectType: "table",
            alsoUsedByProjects: [
              { projectId: "pA2", projectName: "Beta", usageClass: "used", evidenceCount: 1 },
            ],
          },
        ],
      });
      const res = await request(app).get("/impact-analyses/projects/pA1/cross-project-impact");
      expect(res.status).toBe(200);
      expect(res.body.data.affectedObjects).toHaveLength(1);
      expect(crossProjectImpact).toHaveBeenCalledWith({ id: "user-1", role: "member" }, "pA1");
    });

    it("CROSS-WORKSPACE DENIAL surfaces as 404", async () => {
      crossProjectImpact.mockRejectedValueOnce(new AppError(404, "NOT_FOUND", "Project not found"));
      const res = await request(app).get("/impact-analyses/projects/pB1/cross-project-impact");
      expect(res.status).toBe(404);
    });

    it("403 without analysis.read", async () => {
      permitRead = false;
      const res = await request(app).get("/impact-analyses/projects/pA1/cross-project-impact");
      expect(res.status).toBe(403);
      expect(crossProjectImpact).not.toHaveBeenCalled();
    });
  });
});
