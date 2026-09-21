/**
 * Cross-project shared-table consumer resolution tests — Epic #954 (#956).
 *
 * Proves the TWO-tier cascade in `resolveAffectedTableConsumers`:
 *   - IDENTITY tier (reuses #822's enumerateSchemaConsumers) when the analyzed
 *     project is linked to a shared resource AND the object has a canonical
 *     identity → resolution `identity`, authoritative consumers.
 *   - STRING-MATCH tier when identity is absent but a workspace exists → match
 *     siblings by bare tableName → resolution `string-match` (lower confidence).
 *   - could-not-verify (`unverifiable`) when identity is absent AND string-match
 *     finds no positive evidence — DISTINCT from a resolved zero-consumer object.
 *   - no workspace → NOTHING computed (single-project runs render unchanged).
 *
 * Plus `buildImpactIdentityResolver` — the resolver the engine threads into
 * crossToSchema so affected rows carry their canonical identity id.
 *
 * A real in-memory Prisma fake seeds the resource/identity/classification/
 * connection/project rows and drives the REAL services end-to-end (no stubs).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  resolveAffectedTableConsumers,
  buildImpactIdentityResolver,
} from "../src/lib/impact-analysis/impact-consumers.js";
import type { ConsumersPrisma } from "../src/lib/analysis/affected-schema-consumers.js";
import type { AffectedTableInput } from "../src/lib/impact-analysis/schema-impact.js";

// ---- Fixtures --------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  workspaceId: string | null;
  createdById: string;
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
interface ResourceRow {
  id: string;
  workspaceId: string;
}
interface IdentityRow {
  id: string;
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: string;
}
interface ClassRow {
  projectId: string;
  kind: string;
  tableName: string;
  columnName: string | null;
  usageClass: string;
  evidence: string;
}
interface Store {
  projects: ProjectRow[];
  connections: ConnRow[];
  resources: ResourceRow[];
  identities: IdentityRow[];
  classifications: ClassRow[];
}

/** Build a `UsageEvidence[]` JSON blob from a list of edge kinds. */
function ev(...edgeKinds: string[]): string {
  return JSON.stringify(
    edgeKinds.map((edgeKind) => ({
      edgeKind,
      source: "mybatis",
      fromQualifiedName: null,
      reconciliation: null,
    })),
  );
}

/** An AffectedTableInput with sane defaults; override per-test. */
function affected(
  partial: Partial<AffectedTableInput> & { tableName: string },
): AffectedTableInput {
  return {
    objectKind: "table",
    columnName: null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: null,
    source: "mybatis",
    reconciliation: null,
    confidence: 0.6,
    ...partial,
  };
}

function makeDb(store: Store): ConsumersPrisma {
  /* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
  const db: any = {
    workspaceMember: { findUnique: async () => null, findMany: async () => [] },
    project: {
      findUnique: async ({ where }: any) => {
        const p = store.projects.find((x) => x.id === where.id);
        return p ? { workspaceId: p.workspaceId } : null;
      },
      findMany: async ({ where }: any) => {
        let rows = store.projects.slice();
        if (typeof where?.workspaceId === "string")
          rows = rows.filter((p) => p.workspaceId === where.workspaceId);
        if (where?.deletedAt === null) rows = rows.filter((p) => p.deletedAt == null);
        if (where?.id?.in) rows = rows.filter((p) => where.id.in.includes(p.id));
        if (where?.id?.not) rows = rows.filter((p) => p.id !== where.id.not);
        return rows.map((p) => ({
          id: p.id,
          name: p.name,
          createdById: p.createdById,
          workspaceId: p.workspaceId,
        }));
      },
    },
    databaseConnection: {
      findMany: async ({ where }: any) => {
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
              return true;
            })
            .map((c) => ({
              databaseResourceId: c.databaseResourceId,
              projectId: c.projectId,
              project: { name: store.projects.find((x) => x.id === c.projectId)?.name ?? "" },
            }));
        }
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
    },
    databaseResource: {
      findMany: async ({ where }: any) =>
        store.resources
          .filter((r) => r.workspaceId === where.workspaceId)
          .map((r) => ({ id: r.id })),
    },
    schemaObjectIdentity: {
      findMany: async ({ where }: any) =>
        store.identities
          .filter((i) => where.databaseResourceId?.in?.includes(i.databaseResourceId))
          .map((i) => ({
            id: i.id,
            schemaName: i.schemaName,
            objectName: i.objectName,
            objectType: i.objectType,
          })),
      findFirst: async ({ where }: any) =>
        store.identities.find(
          (i) =>
            where.databaseResourceId.in.includes(i.databaseResourceId) &&
            i.schemaName === where.schemaName &&
            i.objectName === where.objectName &&
            i.objectType === where.objectType,
        ) ?? null,
    },
    schemaUsageClassification: {
      findMany: async ({ where }: any) =>
        store.classifications
          .filter((c) => {
            if (where.projectId?.in && !where.projectId.in.includes(c.projectId)) return false;
            if (where.tableName?.in && !where.tableName.in.includes(c.tableName)) return false;
            if (typeof where.tableName === "string" && c.tableName !== where.tableName)
              return false;
            return true;
          })
          .map((c) => ({ ...c })),
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return db as ConsumersPrisma;
}

function baseStore(): Store {
  return {
    projects: [
      { id: "pA1", name: "Alpha", workspaceId: "wsA", createdById: "u1", deletedAt: null },
      { id: "pA2", name: "Beta", workspaceId: "wsA", createdById: "u2", deletedAt: null },
      { id: "pB1", name: "Zeta", workspaceId: "wsB", createdById: "u4", deletedAt: null },
    ],
    connections: [
      {
        id: "cA1",
        projectId: "pA1",
        driver: "postgres",
        host: "db.internal",
        port: 5432,
        databaseName: "app",
        databaseResourceId: "resA",
        deletedAt: null,
        createdAt: 1,
      },
      {
        id: "cA2",
        projectId: "pA2",
        driver: "postgres",
        host: "db.internal",
        port: 5432,
        databaseName: "app",
        databaseResourceId: "resA",
        deletedAt: null,
        createdAt: 2,
      },
    ],
    resources: [{ id: "resA", workspaceId: "wsA" }],
    identities: [
      {
        id: "idOrders",
        databaseResourceId: "resA",
        schemaName: "public",
        objectName: "orders",
        objectType: "table",
      },
    ],
    classifications: [],
  };
}

// ---- resolveAffectedTableConsumers -----------------------------------------

describe("resolveAffectedTableConsumers — two-tier cascade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("IDENTITY tier: resolves consumers with read/write attribution", async () => {
    const store = baseStore();
    store.classifications = [
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("writes"),
      },
    ];
    const out = await resolveAffectedTableConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out).toHaveLength(1);
    expect(out[0].resolution).toBe("identity");
    expect(out[0].consumers).toEqual([
      {
        projectId: "pA2",
        projectName: "Beta",
        usage: "writtenBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("IDENTITY tier: a resolved object with zero consumers is `identity` (verified none)", async () => {
    const store = baseStore(); // no sibling classifications
    const out = await resolveAffectedTableConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].resolution).toBe("identity");
    expect(out[0].consumers).toEqual([]);
  });

  it("STRING-MATCH tier: unlinked connection but workspace + sibling name match", async () => {
    const store = baseStore();
    // pA1 unlinked ⇒ identity cannot resolve; workspace + sibling still match by name.
    store.connections = store.connections.map((c) =>
      c.id === "cA1" ? { ...c, databaseResourceId: null } : c,
    );
    store.classifications = [
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("reads"),
      },
    ];
    const out = await resolveAffectedTableConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].resolution).toBe("string-match");
    expect(out[0].consumers).toEqual([
      {
        projectId: "pA2",
        projectName: "Beta",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("could-not-verify: unlinked + no positive sibling evidence ⇒ `unverifiable`", async () => {
    const store = baseStore();
    store.connections = store.connections.map((c) =>
      c.id === "cA1" ? { ...c, databaseResourceId: null } : c,
    );
    // Sibling has a row but NO read/write evidence → not a positive match.
    store.classifications = [
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "unreferenced",
        evidence: "[]",
      },
    ];
    const out = await resolveAffectedTableConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].resolution).toBe("unverifiable");
    expect(out[0].consumers).toEqual([]);
  });

  it("no workspace ⇒ nothing computed (single-project unchanged)", async () => {
    const store = baseStore();
    store.projects = store.projects.map((p) => (p.id === "pA1" ? { ...p, workspaceId: null } : p));
    const out = await resolveAffectedTableConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out).toEqual([]);
  });

  it("empty / routine-only affected ⇒ empty result", async () => {
    const db = makeDb(baseStore());
    expect(await resolveAffectedTableConsumers({ projectId: "pA1", affected: [] }, db)).toEqual([]);
    const routineOnly = await resolveAffectedTableConsumers(
      {
        projectId: "pA1",
        affected: [affected({ tableName: "public.do_thing", objectKind: "procedure" })],
      },
      db,
    );
    expect(routineOnly).toEqual([]);
  });

  it("collapses column affected rows to their physical table and dedupes", async () => {
    const store = baseStore();
    store.classifications = [
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("reads"),
      },
    ];
    const out = await resolveAffectedTableConsumers(
      {
        projectId: "pA1",
        affected: [
          affected({ tableName: "public.orders" }),
          affected({ tableName: "public.orders", columnName: "total", objectKind: "column" }),
        ],
      },
      makeDb(store),
    );
    // One physical table ⇒ one resolution entry.
    expect(out).toHaveLength(1);
    expect(out[0].tableName).toBe("public.orders");
  });
});

// ---- buildImpactIdentityResolver -------------------------------------------

describe("buildImpactIdentityResolver", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a linked object to its canonical identity id", async () => {
    const resolver = await buildImpactIdentityResolver("pA1", makeDb(baseStore()));
    expect(resolver).not.toBeNull();
    const id = await resolver!({
      objectKind: "table",
      tableName: "public.orders",
      columnName: null,
    });
    expect(id).toBe("idOrders");
    // A column resolves against its parent table's identity.
    const colId = await resolver!({
      objectKind: "column",
      tableName: "public.orders",
      columnName: "total",
    });
    expect(colId).toBe("idOrders");
    // An unknown object resolves to null (left unlinked).
    const none = await resolver!({
      objectKind: "table",
      tableName: "public.missing",
      columnName: null,
    });
    expect(none).toBeNull();
  });

  it("returns null when the project has no linked resource (no identity context)", async () => {
    const store = baseStore();
    store.connections = store.connections.map((c) =>
      c.id === "cA1" ? { ...c, databaseResourceId: null } : c,
    );
    expect(await buildImpactIdentityResolver("pA1", makeDb(store))).toBeNull();
  });

  it("returns null when the linked resource has no identities", async () => {
    const store = baseStore();
    store.identities = [];
    expect(await buildImpactIdentityResolver("pA1", makeDb(store))).toBeNull();
  });
});
