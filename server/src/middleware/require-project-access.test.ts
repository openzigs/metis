/**
 * Unit tests for the `requireProjectAccess` middleware factory (issue #674,
 * epic #671, OWASP A01 / BOLA). Prisma is mocked at the unit boundary because
 * the middleware delegates to `assertProjectAccess`, which resolves the
 * project's workspace via `prisma.project.findUnique`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { AuthPayload } from "@metis/shared";

const projectFindUnique = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique: projectFindUnique } },
}));

const { requireProjectAccess } = await import("./require-project-access.js");
const { AppError } = await import("./error-handler.js");

function mkReq(params: Record<string, unknown>, user?: Partial<AuthPayload>): Request {
  return { params, user } as unknown as Request;
}

function run(
  mw: ReturnType<typeof requireProjectAccess>,
  req: Request,
): Promise<{ err: unknown; called: boolean }> {
  return new Promise((resolve) => {
    const next: NextFunction = (err?: unknown) =>
      resolve({ err: err ?? null, called: err === undefined });
    mw(req, {} as Response, next);
  });
}

const CALLER: Partial<AuthPayload> = {
  userId: "user-1",
  role: "coordinator",
  workspaces: ["ws-a"],
};

describe("requireProjectAccess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when the request has no authenticated user", async () => {
    const { err, called } = await run(requireProjectAccess(), mkReq({ projectId: "p1" }));
    expect(called).toBe(false);
    expect(err).toBeInstanceOf(AppError);
    expect((err as InstanceType<typeof AppError>).statusCode).toBe(401);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });

  it("400s when the project id path param is missing", async () => {
    const { err } = await run(requireProjectAccess(), mkReq({}, CALLER));
    expect((err as InstanceType<typeof AppError>).statusCode).toBe(400);
    expect((err as InstanceType<typeof AppError>).code).toBe("PROJECT_REQUIRED");
  });

  it("404s (not 403) for a caller outside the project's workspace — no oracle", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const { err } = await run(requireProjectAccess(), mkReq({ projectId: "p-b" }, CALLER));
    expect((err as InstanceType<typeof AppError>).statusCode).toBe(404);
    expect((err as InstanceType<typeof AppError>).code).toBe("NOT_FOUND");
  });

  it("calls next() with no error for an in-tenant caller", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    const { err, called } = await run(requireProjectAccess(), mkReq({ projectId: "p-a" }, CALLER));
    expect(called).toBe(true);
    expect(err).toBeNull();
  });

  it("lets a system admin bypass the workspace scope", async () => {
    const { err, called } = await run(
      requireProjectAccess(),
      mkReq({ projectId: "p-b" }, { userId: "admin-1", role: "admin" }),
    );
    expect(called).toBe(true);
    expect(err).toBeNull();
    expect(projectFindUnique).not.toHaveBeenCalled();
  });

  it("404s for an unknown project id", async () => {
    projectFindUnique.mockResolvedValueOnce(null);
    const { err } = await run(requireProjectAccess(), mkReq({ projectId: "ghost" }, CALLER));
    expect((err as InstanceType<typeof AppError>).statusCode).toBe(404);
  });

  it("reads a custom param name (`id`) for the projects.ts subtree", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-b" });
    const { err } = await run(requireProjectAccess("id"), mkReq({ id: "p-b" }, CALLER));
    expect((err as InstanceType<typeof AppError>).statusCode).toBe(404);
    expect(projectFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p-b" } }),
    );
  });

  it("unwraps an array-valued param (wildcard `.use` mount)", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-a" });
    const { called } = await run(
      requireProjectAccess(),
      mkReq({ projectId: ["p-a", "p-a"] }, CALLER),
    );
    expect(called).toBe(true);
    expect(projectFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p-a" } }),
    );
  });

  it("passes through an unassigned (pre-migration) project to any authed caller", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: null });
    const { called } = await run(requireProjectAccess(), mkReq({ projectId: "legacy" }, CALLER));
    expect(called).toBe(true);
  });
});
