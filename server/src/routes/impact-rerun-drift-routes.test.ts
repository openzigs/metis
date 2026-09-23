/**
 * /api/impact-analyses/:id/rerun + /:id/drift route tests — Issue #965 (Epic #960).
 *
 * Covers permission gating, tenant isolation (the run's projects must be
 * accessible), re-run creation (linked via rerunOfId, reusing the stored source),
 * the completed/no-source/no-projects guards, and the drift diff (real differ over
 * two mocked run details, including the no-parent empty report). The engine + read
 * layers are mocked so these tests focus on the route wiring; the differ + engine
 * have their own dedicated tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { ImpactAnalysisDetail, ImpactItemView } from "@metis/shared";

let currentUser: { userId: string; username: string; role: string } = {
  userId: "user-1",
  username: "alice",
  role: "member",
};
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

vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

const getImpactAnalysisDetail = vi.fn();
vi.mock("../lib/impact-analysis/impact-analysis-read.js", () => ({
  getImpactAnalysisDetail,
  listImpactAnalyses: vi.fn(async () => []),
}));

const triggerImpactAnalysis = vi.fn(async () => ({ id: "rerun-1", status: "pending" }));
vi.mock("../lib/impact-analysis/impact-analysis-engine.js", () => ({
  triggerImpactAnalysis,
  ImpactAnalysisError: class ImpactAnalysisError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  defaultLiveIndexIntrospectorFor: vi.fn(() => async () => null),
}));

const { impactAnalysisRouter } = await import("./impact-analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/impact-analyses", impactAnalysisRouter());
  app.use(errorHandler);
  return app;
}

function item(opts: Partial<ImpactItemView> & { projectId: string }): ImpactItemView {
  return {
    id: `item-${Math.random()}`,
    projectId: opts.projectId,
    requirementId: opts.requirementId ?? null,
    requirementTitle: opts.requirementTitle ?? null,
    changeType: "modified",
    severity: opts.severity ?? "medium",
    impactScore: 0.5,
    confidence: opts.confidence ?? 0.7,
    matchQuality: "moderate",
    matchQualityReason: null,
    affectedFileCount: 1,
    affectedSymbolCount: (opts.affectedSymbols ?? []).length,
    summary: null,
    affectedSymbols: opts.affectedSymbols ?? [],
    affectedTests: [],
    writePathGaps: [],
    affectedTables: opts.affectedTables ?? [],
    affectedTablesSecondary: [],
    feedback: [],
  };
}

function detail(over: Partial<ImpactAnalysisDetail> & { id: string }): ImpactAnalysisDetail {
  return {
    id: over.id,
    status: over.status ?? "completed",
    documentId: "documentId" in over ? (over.documentId ?? null) : null,
    sourceText: "sourceText" in over ? (over.sourceText ?? null) : "change text",
    summary: null,
    errorMessage: null,
    totalImpactedSymbols: 0,
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:01:00.000Z",
    projectIds: over.projectIds ?? ["project-001"],
    // #88 — these cases are about re-run/drift semantics, not access, so the
    // fixture is a run the caller started. It matters for the `projectIds: []`
    // case: an unattributable run is now readable by its starter alone.
    startedById: over.startedById ?? "user-1",
    items: over.items ?? [],
    sharedTableImpacts: [],
    rerunOfId: over.rerunOfId ?? null,
  };
}

describe("POST /:id/rerun (#965)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "alice", role: "member" };
    permitRun = true;
    permitRead = true;
    adminFlag = false;
    accessibleIds = ["project-001"];
    triggerImpactAnalysis.mockResolvedValue({ id: "rerun-1", status: "pending" });
    app = createApp();
  });

  it("creates a re-run linked to the original, reusing its source + projects", async () => {
    getImpactAnalysisDetail.mockResolvedValue(
      detail({ id: "orig-1", sourceText: "reuse me", projectIds: ["project-001"] }),
    );
    const res = await request(app).post("/impact-analyses/orig-1/rerun").send({});
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      id: "rerun-1",
      status: "pending",
      rerunOfId: "orig-1",
      projectIds: ["project-001"],
    });
    expect(triggerImpactAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIds: ["project-001"],
        text: "reuse me",
        documentId: null,
        rerunOfId: "orig-1",
        actorId: "user-1",
      }),
      expect.any(Object),
    );
  });

  it("reuses a documentId source verbatim when the original had no text", async () => {
    getImpactAnalysisDetail.mockResolvedValue(
      detail({ id: "orig-2", sourceText: null, documentId: "doc-9" }),
    );
    const res = await request(app).post("/impact-analyses/orig-2/rerun").send({});
    expect(res.status).toBe(202);
    expect(triggerImpactAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-9", text: null, rerunOfId: "orig-2" }),
      expect.any(Object),
    );
  });

  it("403 when the caller lacks analysis.run", async () => {
    permitRun = false;
    const res = await request(app).post("/impact-analyses/orig-1/rerun").send({});
    expect(res.status).toBe(403);
    expect(triggerImpactAnalysis).not.toHaveBeenCalled();
  });

  it("404 when the original run is not accessible", async () => {
    getImpactAnalysisDetail.mockResolvedValue(null);
    const res = await request(app).post("/impact-analyses/ghost/rerun").send({});
    expect(res.status).toBe(404);
    expect(triggerImpactAnalysis).not.toHaveBeenCalled();
  });

  it("404 when a project of the original is outside the caller's access", async () => {
    getImpactAnalysisDetail.mockResolvedValue(
      detail({ id: "orig-x", projectIds: ["project-001", "project-secret"] }),
    );
    accessibleIds = ["project-001"];
    const res = await request(app).post("/impact-analyses/orig-x/rerun").send({});
    expect(res.status).toBe(404);
    expect(triggerImpactAnalysis).not.toHaveBeenCalled();
  });

  it("409 when the original run is not completed", async () => {
    getImpactAnalysisDetail.mockResolvedValue(detail({ id: "orig-run", status: "running" }));
    const res = await request(app).post("/impact-analyses/orig-run/rerun").send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RERUN_NOT_COMPLETED");
  });

  it("409 when the original impacted no projects", async () => {
    getImpactAnalysisDetail.mockResolvedValue(detail({ id: "orig-empty", projectIds: [] }));
    const res = await request(app).post("/impact-analyses/orig-empty/rerun").send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RERUN_NO_PROJECTS");
  });

  it("409 when the original has no stored source", async () => {
    getImpactAnalysisDetail.mockResolvedValue(
      detail({ id: "orig-nosrc", sourceText: null, documentId: null }),
    );
    const res = await request(app).post("/impact-analyses/orig-nosrc/rerun").send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RERUN_NO_SOURCE");
  });
});

describe("GET /:id/drift (#965)", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "alice", role: "member" };
    permitRead = true;
    adminFlag = false;
    accessibleIds = ["project-001"];
    app = createApp();
  });

  it("diffs a re-run against its parent and returns the drift report", async () => {
    const base = detail({
      id: "base-1",
      items: [
        item({
          projectId: "project-001",
          requirementId: "r1",
          affectedSymbols: [
            {
              id: "s1",
              codeSymbolId: "A",
              filePath: "A.ts",
              qualifiedName: "pkg.A",
              startLine: 1,
              endLine: 2,
              relation: "direct",
              depth: 0,
              confidence: 0.9,
            },
          ],
        }),
      ],
    });
    const head = detail({
      id: "head-1",
      rerunOfId: "base-1",
      items: [
        item({
          projectId: "project-001",
          requirementId: "r1",
          affectedSymbols: [
            {
              id: "s1",
              codeSymbolId: "A",
              filePath: "A.ts",
              qualifiedName: "pkg.A",
              startLine: 1,
              endLine: 2,
              relation: "direct",
              depth: 0,
              confidence: 0.9,
            },
            {
              id: "s2",
              codeSymbolId: "C",
              filePath: "C.ts",
              qualifiedName: "pkg.C",
              startLine: 1,
              endLine: 2,
              relation: "caller",
              depth: 1,
              confidence: 0.5,
            },
          ],
        }),
      ],
    });
    // The route reads head first (id), then base (rerunOfId).
    getImpactAnalysisDetail.mockImplementation(async (id: string) =>
      id === "head-1" ? head : id === "base-1" ? base : null,
    );

    const res = await request(app).get("/impact-analyses/head-1/drift");
    expect(res.status).toBe(200);
    expect(res.body.data.baseAnalysisId).toBe("base-1");
    expect(res.body.data.headAnalysisId).toBe("head-1");
    expect(res.body.data.requirements).toHaveLength(1);
    expect(res.body.data.requirements[0].symbolsAdded).toEqual(["C.ts::pkg.C"]);
  });

  it("returns an empty report for an original run (no parent)", async () => {
    getImpactAnalysisDetail.mockResolvedValue(detail({ id: "orig-1", rerunOfId: null }));
    const res = await request(app).get("/impact-analyses/orig-1/drift");
    expect(res.status).toBe(200);
    expect(res.body.data.baseAnalysisId).toBeNull();
    expect(res.body.data.requirements).toEqual([]);
    // The parent is never fetched for an original run.
    expect(getImpactAnalysisDetail).toHaveBeenCalledTimes(1);
  });

  it("404 when the head run is not accessible", async () => {
    getImpactAnalysisDetail.mockResolvedValue(null);
    const res = await request(app).get("/impact-analyses/ghost/drift");
    expect(res.status).toBe(404);
  });

  it("403 when the caller lacks analysis.read", async () => {
    permitRead = false;
    const res = await request(app).get("/impact-analyses/head-1/drift");
    expect(res.status).toBe(403);
  });
});
