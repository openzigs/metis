/**
 * #632 — the generated-docs router is rate-limited at router level (CodeQL
 * `js/missing-rate-limiting` #202). Uses the REAL express-rate-limit: a flood
 * is answered 429 with the standard envelope before `requireAuth` verifies a
 * JWT and before `refreshAuthenticatedUser` reads the database, while normal
 * traffic is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { issueTokens } from "../lib/auth/jwt.js";
import { generatedDocsRouter } from "./generated-docs.js";
import { errorHandler } from "../middleware/error-handler.js";

const userFindFirst = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "u1",
    username: "alice",
    status: "active",
    deletedAt: null,
    authRolesInitializedAt: new Date("2026-09-17T00:00:00.000Z"),
    authRoleAuthority: "unknown",
  })),
);

vi.mock("../lib/prisma.js", () => ({
  Prisma: { DbNull: null },
  prisma: {
    user: { findFirst: userFindFirst },
    userRole: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    workspaceMember: { findMany: vi.fn(async () => [{ workspaceId: "w1" }]) },
    project: {
      findUnique: vi.fn(async () => ({
        workspaceId: "w1",
        workspace: { deletedAt: null, members: [{ id: "member-row" }] },
      })),
      findFirst: vi.fn(async () => ({ id: "proj-1", deletedAt: null })),
    },
    generatedDocument: { findMany: vi.fn(async () => []) },
    task: { findMany: vi.fn(async () => []) },
    document: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

function app() {
  const instance = express();
  // Lets the pre-auth test give itself a fresh IP bucket via X-Forwarded-For.
  instance.set("trust proxy", true);
  instance.use(express.json());
  instance.use("/projects/:projectId/docs", generatedDocsRouter());
  instance.use(errorHandler);
  return instance;
}

function bearer(userId: string): string {
  const { accessToken } = issueTokens({
    userId,
    username: userId,
    role: "reader",
    permissions: ["project.read"],
    workspaces: ["w1"],
  });
  return `Bearer ${accessToken}`;
}

describe("generated-docs router rate limiting (#632)", () => {
  beforeEach(() => {
    userFindFirst.mockClear();
  });

  afterEach(() => {
    delete process.env.GENERATED_DOCS_RATE_LIMIT_MAX;
    delete process.env.GENERATED_DOCS_PREAUTH_RATE_LIMIT_MAX;
  });

  it("leaves normal traffic unaffected", async () => {
    const a = app();
    for (let i = 0; i < 5; i++) {
      const res = await request(a)
        .get("/projects/proj-1/docs")
        .set("Authorization", bearer("u-normal"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [] });
    }
  });

  it("answers a user over the per-user budget with 429 before reading the database", async () => {
    process.env.GENERATED_DOCS_RATE_LIMIT_MAX = "2";
    const a = app();
    const auth = bearer("u-flood");
    expect((await request(a).get("/projects/proj-1/docs").set("Authorization", auth)).status).toBe(
      200,
    );
    expect((await request(a).get("/projects/proj-1/docs").set("Authorization", auth)).status).toBe(
      200,
    );
    const readsBefore = userFindFirst.mock.calls.length;

    const limited = await request(a).get("/projects/proj-1/docs").set("Authorization", auth);

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      error: {
        code: "GENERATED_DOCS_RATE_LIMITED",
        message: "Too many documentation requests — slow down",
      },
    });
    // The limiter sits in front of refreshAuthenticatedUser's DB read.
    expect(userFindFirst.mock.calls.length).toBe(readsBefore);

    // Another user keeps their own budget.
    const other = await request(a)
      .get("/projects/proj-1/docs")
      .set("Authorization", bearer("u-other"));
    expect(other.status).toBe(200);
  });

  it("answers an IP over the pre-auth ceiling with 429 before verifying any token", async () => {
    process.env.GENERATED_DOCS_PREAUTH_RATE_LIMIT_MAX = "1";
    const a = app();
    // First anonymous request reaches requireAuth and is refused there.
    const ip = "203.0.113.7";
    expect((await request(a).get("/projects/proj-1/docs").set("X-Forwarded-For", ip)).status).toBe(
      401,
    );

    const limited = await request(a).get("/projects/proj-1/docs").set("X-Forwarded-For", ip);

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("GENERATED_DOCS_RATE_LIMITED");
  });
});
