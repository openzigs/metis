import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { issueTokens } from "../lib/auth/jwt.js";
import { generatedDocsRouter } from "./generated-docs.js";
import { errorHandler } from "../middleware/error-handler.js";

const prismaState = vi.hoisted(() => ({
  user: {
    id: "u1",
    username: "alice",
    status: "active",
    deletedAt: null,
    authRolesInitializedAt: new Date("2026-09-17T00:00:00.000Z"),
    authRoleAuthority: "unknown",
  },
  roles: [] as Array<{ role: { key: string }; source?: string | null }>,
  memberships: [{ workspaceId: "w1" }],
}));

vi.mock("../lib/prisma.js", () => ({
  Prisma: { DbNull: null },
  prisma: {
    user: {
      findFirst: vi.fn(async () => prismaState.user),
    },
    userRole: {
      findMany: vi.fn(async () => prismaState.roles),
      findFirst: vi.fn(async () => prismaState.roles[0] ?? null),
    },
    workspaceMember: {
      findMany: vi.fn(async () => prismaState.memberships),
    },
    project: {
      findUnique: vi.fn(async () => ({ workspaceId: "w1" })),
      findFirst: vi.fn(async () => ({ id: "proj-1", deletedAt: null })),
    },
    codeGraph: { findFirst: vi.fn(async () => null) },
    generatedDocument: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/projects/:projectId/docs", generatedDocsRouter());
  instance.use(errorHandler);
  return instance;
}

describe("generated-docs router live auth refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaState.roles = [];
    prismaState.user.authRoleAuthority = "unknown";
    prismaState.memberships = [{ workspaceId: "w1" }];
  });

  it("denies generate when a stale admin JWT no longer has any durable role", async () => {
    const tokens = issueTokens({
      userId: "u1",
      username: "alice",
      role: "admin",
      permissions: ["project.update"],
      workspaces: ["w1"],
    });

    const response = await request(app())
      .post("/projects/proj-1/docs/generate")
      .set("Authorization", `Bearer ${tokens.accessToken}`)
      .send({ title: "Arch", scope: "full" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("denies generate when an explicit SCIM reader override suppresses a provider admin row", async () => {
    prismaState.roles = [
      { role: { key: "admin" }, source: "provider" },
      { role: { key: "reader" }, source: "scim" },
    ];
    const tokens = issueTokens({
      userId: "u1",
      username: "alice",
      role: "admin",
      permissions: ["project.update"],
      workspaces: ["w1"],
    });

    const response = await request(app())
      .post("/projects/proj-1/docs/generate")
      .set("Authorization", `Bearer ${tokens.accessToken}`)
      .send({ title: "Arch", scope: "full" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it.each(["scim", "explicit", "revoked"])(
    "denies stale admin access with only provider grants under %s authority",
    async (authority) => {
      prismaState.user.authRoleAuthority = authority;
      prismaState.roles = [{ role: { key: "admin" }, source: "provider" }];
      const tokens = issueTokens({
        userId: "u1",
        username: "alice",
        role: "admin",
        permissions: ["project.update"],
        workspaces: ["w1"],
      });
      const response = await request(app())
        .post("/projects/proj-1/docs/generate")
        .set("Authorization", `Bearer ${tokens.accessToken}`)
        .send({ title: "Arch", scope: "full" });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    },
  );
});
