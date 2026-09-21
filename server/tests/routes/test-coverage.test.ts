/**
 * Tests for /api/projects/:projectId/test-coverage routes (Epic #856, #864).
 *
 * Covers: import upload + paste, RBAC, run creation, in-progress conflict,
 * report aggregation, mapping override, suggestion update.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    testCaseImport: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    testCaseDoc: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    testCoverageRun: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    coverageMapping: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    gapItem: {
      findMany: vi.fn(),
    },
    suggestion: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    requirement: {
      findMany: vi.fn(),
    },
    // #619 approval gate (PR #638 M1) — the gate reads the project flag and
    // approved review items directly via prisma.
    project: {
      findUnique: vi.fn(),
    },
    reviewRequestItem: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      // emulate interactive transaction with the same prisma mocks
      const { prisma } = await import("../../src/lib/prisma.js");
      return cb(prisma);
    }),
  },
}));

vi.mock("../../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

vi.mock("../../src/lib/projects/project-service.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// PR #879 review — connector + export-dispatch mocks
vi.mock("../../src/lib/testcoverage/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/testcoverage/index.js")>(
    "../../src/lib/testcoverage/index.js",
  );
  return {
    ...actual,
    exportSuggestionsToGithub: vi.fn(async () => ({
      created: [{ number: 42, url: "https://github.com/x/y/issues/42", suggestionId: "sug-1" }],
      skipped: [],
      dryRun: false,
    })),
    exportSuggestionsToXray: vi.fn(async () => ({ created: ["X-1"], failed: [], dryRun: false })),
    exportSuggestionsToZephyr: vi.fn(async () => ({ created: ["Z-1"], failed: [], dryRun: false })),
    exportSuggestionsToTestRail: vi.fn(async () => ({ created: [1], failed: [], dryRun: false })),
    importJiraTestCases: vi.fn(async () => ({
      cases: [{ externalId: "J-1", title: "case", source: "jira", priority: null, tags: [] }],
      fetched: 1,
    })),
    importXrayTests: vi.fn(async () => ({
      cases: [{ externalId: "X-1", title: "case", source: "xray", priority: null, tags: [] }],
      fetched: 1,
    })),
    importZephyrCases: vi.fn(async () => ({
      cases: [{ externalId: "Z-1", title: "case", source: "zephyr", priority: null, tags: [] }],
      fetched: 1,
    })),
    importTestRailCases: vi.fn(async () => ({
      cases: [{ externalId: "T-1", title: "case", source: "testrail", priority: null, tags: [] }],
      fetched: 1,
    })),
  };
});

vi.mock("../../src/lib/connectors/jira/jira-client.js", () => ({
  createJiraClient: vi.fn(() => ({ baseUrl: "https://example.atlassian.net" })),
}));

import { prisma } from "../../src/lib/prisma.js";
import { audit } from "../../src/lib/audit/audit-service.js";
import { getProject } from "../../src/lib/projects/project-service.js";
import { testCoverageRouter } from "../../src/routes/test-coverage.js";
import { AppError } from "../../src/middleware/error-handler.js";
import {
  exportSuggestionsToGithub,
  exportSuggestionsToXray,
  exportSuggestionsToZephyr,
  exportSuggestionsToTestRail,
  importJiraTestCases,
  importXrayTests,
  importZephyrCases,
  importTestRailCases,
} from "../../src/lib/testcoverage/index.js";

function createApp(
  authUser: { userId: string; role: string } | undefined,
  enqueueRun?: ReturnType<typeof vi.fn>,
): Express {
  const app = express();
  app.use(express.json());
  if (authUser) {
    app.use((req, _res, next) => {
      (req as unknown as { user: typeof authUser }).user = authUser;
      next();
    });
  }
  app.use("/projects/:projectId/test-coverage", testCoverageRouter({ enqueueRun }));
  app.use(
    (
      err: AppError | Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err instanceof AppError ? err.statusCode : 500;
      const code = err instanceof AppError ? err.code : "INTERNAL";
      res.status(status).json({
        success: false,
        error: { code, message: err.message, details: (err as AppError).details },
      });
    },
  );
  return app;
}

const mockUser = { userId: "user-1", role: "developer" };

const csvFixture = [
  "title,steps,expected",
  "Login,Open page;Enter creds;Submit,Dashboard visible",
  "Logout,Click avatar;Click logout,Login page visible",
].join("\n");

const stubProject = {
  id: "proj-1",
  status: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProject).mockResolvedValue(stubProject as never);
  vi.mocked(prisma.testCaseImport.create).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: "imp-1", ...data }) as never,
  );
  vi.mocked(prisma.testCaseDoc.upsert).mockResolvedValue({ id: "doc-1" } as never);
  // #619 approval gate off by default so pre-existing tests keep their
  // original (ungated) behavior. The gate describe flips this.
  vi.mocked(prisma.project.findUnique).mockResolvedValue({
    requireApprovedReview: false,
  } as never);
  vi.mocked(prisma.reviewRequestItem.findMany).mockResolvedValue([] as never);
});

describe("POST /projects/:projectId/test-coverage/imports/paste", () => {
  it("rejects unauthenticated callers", async () => {
    const app = createApp(undefined);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports/paste")
      .send({ source: "csv", text: csvFixture, label: "smoke.csv" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("404s when the project does not exist", async () => {
    vi.mocked(getProject).mockResolvedValue(null as never);
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports/paste")
      .send({ source: "csv", text: csvFixture, label: "smoke.csv" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("409s when project is archived", async () => {
    vi.mocked(getProject).mockResolvedValue({ ...stubProject, status: "archived" } as never);
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports/paste")
      .send({ source: "csv", text: csvFixture, label: "smoke.csv" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROJECT_ARCHIVED");
  });

  it("400s when body fails validation", async () => {
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports/paste")
      .send({ source: "csv", label: "" });
    expect(res.status).toBe(500); // zod throws; default handler converts via zodErrorHandler in real app
  });

  it("persists parsed CSV cases and returns import metadata", async () => {
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports/paste")
      .send({ source: "csv", text: csvFixture, label: "smoke.csv" });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.importId).toBe("imp-1");
    expect(res.body.data.cases).toBeGreaterThanOrEqual(1);
    expect(prisma.testCaseImport.create).toHaveBeenCalledTimes(1);
    expect(prisma.testCaseDoc.upsert).toHaveBeenCalled();
  });
});

describe("POST /projects/:projectId/test-coverage/runs", () => {
  it("409s when an existing run is queued/running", async () => {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue({
      id: "run-existing",
      status: "running",
    } as never);
    const app = createApp(mockUser);
    const res = await request(app).post("/projects/proj-1/test-coverage/runs").send({ mode: "A" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RUN_IN_PROGRESS");
    expect(res.body.error.details.runId).toBe("run-existing");
  });

  it("queues a new run, fires enqueueRun, returns 202", async () => {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.testCaseDoc.findMany).mockResolvedValue([
      { contentHash: "a" },
      { contentHash: "b" },
    ] as never);
    vi.mocked(prisma.testCoverageRun.create).mockResolvedValue({
      id: "run-1",
      projectId: "proj-1",
      status: "queued",
      mode: "A",
      contentHash: "deadbeef",
    } as never);
    const enqueueRun = vi.fn().mockResolvedValue(undefined);
    const app = createApp(mockUser, enqueueRun);
    const res = await request(app).post("/projects/proj-1/test-coverage/runs").send({ mode: "A" });
    expect(res.status).toBe(202);
    expect(res.body.data.id).toBe("run-1");
    // microtask
    await new Promise((r) => setTimeout(r, 0));
    expect(enqueueRun).toHaveBeenCalledWith({ runId: "run-1", projectId: "proj-1" });
  });
});

describe("GET /projects/:projectId/test-coverage/runs/:runId/report", () => {
  it("404s when run missing", async () => {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue(null);
    const app = createApp(mockUser);
    const res = await request(app).get("/projects/proj-1/test-coverage/runs/run-x/report");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("RUN_NOT_FOUND");
  });

  it("aggregates mappings, gaps and suggestions with coverage percentage", async () => {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue({
      id: "run-1",
      projectId: "proj-1",
      status: "completed",
    } as never);
    vi.mocked(prisma.coverageMapping.findMany).mockResolvedValue([
      { id: "m1", status: "COVERED" },
      { id: "m2", status: "OVERRIDDEN" },
      { id: "m3", status: "UNCOVERED" },
    ] as never);
    vi.mocked(prisma.gapItem.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.suggestion.findMany).mockResolvedValue([{ id: "s1" }] as never);
    const app = createApp(mockUser);
    const res = await request(app).get("/projects/proj-1/test-coverage/runs/run-1/report");
    expect(res.status).toBe(200);
    expect(res.body.data.summary.total).toBe(4); // 3 mappings + 1 gap
    expect(res.body.data.summary.covered).toBe(2);
    expect(res.body.data.summary.gaps).toBe(1);
    expect(res.body.data.summary.coveragePct).toBe(50);
  });
});

describe("PATCH /mappings/:mappingId", () => {
  it("maps COVERED override to DB status OVERRIDDEN", async () => {
    vi.mocked(prisma.coverageMapping.update).mockResolvedValue({
      id: "m-1",
      status: "OVERRIDDEN",
    } as never);
    const app = createApp(mockUser);
    const res = await request(app)
      .patch("/projects/proj-1/test-coverage/mappings/m-1")
      .send({ status: "COVERED", reason: "human review" });
    expect(res.status).toBe(200);
    expect(prisma.coverageMapping.update).toHaveBeenCalledWith({
      where: { id: "m-1" },
      data: expect.objectContaining({
        status: "OVERRIDDEN",
        overriddenById: "user-1",
        overrideReason: "human review",
      }),
    });
  });

  it("passes through UNCOVERED/AMBIGUOUS verbatim", async () => {
    vi.mocked(prisma.coverageMapping.update).mockResolvedValue({
      id: "m-1",
      status: "UNCOVERED",
    } as never);
    const app = createApp(mockUser);
    const res = await request(app)
      .patch("/projects/proj-1/test-coverage/mappings/m-1")
      .send({ status: "UNCOVERED", reason: "false positive" });
    expect(res.status).toBe(200);
    expect(prisma.coverageMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "UNCOVERED" }),
      }),
    );
  });
});

describe("PATCH /suggestions/:suggestionId", () => {
  it("accepts a suggestion and records audit", async () => {
    vi.mocked(prisma.suggestion.update).mockResolvedValue({
      id: "s-1",
      status: "accepted",
    } as never);
    const app = createApp(mockUser);
    const res = await request(app)
      .patch("/projects/proj-1/test-coverage/suggestions/s-1")
      .send({ status: "accepted", reason: "covers gap" });
    expect(res.status).toBe(200);
    expect(prisma.suggestion.update).toHaveBeenCalledWith({
      where: { id: "s-1" },
      data: { status: "accepted" },
    });
  });
});

describe("GET /projects/:projectId/test-coverage/runs", () => {
  it("returns up to 50 most-recent runs", async () => {
    vi.mocked(prisma.testCoverageRun.findMany).mockResolvedValue([
      { id: "r1" },
      { id: "r2" },
    ] as never);
    const app = createApp(mockUser);
    const res = await request(app).get("/projects/proj-1/test-coverage/runs");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(prisma.testCoverageRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, orderBy: { createdAt: "desc" } }),
    );
  });
});

describe("GET /projects/:projectId/test-coverage/imports", () => {
  it("lists imports for project", async () => {
    vi.mocked(prisma.testCaseImport.findMany).mockResolvedValue([{ id: "imp-1" }] as never);
    const app = createApp(mockUser);
    const res = await request(app).get("/projects/proj-1/test-coverage/imports");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("POST /projects/:projectId/test-coverage/imports (file upload)", () => {
  it("400s when no file is attached", async () => {
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports")
      .field("label", "smoke.csv");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FILE_REQUIRED");
  });

  it("415s when file type is not recognised", async () => {
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports")
      .attach("file", Buffer.from("ignored"), {
        filename: "junk.bin",
        contentType: "application/octet-stream",
      });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_TYPE");
  });

  it("201s on a valid CSV upload", async () => {
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports")
      .field("label", "smoke")
      .attach("file", Buffer.from(csvFixture), {
        filename: "smoke.csv",
        contentType: "text/csv",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.importId).toBe("imp-1");
  });

  it("accepts columnOverrides as JSON string", async () => {
    const app = createApp(mockUser);
    const overrides = JSON.stringify({ "test name": "title" });
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports")
      .field("label", "smoke")
      .field("columnOverrides", overrides)
      .attach("file", Buffer.from("test name,steps\nA,do thing"), {
        filename: "smoke.csv",
        contentType: "text/csv",
      });
    expect(res.status).toBe(201);
  });

  it("rejects unauthenticated callers", async () => {
    const app = createApp(undefined);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports")
      .attach("file", Buffer.from(csvFixture), {
        filename: "smoke.csv",
        contentType: "text/csv",
      });
    expect(res.status).toBe(401);
  });
});

describe("GET /projects/:projectId/test-coverage/runs/:runId", () => {
  it("returns the run when it exists", async () => {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue({
      id: "run-1",
      projectId: "proj-1",
    } as never);
    const app = createApp(mockUser);
    const res = await request(app).get("/projects/proj-1/test-coverage/runs/run-1");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("run-1");
  });

  it("404s when the run does not exist", async () => {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue(null);
    const app = createApp(mockUser);
    const res = await request(app).get("/projects/proj-1/test-coverage/runs/run-x");
    expect(res.status).toBe(404);
  });
});

describe("POST /projects/:projectId/test-coverage/exports", () => {
  function mockReportFixtures(opts: { lowConfidence?: boolean } = {}) {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue({
      id: "run-1",
      projectId: "proj-1",
      project: { name: "Demo" },
    } as never);
    vi.mocked(prisma.coverageMapping.findMany).mockResolvedValue([
      {
        requirementId: "req-1",
        testCaseDocId: "tc-1",
        fused: 0.9,
        status: "COVERED",
      },
    ] as never);
    vi.mocked(prisma.gapItem.findMany).mockResolvedValue([
      { requirementId: "req-2", severity: "high", requirement: { id: "req-2", title: "R2" } },
    ] as never);
    vi.mocked(prisma.suggestion.findMany).mockResolvedValue([
      {
        id: "sug-1",
        title: "Login happy path",
        gwtJson: JSON.stringify({ given: ["g"], when: ["w"], then: ["t"] }),
        stepsJson: "[]",
        mappedRequirementIds: JSON.stringify(["req-2"]),
        faithfulness: opts.lowConfidence ? 0.4 : 0.9,
        lowConfidence: Boolean(opts.lowConfidence),
      },
    ] as never);
    vi.mocked(prisma.testCaseDoc.findMany).mockResolvedValue([
      { id: "tc-1", title: "Existing test" },
    ] as never);
    vi.mocked(prisma.requirement.findMany).mockResolvedValue([
      { id: "req-1", title: "R1" },
      { id: "req-2", title: "R2" },
    ] as never);
  }

  it("returns an .xlsx file for target=excel", async () => {
    mockReportFixtures();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({ runId: "run-1", target: "excel" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain(".xlsx");
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
  });

  it("returns 404 when the run is missing", async () => {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue(null);
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({ runId: "missing", target: "excel" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("RUN_NOT_FOUND");
  });

  it("rejects low-confidence suggestions without override", async () => {
    mockReportFixtures({ lowConfidence: true });
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({ runId: "run-1", target: "gherkin" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("LOW_CONFIDENCE_BLOCKED");
    expect(res.body.error.details.suggestionIds).toContain("sug-1");
  });

  it("allows low-confidence suggestions when overrideLowConfidence=true", async () => {
    mockReportFixtures({ lowConfidence: true });
    const app = createApp(mockUser);
    const res = await request(app).post("/projects/proj-1/test-coverage/exports").send({
      runId: "run-1",
      target: "gherkin",
      overrideLowConfidence: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("Feature:");
  });

  it("rejects unauthenticated callers", async () => {
    const app = createApp(undefined);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({ runId: "run-1", target: "excel" });
    expect(res.status).toBe(401);
  });

  it("returns a zip download for target=playwright-pom (issue #44)", async () => {
    mockReportFixtures();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({ runId: "run-1", target: "playwright-pom" })
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain("playwright-pom-scaffold.zip");
  });
});

describe("POST /projects/:projectId/test-coverage/exports — external push targets (PR #879)", () => {
  function mockMinimalReport() {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue({
      id: "run-1",
      projectId: "proj-1",
      project: { name: "Demo" },
    } as never);
    vi.mocked(prisma.coverageMapping.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.gapItem.findMany).mockResolvedValue([
      { requirementId: "req-1", severity: "high", requirement: { id: "req-1", title: "R1" } },
    ] as never);
    vi.mocked(prisma.suggestion.findMany).mockResolvedValue([
      {
        id: "sug-1",
        title: "T",
        gwtJson: JSON.stringify({ given: [], when: [], then: [] }),
        stepsJson: "[]",
        mappedRequirementIds: JSON.stringify(["req-1"]),
        faithfulness: 0.9,
        lowConfidence: false,
      },
    ] as never);
    vi.mocked(prisma.testCaseDoc.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.requirement.findMany).mockResolvedValue([
      { id: "req-1", title: "R1" },
    ] as never);
  }

  it("dispatches target=github to exportSuggestionsToGithub and returns JSON", async () => {
    mockMinimalReport();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({
        runId: "run-1",
        target: "github",
        options: { targetOwner: "octo", targetRepo: "repo" },
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(exportSuggestionsToGithub).toHaveBeenCalledTimes(1);
    expect(res.body.data.created[0].number).toBe(42);
  });

  it("dispatches target=xray to exportSuggestionsToXray", async () => {
    mockMinimalReport();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({
        runId: "run-1",
        target: "xray",
        connection: { baseUrl: "https://x", clientId: "id", clientSecret: "s" },
        options: { projectKey: "PK" },
      });
    expect(res.status).toBe(200);
    expect(exportSuggestionsToXray).toHaveBeenCalledTimes(1);
    expect(res.body.data.created).toEqual(["X-1"]);
  });

  it("dispatches target=zephyr to exportSuggestionsToZephyr", async () => {
    mockMinimalReport();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({
        runId: "run-1",
        target: "zephyr",
        connection: { baseUrl: "https://z", bearerToken: "tok" },
        options: { projectKey: "PK" },
      });
    expect(res.status).toBe(200);
    expect(exportSuggestionsToZephyr).toHaveBeenCalledTimes(1);
  });

  it("dispatches target=testrail to exportSuggestionsToTestRail", async () => {
    mockMinimalReport();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({
        runId: "run-1",
        target: "testrail",
        connection: { baseUrl: "https://tr", email: "a@b.c", apiKey: "k" },
        options: { sectionId: 7 },
      });
    expect(res.status).toBe(200);
    expect(exportSuggestionsToTestRail).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when github options are missing", async () => {
    mockMinimalReport();
    const app = createApp(mockUser);
    const res = await request(app).post("/projects/proj-1/test-coverage/exports").send({
      runId: "run-1",
      target: "github",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EXPORT_OPTIONS_REQUIRED");
  });
});

describe("POST /projects/:projectId/test-coverage/exports — approval gate on external push targets (#619, PR #638 M1)", () => {
  function mockReportWithSuggestion(mappedRequirementIds: string[] = ["req-1"]) {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue({
      id: "run-1",
      projectId: "proj-1",
      project: { name: "Demo" },
    } as never);
    vi.mocked(prisma.coverageMapping.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.gapItem.findMany).mockResolvedValue([
      { requirementId: "req-1", severity: "high", requirement: { id: "req-1", title: "R1" } },
    ] as never);
    vi.mocked(prisma.suggestion.findMany).mockResolvedValue([
      {
        id: "sug-1",
        title: "T",
        gwtJson: JSON.stringify({ given: [], when: [], then: [] }),
        stepsJson: "[]",
        mappedRequirementIds: JSON.stringify(mappedRequirementIds),
        faithfulness: 0.9,
        lowConfidence: false,
      },
    ] as never);
    vi.mocked(prisma.testCaseDoc.findMany).mockResolvedValue([] as never);
    // Shared between the report builder (id/title) and the gate (id/version).
    vi.mocked(prisma.requirement.findMany).mockResolvedValue([
      { id: "req-1", title: "R1", version: 2 },
    ] as never);
  }

  function flipGateOn() {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      requireApprovedReview: true,
    } as never);
  }

  const payloads: Record<string, Record<string, unknown>> = {
    xray: {
      connection: { baseUrl: "https://x", clientId: "id", clientSecret: "s" },
      options: { projectKey: "PK" },
    },
    jira: {
      connection: { baseUrl: "https://x", clientId: "id", clientSecret: "s" },
      options: { projectKey: "PK" },
    },
    zephyr: {
      connection: { baseUrl: "https://z", bearerToken: "tok" },
      options: { projectKey: "PK" },
    },
    testrail: {
      connection: { baseUrl: "https://tr", email: "a@b.c", apiKey: "k" },
      options: { sectionId: 7 },
    },
  };
  const exporterFor: Record<string, ReturnType<typeof vi.fn>> = {
    xray: vi.mocked(exportSuggestionsToXray),
    jira: vi.mocked(exportSuggestionsToXray),
    zephyr: vi.mocked(exportSuggestionsToZephyr),
    testrail: vi.mocked(exportSuggestionsToTestRail),
  };

  for (const target of ["xray", "jira", "zephyr", "testrail"] as const) {
    it(`blocks target=${target} with 409 APPROVAL_REQUIRED when the requirement lacks an approved current review`, async () => {
      mockReportWithSuggestion();
      flipGateOn();
      const app = createApp(mockUser);
      const res = await request(app)
        .post("/projects/proj-1/test-coverage/exports")
        .send({ runId: "run-1", target, ...payloads[target] });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
      expect(res.body.error.details.requirementIds).toEqual(["req-1"]);
      expect(exporterFor[target]).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "review.gate.blocked" }),
      );
    });

    it(`blocks target=${target} with 503 APPROVAL_GATE_UNAVAILABLE when the gate check fails (fail-closed)`, async () => {
      mockReportWithSuggestion();
      flipGateOn();
      vi.mocked(prisma.reviewRequestItem.findMany).mockRejectedValue(new Error("db down"));
      const app = createApp(mockUser);
      const res = await request(app)
        .post("/projects/proj-1/test-coverage/exports")
        .send({ runId: "run-1", target, ...payloads[target] });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("APPROVAL_GATE_UNAVAILABLE");
      expect(exporterFor[target]).not.toHaveBeenCalled();
    });
  }

  it("passes when the mapped requirement has an approved, still-current review", async () => {
    mockReportWithSuggestion();
    flipGateOn();
    vi.mocked(prisma.reviewRequestItem.findMany).mockResolvedValue([
      { requirementId: "req-1", pinnedVersion: 2 },
    ] as never);
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({ runId: "run-1", target: "xray", ...payloads.xray });
    expect(res.status).toBe(200);
    expect(exportSuggestionsToXray).toHaveBeenCalledTimes(1);
  });

  it("blocks a suggestion with no mapped requirements as unlinked", async () => {
    mockReportWithSuggestion([]);
    flipGateOn();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({ runId: "run-1", target: "zephyr", ...payloads.zephyr });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(res.body.error.details.unlinkedDraftIds).toEqual(["sug-1"]);
  });

  it("stays exempt for dry-run pushes (preview only, no external writes)", async () => {
    mockReportWithSuggestion();
    flipGateOn();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/exports")
      .send({
        runId: "run-1",
        target: "xray",
        connection: payloads.xray.connection,
        options: { projectKey: "PK", dryRun: true },
      });
    expect(res.status).toBe(200);
    expect(exportSuggestionsToXray).toHaveBeenCalledTimes(1);
  });

  it("stays exempt for local file downloads (excel/gherkin/playwright-pom — documented exemption)", async () => {
    flipGateOn();
    const app = createApp(mockUser);
    for (const target of ["excel", "gherkin", "playwright-pom"] as const) {
      mockReportWithSuggestion();
      const res = await request(app)
        .post("/projects/proj-1/test-coverage/exports")
        .send({ runId: "run-1", target })
        .buffer(true);
      expect(res.status, `target=${target}`).toBe(200);
    }
  });
});

describe("POST /projects/:projectId/test-coverage/imports/:source — connector pull (PR #879)", () => {
  it("POST /imports/jira invokes importJiraTestCases and persists", async () => {
    const app = createApp(mockUser);
    const res = await request(app).post("/projects/proj-1/test-coverage/imports/jira").send({
      baseUrl: "https://example.atlassian.net",
      username: "u@e.com",
      apiToken: "t",
      projectKey: "PK",
    });
    expect(res.status).toBe(201);
    expect(importJiraTestCases).toHaveBeenCalledTimes(1);
    expect(prisma.testCaseImport.create).toHaveBeenCalled();
    expect(res.body.data).toMatchObject({
      source: "jira",
      casesParsed: 1,
      casesUpserted: 1,
    });
  });

  it("POST /imports/xray invokes importXrayTests", async () => {
    const app = createApp(mockUser);
    const res = await request(app).post("/projects/proj-1/test-coverage/imports/xray").send({
      baseUrl: "https://x",
      clientId: "id",
      clientSecret: "s",
      projectKey: "PK",
    });
    expect(res.status).toBe(201);
    expect(importXrayTests).toHaveBeenCalledTimes(1);
    expect(res.body.data.source).toBe("xray");
  });

  it("POST /imports/zephyr invokes importZephyrCases", async () => {
    const app = createApp(mockUser);
    const res = await request(app).post("/projects/proj-1/test-coverage/imports/zephyr").send({
      baseUrl: "https://z",
      bearerToken: "tok",
      projectKey: "PK",
    });
    expect(res.status).toBe(201);
    expect(importZephyrCases).toHaveBeenCalledTimes(1);
    expect(res.body.data.source).toBe("zephyr");
  });

  it("POST /imports/testrail invokes importTestRailCases with numeric projectId", async () => {
    const app = createApp(mockUser);
    const res = await request(app).post("/projects/proj-1/test-coverage/imports/testrail").send({
      baseUrl: "https://tr.example.com",
      email: "a@b.com",
      apiKey: "k",
      projectId: 42,
    });
    expect(res.status).toBe(201);
    expect(importTestRailCases).toHaveBeenCalledTimes(1);
    expect(res.body.data.source).toBe("testrail");
  });

  it("validates required jira body fields", async () => {
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/imports/jira")
      .send({ baseUrl: "https://x" });
    expect(res.status).toBe(500); // zod throws → 500 via the test app's error handler
  });
});

describe("POST /projects/:projectId/test-coverage/junit (issue #45)", () => {
  beforeEach(() => {
    vi.mocked(getProject).mockResolvedValue(stubProject as never);
  });

  const JUNIT_XML = `<?xml version="1.0"?>
    <testsuites><testsuite name="auth">
      <testcase classname="auth.LoginTest" name="logs in"/>
      <testcase name="rejects bad password"><failure message="401"/></testcase>
      <testcase name="ghost case"/>
    </testsuite></testsuites>`;

  function mockJunitFixtures() {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue({
      id: "run-1",
      projectId: "proj-1",
      status: "completed",
    } as never);
    vi.mocked(prisma.testCaseDoc.findMany).mockResolvedValue([
      { id: "tc-1", title: "Logs in" },
      { id: "tc-2", title: "Rejects bad password" },
    ] as never);
    vi.mocked(prisma.coverageMapping.updateMany).mockResolvedValue({ count: 1 } as never);
  }

  it("matches testcases, updates mappings and reports unmatched in the summary", async () => {
    mockJunitFixtures();
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/junit")
      .attach("file", Buffer.from(JUNIT_XML), "results.xml");
    expect(res.status).toBe(200);
    expect(res.body.data.runId).toBe("run-1");
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.matched).toBe(2);
    expect(res.body.data.unmatched).toEqual(["ghost case"]);
    expect(res.body.data.byStatus).toEqual({ passed: 2, failed: 1, skipped: 0 });
    expect(prisma.coverageMapping.updateMany).toHaveBeenCalled();
  });

  it("returns 400 when no file is uploaded", async () => {
    mockJunitFixtures();
    const app = createApp(mockUser);
    const res = await request(app).post("/projects/proj-1/test-coverage/junit").field("x", "y");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FILE_REQUIRED");
  });

  it("returns 404 when there is no run to attach to", async () => {
    vi.mocked(prisma.testCoverageRun.findFirst).mockResolvedValue(null);
    const app = createApp(mockUser);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/junit")
      .attach("file", Buffer.from(JUNIT_XML), "results.xml");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("RUN_NOT_FOUND");
  });

  it("returns 422 for a DOCTYPE/XXE payload", async () => {
    mockJunitFixtures();
    const app = createApp(mockUser);
    const xxe = `<?xml version="1.0"?>
      <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
      <testsuites><testsuite><testcase name="&xxe;"/></testsuite></testsuites>`;
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/junit")
      .attach("file", Buffer.from(xxe), "evil.xml");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("JUNIT_PARSE_FAILED");
  });

  it("rejects unauthenticated callers", async () => {
    const app = createApp(undefined);
    const res = await request(app)
      .post("/projects/proj-1/test-coverage/junit")
      .attach("file", Buffer.from(JUNIT_XML), "results.xml");
    expect(res.status).toBe(401);
  });
});
