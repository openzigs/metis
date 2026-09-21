/**
 * Scans router tests — Epic #708 / Issue #711.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  repoConnection: { findFirst: vi.fn() },
  scan: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  codeGraph: { findFirst: vi.fn() },
  task: { findMany: vi.fn() },
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

const mockEnqueue = vi.fn();
vi.mock("../lib/scheduler/index.js", () => ({
  getSchedulerBootstrap: () => ({ queue: { enqueue: mockEnqueue } }),
}));

const { scansRouter } = await import("./scans.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId", scansRouter());
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

describe("scans router", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no in-flight scanner tasks (taskId enrichment resolves to null).
    mockPrisma.task.findMany.mockResolvedValue([]);
    app = createApp();
  });

  it("POST /repositories/:repoId/scans enqueues a scan", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      lastCommitSha: "deadbeef",
      status: "active",
    });
    mockPrisma.codeGraph.findFirst.mockResolvedValue({
      id: "graph-1",
      commitSha: "deadbeef",
    });
    mockPrisma.scan.create.mockResolvedValue({
      id: "scan-1",
      projectId: "proj-1",
      mode: "both",
    });
    mockEnqueue.mockResolvedValue({ id: "task-1" });
    const res = await request(app)
      .post("/projects/proj-1/repositories/repo-1/scans")
      .send({ mode: "both" });
    expect(res.status).toBe(202);
    expect(res.body.data.id).toBe("scan-1");
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "scanner.run-scan",
        payload: { scanId: "scan-1" },
      }),
    );
  });

  it("POST returns 404 when repo connection missing", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
    const res = await request(app).post("/projects/proj-1/repositories/repo-x/scans").send({});
    expect(res.status).toBe(404);
  });

  it("POST returns 409 INDEX_REQUIRED when repository has no code graph", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      lastCommitSha: "deadbeef",
      status: "active",
    });
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post("/projects/proj-1/repositories/repo-1/scans")
      .send({ mode: "both" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INDEX_REQUIRED");
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("POST returns 409 COMMIT_SHA_REQUIRED when no commit anchor exists", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      lastCommitSha: null,
      status: "active",
    });
    mockPrisma.codeGraph.findFirst.mockResolvedValue({
      id: "graph-1",
      commitSha: null,
    });
    const res = await request(app)
      .post("/projects/proj-1/repositories/repo-1/scans")
      .send({ mode: "both" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("COMMIT_SHA_REQUIRED");
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("POST returns 400 on invalid mode", async () => {
    const res = await request(app)
      .post("/projects/proj-1/repositories/repo-1/scans")
      .send({ mode: "garbage" });
    expect(res.status).toBe(400);
  });

  it("GET /repositories/:repoId/scans lists scans", async () => {
    mockPrisma.scan.findMany.mockResolvedValue([{ id: "scan-1" }]);
    const res = await request(app).get("/projects/proj-1/repositories/repo-1/scans");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("GET /scans/:scanId returns single scan", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue({ id: "scan-1", status: "completed" });
    const res = await request(app).get("/projects/proj-1/scans/scan-1");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("scan-1");
  });

  // ---- Issue #422: taskId enrichment so the UI can subscribe:task ----------

  it("GET /scans attaches the in-flight scanner task id (no schema change)", async () => {
    mockPrisma.scan.findMany.mockResolvedValue([
      { id: "scan-running", status: "running", _count: { scanFindings: 2 } },
      { id: "scan-done", status: "completed", _count: { scanFindings: 5 } },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { id: "task-77", payload: JSON.stringify({ scanId: "scan-running" }) },
    ]);
    const res = await request(app).get("/projects/proj-1/scans");
    expect(res.status).toBe(200);
    const running = res.body.data.find((s: { id: string }) => s.id === "scan-running");
    const done = res.body.data.find((s: { id: string }) => s.id === "scan-done");
    expect(running.taskId).toBe("task-77");
    expect(running.findingCount).toBe(2);
    // Terminal scans get a null taskId (no live task to subscribe to).
    expect(done.taskId).toBeNull();
    // Only in-flight scans trigger the task lookup.
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-1",
          type: "scanner.run-scan",
          status: { in: ["pending", "running"] },
        }),
      }),
    );
  });

  it("GET /scans skips the task lookup entirely when no scans are in flight", async () => {
    mockPrisma.scan.findMany.mockResolvedValue([
      { id: "scan-done", status: "completed", _count: { scanFindings: 1 } },
    ]);
    const res = await request(app).get("/projects/proj-1/scans");
    expect(res.status).toBe(200);
    expect(res.body.data[0].taskId).toBeNull();
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it("GET /scans tolerates a malformed task payload without throwing", async () => {
    mockPrisma.scan.findMany.mockResolvedValue([
      { id: "scan-running", status: "running", _count: { scanFindings: 0 } },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { id: "task-bad", payload: "{not-json" },
      { id: "task-good", payload: JSON.stringify({ scanId: "scan-running" }) },
    ]);
    const res = await request(app).get("/projects/proj-1/scans");
    expect(res.status).toBe(200);
    expect(res.body.data[0].taskId).toBe("task-good");
  });

  it("GET /scans/:scanId attaches taskId for an in-flight scan", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue({ id: "scan-1", status: "running" });
    mockPrisma.task.findMany.mockResolvedValue([
      { id: "task-9", payload: JSON.stringify({ scanId: "scan-1" }) },
    ]);
    const res = await request(app).get("/projects/proj-1/scans/scan-1");
    expect(res.status).toBe(200);
    expect(res.body.data.taskId).toBe("task-9");
  });

  it("GET /scans/:scanId returns null taskId for a terminal scan and skips the lookup", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue({ id: "scan-1", status: "completed" });
    const res = await request(app).get("/projects/proj-1/scans/scan-1");
    expect(res.status).toBe(200);
    expect(res.body.data.taskId).toBeNull();
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it("GET /scans/:scanId returns 404 when missing", async () => {
    mockPrisma.scan.findFirst.mockResolvedValue(null);
    const res = await request(app).get("/projects/proj-1/scans/scan-x");
    expect(res.status).toBe(404);
  });

  it("GET /repositories/:repoId/scans/index-status reports indexed when graph + sha present", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      lastCommitSha: "deadbeef",
    });
    mockPrisma.codeGraph.findFirst.mockResolvedValue({
      id: "graph-1",
      commitSha: "feedface",
      updatedAt: new Date("2024-01-01T00:00:00Z"),
    });
    const res = await request(app).get("/projects/proj-1/repositories/repo-1/scans/index-status");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ indexed: true, commitSha: "feedface" });
  });

  it("GET /repositories/:repoId/scans/index-status reports not indexed when no graph", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue({
      id: "repo-1",
      lastCommitSha: "deadbeef",
    });
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    const res = await request(app).get("/projects/proj-1/repositories/repo-1/scans/index-status");
    expect(res.status).toBe(200);
    expect(res.body.data.indexed).toBe(false);
  });

  it("GET /repositories/:repoId/scans/index-status returns 404 when repo missing", async () => {
    mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    const res = await request(app).get("/projects/proj-1/repositories/repo-x/scans/index-status");
    expect(res.status).toBe(404);
  });
});
