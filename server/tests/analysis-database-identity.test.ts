/**
 * Analysis-facing database identity resolution tests — Epic #820 Phase 1 (#821).
 *
 * Proves the read-only identity resolver surfaces linked resources + sibling
 * projects (and NEVER a guessed link for insufficient identity), and that the
 * explicit link/unlink/re-resolve mutations are conservative, idempotent,
 * audited, and refuse to cross a workspace boundary. Prisma + audit fully mocked
 * (the #289 clean-CI-DB lesson) — deterministic, no real DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { audit } from "../src/lib/audit/audit-service.js";
import { AppError } from "../src/middleware/error-handler.js";
import {
  linkConnectionToResourceExplicit,
  reresolveConnectionResource,
  resolveProjectDatabaseIdentities,
  unlinkConnectionFromResource,
  type IdentityPrisma,
} from "../src/lib/cross-project/analysis-database-identity.js";

const auditMock = vi.mocked(audit);

interface ProjectRow {
  id: string;
  name: string;
  workspaceId: string | null;
  deletedAt: Date | null;
}
interface ConnRow {
  id: string;
  projectId: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  databaseResourceId: string | null;
  deletedAt: Date | null;
  createdAt: number;
}
interface ResRow {
  id: string;
  workspaceId: string;
  driver: string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
}
interface Store {
  projects: ProjectRow[];
  connections: ConnRow[];
  resources: ResRow[];
}

/**
 * In-memory fake covering exactly the Prisma calls the service (and the
 * `resolveDatabaseResourceId` it reuses) make. `update`/`create` mutate the
 * store so idempotency across sequential calls is exercised end-to-end.
 */
function makeDb(store: Store): IdentityPrisma {
  let seq = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
  const db: any = {
    project: {
      findUnique: async ({ where }: any) => {
        const p = store.projects.find((x) => x.id === where.id);
        return p ? { workspaceId: p.workspaceId } : null;
      },
    },
    databaseResource: {
      findUnique: async ({ where }: any) => {
        const r = store.resources.find((x) => x.id === where.id);
        return r ? { id: r.id, workspaceId: r.workspaceId } : null;
      },
      findFirst: async ({ where }: any) => {
        const r = store.resources.find(
          (x) =>
            x.workspaceId === where.workspaceId &&
            x.driver === where.driver &&
            x.host === where.host &&
            x.port === where.port &&
            x.databaseName === where.databaseName,
        );
        return r ? { id: r.id } : null;
      },
      create: async ({ data }: any) => {
        const row: ResRow = {
          id: `res-new-${++seq}`,
          workspaceId: data.workspaceId,
          driver: data.driver,
          host: data.host,
          port: data.port,
          databaseName: data.databaseName,
        };
        store.resources.push(row);
        return { id: row.id };
      },
    },
    databaseConnection: {
      findMany: async ({ where }: any) => {
        // Sibling-sharing query (has databaseResourceId.in + project filter).
        if (where.databaseResourceId?.in) {
          const ids: string[] = where.databaseResourceId.in;
          const notProject: string | undefined = where.projectId?.not;
          const wsFilter: string | undefined = where.project?.workspaceId;
          return store.connections
            .filter((c) => c.deletedAt == null)
            .filter((c) => c.databaseResourceId != null && ids.includes(c.databaseResourceId))
            .filter((c) => (notProject ? c.projectId !== notProject : true))
            .filter((c) => {
              const p = store.projects.find((x) => x.id === c.projectId);
              if (!p) return false;
              if (wsFilter != null && p.workspaceId !== wsFilter) return false;
              if (where.project?.deletedAt === null && p.deletedAt != null) return false;
              return true;
            })
            .map((c) => ({
              databaseResourceId: c.databaseResourceId,
              projectId: c.projectId,
              project: { name: store.projects.find((x) => x.id === c.projectId)?.name ?? "" },
            }));
        }
        // Project-connections query.
        return store.connections
          .filter((c) => c.projectId === where.projectId && c.deletedAt == null)
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((c) => ({
            id: c.id,
            driver: c.driver,
            host: c.host,
            port: c.port,
            databaseName: c.databaseName,
            databaseResourceId: c.databaseResourceId,
          }));
      },
      findFirst: async ({ where }: any) => {
        const c = store.connections.find(
          (x) => x.id === where.id && x.projectId === where.projectId && x.deletedAt == null,
        );
        if (!c) return null;
        const p = store.projects.find((x) => x.id === c.projectId);
        return {
          id: c.id,
          driver: c.driver,
          host: c.host,
          port: c.port,
          databaseName: c.databaseName,
          databaseResourceId: c.databaseResourceId,
          project: { workspaceId: p?.workspaceId ?? null },
        };
      },
      update: async ({ where, data }: any) => {
        const c = store.connections.find((x) => x.id === where.id);
        if (!c) throw new Error("connection missing in fake");
        if ("databaseResourceId" in data) c.databaseResourceId = data.databaseResourceId;
        return { id: c.id };
      },
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return db as IdentityPrisma;
}

function baseStore(): Store {
  return {
    projects: [
      { id: "proj-a", name: "Project A", workspaceId: "ws-1", deletedAt: null },
      { id: "proj-b", name: "Project B", workspaceId: "ws-1", deletedAt: null },
      { id: "proj-x", name: "Project X", workspaceId: "ws-2", deletedAt: null },
      { id: "proj-lonely", name: "Lonely", workspaceId: null, deletedAt: null },
    ],
    connections: [],
    resources: [
      {
        id: "res-1",
        workspaceId: "ws-1",
        driver: "postgres",
        host: "db1",
        port: 5432,
        databaseName: "app",
      },
      {
        id: "res-ws2",
        workspaceId: "ws-2",
        driver: "postgres",
        host: "db9",
        port: 5432,
        databaseName: "other",
      },
    ],
  };
}

beforeEach(() => {
  auditMock.mockReset();
});

describe("resolveProjectDatabaseIdentities", () => {
  it("returns linked resource + sibling projects, and flags insufficient identity", async () => {
    const store = baseStore();
    store.connections.push(
      {
        id: "c-a1",
        projectId: "proj-a",
        driver: "postgres",
        host: "db1",
        port: 5432,
        databaseName: "app",
        databaseResourceId: "res-1",
        deletedAt: null,
        createdAt: 1,
      },
      {
        id: "c-a2",
        projectId: "proj-a",
        driver: "sqlite",
        host: null,
        port: null,
        databaseName: null,
        databaseResourceId: null,
        deletedAt: null,
        createdAt: 2,
      },
      // Sibling in the same workspace sharing res-1 → should appear.
      {
        id: "c-b1",
        projectId: "proj-b",
        driver: "postgres",
        host: "db1",
        port: 5432,
        databaseName: "app",
        databaseResourceId: "res-1",
        deletedAt: null,
        createdAt: 3,
      },
    );
    const identities = await resolveProjectDatabaseIdentities("proj-a", makeDb(store));

    expect(identities).toHaveLength(2);
    const linked = identities.find((i) => i.connectionId === "c-a1")!;
    expect(linked.databaseResourceId).toBe("res-1");
    expect(linked.insufficientIdentity).toBe(false);
    expect(linked.sharingProjects).toEqual([{ projectId: "proj-b", name: "Project B" }]);

    const unlinked = identities.find((i) => i.connectionId === "c-a2")!;
    expect(unlinked.databaseResourceId).toBeNull();
    expect(unlinked.insufficientIdentity).toBe(true);
    expect(unlinked.sharingProjects).toEqual([]);
  });

  it("never returns siblings from a different workspace or the same project", async () => {
    const store = baseStore();
    store.connections.push(
      {
        id: "c-a1",
        projectId: "proj-a",
        driver: "postgres",
        host: "db1",
        port: 5432,
        databaseName: "app",
        databaseResourceId: "res-1",
        deletedAt: null,
        createdAt: 1,
      },
      // Same project, same resource → excluded (only OTHER projects count).
      {
        id: "c-a2",
        projectId: "proj-a",
        driver: "postgres",
        host: "db1",
        port: 5432,
        databaseName: "app",
        databaseResourceId: "res-1",
        deletedAt: null,
        createdAt: 2,
      },
      // Deleted sibling connection → excluded.
      {
        id: "c-b-del",
        projectId: "proj-b",
        driver: "postgres",
        host: "db1",
        port: 5432,
        databaseName: "app",
        databaseResourceId: "res-1",
        deletedAt: new Date(),
        createdAt: 3,
      },
    );
    const identities = await resolveProjectDatabaseIdentities("proj-a", makeDb(store));
    const linked = identities.find((i) => i.connectionId === "c-a1")!;
    expect(linked.sharingProjects).toEqual([]);
  });

  it("returns identities with empty sharing for a project with no workspace", async () => {
    const store = baseStore();
    store.connections.push({
      id: "c-l1",
      projectId: "proj-lonely",
      driver: "postgres",
      host: "db1",
      port: 5432,
      databaseName: "app",
      databaseResourceId: "res-1",
      deletedAt: null,
      createdAt: 1,
    });
    const identities = await resolveProjectDatabaseIdentities("proj-lonely", makeDb(store));
    expect(identities).toHaveLength(1);
    expect(identities[0].sharingProjects).toEqual([]);
    expect(identities[0].insufficientIdentity).toBe(false);
  });

  it("returns an empty list for an unknown project", async () => {
    const store = baseStore();
    const identities = await resolveProjectDatabaseIdentities("proj-missing", makeDb(store));
    expect(identities).toEqual([]);
  });
});

describe("linkConnectionToResourceExplicit", () => {
  function storeWithUnlinkedConn(): Store {
    const store = baseStore();
    store.connections.push({
      id: "c-a1",
      projectId: "proj-a",
      driver: "postgres",
      host: "db-alias",
      port: 5432,
      databaseName: "app",
      databaseResourceId: null,
      deletedAt: null,
      createdAt: 1,
    });
    return store;
  }

  it("links across a hostname alias the conservative key cannot auto-detect, and audits", async () => {
    const store = storeWithUnlinkedConn();
    const result = await linkConnectionToResourceExplicit(
      { projectId: "proj-a", connectionId: "c-a1", databaseResourceId: "res-1", actorId: "u1" },
      makeDb(store),
    );
    expect(result).toEqual({ connectionId: "c-a1", databaseResourceId: "res-1", changed: true });
    expect(store.connections[0].databaseResourceId).toBe("res-1");
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][0]).toMatchObject({
      action: "cross-project.connection.link",
      target: { type: "db_connector", id: "c-a1" },
      metadata: { mode: "explicit", databaseResourceId: "res-1", projectId: "proj-a" },
    });
  });

  it("is idempotent when already linked to the same resource (no audit, no write)", async () => {
    const store = storeWithUnlinkedConn();
    store.connections[0].databaseResourceId = "res-1";
    const result = await linkConnectionToResourceExplicit(
      { projectId: "proj-a", connectionId: "c-a1", databaseResourceId: "res-1", actorId: "u1" },
      makeDb(store),
    );
    expect(result.changed).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("404s when the connection is not in the project", async () => {
    const store = storeWithUnlinkedConn();
    await expect(
      linkConnectionToResourceExplicit(
        { projectId: "proj-b", connectionId: "c-a1", databaseResourceId: "res-1", actorId: "u1" },
        makeDb(store),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "DB_CONNECTOR_NOT_FOUND" });
  });

  it("400s when the connection's project has no workspace", async () => {
    const store = baseStore();
    store.connections.push({
      id: "c-l1",
      projectId: "proj-lonely",
      driver: "postgres",
      host: "db1",
      port: 5432,
      databaseName: "app",
      databaseResourceId: null,
      deletedAt: null,
      createdAt: 1,
    });
    await expect(
      linkConnectionToResourceExplicit(
        {
          projectId: "proj-lonely",
          connectionId: "c-l1",
          databaseResourceId: "res-1",
          actorId: "u1",
        },
        makeDb(store),
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: "PROJECT_NO_WORKSPACE" });
  });

  it("rejects cross-workspace linking with a 404 (no existence oracle)", async () => {
    const store = storeWithUnlinkedConn();
    await expect(
      linkConnectionToResourceExplicit(
        { projectId: "proj-a", connectionId: "c-a1", databaseResourceId: "res-ws2", actorId: "u1" },
        makeDb(store),
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "DB_RESOURCE_NOT_FOUND" });
    expect(store.connections[0].databaseResourceId).toBeNull();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("404s a missing resource", async () => {
    const store = storeWithUnlinkedConn();
    await expect(
      linkConnectionToResourceExplicit(
        {
          projectId: "proj-a",
          connectionId: "c-a1",
          databaseResourceId: "res-nope",
          actorId: "u1",
        },
        makeDb(store),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("unlinkConnectionFromResource", () => {
  it("unlinks a linked connection and audits", async () => {
    const store = baseStore();
    store.connections.push({
      id: "c-a1",
      projectId: "proj-a",
      driver: "postgres",
      host: "db1",
      port: 5432,
      databaseName: "app",
      databaseResourceId: "res-1",
      deletedAt: null,
      createdAt: 1,
    });
    const result = await unlinkConnectionFromResource(
      { projectId: "proj-a", connectionId: "c-a1", actorId: "u1" },
      makeDb(store),
    );
    expect(result).toEqual({ connectionId: "c-a1", databaseResourceId: null, changed: true });
    expect(store.connections[0].databaseResourceId).toBeNull();
    expect(auditMock.mock.calls[0][0]).toMatchObject({
      action: "cross-project.connection.unlink",
      metadata: { previousDatabaseResourceId: "res-1", projectId: "proj-a" },
    });
  });

  it("is a no-op for an already-unlinked connection (no audit)", async () => {
    const store = baseStore();
    store.connections.push({
      id: "c-a1",
      projectId: "proj-a",
      driver: "postgres",
      host: "db1",
      port: 5432,
      databaseName: "app",
      databaseResourceId: null,
      deletedAt: null,
      createdAt: 1,
    });
    const result = await unlinkConnectionFromResource(
      { projectId: "proj-a", connectionId: "c-a1", actorId: "u1" },
      makeDb(store),
    );
    expect(result.changed).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("404s an unknown connection", async () => {
    const store = baseStore();
    await expect(
      unlinkConnectionFromResource(
        { projectId: "proj-a", connectionId: "c-missing", actorId: "u1" },
        makeDb(store),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("reresolveConnectionResource", () => {
  it("links a pre-existing unlinked connection to its find-or-created resource", async () => {
    const store = baseStore();
    store.connections.push({
      id: "c-a1",
      projectId: "proj-a",
      driver: "postgres",
      host: "db1",
      port: 5432,
      databaseName: "app",
      databaseResourceId: null,
      deletedAt: null,
      createdAt: 1,
    });
    const db = makeDb(store);
    const first = await reresolveConnectionResource(
      { projectId: "proj-a", connectionId: "c-a1", actorId: "u1" },
      db,
    );
    expect(first.changed).toBe(true);
    expect(first.databaseResourceId).toBe("res-1"); // matched existing by key
    expect(auditMock.mock.calls.at(-1)?.[0]).toMatchObject({
      action: "cross-project.connection.link",
      metadata: { mode: "reresolve" },
    });

    // Second call is a no-op (already linked) — proves idempotency.
    auditMock.mockReset();
    const second = await reresolveConnectionResource(
      { projectId: "proj-a", connectionId: "c-a1", actorId: "u1" },
      db,
    );
    expect(second).toEqual({ connectionId: "c-a1", databaseResourceId: "res-1", changed: false });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("creates a new resource when none exists yet", async () => {
    const store = baseStore();
    store.resources = []; // no pre-existing resources
    store.connections.push({
      id: "c-a1",
      projectId: "proj-a",
      driver: "mysql",
      host: "newhost",
      port: 3306,
      databaseName: "sales",
      databaseResourceId: null,
      deletedAt: null,
      createdAt: 1,
    });
    const result = await reresolveConnectionResource(
      { projectId: "proj-a", connectionId: "c-a1", actorId: "u1" },
      makeDb(store),
    );
    expect(result.changed).toBe(true);
    expect(result.databaseResourceId).toMatch(/^res-new-/);
    expect(store.resources).toHaveLength(1);
  });

  it("never collapses two connections whose key parts differ", async () => {
    const store = baseStore();
    store.resources = [];
    store.connections.push(
      {
        id: "c-a1",
        projectId: "proj-a",
        driver: "postgres",
        host: "shared",
        port: 5432,
        databaseName: "db_a",
        databaseResourceId: null,
        deletedAt: null,
        createdAt: 1,
      },
      {
        id: "c-a2",
        projectId: "proj-a",
        driver: "postgres",
        host: "shared",
        port: 5432,
        databaseName: "db_b",
        databaseResourceId: null,
        deletedAt: null,
        createdAt: 2,
      },
    );
    const db = makeDb(store);
    const r1 = await reresolveConnectionResource(
      { projectId: "proj-a", connectionId: "c-a1", actorId: "u1" },
      db,
    );
    const r2 = await reresolveConnectionResource(
      { projectId: "proj-a", connectionId: "c-a2", actorId: "u1" },
      db,
    );
    expect(r1.databaseResourceId).not.toBe(r2.databaseResourceId);
    expect(store.resources).toHaveLength(2);
  });

  it("leaves a connection with insufficient identity unlinked (no guess)", async () => {
    const store = baseStore();
    store.connections.push({
      id: "c-a1",
      projectId: "proj-a",
      driver: "sqlite",
      host: null,
      port: null,
      databaseName: null,
      databaseResourceId: null,
      deletedAt: null,
      createdAt: 1,
    });
    const result = await reresolveConnectionResource(
      { projectId: "proj-a", connectionId: "c-a1", actorId: "u1" },
      makeDb(store),
    );
    expect(result).toEqual({ connectionId: "c-a1", databaseResourceId: null, changed: false });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("does not clobber an already-linked (explicit) connection", async () => {
    const store = baseStore();
    store.connections.push({
      id: "c-a1",
      projectId: "proj-a",
      driver: "postgres",
      host: "db-alias",
      port: 5432,
      databaseName: "app",
      databaseResourceId: "res-1",
      deletedAt: null,
      createdAt: 1,
    });
    const result = await reresolveConnectionResource(
      { projectId: "proj-a", connectionId: "c-a1", actorId: "u1" },
      makeDb(store),
    );
    expect(result).toEqual({ connectionId: "c-a1", databaseResourceId: "res-1", changed: false });
    expect(store.connections[0].databaseResourceId).toBe("res-1");
  });

  it("404s an unknown connection", async () => {
    const store = baseStore();
    await expect(
      reresolveConnectionResource(
        { projectId: "proj-a", connectionId: "c-missing", actorId: "u1" },
        makeDb(store),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
