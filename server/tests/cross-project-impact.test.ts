/**
 * Cross-project usage + impact query tests — Epic #295 Phase 4 (#309).
 *
 * TENANT ISOLATION is the critical concern: these tests PROVE a member of
 * workspace A cannot see workspace B's objects/usage/projects (cross-workspace
 * denial -> 404, no leak), and that sibling projects are intersected with the
 * caller's accessible set even inside a shared workspace. Prisma + audit fully
 * mocked — deterministic, no real DB (the #289 lesson).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  crossProjectImpact,
  whichProjectsUseObject,
  type CrossImpactPrisma,
} from "../src/lib/cross-project/cross-project-impact.js";
import type { SchedulerActor } from "../src/lib/scheduler/project-access.js";

const MEMBER_A: SchedulerActor = { id: "user-A", role: "member" };
const ADMIN: SchedulerActor = { id: "admin", role: "admin" };

/**
 * Seed shape. `members`: workspaceId -> userIds. `projects`: id -> {workspaceId,
 * createdById}. `resources`: id -> workspaceId. `identities`: rows.
 * `classifications`: per-project usage rows.
 */
interface Seed {
  members: Record<string, string[]>;
  projects: Record<string, { workspaceId: string | null; createdById: string; name?: string }>;
  resources: Record<string, string>; // resourceId -> workspaceId
  identities: {
    id: string;
    databaseResourceId: string;
    schemaName: string | null;
    objectName: string;
    objectType: string;
    usageClass?: string | null;
  }[];
  classifications: {
    projectId: string;
    kind: string;
    tableName: string;
    columnName: string | null;
    usageClass: string;
    evidence: string;
  }[];
}

function makeFakePrisma(seed: Seed): CrossImpactPrisma {
  return {
    workspaceMember: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        return (seed.members[workspaceId] ?? []).includes(userId) ? { id: "m" } : null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) =>
        Object.entries(seed.members)
          .filter(([, users]) => users.includes(where.userId))
          .map(([ws]) => ({ workspaceId: ws })),
    },
    project: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => {
        const p = seed.projects[where.id];
        return p ? { workspaceId: p.workspaceId } : null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) => {
        const p = seed.projects[where.id];
        if (!p) return null;
        if (where.createdById && p.createdById !== where.createdById) return null;
        return { id: where.id };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        let rows = Object.entries(seed.projects).map(([id, p]) => ({ id, ...p }));
        if (typeof where?.workspaceId === "string")
          rows = rows.filter((p) => p.workspaceId === where.workspaceId);
        if (where?.id?.in) rows = rows.filter((p) => where.id.in.includes(p.id));
        return rows.map((p) => ({
          id: p.id,
          workspaceId: p.workspaceId,
          createdById: p.createdById,
          // Intentionally pass through undefined when a seed omits `name`, so the
          // service's `nameById.get() ?? projectId` fallback is exercised.
          name: p.name,
        }));
      },
    },
    databaseResource: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) =>
        Object.entries(seed.resources)
          .filter(([, ws]) => ws === where.workspaceId)
          .map(([id]) => ({ id })),
    },
    schemaObjectIdentity: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) =>
        seed.identities.find(
          (i) =>
            where.databaseResourceId.in.includes(i.databaseResourceId) &&
            i.schemaName === where.schemaName &&
            i.objectName === where.objectName &&
            i.objectType === where.objectType,
        ) ?? null,
    },
    schemaUsageClassification: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) =>
        seed.classifications.filter((c) => {
          if (where.projectId?.in && !where.projectId.in.includes(c.projectId)) return false;
          if (
            where.projectId &&
            typeof where.projectId === "string" &&
            c.projectId !== where.projectId
          )
            return false;
          // `tableName` may be a string equality (single-object query) or an
          // `{ in: [...] }` set (the batched cross-project query).
          if (where.tableName?.in && !where.tableName.in.includes(c.tableName)) return false;
          if (typeof where.tableName === "string" && c.tableName !== where.tableName) return false;
          return true;
        }),
    },
  } as unknown as CrossImpactPrisma;
}

function baseSeed(): Seed {
  return {
    members: { wsA: ["user-A"], wsB: ["user-B"] },
    projects: {
      pA1: { workspaceId: "wsA", createdById: "user-A", name: "Alpha" },
      pA2: { workspaceId: "wsA", createdById: "user-A", name: "Beta" },
      pB1: { workspaceId: "wsB", createdById: "user-B", name: "Gamma" },
    },
    resources: { resA: "wsA", resB: "wsB" },
    identities: [
      {
        id: "idA",
        databaseResourceId: "resA",
        schemaName: "public",
        objectName: "orders",
        objectType: "table",
      },
      {
        id: "idB",
        databaseResourceId: "resB",
        schemaName: "public",
        objectName: "orders",
        objectType: "table",
      },
    ],
    classifications: [
      {
        projectId: "pA1",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: '[{"x":1},{"y":2}]',
      },
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "unreferenced",
        evidence: "[]",
      },
      {
        projectId: "pB1",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: '[{"z":1}]',
      },
    ],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("whichProjectsUseObject", () => {
  it("lists the workspace's projects that use the object with usage + evidence", async () => {
    const db = makeFakePrisma(baseSeed());
    const res = await whichProjectsUseObject(
      MEMBER_A,
      "wsA",
      { objectName: "orders", schemaName: "public", objectType: "table" },
      db,
    );
    expect(res.identity.id).toBe("idA");
    expect(res.projects.map((p) => p.projectId).sort()).toEqual(["pA1", "pA2"]);
    // pA1 used with 2 evidence sorts before pA2 unreferenced with 0.
    expect(res.projects[0]).toMatchObject({
      projectId: "pA1",
      usageClass: "used",
      evidenceCount: 2,
    });
    expect(res.rollupUsageClass).toBe("used");
    // NEVER includes workspace B's project.
    expect(res.projects.map((p) => p.projectId)).not.toContain("pB1");
  });

  it("CROSS-WORKSPACE DENIAL: a member of A asking about workspace B gets 404 (no leak)", async () => {
    const db = makeFakePrisma(baseSeed());
    await expect(
      whichProjectsUseObject(MEMBER_A, "wsB", { objectName: "orders", schemaName: "public" }, db),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404 when the object has no identity in the (authorized) workspace", async () => {
    const db = makeFakePrisma(baseSeed());
    await expect(
      whichProjectsUseObject(MEMBER_A, "wsA", { objectName: "ghost", schemaName: "public" }, db),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("404 when the authorized workspace has NO database resources at all", async () => {
    const seed = baseSeed();
    seed.resources = {}; // wsA exists + member, but no resources => no identities
    const db = makeFakePrisma(seed);
    await expect(
      whichProjectsUseObject(MEMBER_A, "wsA", { objectName: "orders", schemaName: "public" }, db),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("resolves a bare object name (no schema) via the null-schema branch", async () => {
    const seed = baseSeed();
    seed.identities.push({
      id: "idBare",
      databaseResourceId: "resA",
      schemaName: null,
      objectName: "audit_log",
      objectType: "table",
    });
    seed.classifications.push({
      projectId: "pA1",
      kind: "table",
      tableName: "audit_log",
      columnName: null,
      usageClass: "used",
      evidence: "[]",
    });
    const db = makeFakePrisma(seed);
    const res = await whichProjectsUseObject(MEMBER_A, "wsA", { objectName: "audit_log" }, db);
    expect(res.identity.id).toBe("idBare");
    expect(res.identity.schemaName).toBeNull();
  });

  it("admin can query workspace B and sees only B's projects for the object", async () => {
    const db = makeFakePrisma(baseSeed());
    const res = await whichProjectsUseObject(
      ADMIN,
      "wsB",
      { objectName: "orders", schemaName: "public" },
      db,
    );
    expect(res.identity.id).toBe("idB");
    expect(res.projects.map((p) => p.projectId)).toEqual(["pB1"]);
  });
});

describe("crossProjectImpact", () => {
  it("aggregates the OTHER projects in the workspace that use the source's objects", async () => {
    const db = makeFakePrisma(baseSeed());
    const res = await crossProjectImpact(MEMBER_A, "pA1", db);
    expect(res.workspaceId).toBe("wsA");
    expect(res.affectedObjects).toHaveLength(1);
    const obj = res.affectedObjects[0];
    expect(obj).toMatchObject({ objectName: "orders", schemaName: "public", objectType: "table" });
    // pA2 (sibling in wsA) uses it; the source pA1 is excluded; pB1 is in wsB.
    expect(obj.alsoUsedByProjects.map((p) => p.projectId)).toEqual(["pA2"]);
  });

  it("CROSS-WORKSPACE ISOLATION: never surfaces a sibling from another workspace", async () => {
    const seed = baseSeed();
    // Add a wsB project that also uses public.orders — must NOT leak into wsA impact.
    seed.classifications.push({
      projectId: "pB1",
      kind: "table",
      tableName: "public.orders",
      columnName: null,
      usageClass: "used",
      evidence: "[]",
    });
    const db = makeFakePrisma(seed);
    const res = await crossProjectImpact(MEMBER_A, "pA1", db);
    const everyProject = res.affectedObjects.flatMap((o) =>
      o.alsoUsedByProjects.map((p) => p.projectId),
    );
    expect(everyProject).not.toContain("pB1");
  });

  it("DENIES (404) when the caller is not a member of the source project's workspace", async () => {
    const db = makeFakePrisma(baseSeed());
    // user-A is NOT a member of wsB; pB1 lives in wsB.
    await expect(crossProjectImpact(MEMBER_A, "pB1", db)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns an empty result for a project with no workspace (accessible)", async () => {
    const seed = baseSeed();
    seed.projects.pNo = { workspaceId: null, createdById: "user-A" };
    const db = makeFakePrisma(seed);
    const res = await crossProjectImpact(MEMBER_A, "pNo", db);
    expect(res).toEqual({ sourceProjectId: "pNo", workspaceId: "", affectedObjects: [] });
  });

  it("404 for an unknown source project", async () => {
    const db = makeFakePrisma(baseSeed());
    await expect(crossProjectImpact(MEMBER_A, "ghost", db)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("404 when a non-owner member cannot access the source project even in their workspace", async () => {
    const seed = baseSeed();
    // pOther is in wsA but owned by someone else; user-A is a wsA member but not owner.
    seed.projects.pOther = { workspaceId: "wsA", createdById: "someone-else" };
    const db = makeFakePrisma(seed);
    await expect(crossProjectImpact(MEMBER_A, "pOther", db)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("admin gets an empty result (not 404) for an accessible no-workspace project", async () => {
    const seed = baseSeed();
    seed.projects.pNoWs = { workspaceId: null, createdById: "whoever" };
    const db = makeFakePrisma(seed);
    const res = await crossProjectImpact(ADMIN, "pNoWs", db);
    expect(res).toEqual({ sourceProjectId: "pNoWs", workspaceId: "", affectedObjects: [] });
  });

  it("treats malformed evidence JSON as zero evidence (never throws)", async () => {
    const seed = baseSeed();
    seed.classifications = [
      {
        projectId: "pA1",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: "{not-json",
      },
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: "{also-broken",
      },
    ];
    const db = makeFakePrisma(seed);
    const res = await crossProjectImpact(MEMBER_A, "pA1", db);
    expect(res.affectedObjects[0].alsoUsedByProjects[0].evidenceCount).toBe(0);
  });

  it("sorts multiple affected objects incl. a bare (no-schema) name", async () => {
    const seed = baseSeed();
    // Source pA1 has three objects; sibling pA2 uses all three. One is bare
    // (no schema), two share schema 'public' so the sort comparator exercises
    // both the schema (?? '') branch and the same-schema name tiebreak.
    seed.classifications = [
      {
        projectId: "pA1",
        kind: "table",
        tableName: "audit_log",
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      },
      {
        projectId: "pA1",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      },
      {
        projectId: "pA1",
        kind: "table",
        tableName: "public.customers",
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      },
      {
        // pA1-only object that NO sibling uses -> exercises the `continue` branch.
        projectId: "pA1",
        kind: "table",
        tableName: "private.secrets",
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      },
      {
        projectId: "pA2",
        kind: "table",
        tableName: "audit_log",
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      },
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      },
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.customers",
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      },
    ];
    const db = makeFakePrisma(seed);
    const res = await crossProjectImpact(MEMBER_A, "pA1", db);
    // private.secrets is dropped (no sibling uses it) -> 3 shared objects remain.
    expect(res.affectedObjects).toHaveLength(3);
    expect(res.affectedObjects.map((o) => o.objectName)).not.toContain("secrets");
    // Bare-name object has a null schema.
    const bare = res.affectedObjects.find((o) => o.objectName === "audit_log");
    expect(bare?.schemaName).toBeNull();
    // public.customers sorts before public.orders (same schema, name tiebreak).
    const publicNames = res.affectedObjects
      .filter((o) => o.schemaName === "public")
      .map((o) => o.objectName);
    expect(publicNames).toEqual(["customers", "orders"]);
  });

  it("batches sibling lookups: ONE classifications query + ONE project-name query for many affected objects (no N+1)", async () => {
    const seed = baseSeed();
    // Source pA1 has 4 distinct affected tables; sibling pA2 uses 3 of them.
    seed.classifications = [
      ...["t1", "t2", "t3", "t4"].map((t) => ({
        projectId: "pA1",
        kind: "table",
        tableName: t,
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      })),
      ...["t1", "t2", "t3"].map((t) => ({
        projectId: "pA2",
        kind: "table",
        tableName: t,
        columnName: null,
        usageClass: "used",
        evidence: "[]",
      })),
    ];
    const db = makeFakePrisma(seed);
    // Spy on the two queries that previously ran once PER affected object.
    const classSpy = vi.spyOn(db.schemaUsageClassification, "findMany");
    const projectSpy = vi.spyOn(db.project, "findMany");
    const res = await crossProjectImpact(MEMBER_A, "pA1", db);
    expect(res.affectedObjects.map((o) => o.objectName).sort()).toEqual(["t1", "t2", "t3"]);
    // The source-objects read is ONE classifications query; the batched sibling
    // lookup is exactly ONE more (4 affected objects would be 4 before the fix).
    expect(classSpy).toHaveBeenCalledTimes(2);
    // Sibling project NAMES are resolved ONCE for the whole batch.
    expect(projectSpy.mock.calls.filter(([arg]) => arg?.select?.name).length).toBe(1);
  });

  it("falls back to the project id when a project name is missing, and surfaces a non-null identity usageClass", async () => {
    const seed = baseSeed();
    // Give the identity a precomputed usageClass to cover toIdentityView's branch.
    seed.identities[0].usageClass = "uncertain";
    // pA2 uses the object but has no `name` so the fallback (projectId) is used.
    seed.projects.pA2 = { workspaceId: "wsA", createdById: "user-A" };
    const db = makeFakePrisma(seed);
    const res = await whichProjectsUseObject(
      MEMBER_A,
      "wsA",
      { objectName: "orders", schemaName: "public", objectType: "table" },
      db,
    );
    expect(res.identity.usageClass).toBe("uncertain");
    const pa2 = res.projects.find((p) => p.projectId === "pA2");
    expect(pa2?.projectName).toBe("pA2");
  });
});
