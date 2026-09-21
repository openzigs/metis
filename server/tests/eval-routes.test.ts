/**
 * Epic #194 (C.5) — Eval leaderboard route tests.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { benchRunFindMany, benchRunFindUnique } = vi.hoisted(() => ({
  benchRunFindMany: vi.fn(),
  benchRunFindUnique: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    benchRun: {
      findMany: benchRunFindMany,
      findUnique: benchRunFindUnique,
    },
  },
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { evalRouter, type TriggerRunner } from "../src/routes/eval.js";

let adminToken: string;
let viewerToken: string;

function makeApp(triggerRunner?: TriggerRunner, isEnabled?: () => boolean): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/eval", evalRouter({ triggerRunner, isEnabled }));
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  adminToken = issueTokens({
    userId: "u-admin",
    username: "admin",
    role: "admin",
    permissions: getPermissionsForRole("admin"),
  }).accessToken;
  viewerToken = issueTokens({
    userId: "u-viewer",
    username: "viewer",
    role: "viewer",
    permissions: getPermissionsForRole("viewer"),
  }).accessToken;
});

afterEach(() => {
  benchRunFindMany.mockReset();
  benchRunFindUnique.mockReset();
  delete process.env.EVAL_NIGHTLY_ENABLED;
});

describe("GET /api/eval/leaderboard", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp()).get("/api/eval/leaderboard");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid bench query", async () => {
    const res = await request(makeApp())
      .get("/api/eval/leaderboard?bench=bogus")
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(400);
  });

  it("returns the latest runs filtered by bench", async () => {
    benchRunFindMany.mockResolvedValueOnce([
      {
        id: "r1",
        benchmark: "swe-bench-pro",
        model: "gpt-5",
        score: 0.5,
        totalTasks: 10,
        passedTasks: 5,
        meanTokens: 100,
        meanCostCents: 12,
        meanLatencyMs: 200,
        startedAt: new Date("2026-04-25T00:00:00Z"),
        completedAt: new Date("2026-04-25T01:00:00Z"),
        status: "completed",
      },
    ]);
    const res = await request(makeApp())
      .get("/api/eval/leaderboard?bench=swe-bench-pro&days=7")
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.runs[0]).toMatchObject({ id: "r1", benchmark: "swe-bench-pro" });
    const where = benchRunFindMany.mock.calls[0]?.[0]?.where as { benchmark: string };
    expect(where.benchmark).toBe("swe-bench-pro");
  });
});

describe("GET /api/eval/leaderboard/runs/:id", () => {
  it("returns 404 when the run is missing", async () => {
    benchRunFindUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .get("/api/eval/leaderboard/runs/missing")
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(404);
  });

  it("hides expected/actual diff content from non-admins", async () => {
    benchRunFindUnique.mockResolvedValueOnce({
      id: "r1",
      benchmark: "swe-bench-pro",
      model: "gpt-5",
      score: 1,
      totalTasks: 1,
      passedTasks: 1,
      meanTokens: 1,
      meanCostCents: 0,
      meanLatencyMs: 1,
      startedAt: new Date("2026-04-25T00:00:00Z"),
      completedAt: new Date("2026-04-25T00:00:01Z"),
      status: "completed",
      metadata: '{"foo":"bar"}',
      tasks: [
        {
          id: "t1",
          taskId: "task-1",
          passed: true,
          score: 1,
          tokens: 1,
          costCents: 0,
          latencyMs: 1,
          expected: "EXPECTED",
          actual: "ACTUAL",
          error: null,
        },
      ],
    });
    const res = await request(makeApp())
      .get("/api/eval/leaderboard/runs/r1")
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.run.metadata).toEqual({ foo: "bar" });
    expect(res.body.data.tasks[0].expected).toBeNull();
    expect(res.body.data.tasks[0].actual).toBeNull();
  });

  it("exposes diff content to admins", async () => {
    benchRunFindUnique.mockResolvedValueOnce({
      id: "r1",
      benchmark: "swe-bench-pro",
      model: "gpt-5",
      score: 1,
      totalTasks: 1,
      passedTasks: 1,
      meanTokens: 1,
      meanCostCents: 0,
      meanLatencyMs: 1,
      startedAt: new Date(),
      completedAt: new Date(),
      status: "completed",
      metadata: "not-json",
      tasks: [
        {
          id: "t1",
          taskId: "task-1",
          passed: true,
          score: 1,
          tokens: 1,
          costCents: 0,
          latencyMs: 1,
          expected: "EXPECTED",
          actual: "ACTUAL",
          error: null,
        },
      ],
    });
    const res = await request(makeApp())
      .get("/api/eval/leaderboard/runs/r1")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tasks[0].expected).toBe("EXPECTED");
    expect(res.body.data.tasks[0].actual).toBe("ACTUAL");
    // metadata fallback when it's not valid JSON.
    expect(res.body.data.run.metadata).toBe("not-json");
  });
});

describe("POST /api/eval/leaderboard/run", () => {
  it("requires admin permission", async () => {
    const res = await request(makeApp())
      .post("/api/eval/leaderboard/run")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ bench: "swe-bench-pro" });
    expect(res.status).toBe(403);
  });

  it("validates the payload", async () => {
    const res = await request(makeApp())
      .post("/api/eval/leaderboard/run")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bench: "bogus" });
    expect(res.status).toBe(400);
  });

  it("returns disabled when EVAL_NIGHTLY_ENABLED is unset", async () => {
    const res = await request(makeApp(undefined, () => false))
      .post("/api/eval/leaderboard/run")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bench: "swe-bench-pro", model: "gpt-5" });
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe("disabled");
  });

  it("invokes the runner when enabled and a runner is wired", async () => {
    const triggerRunner = vi.fn(async () => ({ benchRunId: "r-1", status: "completed" }));
    const res = await request(makeApp(triggerRunner, () => true))
      .post("/api/eval/leaderboard/run")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bench: "tau-bench", model: "gpt-5", costCapCents: 100 });
    expect(res.status).toBe(202);
    expect(triggerRunner).toHaveBeenCalledWith({
      bench: "tau-bench",
      model: "gpt-5",
      costCapCents: 100,
    });
  });

  it("returns 503 when enabled but no runner is wired", async () => {
    const res = await request(makeApp(undefined, () => true))
      .post("/api/eval/leaderboard/run")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bench: "swe-bench-pro", model: "gpt-5" });
    expect(res.status).toBe(503);
  });
});
