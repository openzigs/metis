/**
 * scheduler/project-access — RBAC primitives used by the scheduler/tasks
 * routes and the SchedulerService for defence-in-depth (review fixes H1/H2/H3).
 *
 * #1221 — `actorHasProjectAccess` and `buildProjectAccessWhere` follow the
 * project-access rule (workspace members, not only the creator). The
 * in-memory database below models the rows that rule reads: projects with a
 * workspace and a creator, and live workspace memberships.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

interface ProjectRow {
  id: string;
  createdById: string | null;
  workspaceId: string | null;
  deletedAt: Date | null;
}
const projects = new Map<string, ProjectRow>();
/** userId → workspace ids (live memberships). */
const members = new Map<string, string[]>();

type Where = Record<string, unknown>;
const isMember = (userId: string, workspaceId: string | null) =>
  workspaceId != null && (members.get(userId) ?? []).includes(workspaceId);

/** Evaluate the subset of Prisma `where` shapes the helpers under test build. */
function matchesProject(p: ProjectRow, where: Where = {}): boolean {
  if (where.deletedAt === null && p.deletedAt) return false;
  if (typeof where.createdById === "string" && p.createdById !== where.createdById) return false;
  if (Array.isArray(where.OR)) {
    return (where.OR as Where[]).some((clause) => {
      if (clause.workspaceId === null) return p.workspaceId === null;
      const inList = (clause.workspaceId as { in: string[] }).in;
      const userId = (clause.workspace as { members: { some: { userId: string } } }).members.some
        .userId;
      return (
        p.workspaceId != null && inList.includes(p.workspaceId) && isMember(userId, p.workspaceId)
      );
    });
  }
  return true;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findMany: vi.fn(async ({ where }: { where?: Where } = {}) =>
        Array.from(projects.values()).filter((p) => matchesProject(p, where)),
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const p = projects.get(where.id as string);
        return p && matchesProject(p, where) ? { id: p.id } : null;
      }),
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { id: string };
          select: { workspace: { select: { members: { where: { userId: string } } } } };
        }) => {
          const p = projects.get(where.id);
          if (!p) return null;
          const userId = select.workspace.select.members.where.userId;
          return {
            workspaceId: p.workspaceId,
            workspace: p.workspaceId
              ? {
                  deletedAt: null,
                  members: isMember(userId, p.workspaceId) ? [{ id: "m" }] : [],
                }
              : null,
          };
        },
      ),
    },
    workspaceMember: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        (members.get(where.userId) ?? []).map((workspaceId) => ({ workspaceId })),
      ),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  actorHasProjectAccess,
  buildProjectAccessWhere,
  isAdminActor,
  listAccessibleProjectIds,
  listMemberAccessibleProjectIds,
} from "../src/lib/scheduler/project-access.js";
import { audit } from "../src/lib/audit/audit-service.js";

const CTX = { resource: "scheduled-job", resourceId: "j1", action: "scheduled-job.read" };

/** p1 in ws1 created by alice; bob is the other ws1 member; mallory is in ws2. */
function seedTeam() {
  projects.set("p1", { id: "p1", createdById: "alice", workspaceId: "ws1", deletedAt: null });
  projects.set("p2", { id: "p2", createdById: "mallory", workspaceId: "ws2", deletedAt: null });
  members.set("alice", ["ws1"]);
  members.set("bob", ["ws1"]);
  members.set("mallory", ["ws2"]);
}

afterEach(() => {
  projects.clear();
  members.clear();
  vi.clearAllMocks();
});

describe("project-access helpers", () => {
  it("recognises admin actors", () => {
    expect(isAdminActor({ id: "a", role: "admin" })).toBe(true);
    expect(isAdminActor({ id: "b", role: "developer" })).toBe(false);
  });

  it("returns an empty where fragment for admin (matches everything)", async () => {
    const w = await buildProjectAccessWhere({ id: "a", role: "admin" });
    expect(w).toEqual({});
  });

  it("#1221 — the list fragment scopes to the workspace's projects + system rows, for a member who did not create them", async () => {
    seedTeam();
    const w = await buildProjectAccessWhere({ id: "bob", role: "developer" });
    expect(w).toEqual({ OR: [{ projectId: null }, { projectId: { in: ["p1"] } }] });
    const outsider = await buildProjectAccessWhere({ id: "mallory", role: "developer" });
    expect(outsider).toEqual({ OR: [{ projectId: null }, { projectId: { in: ["p2"] } }] });
  });

  it("listMemberAccessibleProjectIds drops soft-deleted projects and keeps legacy workspace-less ones", async () => {
    seedTeam();
    projects.set("p-dead", {
      id: "p-dead",
      createdById: "bob",
      workspaceId: "ws1",
      deletedAt: new Date(),
    });
    projects.set("p-legacy", {
      id: "p-legacy",
      createdById: "x",
      workspaceId: null,
      deletedAt: null,
    });
    const ids = await listMemberAccessibleProjectIds({ id: "bob", role: "reader" });
    expect(ids.sort()).toEqual(["p-legacy", "p1"]);
  });

  it("listMemberAccessibleProjectIds gives an admin every live project", async () => {
    seedTeam();
    const ids = await listMemberAccessibleProjectIds({ id: "root", role: "admin" });
    expect(ids.sort()).toEqual(["p1", "p2"]);
  });

  it("listAccessibleProjectIds (creator-only, remaining callers) respects soft-deleted projects", async () => {
    projects.set("p1", { id: "p1", createdById: "u1", workspaceId: null, deletedAt: null });
    projects.set("p2", { id: "p2", createdById: "u1", workspaceId: null, deletedAt: new Date() });
    const ids = await listAccessibleProjectIds({ id: "u1", role: "developer" });
    expect(ids).toEqual(["p1"]);
    expect(await listAccessibleProjectIds({ id: "root", role: "admin" })).toEqual(["p1"]);
  });

  it("admin actorHasProjectAccess is always true and skips audits", async () => {
    const ok = await actorHasProjectAccess({ id: "admin", role: "admin" }, "any", CTX);
    expect(ok).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it("the creator and a second workspace member (not the creator) both pass", async () => {
    seedTeam();
    expect(await actorHasProjectAccess({ id: "alice", role: "developer" }, "p1", CTX)).toBe(true);
    expect(await actorHasProjectAccess({ id: "bob", role: "reader" }, "p1", CTX)).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a non-member is denied + audited (L2)", async () => {
    seedTeam();
    const ok = await actorHasProjectAccess({ id: "mallory", role: "developer" }, "p1", CTX);
    expect(ok).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "scheduled-job.read.denied",
        actor: { id: "mallory" },
        target: { type: "scheduled-job", id: "j1" },
      }),
    );
  });

  it("a soft-deleted project is closed to its own members", async () => {
    seedTeam();
    projects.get("p1")!.deletedAt = new Date();
    expect(await actorHasProjectAccess({ id: "alice", role: "developer" }, "p1", CTX)).toBe(false);
  });

  it("system-wide rows (projectId=null) are admin-only", async () => {
    const ok = await actorHasProjectAccess({ id: "u1", role: "developer" }, null, CTX);
    expect(ok).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { reason: "system-row-denied", projectId: null } }),
    );
  });
});
