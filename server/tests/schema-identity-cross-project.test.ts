/**
 * Issue #955 — end-to-end cross-project identity resolution.
 *
 * Two projects in ONE workspace whose connections resolve to the SAME
 * DatabaseResource. Before #955 the identity write path had zero callers, so
 * `whichProjectsUseObject` (#309) always 404'd and `enumerateSchemaConsumers`
 * (#822) always returned `identityResolved: false` ("could not verify"). This
 * test drives `reconcileProjectSchemaIdentities` (the newly-wired write path) for
 * both projects, then proves the two identity-gated queries now resolve to real
 * consumers, and that a re-run is idempotent.
 *
 * Prisma is a single in-memory store shared by the reconcile, the cross-project
 * queries, and the consumer enumeration — no real DB, deterministic. Read-only
 * against the customer DB (the store models METIS's own tables only).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { reconcileProjectSchemaIdentities } from "../src/lib/cross-project/schema-object-identity-service.js";
import {
  whichProjectsUseObject,
  type CrossImpactPrisma,
} from "../src/lib/cross-project/cross-project-impact.js";
import { enumerateSchemaConsumers } from "../src/lib/analysis/affected-schema-consumers.js";
import type { AffectedTableInput } from "../src/lib/impact-analysis/schema-impact.js";
import type { SchedulerActor } from "../src/lib/scheduler/project-access.js";

const ADMIN: SchedulerActor = { id: "admin", role: "admin" };

interface IdRow {
  id: string;
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: string;
  usageClass: string | null;
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
interface ProjRow {
  id: string;
  name: string;
  workspaceId: string | null;
  createdById: string;
  deletedAt: Date | null;
}
interface SymRow {
  projectId: string;
  kind: string;
  qualifiedName: string;
}
interface ClassRow {
  projectId: string;
  tableName: string;
  columnName: string | null;
  kind: string;
  usageClass: string;
  evidence: string;
}

function makeStore() {
  const projects: ProjRow[] = [
    { id: "p1", name: "Alpha", workspaceId: "w1", createdById: "u1", deletedAt: null },
    { id: "p2", name: "Beta", workspaceId: "w1", createdById: "u2", deletedAt: null },
  ];
  const resources = [
    {
      id: "res-1",
      workspaceId: "w1",
      driver: "postgres",
      host: "db",
      port: 5432,
      databaseName: "app",
    },
  ];
  const connections: ConnRow[] = [
    {
      id: "c1",
      projectId: "p1",
      driver: "postgres",
      host: "db",
      port: 5432,
      databaseName: "app",
      databaseResourceId: "res-1",
      deletedAt: null,
      createdAt: 1,
    },
    {
      id: "c2",
      projectId: "p2",
      driver: "postgres",
      host: "db",
      port: 5432,
      databaseName: "app",
      databaseResourceId: "res-1",
      deletedAt: null,
      createdAt: 2,
    },
  ];
  const symbols: SymRow[] = [
    { projectId: "p1", kind: "table", qualifiedName: "app.accounts" },
    { projectId: "p2", kind: "table", qualifiedName: "app.accounts" },
    { projectId: "p2", kind: "table", qualifiedName: "app.orders" },
  ];
  const classifications: ClassRow[] = [
    {
      projectId: "p1",
      tableName: "app.accounts",
      columnName: null,
      kind: "table",
      usageClass: "used",
      evidence: '[{"edgeKind":"reads"}]',
    },
    {
      projectId: "p2",
      tableName: "app.accounts",
      columnName: null,
      kind: "table",
      usageClass: "used",
      evidence: '[{"edgeKind":"writes"}]',
    },
  ];
  const identities: IdRow[] = [];
  return { projects, resources, connections, symbols, classifications, identities };
}

type Store = ReturnType<typeof makeStore>;

function makeDb(store: Store) {
  let seq = 0;
  const db: any = {
    workspaceMember: {
      findUnique: async () => null, // admin actor bypasses membership
      findMany: async () => [],
    },
    project: {
      findUnique: async ({ where }: any) => {
        const p = store.projects.find((x) => x.id === where.id);
        return p ? { workspaceId: p.workspaceId } : null;
      },
      findMany: async ({ where, select }: any) => {
        let rows = store.projects.filter((p) => p.deletedAt == null);
        if (where?.workspaceId != null)
          rows = rows.filter((p) => p.workspaceId === where.workspaceId);
        if (where?.id?.in) rows = rows.filter((p) => where.id.in.includes(p.id));
        return rows.map((p) => ({
          id: p.id,
          ...(select?.name ? { name: p.name } : {}),
          ...(select?.createdById ? { createdById: p.createdById } : {}),
        }));
      },
    },
    databaseResource: {
      findMany: async ({ where }: any) =>
        store.resources
          .filter((r) => r.workspaceId === where.workspaceId)
          .map((r) => ({ id: r.id })),
    },
    databaseConnection: {
      findMany: async ({ where, select }: any) => {
        let rows = store.connections.filter((c) => c.deletedAt == null);
        if (where.projectId != null && typeof where.projectId === "string") {
          rows = rows.filter((c) => c.projectId === where.projectId);
        }
        if (where.projectId?.not != null) {
          rows = rows.filter((c) => c.projectId !== where.projectId.not);
        }
        if (where.databaseResourceId?.not === null) {
          rows = rows.filter((c) => c.databaseResourceId != null);
        } else if (typeof where.databaseResourceId === "string") {
          rows = rows.filter((c) => c.databaseResourceId === where.databaseResourceId);
        } else if (where.databaseResourceId?.in) {
          rows = rows.filter(
            (c) =>
              c.databaseResourceId != null &&
              where.databaseResourceId.in.includes(c.databaseResourceId),
          );
        }
        if (where.project?.workspaceId != null) {
          rows = rows.filter((c) => {
            const p = store.projects.find((x) => x.id === c.projectId);
            return p != null && p.workspaceId === where.project.workspaceId && p.deletedAt == null;
          });
        }
        rows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
        return rows.map((c) => {
          if (select?.databaseResourceId && Object.keys(select).length === 1) {
            return { databaseResourceId: c.databaseResourceId };
          }
          if (select?.projectId && select?.project) {
            const p = store.projects.find((x) => x.id === c.projectId);
            return {
              databaseResourceId: c.databaseResourceId,
              projectId: c.projectId,
              project: { name: p?.name ?? "" },
            };
          }
          if (select?.projectId && Object.keys(select).length === 1) {
            return { projectId: c.projectId };
          }
          return {
            id: c.id,
            driver: c.driver,
            host: c.host,
            port: c.port,
            databaseName: c.databaseName,
            databaseResourceId: c.databaseResourceId,
          };
        });
      },
    },
    codeSymbol: {
      findMany: async ({ where }: any) => {
        const kinds: string[] = where?.kind?.in ?? [];
        return store.symbols
          .filter((s) => s.projectId === where.projectId && kinds.includes(s.kind))
          .map((s) => ({ kind: s.kind, qualifiedName: s.qualifiedName }));
      },
    },
    schemaObjectIdentity: {
      findFirst: async ({ where }: any) => {
        return (
          store.identities.find((r) => {
            if (where.databaseResourceId?.in) {
              if (!where.databaseResourceId.in.includes(r.databaseResourceId)) return false;
            } else if (r.databaseResourceId !== where.databaseResourceId) {
              return false;
            }
            return (
              r.schemaName === where.schemaName &&
              r.objectName === where.objectName &&
              r.objectType === where.objectType
            );
          }) ?? null
        );
      },
      findMany: async ({ where }: any) => {
        const ids: string[] = where.databaseResourceId?.in ?? [];
        return store.identities
          .filter((r) => ids.includes(r.databaseResourceId))
          .map((r) => ({
            schemaName: r.schemaName,
            objectName: r.objectName,
            objectType: r.objectType,
          }));
      },
      create: async ({ data }: any) => {
        const row: IdRow = { id: `id_${++seq}`, usageClass: null, ...data };
        store.identities.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = store.identities.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    schemaUsageClassification: {
      findMany: async ({ where }: any) => {
        const projectIds: string[] = where.projectId?.in ?? [];
        let rows = store.classifications.filter((c) => projectIds.includes(c.projectId));
        if (typeof where.tableName === "string") {
          rows = rows.filter((c) => c.tableName === where.tableName);
        } else if (where.tableName?.in) {
          rows = rows.filter((c) => where.tableName.in.includes(c.tableName));
        }
        return rows.map((c) => ({
          projectId: c.projectId,
          tableName: c.tableName,
          columnName: c.columnName,
          kind: c.kind,
          usageClass: c.usageClass,
          evidence: c.evidence,
        }));
      },
    },
  };
  return db;
}

const affectedAccounts: AffectedTableInput = {
  objectKind: "table",
  tableName: "app.accounts",
  columnName: null,
  columnType: null,
  changeKind: "alter-column",
  suggestedDdl: null,
  source: "live-db",
  reconciliation: null,
  confidence: 1,
};

describe("cross-project identity resolution after reconcile (#955)", () => {
  it("populates identities so whichProjectsUseObject + enumerateSchemaConsumers resolve", async () => {
    const store = makeStore();
    const db = makeDb(store);

    // Both projects reconcile their schema graph into the shared resource.
    const r1 = await reconcileProjectSchemaIdentities("p1", db);
    const r2 = await reconcileProjectSchemaIdentities("p2", db);
    expect(r1.databaseResourceId).toBe("res-1");
    expect(r2.databaseResourceId).toBe("res-1");

    // The shared table dedupes onto ONE identity across both projects; p2's
    // extra table adds a second. No duplicates.
    expect(store.identities).toHaveLength(2);
    const accountsIds = store.identities.filter((i) => i.objectName === "accounts");
    expect(accountsIds).toHaveLength(1);

    // #309 whichProjectsUseObject: BOTH projects now surface (previously 404).
    const usage = await whichProjectsUseObject(
      ADMIN,
      "w1",
      { schemaName: "app", objectName: "accounts", objectType: "table" },
      db as unknown as CrossImpactPrisma,
    );
    expect(usage.projects.map((p) => p.projectId).sort()).toEqual(["p1", "p2"]);

    // #822 enumerateSchemaConsumers (analyzed project p1): the shared object now
    // resolves and lists p2 as a real consumer (no permanent "could not verify").
    const consumers = await enumerateSchemaConsumers(
      { projectId: "p1", affected: [affectedAccounts] },
      db as any,
    );
    expect(consumers).toHaveLength(1);
    expect(consumers[0].identityResolved).toBe(true);
    expect(consumers[0].consumers.map((c) => c.projectId)).toEqual(["p2"]);
    expect(consumers[0].consumers[0].usage).toBe("writtenBy");
  });

  it("is idempotent — re-reconciling both projects creates NO duplicate identities", async () => {
    const store = makeStore();
    const db = makeDb(store);

    await reconcileProjectSchemaIdentities("p1", db);
    await reconcileProjectSchemaIdentities("p2", db);
    const afterFirst = store.identities.length;

    await reconcileProjectSchemaIdentities("p1", db);
    await reconcileProjectSchemaIdentities("p2", db);

    expect(store.identities).toHaveLength(afterFirst);
    expect(afterFirst).toBe(2);
  });

  it("without reconcile, enumerateSchemaConsumers stays UNRESOLVED (the dead-service baseline)", async () => {
    const store = makeStore();
    const db = makeDb(store);
    // Deliberately do NOT reconcile — mirrors the pre-#955 world (zero callers).
    const consumers = await enumerateSchemaConsumers(
      { projectId: "p1", affected: [affectedAccounts] },
      db as any,
    );
    expect(consumers[0].identityResolved).toBe(false);
    expect(consumers[0].consumers).toEqual([]);
  });
});
