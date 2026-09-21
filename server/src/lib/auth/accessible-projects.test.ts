/**
 * Issue #533 — Unit tests for getUserAccessibleProjects.
 * Issue #1052 (F4) — workspace scoping regression tests. The helper used to
 * ignore its `userId` argument entirely and return EVERY non-archived project
 * in the deployment; these tests pin the workspace-membership scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUserAccessibleProjects } from "./accessible-projects.js";

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
      expect.objectContaining({ where: { userId: "user-b" } }),
    );
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: { not: "archived" },
        OR: [{ workspaceId: null }, { workspaceId: { in: ["ws-b"] } }],
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
          OR: [{ workspaceId: null }, { workspaceId: { in: [] } }],
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
          OR: [{ workspaceId: null }, { workspaceId: { in: ["ws-b"] } }],
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
