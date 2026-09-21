/**
 * scheduler/project-access — RBAC primitives used by the scheduler/tasks
 * routes and the SchedulerService for defence-in-depth (review fixes H1/H2/H3).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const projects = new Map<
  string,
  { id: string; createdById: string | null; deletedAt: Date | null }
>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findMany: vi.fn(
        async ({ where }: { where?: { createdById?: string; deletedAt?: null } } = {}) => {
          return Array.from(projects.values()).filter((p) => {
            if (where?.deletedAt === null && p.deletedAt) return false;
            if (where?.createdById && p.createdById !== where.createdById) return false;
            return true;
          });
        },
      ),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  actorCanAccessProject,
  buildProjectAccessWhere,
  isAdminActor,
  listAccessibleProjectIds,
} from "../src/lib/scheduler/project-access.js";
import { audit } from "../src/lib/audit/audit-service.js";

afterEach(() => {
  projects.clear();
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

  it("returns an OR fragment scoping to owned projects + null", async () => {
    projects.set("p1", { id: "p1", createdById: "u1", deletedAt: null });
    projects.set("p2", { id: "p2", createdById: "u2", deletedAt: null });
    const w = await buildProjectAccessWhere({ id: "u1", role: "developer" });
    expect(w).toEqual({ OR: [{ projectId: null }, { projectId: { in: ["p1"] } }] });
  });

  it("listAccessibleProjectIds respects soft-deleted projects", async () => {
    projects.set("p1", { id: "p1", createdById: "u1", deletedAt: null });
    projects.set("p2", { id: "p2", createdById: "u1", deletedAt: new Date() });
    const ids = await listAccessibleProjectIds({ id: "u1", role: "developer" });
    expect(ids).toEqual(["p1"]);
  });

  it("admin actorCanAccessProject is always true and skips audits", async () => {
    const ok = await actorCanAccessProject({ id: "admin", role: "admin" }, "any", {
      resource: "scheduled-job",
      resourceId: "x",
      action: "scheduled-job.read",
    });
    expect(ok).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it("non-admin actorCanAccessProject allows access to owned project", async () => {
    projects.set("p1", { id: "p1", createdById: "u1", deletedAt: null });
    const ok = await actorCanAccessProject({ id: "u1", role: "developer" }, "p1", {
      resource: "scheduled-job",
      resourceId: "x",
      action: "scheduled-job.read",
    });
    expect(ok).toBe(true);
  });

  it("non-admin actorCanAccessProject denies + audits L2", async () => {
    projects.set("p1", { id: "p1", createdById: "u1", deletedAt: null });
    const ok = await actorCanAccessProject({ id: "intruder", role: "developer" }, "p1", {
      resource: "scheduled-job",
      resourceId: "j1",
      action: "scheduled-job.read",
    });
    expect(ok).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "scheduled-job.read.denied",
        actor: { id: "intruder" },
      }),
    );
  });

  it("system-wide rows (projectId=null) are admin-only", async () => {
    const ok = await actorCanAccessProject({ id: "u1", role: "developer" }, null, {
      resource: "scheduled-job",
      resourceId: "x",
      action: "scheduled-job.read",
    });
    expect(ok).toBe(false);
  });
});
