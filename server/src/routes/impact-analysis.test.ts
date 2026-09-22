/**
 * /api/impact-analyses router tests — Epic #159 (#163).
 *
 * Exercises the route layer with the engine + read services and the
 * project-access guard mocked, so the suite focuses on request validation,
 * the multi-project authorization rules (every project must be accessible),
 * and status-code mapping.
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
let permitPublish = true;
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
      if (perm === "issue.publish" && !permitPublish) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } });
        return;
      }
      next();
    },
}));

let adminFlag = false;
let accessibleIds: string[] = ["project-001", "project-002"];
vi.mock("../lib/scheduler/project-access.js", () => ({
  isAdminActor: () => adminFlag,
  listAccessibleProjectIds: vi.fn(async () => accessibleIds),
}));

const triggerImpactAnalysis = vi.fn(async () => ({ id: "ia-1", status: "pending" }));
vi.mock("../lib/impact-analysis/impact-analysis-engine.js", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/impact-analysis/impact-analysis-engine.js")
  >("../lib/impact-analysis/impact-analysis-engine.js");
  return { ImpactAnalysisError: actual.ImpactAnalysisError, triggerImpactAnalysis };
});

const listImpactAnalyses = vi.fn(async () => []);
const getImpactAnalysisDetail = vi.fn(async () => null as unknown);
vi.mock("../lib/impact-analysis/impact-analysis-read.js", () => ({
  listImpactAnalyses,
  getImpactAnalysisDetail,
}));

// #963 — the export + Jira-publish routes resolve project display names / Jira
// config via prisma, and delegate the publish to the shared finding-publisher.
// The publish route issues TWO findMany calls: a Jira-config check (select {id})
// and a display-name lookup (select {id,name}). `jiraConfiguredIds` controls
// which run projects the config check reports as configured.
let jiraConfiguredIds: string[] = ["project-001", "project-002"];
const projectNameRows = [
  { id: "project-001", name: "Alpha" },
  { id: "project-002", name: "Beta" },
];
const projectFindMany = vi.fn(
  async (args: { select?: { name?: boolean } }): Promise<Array<Record<string, unknown>>> => {
    if (args?.select?.name) return projectNameRows;
    return jiraConfiguredIds.map((id) => ({ id }));
  },
);
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findMany: projectFindMany } },
}));

const publishImpactAnalysisToJira = vi.fn(async () => ({
  id: "link-1",
  scanFindingId: "ia-1",
  provider: "jira",
  externalId: "IMP-1",
  externalUrl: "https://jira.example.com/browse/IMP-1",
}));
vi.mock("../lib/scanner/prisma-adapter.js", () => ({ publishImpactAnalysisToJira }));

// Issue #958 — connector plumbing behind `defaultLiveIndexIntrospectorFor`.
// Mocked here (not `../lib/impact-analysis/live-schema-ingest.js`) so the real
// `loadLiveSchema`/`LiveSchemaIndex` reconciliation logic still runs, proving
// the wiring actually reconciles rather than just forwarding a stub.
let dbConnectorsResult: Array<{ id: string }> = [];
let dbSnapshotResult: unknown = { tables: [], routines: [] };
let dbListError: Error | null = null;
let dbInspectError: Error | null = null;
const listDbConnectorsMock = vi.fn(async () => {
  if (dbListError) throw dbListError;
  return dbConnectorsResult;
});
const inspectDbConnectorMock = vi.fn(async () => {
  if (dbInspectError) throw dbInspectError;
  return dbSnapshotResult;
});
vi.mock("../lib/connectors/db/db-service.js", () => ({
  listDbConnectors: (...args: unknown[]) =>
    (listDbConnectorsMock as (...a: unknown[]) => unknown)(...args),
  inspectDbConnector: (...args: unknown[]) =>
    (inspectDbConnectorMock as (...a: unknown[]) => unknown)(...args),
}));

const { impactAnalysisRouter, defaultLiveIndexIntrospectorFor } =
  await import("./impact-analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/impact-analyses", impactAnalysisRouter());
  app.use(errorHandler);
  return app;
}

describe("impact-analyses router", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", role: "member" };
    permitRun = true;
    permitRead = true;
    permitPublish = true;
    adminFlag = false;
    accessibleIds = ["project-001", "project-002"];
    triggerImpactAnalysis.mockResolvedValue({ id: "ia-1", status: "pending" });
    listImpactAnalyses.mockResolvedValue([]);
    getImpactAnalysisDetail.mockResolvedValue(null);
    jiraConfiguredIds = ["project-001", "project-002"];
    publishImpactAnalysisToJira.mockResolvedValue({
      id: "link-1",
      scanFindingId: "ia-1",
      provider: "jira",
      externalId: "IMP-1",
      externalUrl: "https://jira.example.com/browse/IMP-1",
    });
    dbConnectorsResult = [];
    dbSnapshotResult = { tables: [], routines: [] };
    dbListError = null;
    dbInspectError = null;
    app = createApp();
  });

  describe("POST /", () => {
    it("triggers an analysis and returns 202 with project ids", async () => {
      const res = await request(app)
        .post("/impact-analyses")
        .send({ text: "Change something.", projectIds: ["project-001", "project-002"] });
      expect(res.status).toBe(202);
      expect(res.body.data).toEqual({
        id: "ia-1",
        status: "pending",
        projectIds: ["project-001", "project-002"],
      });
      expect(triggerImpactAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ projectIds: ["project-001", "project-002"], actorId: "user-1" }),
        // #931 — the route passes a (possibly empty) deps object as the 2nd arg;
        // with IMPACT_LLM_SEEDING off it is `{}` (deterministic BM25 default).
        expect.any(Object),
      );
    });

    it("forwards includeDependencies=false (zod default) when omitted", async () => {
      await request(app)
        .post("/impact-analyses")
        .send({ text: "Change something.", projectIds: ["project-001"] });
      expect(triggerImpactAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ includeDependencies: false }),
        expect.any(Object),
      );
    });

    it("forwards an explicit includeDependencies=true", async () => {
      await request(app)
        .post("/impact-analyses")
        .send({
          text: "Change something.",
          projectIds: ["project-001"],
          includeDependencies: true,
        });
      expect(triggerImpactAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ includeDependencies: true }),
        expect.any(Object),
      );
    });

    it("dedupes project ids before authz", async () => {
      await request(app)
        .post("/impact-analyses")
        .send({ text: "x", projectIds: ["project-001", "project-001", "project-002"] });
      expect(triggerImpactAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ projectIds: ["project-001", "project-002"] }),
        expect.any(Object),
      );
    });

    it("rejects an empty project list with 400", async () => {
      const res = await request(app).post("/impact-analyses").send({ text: "x", projectIds: [] });
      expect(res.status).toBe(400);
      expect(triggerImpactAnalysis).not.toHaveBeenCalled();
    });

    it("rejects when neither documentId nor text is provided", async () => {
      const res = await request(app)
        .post("/impact-analyses")
        .send({ projectIds: ["project-001"] });
      expect(res.status).toBe(400);
    });

    it("returns 403 when the caller cannot access a requested project", async () => {
      accessibleIds = ["project-001"];
      const res = await request(app)
        .post("/impact-analyses")
        .send({ text: "x", projectIds: ["project-001", "project-002"] });
      expect(res.status).toBe(403);
      expect(triggerImpactAnalysis).not.toHaveBeenCalled();
    });

    it("returns 404 when an admin requests an unknown project", async () => {
      adminFlag = true;
      accessibleIds = ["project-001"]; // admin's accessible set = all existing projects
      const res = await request(app)
        .post("/impact-analyses")
        .send({ text: "x", projectIds: ["project-001", "project-ghost"] });
      expect(res.status).toBe(404);
    });

    it("returns 403 when analysis.run permission is denied", async () => {
      permitRun = false;
      const res = await request(app)
        .post("/impact-analyses")
        .send({ text: "x", projectIds: ["project-001"] });
      expect(res.status).toBe(403);
    });

    // Issue #958 — `liveIndexFor` must actually reach the engine so reconciled
    // DDL is reachable for a connected-DB project (previously always undefined).
    it("wires a liveIndexIntrospectorFor function into the engine deps", async () => {
      await request(app)
        .post("/impact-analyses")
        .send({ text: "Change something.", projectIds: ["project-001"] });
      expect(triggerImpactAnalysis).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ liveIndexIntrospectorFor: expect.any(Function) }),
      );
    });
  });

  describe("GET /", () => {
    it("lists analyses scoped to accessible projects for non-admins", async () => {
      listImpactAnalyses.mockResolvedValue([{ id: "ia-1", projectCount: 2 }] as never);
      const res = await request(app).get("/impact-analyses");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(listImpactAnalyses).toHaveBeenCalledWith({
        accessibleProjectIds: ["project-001", "project-002"],
      });
    });

    it("passes a null scope for admins", async () => {
      adminFlag = true;
      await request(app).get("/impact-analyses");
      expect(listImpactAnalyses).toHaveBeenCalledWith({ accessibleProjectIds: null });
    });

    it("#61 — narrows to one accessible project", async () => {
      const res = await request(app).get("/impact-analyses?projectId=project-002");
      expect(res.status).toBe(200);
      expect(listImpactAnalyses).toHaveBeenCalledWith({
        accessibleProjectIds: ["project-001", "project-002"],
        projectId: "project-002",
      });
    });

    it("#61 — lists nothing for a project the caller cannot access", async () => {
      listImpactAnalyses.mockResolvedValue([{ id: "ia-1", projectCount: 2 }] as never);
      const res = await request(app).get("/impact-analyses?projectId=project-999");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(listImpactAnalyses).not.toHaveBeenCalled();
    });

    it("#61 — lets an admin narrow to any project", async () => {
      adminFlag = true;
      await request(app).get("/impact-analyses?projectId=project-999");
      expect(listImpactAnalyses).toHaveBeenCalledWith({
        accessibleProjectIds: null,
        projectId: "project-999",
      });
    });

    it("returns 403 when analysis.read permission is denied", async () => {
      permitRead = false;
      const res = await request(app).get("/impact-analyses");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /:id", () => {
    const detail = {
      id: "ia-1",
      status: "completed",
      projectIds: ["project-001", "project-002"],
      items: [],
    };

    it("returns the detail when the caller can access all projects", async () => {
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const res = await request(app).get("/impact-analyses/ia-1");
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("ia-1");
    });

    it("returns 404 when the analysis does not exist", async () => {
      getImpactAnalysisDetail.mockResolvedValue(null);
      const res = await request(app).get("/impact-analyses/missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the caller cannot access every project in the report", async () => {
      accessibleIds = ["project-001"]; // report spans project-001 + project-002
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const res = await request(app).get("/impact-analyses/ia-1");
      expect(res.status).toBe(404);
    });

    it("lets admins read any analysis", async () => {
      adminFlag = true;
      accessibleIds = [];
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const res = await request(app).get("/impact-analyses/ia-1");
      expect(res.status).toBe(200);
    });
  });

  // #963 — markdown export.
  describe("GET /:id/export.md", () => {
    const detail = {
      id: "ia-1",
      status: "completed",
      summary: "Two projects impacted.",
      errorMessage: null,
      totalImpactedSymbols: 3,
      projectIds: ["project-001", "project-002"],
      items: [],
      sharedTableImpacts: [],
    };

    it("streams a markdown attachment when the caller can access all projects", async () => {
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const res = await request(app).get("/impact-analyses/ia-1/export.md");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.headers["content-disposition"]).toContain('filename="impact-analysis-ia-1.md"');
      expect(res.text).toContain("# Impact analysis");
      // The response is a raw markdown body, NOT the { success, data } envelope.
      expect(res.text).not.toContain('"success"');
    });

    it("returns 404 when the analysis does not exist", async () => {
      getImpactAnalysisDetail.mockResolvedValue(null);
      const res = await request(app).get("/impact-analyses/missing/export.md");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the caller cannot access every project in the run", async () => {
      accessibleIds = ["project-001"];
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const res = await request(app).get("/impact-analyses/ia-1/export.md");
      expect(res.status).toBe(404);
    });

    it("returns 403 when analysis.read permission is denied", async () => {
      permitRead = false;
      const res = await request(app).get("/impact-analyses/ia-1/export.md");
      expect(res.status).toBe(403);
    });
  });

  // #963 — Jira publish.
  describe("POST /:id/publish/jira", () => {
    const detail = {
      id: "ia-1",
      status: "completed",
      summary: "Summary text",
      errorMessage: null,
      totalImpactedSymbols: 1,
      projectIds: ["project-001", "project-002"],
      items: [],
      sharedTableImpacts: [],
    };

    it("publishes one Jira issue and returns its key/url", async () => {
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const res = await request(app).post("/impact-analyses/ia-1/publish/jira").send({});
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        provider: "jira",
        issueKey: "IMP-1",
        url: "https://jira.example.com/browse/IMP-1",
      });
      // Billed to the first (sorted) configured run project.
      expect(publishImpactAnalysisToJira).toHaveBeenCalledWith(
        expect.objectContaining({ analysisId: "ia-1", jiraProjectId: "project-001" }),
      );
    });

    it("honours an explicit in-run projectId", async () => {
      getImpactAnalysisDetail.mockResolvedValue(detail);
      jiraConfiguredIds = ["project-002"];
      const res = await request(app)
        .post("/impact-analyses/ia-1/publish/jira")
        .send({ projectId: "project-002" });
      expect(res.status).toBe(200);
      expect(publishImpactAnalysisToJira).toHaveBeenCalledWith(
        expect.objectContaining({ jiraProjectId: "project-002" }),
      );
    });

    it("rejects a projectId that is not part of the run with 400", async () => {
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const res = await request(app)
        .post("/impact-analyses/ia-1/publish/jira")
        .send({ projectId: "project-ghost" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PROJECT_NOT_IN_RUN");
      expect(publishImpactAnalysisToJira).not.toHaveBeenCalled();
    });

    it("returns 400 when no run project has Jira configured", async () => {
      getImpactAnalysisDetail.mockResolvedValue(detail);
      jiraConfiguredIds = [];
      const res = await request(app).post("/impact-analyses/ia-1/publish/jira").send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("JIRA_NOT_CONFIGURED");
      expect(publishImpactAnalysisToJira).not.toHaveBeenCalled();
    });

    it("maps a downstream PublishError to a 400", async () => {
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const { PublishError } = await import("../lib/scanner/finding-publisher.js");
      publishImpactAnalysisToJira.mockRejectedValueOnce(
        new PublishError("ERR_JIRA_NOT_CONFIGURED", "Jira connection is in error state"),
      );
      const res = await request(app).post("/impact-analyses/ia-1/publish/jira").send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("JIRA_PUBLISH_FAILED");
    });

    it("returns 404 when the analysis does not exist", async () => {
      getImpactAnalysisDetail.mockResolvedValue(null);
      const res = await request(app).post("/impact-analyses/missing/publish/jira").send({});
      expect(res.status).toBe(404);
      expect(publishImpactAnalysisToJira).not.toHaveBeenCalled();
    });

    it("returns 404 when the caller cannot access every project in the run", async () => {
      accessibleIds = ["project-001"];
      getImpactAnalysisDetail.mockResolvedValue(detail);
      const res = await request(app).post("/impact-analyses/ia-1/publish/jira").send({});
      expect(res.status).toBe(404);
    });

    it("returns 403 when issue.publish permission is denied", async () => {
      permitPublish = false;
      const res = await request(app).post("/impact-analyses/ia-1/publish/jira").send({});
      expect(res.status).toBe(403);
    });
  });
});

// Issue #958 — the route-level factory that resolves a project's primary
// connector into a `LiveSchemaIndex` for reconciliation. Unit-tested directly
// (no HTTP layer) with the REAL `loadLiveSchema`/`LiveSchemaIndex` so this
// proves actual reconciliation, not just a passthrough of a mocked stub.
describe("defaultLiveIndexIntrospectorFor (#958)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbConnectorsResult = [];
    dbSnapshotResult = { tables: [], routines: [] };
    dbListError = null;
    dbInspectError = null;
  });

  it("returns null when the project has no DB connector (never introspects)", async () => {
    dbConnectorsResult = [];
    const introspect = defaultLiveIndexIntrospectorFor("actor-1");
    const result = await introspect("project-001");
    expect(result).toBeNull();
    expect(listDbConnectorsMock).toHaveBeenCalledWith("project-001");
    expect(inspectDbConnectorMock).not.toHaveBeenCalled();
  });

  it("builds a reconciliation index from the PRIMARY connector's live snapshot", async () => {
    dbConnectorsResult = [{ id: "conn-1" }, { id: "conn-2" }];
    dbSnapshotResult = {
      tables: [
        {
          schema: "shop",
          name: "orders",
          columns: [
            { name: "email", dataType: "varchar(255)", nullable: true, isPrimaryKey: false },
          ],
        },
      ],
      routines: [],
    };
    const introspect = defaultLiveIndexIntrospectorFor("actor-1");
    const index = await introspect("project-001");
    expect(index).not.toBeNull();
    expect(index?.getColumn("orders", "email", "shop")?.dataType).toBe("varchar(255)");
    expect(index?.reconcile({ table: "orders", schema: "shop", column: "phone" })).toBe(
      "column-not-found",
    );
    // Only the FIRST (primary) connector is introspected — one call, right args.
    expect(inspectDbConnectorMock).toHaveBeenCalledTimes(1);
    expect(inspectDbConnectorMock).toHaveBeenCalledWith("project-001", "conn-1", "actor-1");
  });

  it("degrades to null (never throws) when listing connectors fails", async () => {
    dbListError = new Error("db down");
    const introspect = defaultLiveIndexIntrospectorFor("actor-1");
    await expect(introspect("project-001")).resolves.toBeNull();
  });

  it("degrades to null (never throws) when introspection itself fails", async () => {
    dbConnectorsResult = [{ id: "conn-1" }];
    dbInspectError = new Error("connector offline");
    const introspect = defaultLiveIndexIntrospectorFor("actor-1");
    await expect(introspect("project-001")).resolves.toBeNull();
  });
});
