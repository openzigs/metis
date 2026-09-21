/**
 * DatabaseResource registry service tests — Epic #295 Phase 4 (#307).
 *
 * Covers find-or-create dedupe (same physical DB across projects in a workspace
 * collapses to one resource; distinct DBs stay separate), the unlinkable cases
 * (no workspace, insufficient identity), the create-race retry, and the
 * link-to-connection hook. Prisma + audit fully mocked — no real DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  linkConnectionToResource,
  resolveDatabaseResourceId,
  type ResourcePrisma,
} from "../src/lib/cross-project/database-resource-service.js";

interface ResRow {
  id: string;
  workspaceId: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
}

function makeFakePrisma(opts: {
  projects: Record<string, { workspaceId: string | null }>;
  failCreateOnce?: boolean;
}) {
  const resources: ResRow[] = [];
  let seq = 0;
  const connLinks: Record<string, string | null> = {};
  let failCreateOnce = opts.failCreateOnce ?? false;
  const keyOf = (r: {
    workspaceId: string;
    driver: string;
    host: string | null;
    port: number | null;
    databaseName: string | null;
  }) => `${r.workspaceId}|${r.driver}|${r.host}|${r.port}|${r.databaseName}`;

  const prisma = {
    project: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => {
        const p = opts.projects[where.id];
        return p ? { workspaceId: p.workspaceId } : null;
      },
    },
    databaseResource: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) => resources.find((r) => keyOf(r) === keyOf(where)) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: any) => {
        if (failCreateOnce) {
          failCreateOnce = false;
          // Simulate a concurrent insert winning the unique race.
          seq += 1;
          resources.push({ id: `res_race_${seq}`, ...data });
          throw new Error("UNIQUE constraint failed");
        }
        seq += 1;
        const row: ResRow = { id: `res_${seq}`, ...data };
        resources.push(row);
        return row;
      },
    },
    databaseConnection: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async ({ where, data }: any) => {
        connLinks[where.id] = data.databaseResourceId;
        return { id: where.id, databaseResourceId: data.databaseResourceId };
      },
    },
  } as unknown as ResourcePrisma;

  return { prisma, resources, connLinks };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveDatabaseResourceId — dedupe", () => {
  it("collapses the same physical DB across two projects of one workspace to ONE resource", async () => {
    const { prisma, resources } = makeFakePrisma({
      projects: { pA: { workspaceId: "wsA" }, pB: { workspaceId: "wsA" } },
    });
    const parts = { driver: "postgres", host: "db.internal", port: 5432, databaseName: "sales" };
    const idA = await resolveDatabaseResourceId({ projectId: "pA", ...parts }, prisma);
    const idB = await resolveDatabaseResourceId({ projectId: "pB", ...parts }, prisma);
    expect(idA).toBeTruthy();
    expect(idA).toBe(idB);
    expect(resources).toHaveLength(1);
  });

  it("keeps distinct physical DBs as separate resources", async () => {
    const { prisma, resources } = makeFakePrisma({ projects: { pA: { workspaceId: "wsA" } } });
    const id1 = await resolveDatabaseResourceId(
      { projectId: "pA", driver: "postgres", host: "h1", port: 5432, databaseName: "d" },
      prisma,
    );
    const id2 = await resolveDatabaseResourceId(
      { projectId: "pA", driver: "postgres", host: "h2", port: 5432, databaseName: "d" },
      prisma,
    );
    expect(id1).not.toBe(id2);
    expect(resources).toHaveLength(2);
  });

  it("does NOT cross workspaces: same DB identity in two workspaces yields two resources", async () => {
    const { prisma, resources } = makeFakePrisma({
      projects: { pA: { workspaceId: "wsA" }, pB: { workspaceId: "wsB" } },
    });
    const parts = { driver: "mysql", host: "h", port: 3306, databaseName: "d" };
    const a = await resolveDatabaseResourceId({ projectId: "pA", ...parts }, prisma);
    const b = await resolveDatabaseResourceId({ projectId: "pB", ...parts }, prisma);
    expect(a).not.toBe(b);
    expect(resources.map((r) => r.workspaceId).sort()).toEqual(["wsA", "wsB"]);
  });

  it("returns null (unlinked) when the project has no workspace", async () => {
    const { prisma, resources } = makeFakePrisma({ projects: { pC: { workspaceId: null } } });
    const id = await resolveDatabaseResourceId(
      { projectId: "pC", driver: "postgres", host: "h", port: 5432, databaseName: "d" },
      prisma,
    );
    expect(id).toBeNull();
    expect(resources).toHaveLength(0);
  });

  it("returns null when identity is insufficient (no host)", async () => {
    const { prisma, resources } = makeFakePrisma({ projects: { pA: { workspaceId: "wsA" } } });
    const id = await resolveDatabaseResourceId(
      { projectId: "pA", driver: "sqlite", host: null, port: null, databaseName: "local" },
      prisma,
    );
    expect(id).toBeNull();
    expect(resources).toHaveLength(0);
  });

  it("returns null when the project does not exist", async () => {
    const { prisma } = makeFakePrisma({ projects: {} });
    const id = await resolveDatabaseResourceId(
      { projectId: "ghost", driver: "postgres", host: "h", port: 5432, databaseName: "d" },
      prisma,
    );
    expect(id).toBeNull();
  });

  it("retries as a find when a concurrent create wins the unique race", async () => {
    const { prisma } = makeFakePrisma({
      projects: { pA: { workspaceId: "wsA" } },
      failCreateOnce: true,
    });
    const id = await resolveDatabaseResourceId(
      { projectId: "pA", driver: "postgres", host: "h", port: 5432, databaseName: "d" },
      prisma,
    );
    // The losing create throws; the retry find returns the row the winner inserted.
    expect(id).toMatch(/^res_race_/);
  });
});

describe("linkConnectionToResource", () => {
  it("links the connection when a resource resolves", async () => {
    const { prisma, connLinks } = makeFakePrisma({ projects: { pA: { workspaceId: "wsA" } } });
    const resId = await linkConnectionToResource(
      "conn-1",
      { projectId: "pA", driver: "postgres", host: "h", port: 5432, databaseName: "d" },
      prisma,
    );
    expect(resId).toBeTruthy();
    expect(connLinks["conn-1"]).toBe(resId);
  });

  it("leaves the connection unlinked (returns null, no update) when not linkable", async () => {
    const { prisma, connLinks } = makeFakePrisma({ projects: { pC: { workspaceId: null } } });
    const resId = await linkConnectionToResource(
      "conn-2",
      { projectId: "pC", driver: "postgres", host: "h", port: 5432, databaseName: "d" },
      prisma,
    );
    expect(resId).toBeNull();
    expect(connLinks["conn-2"]).toBeUndefined();
  });

  it("returns null (never throws) when the connection update fails", async () => {
    const { prisma } = makeFakePrisma({ projects: { pA: { workspaceId: "wsA" } } });
    // Force the connection update to throw — the link must degrade to null.
    (
      prisma as unknown as { databaseConnection: { update: () => Promise<never> } }
    ).databaseConnection.update = async () => {
      throw new Error("update failed");
    };
    const resId = await linkConnectionToResource(
      "conn-3",
      { projectId: "pA", driver: "postgres", host: "h", port: 5432, databaseName: "d" },
      prisma,
    );
    expect(resId).toBeNull();
  });
});

describe("resolveDatabaseResourceId — never throws", () => {
  it("returns null when an unexpected Prisma error is thrown (outer catch)", async () => {
    const { prisma } = makeFakePrisma({ projects: { pA: { workspaceId: "wsA" } } });
    (prisma as unknown as { project: { findUnique: () => Promise<never> } }).project.findUnique =
      async () => {
        throw new Error("db exploded");
      };
    const id = await resolveDatabaseResourceId(
      { projectId: "pA", driver: "postgres", host: "h", port: 5432, databaseName: "d" },
      prisma,
    );
    expect(id).toBeNull();
  });
});
