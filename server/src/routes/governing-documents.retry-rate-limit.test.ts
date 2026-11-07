/**
 * #1958 — the admin retry route (`POST …/rule-extraction`, #1947) starts up to
 * `MAX_SECTIONS` billed model calls per 202, so it sits behind the upload
 * limiter, as the upload routes do. The limiter is a double here: the test
 * asserts the route consults it, and that a refusal starts no run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const limiter = vi.hoisted(() => {
  process.env.GOVERNING_DOCS_ENABLED = "1";
  return { refuse: false, calls: 0 };
});
vi.mock("../middleware/upload-rate-limit.js", () => ({
  uploadRateLimiter: (_req: express.Request, res: express.Response, next: () => void) => {
    limiter.calls += 1;
    if (limiter.refuse) {
      res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message: "slow" } });
      return;
    }
    next();
  },
}));
vi.mock("../middleware/auth.js", () => ({
  // A deployment admin: passes `requireWorkspaceRole` without a membership row.
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = { userId: "admin-1", role: "admin" };
    next();
  },
}));
const revisionFindFirst = vi.hoisted(() => vi.fn());
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    workspace: { findFirst: vi.fn(async () => ({ id: "ws-1" })) },
    governingDocumentRevision: { findFirst: revisionFindFirst },
  },
}));
vi.mock("../lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { governingDocumentsRouter } = await import("./governing-documents.js");
const { errorHandler } = await import("../middleware/error-handler.js");

const RETRY = "/api/workspaces/ws-1/governing-documents/doc-1/revisions/rev-1/rule-extraction";

function app(extractRules: () => Promise<void>) {
  const a = express();
  a.use(express.json());
  a.use(
    "/api/workspaces/:workspaceId/governing-documents",
    governingDocumentsRouter({ extractRules }),
  );
  a.use(errorHandler);
  return a;
}

describe("#1958 — the rule-extraction retry route is rate limited", () => {
  beforeEach(() => {
    limiter.refuse = false;
    limiter.calls = 0;
    revisionFindFirst.mockReset();
    revisionFindFirst.mockResolvedValue({ extractionState: "failed", extractionStartedAt: null });
  });

  it("a retry the limiter allows is scheduled (202), and the limiter was consulted", async () => {
    const extractRules = vi.fn(async () => undefined);
    const res = await request(app(extractRules)).post(RETRY);
    expect(res.status).toBe(202);
    expect(limiter.calls).toBe(1);
    expect(extractRules).toHaveBeenCalledWith({ workspaceId: "ws-1", revisionId: "rev-1" });
  });

  it("a retry the limiter refuses is 429 and starts no billed run", async () => {
    limiter.refuse = true;
    const extractRules = vi.fn(async () => undefined);
    const res = await request(app(extractRules)).post(RETRY);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(extractRules).not.toHaveBeenCalled();
    expect(revisionFindFirst).not.toHaveBeenCalled();
  });
});
