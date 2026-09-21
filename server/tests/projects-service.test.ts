/**
 * Project service tests (Phase 5 / issue #38).
 *
 * Prisma is mocked in-memory. We exercise:
 *   - happy-path CRUD
 *   - lifecycle transitions (draft → active → archived)
 *   - "owner OR admin can archive" RBAC
 *   - archive-hook fan-out for vector-store cleanup
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  createdById: string;
  deletedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

const projects = new Map<string, MockProjectRow>();
let nextId = 0;

function reset(): void {
  projects.clear();
  nextId = 0;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        if (where.slug) {
          for (const p of projects.values()) if (p.slug === where.slug) return p;
          return null;
        }
        if (where.id) return projects.get(where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) => {
        const p = projects.get(where.id);
        if (!p || p.deletedAt) return null;
        return p;
      }),
      findMany: vi.fn(
        async ({
          where,
          take,
          skip,
        }: {
          where: Record<string, unknown>;
          take: number;
          skip: number;
        }) => {
          const all = [...projects.values()].filter(
            (p) => p.deletedAt === null && (!where.status || p.status === where.status),
          );
          return all.slice(skip, skip + take);
        },
      ),
      count: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          [...projects.values()].filter(
            (p) => p.deletedAt === null && (!where.status || p.status === where.status),
          ).length,
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<MockProjectRow, "id" | "createdAt" | "updatedAt" | "deletedAt">;
        }) => {
          nextId += 1;
          const row: MockProjectRow = {
            id: `proj_${nextId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            description: "",
            ...data,
          };
          projects.set(row.id, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MockProjectRow> }) => {
          const existing = projects.get(where.id);
          if (!existing) throw new Error(`record ${where.id} not found`);
          const next: MockProjectRow = {
            ...existing,
            ...data,
            updatedAt: new Date(),
          } as MockProjectRow;
          projects.set(where.id, next);
          return next;
        },
      ),
    },
  },
}));

import {
  ProjectError,
  __resetArchiveHooks,
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  onArchive,
  updateProject,
} from "../src/lib/projects/project-service.js";

const owner = { id: "user-owner", role: "developer" as const };
const admin = { id: "user-admin", role: "admin" as const };
const someoneElse = { id: "user-other", role: "developer" as const };
const reader = { id: "user-reader", role: "reader" as const };

beforeEach(() => {
  reset();
  __resetArchiveHooks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createProject", () => {
  it("creates a project with default status=draft", async () => {
    const p = await createProject({ name: "Alpha", slug: "alpha" }, owner);
    expect(p.status).toBe("draft");
    expect(p.createdById).toBe(owner.id);
    expect(p.slug).toBe("alpha");
  });

  it("rejects an invalid slug", async () => {
    await expect(createProject({ name: "X", slug: "Bad Slug" }, owner)).rejects.toThrow(
      ProjectError,
    );
  });

  it("rejects a duplicate slug with 409 SLUG_TAKEN", async () => {
    await createProject({ name: "A", slug: "x" }, owner);
    await expect(createProject({ name: "B", slug: "x" }, owner)).rejects.toMatchObject({
      code: "SLUG_TAKEN",
      status: 409,
    });
  });

  it("lowercases the slug", async () => {
    const p = await createProject({ name: "A", slug: "MixedCase" }, owner);
    expect(p.slug).toBe("mixedcase");
  });
});

describe("updateProject", () => {
  it("the project owner can update name + description", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    const updated = await updateProject({ id: p.id, name: "A2", description: "d" }, owner);
    expect(updated.name).toBe("A2");
    expect(updated.description).toBe("d");
  });

  it("an admin can update any project", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    const updated = await updateProject({ id: p.id, name: "by admin" }, admin);
    expect(updated.name).toBe("by admin");
  });

  it("a non-owner non-admin developer is rejected with 403", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    await expect(updateProject({ id: p.id, name: "nope" }, someoneElse)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("readers cannot mutate", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    await expect(updateProject({ id: p.id, name: "nope" }, reader)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects invalid lifecycle transitions (active → draft)", async () => {
    const p = await createProject({ name: "A", slug: "a", status: "active" }, owner);
    await expect(updateProject({ id: p.id, status: "draft" }, owner)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("permits draft → active", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    const u = await updateProject({ id: p.id, status: "active" }, owner);
    expect(u.status).toBe("active");
  });
});

describe("archiveProject", () => {
  it("archives when called by the owner and fires onArchive hooks", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    const hook = vi.fn();
    onArchive(hook);
    const archived = await archiveProject(p.id, owner);
    expect(archived.status).toBe("archived");
    expect(hook).toHaveBeenCalledWith(p.id);
  });

  it("archives when called by an admin", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    const archived = await archiveProject(p.id, admin);
    expect(archived.status).toBe("archived");
  });

  it("rejects archive by anyone else", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    await expect(archiveProject(p.id, someoneElse)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("is idempotent — already-archived returns the same project without firing hooks again", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    await archiveProject(p.id, owner);
    const hook = vi.fn();
    onArchive(hook);
    const second = await archiveProject(p.id, owner);
    expect(second.status).toBe("archived");
    expect(hook).not.toHaveBeenCalled();
  });

  it("hook failures don't break the archive", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    onArchive(() => {
      throw new Error("boom");
    });
    const archived = await archiveProject(p.id, owner);
    expect(archived.status).toBe("archived");
  });

  it("returns 404 for an unknown project", async () => {
    await expect(archiveProject("nope", admin)).rejects.toMatchObject({ status: 404 });
  });
});

describe("deleteProject", () => {
  it("soft-deletes (sets deletedAt) and triggers archive hooks", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    const hook = vi.fn();
    onArchive(hook);
    await deleteProject(p.id, owner);
    const after = await getProject(p.id);
    expect(after).toBeNull();
    expect(hook).toHaveBeenCalledWith(p.id);
  });

  it("rejects non-owners", async () => {
    const p = await createProject({ name: "A", slug: "a" }, owner);
    await expect(deleteProject(p.id, someoneElse)).rejects.toMatchObject({ status: 403 });
  });
});

describe("listProjects", () => {
  it("paginates and filters by status", async () => {
    await createProject({ name: "A", slug: "a" }, owner);
    await createProject({ name: "B", slug: "b", status: "active" }, owner);
    const list = await listProjects({ status: "active" });
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
  });
});

describe("aiProviderId override (issue #134)", () => {
  it("createProject persists a known provider key", async () => {
    const project = await createProject(
      { name: "P", slug: "ai-p1", aiProviderId: "bedrock-gateway" },
      owner,
    );
    expect((project as { aiProviderId?: string | null }).aiProviderId).toBe("bedrock-gateway");
  });

  it("createProject rejects an unknown provider key", async () => {
    await expect(
      createProject({ name: "P", slug: "ai-p2", aiProviderId: "totally-fake" }, owner),
    ).rejects.toBeInstanceOf(ProjectError);
  });

  it("createProject treats empty / null as 'use global default'", async () => {
    const a = await createProject({ name: "P", slug: "ai-p3", aiProviderId: null }, owner);
    expect((a as { aiProviderId?: string | null }).aiProviderId).toBeNull();
    const b = await createProject({ name: "P", slug: "ai-p4", aiProviderId: "   " }, owner);
    expect((b as { aiProviderId?: string | null }).aiProviderId).toBeNull();
  });

  it("updateProject changes the override and only writes when it changes", async () => {
    const created = await createProject({ name: "P", slug: "ai-up1" }, owner);
    const first = await updateProject({ id: created.id, aiProviderId: "openai" }, owner);
    expect((first as { aiProviderId?: string | null }).aiProviderId).toBe("openai");
    // Re-applying the same value should be a no-op (no provider field in
    // the diff).
    const second = await updateProject({ id: created.id, aiProviderId: "openai" }, owner);
    expect((second as { aiProviderId?: string | null }).aiProviderId).toBe("openai");
  });

  it("updateProject can clear the override by passing null", async () => {
    const created = await createProject(
      { name: "P", slug: "ai-up2", aiProviderId: "azure" },
      owner,
    );
    const cleared = await updateProject({ id: created.id, aiProviderId: null }, owner);
    expect((cleared as { aiProviderId?: string | null }).aiProviderId).toBeNull();
  });

  it("updateProject rejects an unknown provider key", async () => {
    const created = await createProject({ name: "P", slug: "ai-up3" }, owner);
    await expect(
      updateProject({ id: created.id, aiProviderId: "totally-fake" }, owner),
    ).rejects.toBeInstanceOf(ProjectError);
  });
});

describe("aiModel override (v1.2.0)", () => {
  it("createProject persists a free-form model id", async () => {
    const project = await createProject(
      {
        name: "P",
        slug: "ai-m1",
        aiModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      },
      owner,
    );
    expect((project as { aiModel?: string | null }).aiModel).toBe(
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
  });

  it("createProject treats empty / whitespace / null as 'use global default'", async () => {
    const a = await createProject({ name: "P", slug: "ai-m2", aiModel: null }, owner);
    expect((a as { aiModel?: string | null }).aiModel).toBeNull();
    const b = await createProject({ name: "P", slug: "ai-m3", aiModel: "" }, owner);
    expect((b as { aiModel?: string | null }).aiModel).toBeNull();
    const c = await createProject({ name: "P", slug: "ai-m4", aiModel: "   " }, owner);
    expect((c as { aiModel?: string | null }).aiModel).toBeNull();
  });

  it("createProject rejects oversize model ids (> 200 chars)", async () => {
    await expect(
      createProject({ name: "P", slug: "ai-m5", aiModel: "x".repeat(201) }, owner),
    ).rejects.toBeInstanceOf(ProjectError);
  });

  it("updateProject sets, changes, and clears the override", async () => {
    const created = await createProject({ name: "P", slug: "ai-m-up1" }, owner);
    const set = await updateProject(
      { id: created.id, aiModel: "anthropic.claude-3-5-sonnet" },
      owner,
    );
    expect((set as { aiModel?: string | null }).aiModel).toBe("anthropic.claude-3-5-sonnet");
    const changed = await updateProject(
      { id: created.id, aiModel: "anthropic.claude-3-7-sonnet" },
      owner,
    );
    expect((changed as { aiModel?: string | null }).aiModel).toBe("anthropic.claude-3-7-sonnet");
    const cleared = await updateProject({ id: created.id, aiModel: null }, owner);
    expect((cleared as { aiModel?: string | null }).aiModel).toBeNull();
  });

  it("updateProject rejects oversize model ids", async () => {
    const created = await createProject({ name: "P", slug: "ai-m-up2" }, owner);
    await expect(
      updateProject({ id: created.id, aiModel: "y".repeat(201) }, owner),
    ).rejects.toBeInstanceOf(ProjectError);
  });

  it("updateProject rejects non-string aiModel", async () => {
    const created = await createProject({ name: "P", slug: "ai-m-up3" }, owner);
    await expect(
      updateProject({ id: created.id, aiModel: 42 as unknown as string }, owner),
    ).rejects.toBeInstanceOf(ProjectError);
  });
});
