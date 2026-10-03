/**
 * Traceability router tests — Epic #207 (#226/#227/#228/#229).
 *
 * Exercises the route layer with the real service modules (Prisma mocked) so a
 * single suite covers RBAC denial, validation failure, the full requirement
 * chain, spec/code CRUD, the reverse file lookup, and the backfill endpoint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  requirement: { findFirst: vi.fn(), findMany: vi.fn() },
  generatedDocument: { findFirst: vi.fn(), findMany: vi.fn() },
  codeSymbol: { findFirst: vi.fn(), findMany: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  analysis: { findFirst: vi.fn() },
  requirementSpecMapping: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  specCodeMapping: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    count: vi.fn(),
  },
  requirementCodeMapping: { findMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};
vi.mock("../lib/prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: { userId: string; role: string } }).user = {
      userId: "user-1",
      role: "member",
    };
    next();
  },
}));

// #814 — the router mounts `requireProjectAccess()` itself; a flag drives the
// real middleware's 404 (non-member) outcome without a workspace fixture.
let projectAccessible = true;
const requireProjectAccessCalls: string[] = [];
vi.mock("../middleware/require-project-access.js", () => ({
  requireProjectAccess:
    () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      requireProjectAccessCalls.push(String(req.params.projectId));
      if (!projectAccessible) {
        res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "no" } });
        return;
      }
      next();
    },
}));

let permitWrite = true;
let permitRead = true;
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (perm: string) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (perm === "analysis.run" && !permitWrite) {
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

// The workspace-rollup service is unit-tested separately (workspace-rollup.test.ts);
// here we mock it to assert route WIRING (actor + params + query threading, RBAC).
const getRequirementChainWithLinks = vi.fn();
const getWorkspaceTraceabilitySummary = vi.fn();
vi.mock("../lib/traceability/workspace-rollup.js", () => ({
  getRequirementChainWithLinks: (...args: unknown[]) => getRequirementChainWithLinks(...args),
  getWorkspaceTraceabilitySummary: (...args: unknown[]) => getWorkspaceTraceabilitySummary(...args),
}));

const { traceabilityRouter, workspaceTraceabilityRouter } = await import("./traceability.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId", traceabilityRouter());
  app.use(errorHandler);
  return app;
}

function createWorkspaceApp() {
  const app = express();
  app.use(express.json());
  app.use("/workspaces/:workspaceId/traceability", workspaceTraceabilityRouter());
  app.use(errorHandler);
  return app;
}

const BASE = "/projects/proj-1";

describe("traceability router", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps queued `mockResolvedValueOnce` values; drop them too.
    for (const model of Object.values(mockPrisma)) {
      if (typeof model === "object") for (const fn of Object.values(model)) fn.mockReset();
    }
    mockPrisma.codeSymbol.findMany.mockResolvedValue([]);
    mockPrisma.codeEdge.findMany.mockResolvedValue([]);
    permitWrite = true;
    permitRead = true;
    projectAccessible = true;
    requireProjectAccessCalls.length = 0;
    app = createApp();
  });

  describe("GET /requirements/:id/traceability (#229)", () => {
    it("returns the assembled requirement→spec→code chain", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1", title: "Login" });
      mockPrisma.requirementSpecMapping.findMany.mockResolvedValue([
        {
          specDocumentId: "spec-1",
          confidence: 0.9,
          source: "derived",
          specDocument: { title: "Auth" },
        },
      ]);
      mockPrisma.specCodeMapping.findMany.mockResolvedValue([
        {
          specDocumentId: "spec-1",
          codeSymbolId: "sym-1",
          filePath: "src/auth.ts",
          startLine: 1,
          endLine: 2,
          confidence: 0.8,
          source: "derived",
        },
      ]);
      mockPrisma.requirementCodeMapping.findMany.mockResolvedValue([]);

      const res = await request(app).get(`${BASE}/requirements/req-1/traceability`);

      expect(res.status).toBe(200);
      expect(res.body.data.requirementTitle).toBe("Login");
      expect(res.body.data.specs[0].specTitle).toBe("Auth");
      expect(res.body.data.specs[0].code[0].filePath).toBe("src/auth.ts");
    });

    it("404s for an unknown requirement", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue(null);
      const res = await request(app).get(`${BASE}/requirements/ghost/traceability`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
    });
  });

  describe("GET /traceability/by-file (#229)", () => {
    it("requires the filePath query param", async () => {
      const res = await request(app).get(`${BASE}/traceability/by-file`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FILE_PATH_REQUIRED");
    });

    it("returns the requirement ids touching the file", async () => {
      mockPrisma.requirementCodeMapping.findMany.mockResolvedValue([{ requirementId: "req-1" }]);
      mockPrisma.specCodeMapping.findMany.mockResolvedValue([]);
      const res = await request(app).get(`${BASE}/traceability/by-file?filePath=src/auth.ts`);
      expect(res.status).toBe(200);
      expect(res.body.data.requirementIds).toEqual(["req-1"]);
    });
  });

  describe("requirement↔spec mappings (#226)", () => {
    it("creates a link (201)", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.generatedDocument.findFirst.mockResolvedValue({ id: "spec-1" });
      mockPrisma.requirementSpecMapping.create.mockResolvedValue({
        id: "rsm-1",
        requirementId: "req-1",
        specDocumentId: "spec-1",
        projectId: "proj-1",
        confidence: 0.7,
        source: "manual",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        specDocument: { title: "Auth" },
      });

      const res = await request(app)
        .post(`${BASE}/requirements/req-1/spec-mappings`)
        .send({ specDocumentId: "spec-1" });

      expect(res.status).toBe(201);
      expect(res.body.data.specTitle).toBe("Auth");
    });

    it("rejects an invalid payload (400)", async () => {
      const res = await request(app)
        .post(`${BASE}/requirements/req-1/spec-mappings`)
        .send({ confidence: 5 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("denies create without analysis.run (403)", async () => {
      permitWrite = false;
      const res = await request(app)
        .post(`${BASE}/requirements/req-1/spec-mappings`)
        .send({ specDocumentId: "spec-1" });
      expect(res.status).toBe(403);
    });

    it("deletes a link (204)", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1" });
      mockPrisma.requirementSpecMapping.findFirst.mockResolvedValue({ id: "rsm-1" });
      const res = await request(app).delete(`${BASE}/requirements/req-1/spec-mappings/rsm-1`);
      expect(res.status).toBe(204);
      expect(mockPrisma.requirementSpecMapping.delete).toHaveBeenCalled();
    });
  });

  describe("spec↔code mappings (#227)", () => {
    it("lists a spec's code links", async () => {
      mockPrisma.generatedDocument.findFirst.mockResolvedValue({ id: "spec-1" });
      mockPrisma.specCodeMapping.findMany.mockResolvedValue([
        {
          id: "scm-1",
          specDocumentId: "spec-1",
          projectId: "proj-1",
          codeSymbolId: null,
          filePath: "a.ts",
          startLine: null,
          endLine: null,
          confidence: 0.7,
          source: "derived",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]);
      const res = await request(app).get(`${BASE}/specs/spec-1/code-mappings`);
      expect(res.status).toBe(200);
      expect(res.body.data[0].filePath).toBe("a.ts");
    });

    it("creates a spec→code link (201)", async () => {
      mockPrisma.generatedDocument.findFirst.mockResolvedValue({ id: "spec-1" });
      mockPrisma.specCodeMapping.create.mockResolvedValue({
        id: "scm-1",
        specDocumentId: "spec-1",
        projectId: "proj-1",
        codeSymbolId: null,
        filePath: "a.ts",
        startLine: null,
        endLine: null,
        confidence: 0.7,
        source: "manual",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      const res = await request(app)
        .post(`${BASE}/specs/spec-1/code-mappings`)
        .send({ filePath: "a.ts" });
      expect(res.status).toBe(201);
      expect(res.body.data.filePath).toBe("a.ts");
    });

    it("rejects a missing filePath (400)", async () => {
      const res = await request(app).post(`${BASE}/specs/spec-1/code-mappings`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /traceability/backfill (#228)", () => {
    it("runs the backfill and returns counts", async () => {
      mockPrisma.generatedDocument.findMany.mockResolvedValue([
        { id: "spec-1", scopeFilter: JSON.stringify({ filePaths: ["a.ts"] }) },
      ]);
      mockPrisma.requirement.findMany.mockResolvedValue([
        {
          id: "req-1",
          codeMappings: [{ codeSymbolId: "s", filePath: "a.ts", startLine: 1, endLine: 2 }],
        },
      ]);
      mockPrisma.requirementSpecMapping.findFirst.mockResolvedValue(null);
      mockPrisma.requirementSpecMapping.create.mockResolvedValue({});
      mockPrisma.specCodeMapping.count.mockResolvedValue(0);
      mockPrisma.specCodeMapping.deleteMany.mockResolvedValue({});
      mockPrisma.specCodeMapping.createMany.mockResolvedValue({});

      const res = await request(app).post(`${BASE}/traceability/backfill`).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.requirementSpecLinksCreated).toBe(1);
      expect(res.body.data.specCodeLinksCreated).toBe(1);
    });

    it("denies backfill without analysis.run (403)", async () => {
      permitWrite = false;
      const res = await request(app).post(`${BASE}/traceability/backfill`).send({});
      expect(res.status).toBe(403);
    });
  });

  // ---- #814 "Tested by" + project scope ------------------------------------
  describe("project scope (#814)", () => {
    it("runs requireProjectAccess before every handler and 404s a non-member", async () => {
      projectAccessible = false;
      const res = await request(app).get(`${BASE}/requirements/req-1/traceability`);
      expect(res.status).toBe(404);
      expect(requireProjectAccessCalls).toEqual(["proj-1"]);
      expect(mockPrisma.requirement.findFirst).not.toHaveBeenCalled();

      const gaps = await request(app).get(`${BASE}/traceability/test-gaps`);
      expect(gaps.status).toBe(404);
      expect(mockPrisma.requirement.findMany).not.toHaveBeenCalled();
    });
  });

  describe("GET /requirements/:id/traceability testedBy (#814)", () => {
    it("adds testedBy and isTest; every pre-#814 field is unchanged", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({
        id: "req-1",
        title: "Password length",
        body: "Password must be at least 6 characters",
      });
      mockPrisma.requirementSpecMapping.findMany.mockResolvedValue([
        {
          specDocumentId: "spec-1",
          confidence: 0.9,
          source: "derived",
          specDocument: { title: "Auth" },
        },
      ]);
      mockPrisma.specCodeMapping.findMany.mockResolvedValue([
        {
          specDocumentId: "spec-1",
          codeSymbolId: null,
          filePath: "internal/validator/user_test.go",
          startLine: null,
          endLine: null,
          confidence: 0.8,
          source: "derived",
        },
      ]);
      mockPrisma.requirementCodeMapping.findMany.mockResolvedValue([
        {
          codeSymbolId: "sym-v",
          filePath: "internal/validator/user.go",
          startLine: 10,
          endLine: 20,
          confidence: 0.7,
          source: "semantic",
        },
      ]);
      mockPrisma.codeSymbol.findMany
        .mockResolvedValueOnce([
          {
            id: "sym-v",
            name: "validatePassword",
            qualifiedName: "internal/validator/user.go::validatePassword",
            filePath: "internal/validator/user.go",
            kind: "function",
            language: "go",
            startLine: 10,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "sym-t",
            name: "TestValidatePassword",
            qualifiedName: "internal/validator/user_test.go::TestValidatePassword",
            filePath: "internal/validator/user_test.go",
            kind: "function",
            language: "go",
            startLine: 55,
          },
        ]);

      const res = await request(app).get(`${BASE}/requirements/req-1/traceability`);

      expect(res.status).toBe(200);
      const { testedBy, ...rest } = res.body.data;
      const strip = (nodes: Array<Record<string, unknown>>) =>
        nodes.map(({ isTest: _isTest, ...n }) => n);
      // The #229 shape, byte for byte, once the two additive fields are removed.
      expect(
        JSON.stringify({
          ...rest,
          specs: rest.specs.map((sp: { code: Array<Record<string, unknown>> }) => ({
            ...sp,
            code: strip(sp.code),
          })),
          directCode: strip(rest.directCode),
        }),
      ).toMatchInlineSnapshot(
        `"{"requirementId":"req-1","requirementTitle":"Password length","projectId":"proj-1","specs":[{"specDocumentId":"spec-1","specTitle":"Auth","confidence":0.9,"source":"derived","code":[{"codeSymbolId":null,"filePath":"internal/validator/user_test.go","startLine":null,"endLine":null,"confidence":0.8,"source":"derived"}]}],"directCode":[{"codeSymbolId":"sym-v","filePath":"internal/validator/user.go","startLine":10,"endLine":20,"confidence":0.7,"source":"semantic"}]}"`,
      );
      expect(rest.specs[0].code[0].isTest).toBe(true);
      expect(rest.directCode[0].isTest).toBe(false);
      expect(
        testedBy.map((t: { symbol: string; relation: string }) => [t.symbol, t.relation]),
      ).toEqual([
        ["internal/validator/user_test.go", "direct"],
        ["internal/validator/user_test.go::TestValidatePassword", "naming"],
      ]);
    });
  });

  describe("GET /traceability/test-gaps (#814)", () => {
    const reqRow = (id: string, title: string) => ({
      id,
      title,
      body: "",
      analysisId: "an-1",
    });

    it("lists untested requirements, counts the unmapped ones, and paginates", async () => {
      mockPrisma.analysis.findFirst.mockResolvedValue({ id: "an-1" });
      mockPrisma.requirement.findMany.mockResolvedValue([
        reqRow("r3", "C"),
        reqRow("r1", "A"),
        reqRow("r2", "B"),
        reqRow("r4", "No code"),
      ]);
      mockPrisma.requirementCodeMapping.findMany.mockResolvedValue([
        { requirementId: "r1", codeSymbolId: null, filePath: "a.go", startLine: null },
        { requirementId: "r2", codeSymbolId: null, filePath: "b.go", startLine: null },
        { requirementId: "r3", codeSymbolId: null, filePath: "c.go", startLine: null },
      ]);
      mockPrisma.requirementSpecMapping.findMany.mockResolvedValue([]);

      const res = await request(app).get(`${BASE}/traceability/test-gaps?analysisId=an-1&limit=2`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        total: 4,
        tested: 0,
        noCode: 1,
        untested: [
          {
            requirementId: "r1",
            title: "A",
            analysisId: "an-1",
            reason: "no-test",
            mappedFiles: 1,
          },
          {
            requirementId: "r2",
            title: "B",
            analysisId: "an-1",
            reason: "no-test",
            mappedFiles: 1,
          },
        ],
        nextCursor: "r2",
      });
      expect(mockPrisma.analysis.findFirst).toHaveBeenCalledWith({
        where: { id: "an-1", projectId: "proj-1" },
        select: { id: true },
      });
      expect(mockPrisma.requirement.findMany.mock.calls[0][0].where).toEqual({
        projectId: "proj-1",
        deletedAt: null,
        analysisId: "an-1",
      });

      const next = await request(app).get(`${BASE}/traceability/test-gaps?limit=2&cursor=r2`);
      expect(
        next.body.data.untested.map((g: { requirementId: string }) => g.requirementId),
      ).toEqual(["r3"]);
      expect(next.body.data.nextCursor).toBeNull();
    });

    it("returns an empty report for an empty project", async () => {
      mockPrisma.requirement.findMany.mockResolvedValue([]);
      const res = await request(app).get(`${BASE}/traceability/test-gaps`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        total: 0,
        tested: 0,
        untested: [],
        noCode: 0,
        nextCursor: null,
      });
      expect(mockPrisma.requirementCodeMapping.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ["limit=0"],
      ["limit=201"],
      ["limit=abc"],
      ["limit=1.5"],
      ["cursor=a%20b"],
      ["cursor=" + "x".repeat(65)],
      ["analysisId=%27%3B--"],
    ])("400s on a bad query (%s) before touching Prisma", async (qs) => {
      const res = await request(app).get(`${BASE}/traceability/test-gaps?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(mockPrisma.requirement.findMany).not.toHaveBeenCalled();
    });

    it("403s without analysis.read", async () => {
      permitRead = false;
      const res = await request(app).get(`${BASE}/traceability/test-gaps`);
      expect(res.status).toBe(403);
    });

    it("404s for an analysisId outside the project", async () => {
      mockPrisma.analysis.findFirst.mockResolvedValue(null);
      const res = await request(app).get(`${BASE}/traceability/test-gaps?analysisId=foreign`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("ANALYSIS_NOT_FOUND");
      expect(mockPrisma.requirement.findMany).not.toHaveBeenCalled();
    });
  });

  // ---- #626 linked chains (includeLinked / depth) -------------------------
  describe("GET /requirements/:id/traceability?includeLinked (#626)", () => {
    it("keeps the #229 single-project behaviour when includeLinked is absent", async () => {
      mockPrisma.requirement.findFirst.mockResolvedValue({ id: "req-1", title: "Login" });
      mockPrisma.requirementSpecMapping.findMany.mockResolvedValue([]);
      mockPrisma.requirementCodeMapping.findMany.mockResolvedValue([]);

      const res = await request(app).get(`${BASE}/requirements/req-1/traceability`);

      expect(res.status).toBe(200);
      expect(res.body.data.requirementTitle).toBe("Login");
      expect(res.body.data.linkedChains).toBeUndefined();
      // The rollup path must NOT be touched for the default (regression guard).
      expect(getRequirementChainWithLinks).not.toHaveBeenCalled();
    });

    it("threads actor + project + depth into the rollup when includeLinked=true", async () => {
      getRequirementChainWithLinks.mockResolvedValue({
        requirementId: "req-1",
        requirementTitle: "Login",
        projectId: "proj-1",
        specs: [],
        directCode: [],
        depth: 2,
        linkedChains: [
          {
            link: {
              linkId: "L1",
              type: "relates_to",
              sourceRequirementId: "req-1",
              targetRequirementId: "req-2",
              requirement: { id: "req-2", title: "SSO", projectId: "proj-2", projectName: "Beta" },
            },
            chain: null,
            restricted: true,
          },
        ],
      });

      const res = await request(app).get(
        `${BASE}/requirements/req-1/traceability?includeLinked=true&depth=2`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data.linkedChains).toHaveLength(1);
      expect(res.body.data.linkedChains[0].restricted).toBe(true);
      expect(getRequirementChainWithLinks).toHaveBeenCalledWith(
        { id: "user-1", role: "member" },
        "proj-1",
        "req-1",
        { depth: 2 },
      );
    });

    it("passes depth undefined (service defaults to 1) when omitted", async () => {
      getRequirementChainWithLinks.mockResolvedValue({
        requirementId: "req-1",
        requirementTitle: "Login",
        projectId: "proj-1",
        specs: [],
        directCode: [],
        depth: 1,
        linkedChains: [],
      });
      await request(app).get(`${BASE}/requirements/req-1/traceability?includeLinked=true`);
      expect(getRequirementChainWithLinks).toHaveBeenCalledWith(
        { id: "user-1", role: "member" },
        "proj-1",
        "req-1",
        { depth: undefined },
      );
    });
  });
});

// ---- #626 workspace rollup summary ----------------------------------------
describe("workspace traceability router (#626)", () => {
  let app: ReturnType<typeof createWorkspaceApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    permitRead = true;
    app = createWorkspaceApp();
  });

  it("returns the workspace summary and threads the actor + workspaceId", async () => {
    getWorkspaceTraceabilitySummary.mockResolvedValue({
      projects: [
        {
          projectId: "proj-1",
          name: "Alpha",
          requirements: 3,
          linkedCrossProject: 1,
          specCoverage: 0.5,
          codeCoverage: 0.25,
        },
      ],
      crossProjectLinks: [
        {
          linkId: "L1",
          type: "relates_to",
          source: { requirementId: "r1", projectId: "proj-1" },
          target: { requirementId: "r2", projectId: "proj-2" },
        },
      ],
    });

    const res = await request(app).get("/workspaces/ws-1/traceability/summary");

    expect(res.status).toBe(200);
    expect(res.body.data.projects[0].name).toBe("Alpha");
    expect(res.body.data.crossProjectLinks[0].linkId).toBe("L1");
    expect(getWorkspaceTraceabilitySummary).toHaveBeenCalledWith(
      { id: "user-1", role: "member" },
      "ws-1",
    );
  });

  it("denies the summary without analysis.read (403)", async () => {
    permitRead = false;
    const res = await request(app).get("/workspaces/ws-1/traceability/summary");
    expect(res.status).toBe(403);
    expect(getWorkspaceTraceabilitySummary).not.toHaveBeenCalled();
  });

  it("propagates a 404 from the membership assertion", async () => {
    const { AppError } = await import("../middleware/error-handler.js");
    getWorkspaceTraceabilitySummary.mockRejectedValue(
      new AppError(404, "NOT_FOUND", "Workspace not found"),
    );
    const res = await request(app).get("/workspaces/ws-nope/traceability/summary");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
