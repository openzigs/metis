/**
 * Unit coverage for the `/api/runs` authorization seam (Issue #1056) — the
 * paths the route-level regression suite cannot reach: a missing `req.user`,
 * and a non-404 rejection from `assertProjectAccess` (which must propagate
 * unchanged rather than be flattened into a run-level 404).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    backgroundRun: { findUnique: vi.fn(async () => ({ projectId: "proj_a" })) },
    runGroup: { findUnique: vi.fn(async () => ({ projectId: "proj_a" })) },
  },
}));
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));

const assertProjectAccessMock = vi.fn(async () => undefined);
vi.mock("../custom-agents/authz.js", () => ({
  assertProjectAccess: (...args: unknown[]) => assertProjectAccessMock(...(args as [])),
}));

import type { AuthPayload } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import {
  authorizeBackgroundRun,
  authorizeRunGroup,
  authorizeRunProject,
  runProjectScope,
} from "./run-authz.js";

const member: AuthPayload = {
  userId: "user_1",
  username: "coordinator",
  role: "coordinator",
  workspaces: ["ws_b"],
};

beforeEach(() => {
  vi.clearAllMocks();
  assertProjectAccessMock.mockResolvedValue(undefined);
  prismaMock.backgroundRun.findUnique.mockResolvedValue({ projectId: "proj_a" });
  prismaMock.runGroup.findUnique.mockResolvedValue({ projectId: "proj_a" });
});

describe("missing authenticated user", () => {
  it("rejects with 401 on every entry point without querying", async () => {
    await expect(authorizeBackgroundRun(undefined, "run_1")).rejects.toMatchObject({
      statusCode: 401,
      code: "AUTH_REQUIRED",
    });
    await expect(authorizeRunGroup(undefined, "grp_1")).rejects.toMatchObject({ statusCode: 401 });
    await expect(authorizeRunProject(undefined, "proj_a")).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(() => runProjectScope(undefined)).toThrow(AppError);
    expect(prismaMock.backgroundRun.findUnique).not.toHaveBeenCalled();
    expect(assertProjectAccessMock).not.toHaveBeenCalled();
  });
});

describe("non-404 denials propagate unchanged", () => {
  it("keeps a 403 from the project seam instead of masking it as RUN_NOT_FOUND", async () => {
    assertProjectAccessMock.mockRejectedValue(new AppError(403, "FORBIDDEN", "nope"));
    await expect(authorizeBackgroundRun(member, "run_1")).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
  });

  it("keeps a non-AppError failure unchanged", async () => {
    assertProjectAccessMock.mockRejectedValue(new Error("db down"));
    await expect(authorizeRunGroup(member, "grp_1")).rejects.toThrow("db down");
  });
});

describe("runProjectScope", () => {
  it("falls back to an empty workspace list when the token carries none", () => {
    const noWorkspaces: AuthPayload = { ...member, workspaces: undefined };
    expect(runProjectScope(noWorkspaces)).toEqual({
      project: { OR: [{ workspaceId: null }, { workspaceId: { in: [] } }] },
    });
  });

  it("returns an empty fragment for system admins", () => {
    expect(runProjectScope({ ...member, role: "admin" })).toEqual({});
  });
});
