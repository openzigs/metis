/**
 * Issue #533 — Unit tests for getUserAccessibleProjects.
 * Issue #1052 (F4) — workspace scoping regression tests. The helper used to
 * ignore its `userId` argument entirely and return EVERY non-archived project
 * in the deployment; these tests pin the workspace-membership scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getUserAccessibleProjects,
  getUserArchivedProjects,
  getUserProjectScope,
} from "./accessible-projects.js";

vi.mock("../prisma.js", () => ({
  prisma: {
    project: {
      findMany: vi.fn(),
    },
    userRole: {
      findFirst: vi.fn(),
    },
    workspaceMember: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "../prisma.js";

const mockFindMany = vi.mocked(prisma.project.findMany);
const mockUserRole = vi.mocked(prisma.userRole.findFirst);
const mockMemberships = vi.mocked(prisma.workspaceMember.findMany);

/** Configure the DB-resolved actor for the user under test. */
function actor(role: string | null, workspaceIds: string[]): void {
  mockUserRole.mockResolvedValue((role ? { role: { key: role } } : null) as never);
  mockMemberships.mockResolvedValue(workspaceIds.map((workspaceId) => ({ workspaceId })) as never);
}

describe("getUserAccessibleProjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actor("reader", []);
    mockFindMany.mockResolvedValue([] as never);
  });

  it("returns empty array for empty userId", async () => {
    const result = await getUserAccessibleProjects("");
    expect(result).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("scopes a non-admin to their workspace memberships (plus open projects)", async () => {
    actor("reader", ["ws-b"]);
    mockFindMany.mockResolvedValue([{ id: "proj-b", name: "Beta" }] as never);

    const result = await getUserAccessibleProjects("user-b");

    expect(mockUserRole).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-b" } }),
    );
    expect(mockMemberships).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-b",
          workspace: { deletedAt: null },
          // #612 — a deprovisioned user's surviving membership rows do not count.
          user: { deletedAt: null, status: "active" },
        },
      }),
    );
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: { not: "archived" },
        OR: [
          { workspaceId: null },
          {
            workspaceId: { in: ["ws-b"] },
            workspace: { deletedAt: null, members: { some: { userId: "user-b" } } },
          },
        ],
      },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(result).toEqual([{ id: "proj-b", name: "Beta" }]);
  });

  it("still matches workspace-less (pre-migration) projects for a user with no memberships", async () => {
    actor("reader", []);
    mockFindMany.mockResolvedValue([{ id: "proj-open", name: "Legacy" }] as never);

    const result = await getUserAccessibleProjects("user-none");

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { workspaceId: null },
            {
              workspaceId: { in: [] },
              workspace: { deletedAt: null, members: { some: { userId: "user-none" } } },
            },
          ],
        }),
      }),
    );
    expect(result).toEqual([{ id: "proj-open", name: "Legacy" }]);
  });

  it("lets system admins bypass workspace scoping", async () => {
    actor("admin", []);
    mockFindMany.mockResolvedValue([
      { id: "proj-a", name: "Alpha" },
      { id: "proj-b", name: "Beta" },
    ] as never);

    const result = await getUserAccessibleProjects("user-admin");

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { deletedAt: null, status: { not: "archived" } },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(result).toHaveLength(2);
  });

  it("falls back to the least-privileged role when the user has no role row", async () => {
    actor(null, ["ws-b"]);
    mockFindMany.mockResolvedValue([] as never);

    await getUserAccessibleProjects("user-unassigned");

    // No admin bypass for an unassigned user — the workspace OR clause is present.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { workspaceId: null },
            {
              workspaceId: { in: ["ws-b"] },
              workspace: { deletedAt: null, members: { some: { userId: "user-unassigned" } } },
            },
          ],
        }),
      }),
    );
  });

  it("excludes deleted and archived projects", async () => {
    actor("reader", ["ws-b"]);
    await getUserAccessibleProjects("user-b");
    const where = mockFindMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where.deletedAt).toBeNull();
    expect(where.status).toEqual({ not: "archived" });
  });

  it("returns empty array when no projects match", async () => {
    actor("reader", ["ws-b"]);
    mockFindMany.mockResolvedValue([] as never);
    const result = await getUserAccessibleProjects("user-b");
    expect(result).toEqual([]);
  });
});

describe("getUserArchivedProjects (#2264)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([] as never);
  });

  it("reads only the requested archived projects, under the same workspace scope", async () => {
    actor("reader", ["ws-b"]);
    mockFindMany.mockResolvedValue([{ id: "proj-old", name: "Old" }] as never);

    const result = await getUserArchivedProjects("user-b", ["proj-old", "proj-x"]);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { workspaceId: null },
          {
            workspaceId: { in: ["ws-b"] },
            workspace: { deletedAt: null, members: { some: { userId: "user-b" } } },
          },
        ],
        id: { in: ["proj-old", "proj-x"] },
        status: "archived",
      },
      select: { id: true, name: true },
    });
    expect(result).toEqual([{ id: "proj-old", name: "Old" }]);
  });

  it("reads nothing for no ids or no user", async () => {
    expect(await getUserArchivedProjects("user-b", [])).toEqual([]);
    expect(await getUserArchivedProjects("", ["proj-old"])).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe("getUserProjectScope (#2264)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([] as never);
  });

  it("reads the live and the archived projects for one resolution of the caller", async () => {
    actor("reader", ["ws-b"]);
    mockFindMany
      .mockResolvedValueOnce([{ id: "proj-b", name: "B" }] as never)
      .mockResolvedValueOnce([{ id: "proj-old", name: "Old" }] as never);

    const scope = await getUserProjectScope("user-b");
    const archived = await scope.archived(["proj-old"]);

    expect(scope.accessible).toEqual([{ id: "proj-b", name: "B" }]);
    expect(archived).toEqual([{ id: "proj-old", name: "Old" }]);
    expect(mockUserRole).toHaveBeenCalledTimes(1);
    expect(mockMemberships).toHaveBeenCalledTimes(1);
    const where = (n: number) => (mockFindMany.mock.calls[n]![0] as { where: unknown }).where;
    expect(where(0)).toMatchObject({ status: { not: "archived" } });
    expect(where(1)).toMatchObject({ id: { in: ["proj-old"] }, status: "archived" });
  });

  it("reads nothing for no user, and no archived read for no ids", async () => {
    const none = await getUserProjectScope("");
    expect(none.accessible).toEqual([]);
    expect(await none.archived(["proj-old"])).toEqual([]);
    actor("reader", ["ws-b"]);
    expect(await (await getUserProjectScope("user-b")).archived([])).toEqual([]);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockUserRole).toHaveBeenCalledTimes(1);
  });
});
