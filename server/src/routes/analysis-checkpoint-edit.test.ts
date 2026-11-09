/**
 * Issue #1580 (`b-7-8`) — PATCH .../approvals/:approvalId/requirement edits a
 * requirement in the approval checkpoint. The route validates, scopes the
 * analysis to its project, sits behind both approval limiters and audits; the
 * write itself is covered against a real database in
 * `tests/checkpoint-requirement-edit.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const authCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    authCalls.n += 1;
    (req as unknown as { user: { userId: string; role: string } }).user = {
      userId: "user-1",
      role: "member",
    };
    next();
  },
}));
const permissions = vi.hoisted(() => [] as string[]);
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (permission: string) =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      permissions.push(permission);
      next();
    },
}));
const limiters = vi.hoisted(() => ({ preAuth: false, edit: false, editCalls: 0 }));
vi.mock("../middleware/analysis-approval-rate-limit.js", () => {
  const limited =
    (flag: "preAuth" | "edit") =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (flag === "edit") limiters.editCalls += 1;
      if (limiters[flag]) {
        res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "slow" } });
        return;
      }
      next();
    };
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next();
  return {
    analysisApprovalPreAuthRateLimiter: limited("preAuth"),
    analysisApprovalEditRateLimiter: limited("edit"),
    analysisApprovalReopenRateLimiter: pass,
    analysisApprovalPromoteRateLimiter: pass,
  };
});

const analysisFindFirst = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    analysis: { findFirst: analysisFindFirst },
    project: { findUnique: vi.fn(async () => ({ workspaceId: null })) },
  },
}));

const editCheckpointRequirement = vi.hoisted(() => vi.fn());
vi.mock("../lib/analysis/checkpoint-requirement-edit.js", () => ({ editCheckpointRequirement }));
const audit = vi.hoisted(() => vi.fn());
vi.mock("../lib/audit/audit-service.js", () => ({ audit }));
vi.mock("../lib/ai/index.js", () => ({
  buildProvider: vi.fn(() => ({})),
  loadAIConfig: vi.fn(() => ({})),
}));
vi.mock("../lib/rag/knowledge-service.js", () => ({ getKnowledgeService: vi.fn(() => ({})) }));

const { initAnalysisRouter } = await import("./analysis.js");
const { errorHandler, AppError } = await import("../middleware/error-handler.js");

function createApp() {
  const { projectScoped } = initAnalysisRouter();
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/analyses", projectScoped);
  app.use(errorHandler);
  return app;
}

const URL = "/api/projects/proj-1/analyses/analysis-1/approvals/ap_1/requirement";
const edit = (body: unknown) =>
  request(createApp())
    .patch(URL)
    .send(body as object);

beforeEach(() => {
  vi.clearAllMocks();
  permissions.length = 0;
  limiters.preAuth = false;
  limiters.edit = false;
  limiters.editCalls = 0;
  authCalls.n = 0;
  analysisFindFirst.mockResolvedValue({ id: "analysis-1", projectId: "proj-1" });
  editCheckpointRequirement.mockImplementation(
    async (_a: string, _b: string, e: { title?: string }) => ({
      id: "REQ-1",
      title: e.title ?? "Old",
      description: "",
    }),
  );
});

describe("PATCH .../approvals/:approvalId/requirement — #1580", () => {
  it("writes the trimmed edit for the approval, scoped to its analysis, and audits it", async () => {
    const res = await edit({ title: "  Mark entries read  ", description: " Older than X. " });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: "REQ-1", title: "Mark entries read" });
    expect(editCheckpointRequirement).toHaveBeenCalledWith("analysis-1", "ap_1", {
      title: "Mark entries read",
      description: "Older than X.",
    });
    // #1097 — the analysis is looked up inside the path project.
    expect(analysisFindFirst).toHaveBeenCalledWith({
      where: { id: "analysis-1", deletedAt: null, projectId: "proj-1" },
    });
    expect(permissions).toContain("analysis.run");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "analysis.approval.edit",
        target: { type: "approval_request", id: "ap_1" },
        metadata: { analysisId: "analysis-1", fields: ["title", "description"] },
      }),
    );
  });

  it.each([
    ["an empty body", {}],
    ["a blank title", { title: "   " }],
    ["a field it does not edit", { title: "T", priority: "high" }],
    ["a title over 255 characters", { title: "x".repeat(256) }],
  ])("refuses %s with 400 and writes nothing", async (_label, body) => {
    const res = await edit(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(editCheckpointRequirement).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("answers 404 for an analysis outside the path project", async () => {
    analysisFindFirst.mockResolvedValue(null);

    const res = await edit({ title: "T" });

    expect(res.status).toBe(404);
    expect(editCheckpointRequirement).not.toHaveBeenCalled();
  });

  it("passes the service's 409 through for a resolved approval, without an audit row", async () => {
    editCheckpointRequirement.mockRejectedValueOnce(
      new AppError(409, "APPROVAL_ALREADY_REVIEWED", "already approved"),
    );

    const res = await edit({ title: "T" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("APPROVAL_ALREADY_REVIEWED");
    expect(audit).not.toHaveBeenCalled();
  });

  it("answers 429 from the pre-auth limiter before the route's own auth runs", async () => {
    limiters.preAuth = true;

    const res = await edit({ title: "T" });

    expect(res.status).toBe(429);
    // Only the router-wide `requireAuth` ran; the route's own never did.
    expect(authCalls.n).toBe(1);
    expect(limiters.editCalls).toBe(0);
    expect(editCheckpointRequirement).not.toHaveBeenCalled();
  });

  it("is rate limited per user before the edit runs", async () => {
    limiters.edit = true;

    const res = await edit({ title: "T" });

    expect(res.status).toBe(429);
    expect(limiters.editCalls).toBe(1);
    expect(editCheckpointRequirement).not.toHaveBeenCalled();
  });
});
