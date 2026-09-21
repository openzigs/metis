/**
 * Epic #803 (Epic 09) — Domain Eval read API tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DomainEvalRunResult } from "@metis/shared";

// #678 (epic #671): reads are gated by `requirePermission("admin.read")`.
// Default the injected caller to `admin` (carries admin.read) so the existing
// functional cases exercise the happy path; the authz block below overrides the
// role to assert the 403 denial for a caller without the scope.
interface TestUser {
  userId: string;
  role: string;
}
let currentUser: TestUser = { userId: "user-1", role: "admin" };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: TestUser }).user = currentUser;
    next();
  },
}));

const { domainEvalRouter } = await import("./eval-domain.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { writeRun } = await import("../lib/eval/domain/results-store.js");

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "domain-route-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeRun(runId: string, startedAt: string, f1 = 0.9): DomainEvalRunResult {
  return {
    runId,
    schemaVersion: 1,
    model: "offline-stub",
    startedAt,
    completedAt: startedAt,
    itemCount: 2,
    corpusPrecision: f1,
    corpusRecall: f1,
    corpusF1: f1,
    meanRougeL: 0.8,
    totalTokens: 10,
    totalCostCents: 0,
    commit: null,
    calibration: [],
    drift: {
      previousF1: null,
      deltaF1: null,
      thresholdPct: 0.05,
      alert: false,
      reason: "NO_BASELINE",
    },
    items: [],
  };
}

function createApp(resultsDir: string) {
  const app = express();
  app.use(express.json());
  app.use("/eval/domain", domainEvalRouter({ resultsDir }));
  app.use(errorHandler);
  return app;
}

describe("domainEvalRouter", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    currentUser = { userId: "user-1", role: "admin" };
    dir = await tmp();
    app = createApp(dir);
  });

  describe("GET /eval/domain/runs", () => {
    it("returns run summaries newest-first without per-item payload", async () => {
      await writeRun(dir, makeRun("old", "2026-01-01T00:00:00.000Z", 0.8));
      await writeRun(dir, makeRun("new", "2026-02-01T00:00:00.000Z", 0.95));
      const res = await request(app).get("/eval/domain/runs?days=365");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.runs.map((r: { runId: string }) => r.runId)).toEqual(["new", "old"]);
      expect(res.body.data.runs[0]).toHaveProperty("driftAlert");
      expect(res.body.data.runs[0]).not.toHaveProperty("items");
    });

    it("filters by the days window", async () => {
      const recent = new Date().toISOString();
      const ancient = "2000-01-01T00:00:00.000Z";
      await writeRun(dir, makeRun("recent", recent));
      await writeRun(dir, makeRun("ancient", ancient));
      const res = await request(app).get("/eval/domain/runs?days=30");
      expect(res.status).toBe(200);
      const ids = res.body.data.runs.map((r: { runId: string }) => r.runId);
      expect(ids).toContain("recent");
      expect(ids).not.toContain("ancient");
    });

    it("returns an empty list when there are no runs", async () => {
      const res = await request(app).get("/eval/domain/runs");
      expect(res.status).toBe(200);
      expect(res.body.data.runs).toEqual([]);
    });

    it("rejects an invalid days query", async () => {
      const res = await request(app).get("/eval/domain/runs?days=0");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /eval/domain/runs/:id", () => {
    it("returns the full run detail", async () => {
      await writeRun(dir, makeRun("detail", "2026-02-01T00:00:00.000Z"));
      const res = await request(app).get("/eval/domain/runs/detail");
      expect(res.status).toBe(200);
      expect(res.body.data.run.runId).toBe("detail");
      expect(res.body.data.run).toHaveProperty("items");
    });

    it("404s for an unknown run", async () => {
      const res = await request(app).get("/eval/domain/runs/missing");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("DOMAIN_EVAL_RUN_NOT_FOUND");
    });

    it("404s for a path-traversal id rather than reading outside the dir", async () => {
      const res = await request(app).get("/eval/domain/runs/..%2f..%2fsecret");
      expect(res.status).toBe(404);
    });
  });

  // #678 (epic #671): eval regression-suite history is internal platform data
  // with no tenant PK, so it is gated by `requirePermission("admin.read")` —
  // the catalog's internal/admin read scope. There is no object-level scope to
  // apply (no project/workspace binding); the permission gate is the control.
  describe("authz — requirePermission(admin.read)", () => {
    it("403s a non-admin listing runs", async () => {
      currentUser = { userId: "dev-1", role: "developer" };
      await writeRun(dir, makeRun("r1", "2026-02-01T00:00:00.000Z"));
      const res = await request(app).get("/eval/domain/runs");
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("403s a non-admin reading a run by id", async () => {
      currentUser = { userId: "reader-1", role: "reader" };
      await writeRun(dir, makeRun("r1", "2026-02-01T00:00:00.000Z"));
      const res = await request(app).get("/eval/domain/runs/r1");
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("allows an admin to list and read runs", async () => {
      currentUser = { userId: "root", role: "admin" };
      await writeRun(dir, makeRun("r1", "2026-02-01T00:00:00.000Z"));
      const list = await request(app).get("/eval/domain/runs");
      expect(list.status).toBe(200);
      const detail = await request(app).get("/eval/domain/runs/r1");
      expect(detail.status).toBe(200);
    });
  });
});
