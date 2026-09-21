/**
 * Workspace-membership access guard tests — Epic #295 Phase 4 (#307/#309).
 *
 * THE critical tenant-isolation concern of this phase: a user who is a member of
 * workspace A must NEVER see workspace B's resources / objects / projects. These
 * tests prove the cross-workspace denial path (404, never 403, with audit) and
 * the project-access INTERSECTION inside a shared workspace. Prisma + audit are
 * fully mocked — no real DB (the #289 stale-DB lesson).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn() }));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditMock }));

import {
  actorIsWorkspaceMember,
  assertWorkspaceAccessible,
  listAccessibleProjectsInWorkspace,
  listAccessibleWorkspaceIds,
  type AccessPrisma,
} from "../src/lib/cross-project/cross-project-access.js";
import type { SchedulerActor } from "../src/lib/scheduler/project-access.js";

const MEMBER: SchedulerActor = { id: "user-1", role: "member" };
const ADMIN: SchedulerActor = { id: "admin-1", role: "admin" };

/**
 * In-memory Prisma double. `members` maps workspaceId -> userIds; `projects`
 * maps projectId -> { workspaceId, createdById }.
 */
function makeFakePrisma(seed: {
  members: Record<string, string[]>;
  projects: Record<string, { workspaceId: string | null; createdById: string }>;
}): AccessPrisma {
  return {
    workspaceMember: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: (async ({ where }: any) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        return (seed.members[workspaceId] ?? []).includes(userId)
          ? { id: `${workspaceId}:${userId}` }
          : null;
      }) as AccessPrisma["workspaceMember"]["findUnique"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: (async ({ where }: any) => {
        const out: { workspaceId: string }[] = [];
        for (const [ws, users] of Object.entries(seed.members)) {
          if (users.includes(where.userId)) out.push({ workspaceId: ws });
        }
        return out;
      }) as AccessPrisma["workspaceMember"]["findMany"],
    } as AccessPrisma["workspaceMember"],
    project: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: (async ({ where, distinct }: any) => {
        let rows = Object.entries(seed.projects).map(([id, p]) => ({ id, ...p }));
        if (where?.workspaceId?.not !== undefined) rows = rows.filter((p) => p.workspaceId != null);
        if (typeof where?.workspaceId === "string")
          rows = rows.filter((p) => p.workspaceId === where.workspaceId);
        if (where?.createdById) rows = rows.filter((p) => p.createdById === where.createdById);
        if (distinct?.includes("workspaceId")) {
          const seen = new Set<string | null>();
          rows = rows.filter((p) =>
            seen.has(p.workspaceId) ? false : (seen.add(p.workspaceId), true),
          );
        }
        return rows.map((p) => ({
          id: p.id,
          workspaceId: p.workspaceId,
          createdById: p.createdById,
        }));
      }) as AccessPrisma["project"]["findMany"],
    } as AccessPrisma["project"],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("actorIsWorkspaceMember", () => {
  it("is true for a member, false for a non-member", async () => {
    const db = makeFakePrisma({ members: { wsA: ["user-1"] }, projects: {} });
    expect(await actorIsWorkspaceMember(MEMBER, "wsA", db)).toBe(true);
    expect(await actorIsWorkspaceMember(MEMBER, "wsB", db)).toBe(false);
  });

  it("is always true for a system admin without a membership row", async () => {
    const db = makeFakePrisma({ members: {}, projects: {} });
    expect(await actorIsWorkspaceMember(ADMIN, "wsZ", db)).toBe(true);
  });
});

describe("assertWorkspaceAccessible — cross-workspace denial", () => {
  it("passes for a workspace the actor belongs to", async () => {
    const db = makeFakePrisma({ members: { wsA: ["user-1"] }, projects: {} });
    await expect(assertWorkspaceAccessible(MEMBER, "wsA", db)).resolves.toBeUndefined();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("DENIES a workspace the actor is NOT a member of with 404 (no leak) + audit", async () => {
    const db = makeFakePrisma({ members: { wsA: ["user-1"] }, projects: {} });
    await expect(assertWorkspaceAccessible(MEMBER, "wsB", db)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cross-project.workspace.access.denied",
        target: { type: "workspace", id: "wsB" },
        metadata: expect.objectContaining({ reason: "workspace-membership-missing" }),
      }),
    );
  });
});

describe("listAccessibleWorkspaceIds", () => {
  it("returns only the member's workspaces for a non-admin", async () => {
    const db = makeFakePrisma({
      members: { wsA: ["user-1"], wsB: ["other"], wsC: ["user-1", "other"] },
      projects: {},
    });
    const ids = await listAccessibleWorkspaceIds(MEMBER, db);
    expect(new Set(ids)).toEqual(new Set(["wsA", "wsC"]));
    expect(ids).not.toContain("wsB");
  });

  it("returns every workspace with projects for an admin", async () => {
    const db = makeFakePrisma({
      members: {},
      projects: {
        p1: { workspaceId: "wsA", createdById: "x" },
        p2: { workspaceId: "wsB", createdById: "y" },
        p3: { workspaceId: null, createdById: "z" },
      },
    });
    const ids = await listAccessibleWorkspaceIds(ADMIN, db);
    expect(new Set(ids)).toEqual(new Set(["wsA", "wsB"]));
  });
});

describe("listAccessibleProjectsInWorkspace — project INTERSECTION inside a workspace", () => {
  it("returns only projects the non-admin both owns AND that are in the workspace", async () => {
    const db = makeFakePrisma({
      members: { wsA: ["user-1"] },
      projects: {
        // user-1 owns p1 (in wsA) -> visible
        p1: { workspaceId: "wsA", createdById: "user-1" },
        // sibling p2 in wsA but owned by someone else -> NOT visible (intersection)
        p2: { workspaceId: "wsA", createdById: "other" },
        // p3 owned by user-1 but in a different workspace -> not in this query
        p3: { workspaceId: "wsB", createdById: "user-1" },
      },
    });
    const ids = await listAccessibleProjectsInWorkspace(MEMBER, "wsA", db);
    expect(ids).toEqual(["p1"]);
  });

  it("returns ALL workspace projects for an admin", async () => {
    const db = makeFakePrisma({
      members: {},
      projects: {
        p1: { workspaceId: "wsA", createdById: "a" },
        p2: { workspaceId: "wsA", createdById: "b" },
        p3: { workspaceId: "wsB", createdById: "c" },
      },
    });
    const ids = await listAccessibleProjectsInWorkspace(ADMIN, "wsA", db);
    expect(new Set(ids)).toEqual(new Set(["p1", "p2"]));
  });

  it("DENIES (404) when a non-member asks for a workspace's projects", async () => {
    const db = makeFakePrisma({
      members: { wsA: ["user-1"] },
      projects: { p1: { workspaceId: "wsB", createdById: "other" } },
    });
    await expect(listAccessibleProjectsInWorkspace(MEMBER, "wsB", db)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
