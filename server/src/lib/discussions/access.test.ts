/**
 * Epic #475 (Phase 1, #477) / #734 — thread access tests.
 *
 * `canAccessThread` is the single source of truth shared by the REST routes, the
 * socket `subscribe:thread` handler, presence and the Teams bridge. Since #734 it
 * delegates to the canonical project-access seam (`assertProjectAccess`, the rule
 * behind `requireProjectAccess` and `GET /projects/:id`), so a discussion's
 * audience is the project's audience — not "its creator plus admins". The real
 * `assertProjectAccess` runs here against a prisma double, so these tests pin
 * the rule itself rather than a mock of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const threadFindFirst = vi.fn();
const projectFindFirst = vi.fn();
const projectFindUnique = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    discussionThread: { findFirst: (...a: unknown[]) => threadFindFirst(...a) },
    project: {
      findFirst: (...a: unknown[]) => projectFindFirst(...a),
      findUnique: (...a: unknown[]) => projectFindUnique(...a),
    },
  },
}));

const readLiveWorkspaceIds = vi.fn();
vi.mock("../auth/live-workspace-ids.js", () => ({
  readLiveWorkspaceIds: (...a: unknown[]) => readLiveWorkspaceIds(...a),
}));

const audit = vi.fn();
vi.mock("../audit/audit-service.js", () => ({ audit: (...a: unknown[]) => audit(...a) }));

const { canAccessThread, canAccessProjectDiscussions, resolveThreadProjectId } =
  await import("./access.js");

const developer = { id: "u-dev", role: "developer" as const };
const admin = { id: "u-admin", role: "admin" as const };

/** A live project in workspace `ws1`; `memberIds` hold a membership row. */
function workspaceProject(memberIds: string[], opts: { deleted?: boolean } = {}) {
  projectFindUnique.mockImplementation(
    async (args: {
      select?: { workspace?: { select?: { members?: { where?: { userId?: string } } } } };
    }) => {
      const asked = args.select?.workspace?.select?.members?.where?.userId;
      return {
        workspaceId: "ws1",
        workspace: {
          deletedAt: opts.deleted ? new Date() : null,
          members: asked && memberIds.includes(asked) ? [{ id: `m-${asked}` }] : [],
        },
      };
    },
  );
}

describe("canAccessThread (#734 — project-access seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1" });
    projectFindFirst.mockResolvedValue({ id: "p1" });
    readLiveWorkspaceIds.mockResolvedValue([]);
  });

  it("admits a workspace member who did NOT create the project", async () => {
    workspaceProject(["u-dev"]);
    readLiveWorkspaceIds.mockResolvedValue(["ws1"]);

    await expect(canAccessThread(developer, "t1")).resolves.toEqual({ ok: true, projectId: "p1" });
    expect(readLiveWorkspaceIds).toHaveBeenCalledWith("u-dev");
  });

  it("admits any authenticated user on a project with no workspace (as GET /projects/:id does)", async () => {
    projectFindUnique.mockResolvedValue({ workspaceId: null, workspace: null });

    await expect(canAccessThread(developer, "t1")).resolves.toEqual({ ok: true, projectId: "p1" });
  });

  it("denies a user outside the project's workspace, and audits it", async () => {
    workspaceProject(["someone-else"]);
    readLiveWorkspaceIds.mockResolvedValue(["ws-other"]);

    await expect(canAccessThread(developer, "t1")).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussion.thread.access.denied",
        metadata: expect.objectContaining({ reason: "project-access-denied", projectId: "p1" }),
      }),
    );
  });

  it("denies when the workspace claim names the workspace but the membership row is gone", async () => {
    workspaceProject([]);
    await expect(canAccessThread({ ...developer, workspaces: ["ws1"] }, "t1")).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("denies a member of a soft-deleted workspace", async () => {
    workspaceProject(["u-dev"], { deleted: true });
    readLiveWorkspaceIds.mockResolvedValue(["ws1"]);
    await expect(canAccessThread(developer, "t1")).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("uses a caller-supplied workspace claim instead of re-reading memberships", async () => {
    workspaceProject(["u-dev"]);
    await expect(canAccessThread({ ...developer, workspaces: ["ws1"] }, "t1")).resolves.toEqual({
      ok: true,
      projectId: "p1",
    });
    expect(readLiveWorkspaceIds).not.toHaveBeenCalled();
  });

  it("denies a non-admin on a soft-deleted project", async () => {
    projectFindFirst.mockResolvedValue(null);
    projectFindUnique.mockResolvedValue({ workspaceId: null, workspace: null });
    await expect(canAccessThread(developer, "t1")).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(projectFindFirst).toHaveBeenCalledWith({
      where: { id: "p1", deletedAt: null },
      select: { id: true },
    });
  });

  it("admits an admin without any project or membership lookup", async () => {
    await expect(canAccessThread(admin, "t1")).resolves.toEqual({ ok: true, projectId: "p1" });
    expect(projectFindUnique).not.toHaveBeenCalled();
    expect(readLiveWorkspaceIds).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error instead of turning it into a denial", async () => {
    projectFindUnique.mockRejectedValue(new Error("db down"));
    await expect(canAccessThread(developer, "t1")).rejects.toThrow("db down");
  });

  it("treats a missing or soft-deleted thread as not found (no project lookup, audited)", async () => {
    threadFindFirst.mockResolvedValue(null);

    await expect(canAccessThread(developer, "ghost")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(threadFindFirst).toHaveBeenCalledWith({
      where: { id: "ghost", deletedAt: null },
      select: { id: true, projectId: true },
    });
    expect(projectFindUnique).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussion.thread.access.denied",
        metadata: expect.objectContaining({ reason: "thread-not-found" }),
      }),
    );
  });
});

describe("canAccessProjectDiscussions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectFindFirst.mockResolvedValue({ id: "p1" });
    readLiveWorkspaceIds.mockResolvedValue([]);
  });

  it("audits a denial under the caller's action name when asked to", async () => {
    workspaceProject([]);
    await expect(
      canAccessProjectDiscussions(developer, "p1", {
        resource: "discussion_thread",
        resourceId: "p1",
        action: "discussion.thread.list",
      }),
    ).resolves.toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "discussion.thread.list.denied" }),
    );
  });

  it("does not audit when no audit context is given (a third-party eligibility check)", async () => {
    workspaceProject([]);
    await expect(canAccessProjectDiscussions(developer, "p1")).resolves.toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("resolveThreadProjectId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the projectId of a live thread", async () => {
    threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1" });
    await expect(resolveThreadProjectId("t1")).resolves.toBe("p1");
  });

  it("returns null for a missing / soft-deleted thread", async () => {
    threadFindFirst.mockResolvedValue(null);
    await expect(resolveThreadProjectId("ghost")).resolves.toBeNull();
  });
});
