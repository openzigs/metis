/**
 * /api/impact-analyses usage-classification route tests — Epic #292 (#298).
 *
 * Covers the per-project GET (read persisted classification) and POST
 * (recompute) endpoints: project-access authorization (tenant isolation),
 * permission gating, and that the compute path never requires a live DB (the
 * introspector is injected). Prisma is fully mocked — no real DB (the #289
 * stale-DB lesson).
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

let permitRun = true;
let permitRead = true;
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (perm: string) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (perm === "analysis.run" && !permitRun) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } });
        return;
      }
      if (perm === "analysis.read" && !permitRead) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } });
        return;
      }
      next();
    },
}));

let adminFlag = false;
let accessibleIds: string[] = ["project-001"];
vi.mock("../lib/scheduler/project-access.js", () => ({
  isAdminActor: () => adminFlag,
  listAccessibleProjectIds: vi.fn(async () => accessibleIds),
}));

const readUsageClassification = vi.fn(async () => [] as unknown[]);
vi.mock("../lib/impact-analysis/used-schema-classifier.js", () => ({
  readUsageClassification,
}));

// Epic #294 (#304) — the GET classification route now folds manual overrides in.
// Mock the override service so these tests stay focused on the classification
// path; the override behavior has its own dedicated route + unit tests.
const listManualOverrides = vi.fn(async () => [] as unknown[]);
vi.mock("../lib/impact-analysis/schema-usage-override.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/impact-analysis/schema-usage-override.js")>();
  return { ...actual, listManualOverrides };
});

const computeUsageClassification = vi.fn(
  async (
    _prisma: unknown,
    _projectId: string,
    _introspect: (projectId: string) => Promise<{ length: number }[]>,
  ): Promise<{ classified: unknown[]; persisted: number }> => ({ classified: [], persisted: 0 }),
);
vi.mock("../lib/impact-analysis/used-schema-service.js", () => ({
  computeUsageClassification,
}));

// Prisma must be mocked or the route's `import { prisma }` hits a clean-DB CI
// failure. We never read it directly in these tests (services are mocked).
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

const listDbConnectors = vi.fn(async () => [{ id: "db-1" }] as { id: string }[]);
const inspectDbConnector = vi.fn(async () => ({ tables: [] }));
vi.mock("../lib/connectors/db/db-service.js", () => ({
  listDbConnectors,
  inspectDbConnector,
}));

const { impactAnalysisRouter } = await import("./impact-analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    "/impact-analyses",
    impactAnalysisRouter({
      // Deterministic introspector — never touches a connector or DB.
      introspectorFor: () => async () => [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("usage-classification routes", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    permitRun = true;
    permitRead = true;
    adminFlag = false;
    accessibleIds = ["project-001"];
    app = createApp();
  });

  it("GET returns persisted classification for an accessible project", async () => {
    readUsageClassification.mockResolvedValueOnce([
      {
        id: "c1",
        projectId: "project-001",
        kind: "table",
        tableName: "public.users",
        columnName: null,
        columnType: null,
        usageClass: "used",
        uncertainReason: null,
        evidence: [],
        overriddenClass: null,
        computedAt: "2026-06-18T00:00:00.000Z",
      },
    ]);
    const res = await request(app).get(
      "/impact-analyses/projects/project-001/usage-classification",
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].usageClass).toBe("used");
    expect(readUsageClassification).toHaveBeenCalledWith({}, "project-001");
  });

  it("GET denies access to a project outside the caller's accessible set (404, no leak)", async () => {
    const res = await request(app).get(
      "/impact-analyses/projects/project-999/usage-classification",
    );
    expect(res.status).toBe(403);
    expect(readUsageClassification).not.toHaveBeenCalled();
  });

  it("GET is forbidden without analysis.read permission", async () => {
    permitRead = false;
    const res = await request(app).get(
      "/impact-analyses/projects/project-001/usage-classification",
    );
    expect(res.status).toBe(403);
  });

  it("POST recomputes classification for an accessible project", async () => {
    computeUsageClassification.mockResolvedValueOnce({
      classified: [
        {
          kind: "table",
          tableName: "public.users",
          columnName: null,
          columnType: null,
          existsInSchema: true,
          evidence: [],
          usageClass: "used",
          uncertainReason: null,
          safeToReview: false,
        },
      ],
      persisted: 1,
    });
    const res = await request(app)
      .post("/impact-analyses/projects/project-001/usage-classification")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.persisted).toBe(1);
    expect(res.body.data.objects).toHaveLength(1);
    expect(computeUsageClassification).toHaveBeenCalledOnce();
  });

  it("POST requires analysis.run permission", async () => {
    permitRun = false;
    const res = await request(app)
      .post("/impact-analyses/projects/project-001/usage-classification")
      .send({});
    expect(res.status).toBe(403);
    expect(computeUsageClassification).not.toHaveBeenCalled();
  });

  it("POST denies a project outside the accessible set", async () => {
    const res = await request(app)
      .post("/impact-analyses/projects/nope/usage-classification")
      .send({});
    expect(res.status).toBe(403);
    expect(computeUsageClassification).not.toHaveBeenCalled();
  });

  describe("default introspector (no injection)", () => {
    function appDefault() {
      const a = express();
      a.use(express.json());
      a.use("/impact-analyses", impactAnalysisRouter());
      a.use(errorHandler);
      return a;
    }

    it("resolves the project's first DB connector and introspects (read-only)", async () => {
      listDbConnectors.mockResolvedValueOnce([{ id: "db-1" }]);
      inspectDbConnector.mockResolvedValueOnce({ tables: [] });
      computeUsageClassification.mockImplementationOnce(async (_p, projectId, introspect) => {
        // Drive the injected default introspector to exercise the connector path.
        const tables = await introspect(projectId);
        return { classified: [], persisted: tables.length };
      });
      const res = await request(appDefault())
        .post("/impact-analyses/projects/project-001/usage-classification")
        .send({});
      expect(res.status).toBe(200);
      expect(listDbConnectors).toHaveBeenCalledWith("project-001");
      expect(inspectDbConnector).toHaveBeenCalledWith("project-001", "db-1", "user-1");
    });

    it("returns 404 when the project has no DB connector to introspect", async () => {
      listDbConnectors.mockResolvedValueOnce([]);
      computeUsageClassification.mockImplementationOnce(async (_p, projectId, introspect) => {
        await introspect(projectId); // throws NO_DB_CONNECTOR
        return { classified: [], persisted: 0 };
      });
      const res = await request(appDefault())
        .post("/impact-analyses/projects/project-001/usage-classification")
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NO_DB_CONNECTOR");
    });

    it("passes a routines introspector that returns the snapshot's routines (#302)", async () => {
      listDbConnectors.mockResolvedValue([{ id: "db-1" }]);
      inspectDbConnector.mockResolvedValue({
        tables: [],
        routines: [{ schema: "app", name: "calc", type: "function", signature: "" }],
      });
      computeUsageClassification.mockImplementationOnce(
        async (
          _p: unknown,
          projectId: string,
          _introspect: unknown,
          routinesIntrospect?: (id: string) => Promise<unknown[]>,
        ) => {
          const routines = routinesIntrospect ? await routinesIntrospect(projectId) : [];
          return { classified: [], persisted: routines.length };
        },
      );
      const res = await request(appDefault())
        .post("/impact-analyses/projects/project-001/usage-classification")
        .send({});
      expect(res.status).toBe(200);
      // The default routines introspector surfaced the snapshot's one routine.
      expect(res.body.data.persisted).toBe(1);
    });

    it("routines introspector yields [] when the project has no DB connector (#302)", async () => {
      listDbConnectors.mockResolvedValue([]);
      computeUsageClassification.mockImplementationOnce(
        async (
          _p: unknown,
          projectId: string,
          _introspect: unknown,
          routinesIntrospect?: (id: string) => Promise<unknown[]>,
        ) => {
          const routines = routinesIntrospect ? await routinesIntrospect(projectId) : [];
          return { classified: [], persisted: routines.length };
        },
      );
      const res = await request(appDefault())
        .post("/impact-analyses/projects/project-001/usage-classification")
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.persisted).toBe(0);
    });
  });
});
