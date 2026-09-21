/**
 * Triage router tests — Epic #708 / Issues #714 + #715.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  scan: { findFirst: vi.fn() },
  scanFinding: { findFirst: vi.fn(), findMany: vi.fn() },
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

const mockMaterialize = vi.fn();
const mockPublish = vi.fn();
vi.mock("../lib/scanner/prisma-adapter.js", () => ({
  materializeTriagedFinding: (...args: unknown[]) => mockMaterialize(...args),
  publishScanFinding: (...args: unknown[]) => mockPublish(...args),
}));

import { PublishError } from "../lib/scanner/finding-publisher.js";

const { triageRouter } = await import("./triage.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId", triageRouter());
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

function findingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "sf-1",
    scanId: "scan-1",
    symbolId: "sym-1",
    ruleId: null,
    title: "issue",
    body: "details",
    severity: "high",
    category: "security",
    evidenceLines: "[1,2,3]",
    fingerprint: "fp-abc",
    confidence: 0.9,
    triageStatus: "pending",
    materializedFindingId: null,
    scan: { projectId: "proj-1", repoConnectionId: "repo-1" },
    symbol: { qualifiedName: "x.y", filePath: "src/x.ts" },
    ...overrides,
  };
}

describe("triage router", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("GET /scans/:scanId/findings returns 404 when scan missing", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue(null);
    const res = await request(app).get("/projects/proj-1/scans/scan-x/findings");
    expect(res.status).toBe(404);
  });

  it("GET /scans/:scanId/findings lists findings", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue({ id: "scan-1" });
    mockPrisma.scanFinding.findMany.mockResolvedValue([findingFixture()]);
    const res = await request(app).get("/projects/proj-1/scans/scan-1/findings");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("POST triage approves and materialises", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue(findingFixture());
    mockMaterialize.mockResolvedValue({ findingId: "find-1" });
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/triage")
      .send({ decision: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.data.materializedFindingId).toBe("find-1");
    // #1330 — the route must THREAD `applyTriageDecision`'s own
    // MaterialisedFindingInput through. It used to compute the outcome, keep
    // only `newStatus` and discard `outcome.materialised`, leaving the adapter
    // to rebuild a second, wrong payload from the raw row. Asserting only
    // `objectContaining({ scanFindingId, triageStatus })` is what let that
    // stand, so the whole payload is pinned here.
    expect(mockMaterialize).toHaveBeenCalledWith({
      scanFindingId: "sf-1",
      triagedById: expect.any(String),
      triageStatus: "approved",
      triageNote: undefined,
      materialised: {
        projectId: "proj-1",
        symbolId: "sym-1",
        title: "issue",
        body: "details",
        severity: "high",
        category: "security",
        evidenceLines: [1, 2, 3],
        filePath: "src/x.ts",
        scanFindingId: "sf-1",
        derivation: "inferred",
        confidence: 0.9,
      },
    });
  });

  it("POST triage passes a null payload for a non-approval", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue(findingFixture());
    mockMaterialize.mockResolvedValue({ findingId: undefined });
    await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/triage")
      .send({ decision: "deferred" });
    expect(mockMaterialize).toHaveBeenCalledWith(
      expect.objectContaining({ triageStatus: "deferred", materialised: null }),
    );
  });

  it("POST triage rejects (no materialisation)", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue(findingFixture());
    mockMaterialize.mockResolvedValue({ findingId: undefined });
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/triage")
      .send({ decision: "rejected" });
    expect(res.status).toBe(200);
    expect(res.body.data.newStatus).toBe("rejected");
  });

  it("POST triage returns 409 on no-op", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue(
      findingFixture({ triageStatus: "approved" }),
    );
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/triage")
      .send({ decision: "approved" });
    expect(res.status).toBe(409);
  });

  it("POST triage validates decision", async () => {
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/triage")
      .send({ decision: "garbage" });
    expect(res.status).toBe(400);
  });

  it("POST publish requires approved triage", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue({
      id: "sf-1",
      triageStatus: "pending",
      materializedFindingId: null,
    });
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/publish")
      .send({ provider: "github" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TRIAGE_NOT_APPROVED");
  });

  it("POST publish calls publisher and returns link", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue({
      id: "sf-1",
      triageStatus: "approved",
      materializedFindingId: "find-1",
    });
    mockPublish.mockResolvedValue({
      id: "link-1",
      provider: "github",
      externalUrl: "https://github.com/o/r/issues/1",
    });
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/publish")
      .send({ provider: "github" });
    expect(res.status).toBe(200);
    expect(res.body.data.externalUrl).toBe("https://github.com/o/r/issues/1");
  });

  it("POST publish surfaces publisher errors as 502", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue({
      id: "sf-1",
      triageStatus: "approved",
      materializedFindingId: "find-1",
    });
    mockPublish.mockRejectedValue(new Error("stale commit"));
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/publish")
      .send({ provider: "github" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("PUBLISH_FAILED");
  });

  it("POST publish maps PublishError(ERR_STALE_COMMIT) to 409", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue({
      id: "sf-1",
      triageStatus: "approved",
      materializedFindingId: "find-1",
    });
    mockPublish.mockRejectedValue(
      new PublishError("ERR_STALE_COMMIT", "repo HEAD moved past scan commit"),
    );
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/publish")
      .send({ provider: "github" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ERR_STALE_COMMIT");
  });

  it("POST publish maps PublishError(ERR_JIRA_NOT_CONFIGURED) to 409 with an actionable message", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue({
      id: "sf-1",
      triageStatus: "approved",
      materializedFindingId: "find-1",
    });
    mockPublish.mockRejectedValue(
      new PublishError(
        "ERR_JIRA_NOT_CONFIGURED",
        "Project has no Jira connection or project key configured — wire one in project settings before publishing to Jira.",
      ),
    );
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/publish")
      .send({ provider: "jira" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ERR_JIRA_NOT_CONFIGURED");
    expect(res.body.error.message).toContain("project settings");
  });

  it("POST publish still maps PublishError(ERR_NOT_IMPLEMENTED) to 501", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue({
      id: "sf-1",
      triageStatus: "approved",
      materializedFindingId: "find-1",
    });
    mockPublish.mockRejectedValue(
      new PublishError("ERR_NOT_IMPLEMENTED", "Project has no connected GitHub repository"),
    );
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/publish")
      .send({ provider: "github" });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe("ERR_NOT_IMPLEMENTED");
  });

  it("POST publish maps other PublishError codes to 502 with the original code", async () => {
    mockPrisma.scanFinding.findFirst.mockResolvedValue({
      id: "sf-1",
      triageStatus: "approved",
      materializedFindingId: "find-1",
    });
    mockPublish.mockRejectedValue(new PublishError("ERR_PROVIDER_5XX", "GitHub returned 503"));
    const res = await request(app)
      .post("/projects/proj-1/scans/scan-1/findings/sf-1/publish")
      .send({ provider: "github" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ERR_PROVIDER_5XX");
  });
});
