/**
 * Regression test for #381 — `GET /api/runs/background` must NOT be shadowed
 * by the parameterized `/api/runs/:id` handler in the deterministic-replay
 * router. Both routers mount on the same `/runs` prefix, so registration
 * order matters.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    backgroundRun: {
      findMany: vi.fn(async () => []),
    },
    agentRun: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock("../src/lib/async/runner.js", () => ({
  getAsyncRunner: () => ({
    submit: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  }),
  configureAsyncRunner: vi.fn(),
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { runsRouter } from "../src/routes/runs.js";
import { backgroundRunsRouter } from "../src/routes/background-runs.js";

let token: string;

beforeAll(() => {
  token = issueTokens({
    userId: "u1",
    username: "admin",
    role: "admin",
    permissions: getPermissionsForRole("admin"),
  }).accessToken;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  // Production order — backgroundRunsRouter MUST be registered first so its
  // literal `/background` path wins over `runsRouter`'s parameterized `/:id`.
  app.use("/api/runs", backgroundRunsRouter());
  app.use("/api/runs", runsRouter());
  app.use(errorHandler);
  return app;
}

describe("Issue #381 — /api/runs/background route ordering", () => {
  it("GET /api/runs/background does not return RUN_NOT_FOUND", async () => {
    const res = await request(makeApp())
      .get("/api/runs/background?limit=8")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(404);
    expect(res.body?.error?.code).not.toBe("RUN_NOT_FOUND");
  });

  it("GET /api/runs/background returns the background run collection", async () => {
    const res = await request(makeApp())
      .get("/api/runs/background?limit=8")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });
});
