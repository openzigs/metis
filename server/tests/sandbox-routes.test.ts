/**
 * Route tests for POST /api/sandbox/run-once (Epic #395 #420).
 *
 * Covers the auth / permission / RBAC / validation surface. The
 * happy-path "actually invoke the provider and persist a SandboxSession"
 * journey is covered by the gated Playwright e2e at
 * `e2e/tests/sandbox-ba-loop.spec.ts` which exercises the real E2B
 * vendor (the one place where mocking the provider would defeat the
 * test).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { projectFindMany } = vi.hoisted(() => ({
  projectFindMany: vi.fn(async () => [] as Array<{ id: string }>),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: { findMany: projectFindMany },
  },
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { sandboxRouter } from "../src/routes/sandbox.js";

let adminToken: string;
let developerToken: string;
let readerToken: string;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sandbox", sandboxRouter());
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  adminToken = issueTokens({
    userId: "u_admin",
    username: "admin",
    role: "admin",
    permissions: getPermissionsForRole("admin"),
  }).accessToken;
  developerToken = issueTokens({
    userId: "u_dev",
    username: "developer",
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;
  readerToken = issueTokens({
    userId: "u_reader",
    username: "reader",
    role: "reader",
    permissions: getPermissionsForRole("reader"),
  }).accessToken;
});

afterEach(() => {
  projectFindMany.mockReset();
  projectFindMany.mockResolvedValue([]);
});

describe("POST /api/sandbox/run-once", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp())
      .post("/api/sandbox/run-once")
      .send({ projectId: "p1", code: "print(1)" });
    expect(res.status).toBe(401);
  });

  it("rejects callers without analysis.run permission (reader role)", async () => {
    const res = await request(makeApp())
      .post("/api/sandbox/run-once")
      .set("Authorization", `Bearer ${readerToken}`)
      .send({ projectId: "p1", code: "print(1)" });
    expect(res.status).toBe(403);
  });

  it("returns 400 when projectId is missing", async () => {
    const res = await request(makeApp())
      .post("/api/sandbox/run-once")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "print(1)" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when code is empty", async () => {
    const res = await request(makeApp())
      .post("/api/sandbox/run-once")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1", code: "" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when timeoutMs exceeds the hard cap", async () => {
    const res = await request(makeApp())
      .post("/api/sandbox/run-once")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ projectId: "p1", code: "print(1)", timeoutMs: 999_999_999 });
    expect(res.status).toBe(400);
  });

  it("returns 403 when a non-admin lacks project access (cross-tenant block)", async () => {
    projectFindMany.mockResolvedValueOnce([]); // dev owns no projects
    const res = await request(makeApp())
      .post("/api/sandbox/run-once")
      .set("Authorization", `Bearer ${developerToken}`)
      .send({ projectId: "p_other", code: "print(1)" });
    expect(res.status).toBe(403);
  });
});
