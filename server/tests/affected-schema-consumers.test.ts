/**
 * Affected-schema cross-project consumer enumeration tests — Epic #820 (#822).
 *
 * Proves enumerateSchemaConsumers reports the shared-database blast radius of a
 * requirement's affected objects: it attributes each sibling consumer as
 * read/write, EXCLUDES the analyzed project, NEVER leaks a project outside the
 * analyzed project's workspace, and distinguishes "identity unresolved"
 * (could-not-verify) from a genuinely zero-consumer resolved object.
 *
 * Fixtures seed real DatabaseResource / SchemaObjectIdentity /
 * schemaUsageClassification / DatabaseConnection / Project rows into an
 * in-memory Prisma fake (the #289 no-real-DB-in-CI convention 1a/#821 used) and
 * exercise the REAL services end-to-end — resolveProjectDatabaseIdentities and
 * whichProjectsUseObject are NOT stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  enumerateSchemaConsumers,
  type ConsumersPrisma,
} from "../src/lib/analysis/affected-schema-consumers.js";
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

/**
 * In-memory Prisma fake covering exactly the reads the service +
 * resolveProjectDatabaseIdentities + whichProjectsUseObject make.
 */
function makeDb(store: Store): ConsumersPrisma {
  /* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
  const db: any = {
    workspaceMember: {
      findUnique: async () => null,
      findMany: async () => [],
    },
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
        // Sibling-sharing query (resolveProjectDatabaseIdentities).
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

/**
 * Base seed: workspace wsA holds the analyzed project pA1 (linked to resource
 * resA) plus siblings pA2/pA3; workspace wsB holds pB1 (linked to resB) — a
 * tenant that must NEVER surface. resA carries the canonical `public.orders`.
 */
function baseStore(): Store {
  return {
    projects: [
      { id: "pA1", name: "Alpha", workspaceId: "wsA", createdById: "u1", deletedAt: null },
      { id: "pA2", name: "Beta", workspaceId: "wsA", createdById: "u2", deletedAt: null },
      { id: "pA3", name: "Gamma", workspaceId: "wsA", createdById: "u3", deletedAt: null },
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
      {
        id: "cB1",
        projectId: "pB1",
        driver: "postgres",
        host: "other.internal",
        port: 5432,
        databaseName: "app",
        databaseResourceId: "resB",
        deletedAt: null,
        createdAt: 3,
      },
    ],
    resources: [
      { id: "resA", workspaceId: "wsA" },
      { id: "resB", workspaceId: "wsB" },
    ],
    identities: [
      {
        databaseResourceId: "resA",
        schemaName: "public",
        objectName: "orders",
        objectType: "table",
      },
      {
        databaseResourceId: "resB",
        schemaName: "public",
        objectName: "orders",
        objectType: "table",
      },
    ],
    classifications: [],
  };
}

// ---- Tests -----------------------------------------------------------------

describe("enumerateSchemaConsumers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns sibling consumers with correct readBy/writtenBy attribution", async () => {
    const store = baseStore();
    store.classifications = [
      // Analyzed project — MUST be excluded from its own consumer list.
      {
        projectId: "pA1",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("reads"),
      },
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("writes"),
      },
      {
        projectId: "pA3",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("reads"),
      },
      // Cross-workspace tenant — MUST never surface.
      {
        projectId: "pB1",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("writes"),
      },
    ];

    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );

    expect(out).toHaveLength(1);
    expect(out[0].identityResolved).toBe(true);
    expect(out[0].tableName).toBe("public.orders");
    expect(out[0].consumers).toEqual([
      {
        projectId: "pA2",
        projectName: "Beta",
        usage: "writtenBy",
        objectQualifiedName: "public.orders",
      },
      {
        projectId: "pA3",
        projectName: "Gamma",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("excludes the analyzed project even when it uses the object", async () => {
    const store = baseStore();
    store.classifications = [
      {
        projectId: "pA1",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("writes"),
      },
    ];
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].identityResolved).toBe(true);
    expect(out[0].consumers).toEqual([]);
  });

  it("returns identityResolved:false (not zero-consumer) when the connection is unlinked", async () => {
    const store = baseStore();
    // pA1's connection is unlinked (no resource) — even though a sibling created
    // resA for the same object, we cannot assert the unconfirmed mapping.
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
        evidence: ev("writes"),
      },
    ];
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].identityResolved).toBe(false);
    expect(out[0].consumers).toEqual([]);
  });

  it("returns identityResolved:false when the project has no workspace", async () => {
    const store = baseStore();
    store.projects = store.projects.map((p) => (p.id === "pA1" ? { ...p, workspaceId: null } : p));
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].identityResolved).toBe(false);
    expect(out[0].consumers).toEqual([]);
  });

  it("returns identityResolved:false when the object has no identity in the linked resource", async () => {
    const store = baseStore();
    // resA has a different object identity, but NOT public.orders.
    store.identities = [
      {
        databaseResourceId: "resA",
        schemaName: "public",
        objectName: "customers",
        objectType: "table",
      },
    ];
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
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].identityResolved).toBe(false);
    expect(out[0].consumers).toEqual([]);
  });

  it("reports a resolved object with zero read/write consumers distinctly from unresolved", async () => {
    const store = baseStore();
    // Sibling has a classification row but it is `unreferenced` (empty evidence):
    // it exists in the schema yet does not read or write the object → dropped.
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
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].identityResolved).toBe(true); // resolved…
    expect(out[0].consumers).toEqual([]); // …but genuinely zero consumers
  });

  it("resolves a column affected object against its parent table", async () => {
    const store = baseStore();
    store.classifications = [
      {
        projectId: "pA2",
        kind: "column",
        tableName: "public.orders",
        columnName: "total",
        usageClass: "used",
        evidence: ev("reads"),
      },
    ];
    const out = await enumerateSchemaConsumers(
      {
        projectId: "pA1",
        affected: [
          affected({ tableName: "public.orders", columnName: "total", objectKind: "column" }),
        ],
      },
      makeDb(store),
    );
    expect(out[0].identityResolved).toBe(true);
    expect(out[0].columnName).toBe("total");
    expect(out[0].consumers).toEqual([
      {
        projectId: "pA2",
        projectName: "Beta",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("classifies a project that both reads and writes as writtenBy (write wins)", async () => {
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
      {
        projectId: "pA2",
        kind: "column",
        tableName: "public.orders",
        columnName: "total",
        usageClass: "used",
        evidence: ev("persists-to"),
      },
    ];
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].consumers).toEqual([
      {
        projectId: "pA2",
        projectName: "Beta",
        usage: "writtenBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("treats a non-read/write evidence edge (executes) as readBy", async () => {
    const store = baseStore();
    store.classifications = [
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "uncertain",
        evidence: ev("executes"),
      },
    ];
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].consumers).toEqual([
      {
        projectId: "pA2",
        projectName: "Beta",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("skips evidence entries with a non-string edgeKind", async () => {
    const store = baseStore();
    // First entry is malformed (numeric edgeKind → skipped); the second is a
    // valid read, so the project is still a readBy consumer.
    store.classifications = [
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "uncertain",
        evidence: JSON.stringify([{ edgeKind: 7 }, { edgeKind: "reads" }]),
      },
    ];
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].consumers).toEqual([
      {
        projectId: "pA2",
        projectName: "Beta",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("keeps writtenBy when a write row is merged before a read row", async () => {
    const store = baseStore();
    // Write row FIRST, then a read row for the same project+object — the merged
    // access must stay writtenBy regardless of evidence-row order.
    store.classifications = [
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("writes"),
      },
      {
        projectId: "pA2",
        kind: "column",
        tableName: "public.orders",
        columnName: "total",
        usageClass: "used",
        evidence: ev("reads"),
      },
    ];
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].consumers).toEqual([
      {
        projectId: "pA2",
        projectName: "Beta",
        usage: "writtenBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("drops a candidate whose evidence is malformed or non-array JSON", async () => {
    const store = baseStore();
    store.classifications = [
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "uncertain",
        evidence: "not-json",
      },
      {
        projectId: "pA3",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "uncertain",
        evidence: '{"edgeKind":"reads"}',
      },
    ];
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [affected({ tableName: "public.orders" })] },
      makeDb(store),
    );
    expect(out[0].identityResolved).toBe(true);
    expect(out[0].consumers).toEqual([]);
  });

  it("de-dupes affected rows by (tableName, columnName), keeping the highest-confidence changeKind", async () => {
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
    const out = await enumerateSchemaConsumers(
      {
        projectId: "pA1",
        affected: [
          affected({ tableName: "public.orders", changeKind: "reference", confidence: 0.4 }),
          affected({ tableName: "public.orders", changeKind: "drop-column", confidence: 0.9 }),
        ],
      },
      makeDb(store),
    );
    expect(out).toHaveLength(1);
    expect(out[0].changeKind).toBe("drop-column");
  });

  it("is deterministic and stable-sorted by object name then consumer name", async () => {
    const store = baseStore();
    store.classifications = [
      {
        projectId: "pA3",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("reads"),
      },
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.orders",
        columnName: null,
        usageClass: "used",
        evidence: ev("writes"),
      },
      {
        projectId: "pA2",
        kind: "table",
        tableName: "public.customers",
        columnName: null,
        usageClass: "used",
        evidence: ev("reads"),
      },
    ];
    store.identities.push({
      databaseResourceId: "resA",
      schemaName: "public",
      objectName: "customers",
      objectType: "table",
    });
    const out = await enumerateSchemaConsumers(
      {
        projectId: "pA1",
        // Intentionally out of order — expect deterministic sort on output.
        affected: [
          affected({ tableName: "public.orders" }),
          affected({ tableName: "public.customers" }),
        ],
      },
      makeDb(store),
    );
    expect(out.map((o) => o.tableName)).toEqual(["public.customers", "public.orders"]);
    // orders: Beta (write) before Gamma (read) — sorted by project name.
    expect(out[1].consumers.map((c) => c.projectName)).toEqual(["Beta", "Gamma"]);
  });

  it("carries the DDL changeKind through as the breaking-change hook point", async () => {
    const store = baseStore();
    const out = await enumerateSchemaConsumers(
      {
        projectId: "pA1",
        affected: [affected({ tableName: "public.orders", changeKind: "add-column" })],
      },
      makeDb(store),
    );
    expect(out[0].changeKind).toBe("add-column");
  });

  it("returns an empty array for empty affected input", async () => {
    const out = await enumerateSchemaConsumers(
      { projectId: "pA1", affected: [] },
      makeDb(baseStore()),
    );
    expect(out).toEqual([]);
  });
});
