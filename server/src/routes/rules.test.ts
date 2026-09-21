/**
 * Rules router tests — Epic #708 / Issue #710.
 *
 * Routes exercised:
 *   GET    /rule-sets
 *   POST   /rule-sets
 *   POST   /rule-sets/:setId/rules
 *   POST   /rule-sets/:setId/rules/:ruleId/compile
 *   POST   /rule-sets/:setId/rules/:ruleId/grade
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  ruleSet: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  rule: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
};
vi.mock("../lib/prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: { userId: string } }).user = { userId: "user-1" };
    next();
  },
}));
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const mockCompileRule = vi.fn();
vi.mock("../lib/scanner/rule-compiler.js", () => ({
  compileRule: (...args: unknown[]) => mockCompileRule(...args),
  normaliseCompiledMeta: (raw: unknown) => raw,
}));

vi.mock("../lib/ai/index.js", () => ({
  buildProvider: () => ({}),
  loadAIConfig: () => ({}),
}));

const { rulesRouter } = await import("./rules.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/rule-sets", rulesRouter());
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { statusCode?: number; status?: number; code?: string; message?: string };
      res
        .status(e.statusCode ?? e.status ?? 500)
        .json({ error: { code: e.code ?? "INTERNAL", message: e.message ?? "?" } });
    },
  );
  return app;
}

describe("rules router", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("GET /rule-sets returns rule sets for a project", async () => {
    mockPrisma.ruleSet.findMany.mockResolvedValue([{ id: "rs-1", name: "Security", rules: [] }]);
    const res = await request(app).get("/projects/proj-1/rule-sets");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(mockPrisma.ruleSet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj-1" } }),
    );
  });

  it("POST /rule-sets creates a rule set", async () => {
    mockPrisma.ruleSet.create.mockResolvedValue({ id: "rs-1", name: "Sec" });
    const res = await request(app).post("/projects/proj-1/rule-sets").send({ name: "Sec" });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe("rs-1");
  });

  it("POST /rule-sets returns 400 on missing name", async () => {
    const res = await request(app).post("/projects/proj-1/rule-sets").send({});
    expect(res.status).toBe(400);
  });

  it("POST /rule-sets returns 409 on duplicate", async () => {
    mockPrisma.ruleSet.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await request(app).post("/projects/proj-1/rule-sets").send({ name: "Sec" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RULE_SET_EXISTS");
  });

  it("POST /rule-sets/:setId/rules creates a draft rule", async () => {
    mockPrisma.ruleSet.findFirst.mockResolvedValue({ id: "rs-1", projectId: "proj-1" });
    mockPrisma.rule.create.mockResolvedValue({ id: "r-1", status: "draft" });
    const res = await request(app).post("/projects/proj-1/rule-sets/rs-1/rules").send({
      naturalLanguage: "Detect SQL injection via string concatenation in db queries",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("draft");
  });

  it("POST /rule-sets/:setId/rules returns 404 when set missing", async () => {
    mockPrisma.ruleSet.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post("/projects/proj-1/rule-sets/rs-x/rules")
      .send({ naturalLanguage: "Detect SQL injection in repo via concat" });
    expect(res.status).toBe(404);
  });

  it("POST /rules/:id/compile compiles and updates status", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({ id: "r-1", naturalLanguage: "find bad code" });
    mockPrisma.rule.update.mockImplementation(async ({ data }: { data: unknown }) => ({
      id: "r-1",
      ...(data as object),
    }));
    mockCompileRule.mockResolvedValue({
      meta: { keywords: ["sql"], symbolKinds: ["function"], exemplars: ["bad sql"] },
      raw: "{}",
      totalTokens: 1,
    });
    const res = await request(app)
      .post("/projects/proj-1/rule-sets/rs-1/rules/r-1/compile")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("awaiting_grading");
    expect(mockPrisma.rule.update).toHaveBeenCalledTimes(2); // compiling, then awaiting_grading
  });

  it("POST /rules/:id/compile records failed status on error", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({ id: "r-1", naturalLanguage: "x" });
    mockPrisma.rule.update.mockResolvedValue({ id: "r-1" });
    mockCompileRule.mockRejectedValue(new Error("LLM down"));
    const res = await request(app)
      .post("/projects/proj-1/rule-sets/rs-1/rules/r-1/compile")
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("RULE_COMPILE_FAILED");
  });

  it("POST /rules/:id/grade requires >=5 exemplars", async () => {
    const res = await request(app)
      .post("/projects/proj-1/rule-sets/rs-1/rules/r-1/grade")
      .send({
        exemplars: [
          {
            codeSnippet: "x",
            language: "ts",
            expectedFinding: true,
            humanGrade: "true_positive",
          },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("POST /rules/:id/grade activates rule with 5+ exemplars", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({
      id: "r-1",
      status: "awaiting_grading",
    });
    mockPrisma.rule.update.mockResolvedValue({ id: "r-1", status: "active" });
    const exemplars = Array.from({ length: 5 }, (_, i) => ({
      codeSnippet: `code ${i}`,
      language: "ts" as const,
      expectedFinding: true,
      humanGrade: "true_positive" as const,
    }));
    const res = await request(app)
      .post("/projects/proj-1/rule-sets/rs-1/rules/r-1/grade")
      .send({ exemplars });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("active");
  });

  it("POST /rules/:id/grade rejects when rule still draft", async () => {
    mockPrisma.rule.findFirst.mockResolvedValue({ id: "r-1", status: "draft" });
    const exemplars = Array.from({ length: 5 }, (_, i) => ({
      codeSnippet: `c${i}`,
      language: "ts" as const,
      expectedFinding: true,
      humanGrade: "true_positive" as const,
    }));
    const res = await request(app)
      .post("/projects/proj-1/rule-sets/rs-1/rules/r-1/grade")
      .send({ exemplars });
    expect(res.status).toBe(409);
  });
});
