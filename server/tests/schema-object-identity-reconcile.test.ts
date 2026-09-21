/**
 * Issue #955 — whole-project schema-object identity reconciliation.
 *
 * `reconcileProjectSchemaIdentities` is the production write path that #308 never
 * had, leaving the identity service dead and every identity-gated cross-project
 * query permanently unresolved. These tests cover the reconcile logic in
 * isolation (Prisma fully faked, no real DB): the conservative skip rules, the
 * per-object find-or-create + usage rollup, idempotency, and the dedupe/dynamic
 * guards.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
import { describe, expect, it } from "vitest";

import {
  reconcileProjectSchemaIdentities,
  type ReconcileProjectPrisma,
} from "../src/lib/cross-project/schema-object-identity-service.js";

interface IdRow {
  id: string;
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: string;
  usageClass: string | null;
}
interface ConnRow {
  projectId: string;
  databaseResourceId: string | null;
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
  usageClass: string;
}

interface Store {
  connections: ConnRow[];
  symbols: SymRow[];
  identities: IdRow[];
  classifications: ClassRow[];
}

function makeDb(store: Store): {
  db: ReconcileProjectPrisma;
  store: Store;
  createCalls: () => number;
} {
  let seq = 0;
  let createCalls = 0;
  const keyOf = (r: {
    databaseResourceId: string;
    schemaName: string | null;
    objectName: string;
    objectType: string;
  }) => `${r.databaseResourceId}|${r.schemaName}|${r.objectName}|${r.objectType}`;

  const db: any = {
    databaseConnection: {
      findMany: async ({ where, select }: any) => {
        let rows = store.connections.filter((c) => c.deletedAt == null);
        if (where.projectId != null) rows = rows.filter((c) => c.projectId === where.projectId);
        if (where.databaseResourceId?.not === null) {
          rows = rows.filter((c) => c.databaseResourceId != null);
        } else if (typeof where.databaseResourceId === "string") {
          rows = rows.filter((c) => c.databaseResourceId === where.databaseResourceId);
        }
        if (select?.projectId) return rows.map((c) => ({ projectId: c.projectId }));
        return rows.map((c) => ({ databaseResourceId: c.databaseResourceId }));
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
      findFirst: async ({ where }: any) =>
        store.identities.find((r) => keyOf(r) === keyOf(where)) ?? null,
      create: async ({ data }: any) => {
        createCalls += 1;
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
        return store.classifications
          .filter((c) => projectIds.includes(c.projectId) && c.tableName === where.tableName)
          .map((c) => ({ usageClass: c.usageClass }));
      },
    },
  };
  return { db: db as ReconcileProjectPrisma, store, createCalls: () => createCalls };
}

const emptyStore = (): Store => ({
  connections: [],
  symbols: [],
  identities: [],
  classifications: [],
});

describe("reconcileProjectSchemaIdentities (#955)", () => {
  it("skips a project with NO linked resource (never invents an identity)", async () => {
    const store = emptyStore();
    store.connections.push({ projectId: "p1", databaseResourceId: null, deletedAt: null });
    store.symbols.push({ projectId: "p1", kind: "table", qualifiedName: "app.accounts" });
    const { db } = makeDb(store);

    const res = await reconcileProjectSchemaIdentities("p1", db);

    expect(res).toEqual({
      databaseResourceId: null,
      identitiesReconciled: 0,
      skippedReason: "no-linked-resource",
    });
    expect(store.identities).toHaveLength(0);
  });

  it("skips an AMBIGUOUS project whose connections span >1 resource (never guesses)", async () => {
    const store = emptyStore();
    store.connections.push(
      { projectId: "p1", databaseResourceId: "res-a", deletedAt: null },
      { projectId: "p1", databaseResourceId: "res-b", deletedAt: null },
    );
    store.symbols.push({ projectId: "p1", kind: "table", qualifiedName: "app.accounts" });
    const { db } = makeDb(store);

    const res = await reconcileProjectSchemaIdentities("p1", db);

    expect(res.skippedReason).toBe("ambiguous-resources");
    expect(res.identitiesReconciled).toBe(0);
    expect(store.identities).toHaveLength(0);
  });

  it("find-or-creates one identity per table/routine symbol under the linked resource", async () => {
    const store = emptyStore();
    store.connections.push({ projectId: "p1", databaseResourceId: "res-1", deletedAt: null });
    store.symbols.push(
      { projectId: "p1", kind: "table", qualifiedName: "app.accounts" },
      { projectId: "p1", kind: "table", qualifiedName: "orders" }, // bare (null schema)
      { projectId: "p1", kind: "procedure", qualifiedName: "app.apply_fee" },
      { projectId: "p1", kind: "function", qualifiedName: "app.calc_total" },
      { projectId: "p1", kind: "column", qualifiedName: "app.accounts.balance" }, // excluded
    );
    const { db } = makeDb(store);

    const res = await reconcileProjectSchemaIdentities("p1", db);

    expect(res.databaseResourceId).toBe("res-1");
    expect(res.identitiesReconciled).toBe(4); // column excluded
    const keys = store.identities
      .map((i) => `${i.schemaName ?? ""}.${i.objectName}:${i.objectType}`)
      .sort();
    expect(keys).toEqual([
      ".orders:table",
      "app.accounts:table",
      "app.apply_fee:procedure",
      "app.calc_total:function",
    ]);
  });

  it("is idempotent — a re-run creates NO duplicate identities", async () => {
    const store = emptyStore();
    store.connections.push({ projectId: "p1", databaseResourceId: "res-1", deletedAt: null });
    store.symbols.push({ projectId: "p1", kind: "table", qualifiedName: "app.accounts" });
    const { db, createCalls } = makeDb(store);

    await reconcileProjectSchemaIdentities("p1", db);
    await reconcileProjectSchemaIdentities("p1", db);

    expect(store.identities).toHaveLength(1);
    expect(createCalls()).toBe(1); // second run found the existing identity
  });

  it("de-dupes multiple symbol rows for the SAME object into one identity", async () => {
    const store = emptyStore();
    store.connections.push({ projectId: "p1", databaseResourceId: "res-1", deletedAt: null });
    store.symbols.push(
      { projectId: "p1", kind: "table", qualifiedName: "app.accounts" },
      { projectId: "p1", kind: "table", qualifiedName: "app.accounts" }, // dup row
    );
    const { db } = makeDb(store);

    const res = await reconcileProjectSchemaIdentities("p1", db);

    expect(res.identitiesReconciled).toBe(1);
    expect(store.identities).toHaveLength(1);
  });

  it("never reconciles a synthetic dynamic-placeholder symbol", async () => {
    const store = emptyStore();
    store.connections.push({ projectId: "p1", databaseResourceId: "res-1", deletedAt: null });
    store.symbols.push(
      { projectId: "p1", kind: "table", qualifiedName: "?dynamic:tablename" },
      { projectId: "p1", kind: "table", qualifiedName: "app.accounts" },
    );
    const { db } = makeDb(store);

    const res = await reconcileProjectSchemaIdentities("p1", db);

    expect(res.identitiesReconciled).toBe(1);
    expect(store.identities.map((i) => i.objectName)).toEqual(["accounts"]);
  });

  it("rolls up cross-project usage — 'used' if ANY sharing project uses the object", async () => {
    const store = emptyStore();
    store.connections.push(
      { projectId: "p1", databaseResourceId: "res-1", deletedAt: null },
      { projectId: "p2", databaseResourceId: "res-1", deletedAt: null },
    );
    store.symbols.push({ projectId: "p1", kind: "table", qualifiedName: "app.accounts" });
    // p2 uses the table; p1 does not classify it — the rollup must still be "used".
    store.classifications.push({
      projectId: "p2",
      tableName: "app.accounts",
      usageClass: "used",
    });
    const { db } = makeDb(store);

    await reconcileProjectSchemaIdentities("p1", db);

    expect(store.identities).toHaveLength(1);
    expect(store.identities[0].usageClass).toBe("used");
  });

  it("leaves usageClass null when no sharing project has classified the object", async () => {
    const store = emptyStore();
    store.connections.push({ projectId: "p1", databaseResourceId: "res-1", deletedAt: null });
    store.symbols.push({ projectId: "p1", kind: "table", qualifiedName: "app.accounts" });
    const { db } = makeDb(store);

    await reconcileProjectSchemaIdentities("p1", db);

    expect(store.identities[0].usageClass).toBeNull();
  });
});
