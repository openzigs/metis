import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";

const state = vi.hoisted(() => ({ user: undefined as AuthPayload | undefined }));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!state.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.user = state.user;
    next();
  },
  refreshAuthenticatedUser: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!state.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.user = state.user;
    next();
  },
}));
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));
vi.mock("../lib/prisma.js", () => ({
  Prisma: { DbNull: null },
  prisma: {
    project: { findUnique: vi.fn(), findFirst: vi.fn() },
    codeGraph: { findFirst: vi.fn() },
    generatedDocument: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  },
}));
import { prisma } from "../lib/prisma.js";
import { generatedDocsRouter } from "./generated-docs.js";
import { errorHandler } from "../middleware/error-handler.js";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/projects/:projectId/docs", generatedDocsRouter());
  instance.use(errorHandler);
  return instance;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.user = {
    userId: "alice",
    username: "alice",
    role: "coordinator",
    permissions: getPermissionsForRole("coordinator"),
    workspaces: ["w1"],
  };
  vi.mocked(prisma.project.findUnique).mockResolvedValue({ workspaceId: "w1" } as never);
  vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: "p1" } as never);
  vi.mocked(prisma.codeGraph.findFirst).mockResolvedValue(null);
});

describe("generation admission evidence policy #1353", () => {
  it.each(["", "  ", "missing"])(
    "rejects unavailable repository %j without creating or dispatching generation",
    async (repoConnectorId) => {
      const response = await request(app())
        .post("/projects/p1/docs/generate")
        .send({ title: "Arch", scope: "repository", scopeFilter: { repoConnectorId } });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("REPOSITORY_GRAPH_UNAVAILABLE");
      expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
      expect(prisma.generatedDocument.update).not.toHaveBeenCalled();
    },
  );

  it.each(["repository", "database"])("requires %s connector before dispatch", async (scope) => {
    const response = await request(app())
      .post("/projects/p1/docs/generate")
      .send({ title: "Arch", scope });
    expect(response.status).toBe(400);
    expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
  });

  it("keeps the real project.update permission gate; a forged scope actor cannot elevate a developer", async () => {
    state.user = {
      ...state.user!,
      role: "developer",
      permissions: getPermissionsForRole("developer"),
    };
    const response = await request(app())
      .post("/projects/p1/docs/generate")
      .send({ title: "Arch", scopeFilter: { actorId: "admin", role: "admin" } });
    expect(response.status).toBe(403);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
    expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated admission before any project or document query", async () => {
    state.user = undefined;
    expect(
      (await request(app()).post("/projects/p1/docs/generate").send({ title: "Arch" })).status,
    ).toBe(401);
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
    expect(prisma.generatedDocument.create).not.toHaveBeenCalled();
  });
});
