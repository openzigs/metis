/**
 * Issue #955 — SchemaObjectIdentity reconciliation is now WIRED into ingest.
 *
 * The identity service (#308: `reconcileIdentity`/`rollupIdentityUsage`) shipped
 * with ZERO production callers, so `SchemaObjectIdentity` rows were never created
 * and the identity-gated cross-project queries (#309 `whichProjectsUseObject`,
 * #822 `enumerateSchemaConsumers`) were permanently unresolved. This is the
 * NEUTER-AND-RED REACHABILITY GUARD whose absence let the service land dead: it
 * exercises the REAL ingest entry path (`ingestCodeGraph`) — NOT
 * `reconcileProjectSchemaIdentities` directly — and asserts that canonical
 * identity rows exist after ingest of a project linked to a DatabaseResource.
 *
 * To prove it goes red: remove the `reconcileProjectSchemaIdentities` call from
 * `ingestCodeGraph` (server/src/lib/code-graph/ingest.ts, "Step 6.5") and this
 * suite fails — no identity rows are written.
 *
 * Prisma is an in-memory fake (no real DB); the repo is a temp dir whose only
 * file is a `schema.prisma` (the ORM pass turns it into a `table` symbol). No
 * customer DB is ever touched.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestCodeGraph } from "../src/lib/code-graph/ingest.js";

const prismaSrc = readFileSync(join(__dirname, "fixtures", "orm", "schema.prisma"), "utf8");

interface IdRow {
  id: string;
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: string;
  usageClass: string | null;
}

/**
 * In-memory Prisma covering the code-graph ingest surface PLUS the #955
 * reconcile surface (connections → linked resource, identity find-or-create,
 * usage rollup). `connections` is seeded so the reconcile has a resource to
 * attribute the project's tables to.
 */
function fakeIngestPrisma(connections: { projectId: string; databaseResourceId: string | null }[]) {
  const created: any[] = [];
  const identities: IdRow[] = [];
  let n = 0;
  const graph = { id: "cg1" };
  const keyOf = (r: any) =>
    `${r.databaseResourceId}|${r.schemaName}|${r.objectName}|${r.objectType}`;
  const prisma = {
    // #16 — persistParsed batches per-file writes in a transaction.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    codeGraph: {
      findFirst: async () => null,
      create: async () => graph,
      update: async () => graph,
    },
    codeSymbol: {
      findMany: async ({ where }: any = {}) =>
        created.filter(
          (s) =>
            (!where?.projectId || s.projectId === where.projectId) &&
            (!where?.kind?.in || where.kind.in.includes(s.kind)) &&
            (!where?.filePath?.in || where.filePath.in.includes(s.filePath)),
        ),
      findFirst: async () => null,
      create: async ({ data }: any) => {
        const row = { ...data, id: `s${++n}` };
        created.push(row);
        return { id: row.id };
      },
      deleteMany: async () => ({ count: 0 }),
      count: async () => created.length,
      groupBy: async () => [],
    },
    codeEdge: {
      createMany: async ({ data }: any) => {
        for (const d of data) await prisma.codeEdge.create({ data: d });
        return { count: data.length };
      },
      create: async () => undefined,
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
    codeSymbolEmbedding: { createMany: async () => ({ count: 0 }) },
    finding: { create: async () => ({}), findFirst: async () => null },
    databaseConnection: {
      findMany: async ({ where, select }: any) => {
        let rows = connections;
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
    schemaObjectIdentity: {
      findFirst: async ({ where }: any) =>
        identities.find((r) => keyOf(r) === keyOf(where)) ?? null,
      create: async ({ data }: any) => {
        const row: IdRow = { id: `id_${++n}`, usageClass: null, ...data };
        identities.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = identities.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    schemaUsageClassification: { findMany: async () => [] },
  };
  return { prisma, created, identities };
}

describe("ingestCodeGraph reconciles SchemaObjectIdentity end-to-end (#955)", () => {
  it("creates canonical identity rows for the project's tables when a resource is linked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-ingest-"));
    writeFileSync(join(dir, "schema.prisma"), prismaSrc);
    // The project's connection is linked to a shared DatabaseResource.
    const { prisma, created, identities } = fakeIngestPrisma([
      { projectId: "p1", databaseResourceId: "res-1" },
    ]);

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // The ORM pass produced a `table` symbol (accounts, via @@map).
    expect(created.some((s) => s.kind === "table" && s.name === "accounts")).toBe(true);
    // The #955 wiring: a canonical identity now exists for it under the resource.
    // Remove the reconcile call from ingestCodeGraph and this fails.
    const acct = identities.find((i) => i.objectName === "accounts" && i.objectType === "table");
    expect(acct).toBeDefined();
    expect(acct?.databaseResourceId).toBe("res-1");
  });

  it("creates NO identities when the project has no linked resource (conservative)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-ingest-unlinked-"));
    writeFileSync(join(dir, "schema.prisma"), prismaSrc);
    const { prisma, created, identities } = fakeIngestPrisma([
      { projectId: "p1", databaseResourceId: null },
    ]);

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // Tables still produced, but no identity is invented without a linked DB.
    expect(created.some((s) => s.kind === "table")).toBe(true);
    expect(identities).toHaveLength(0);
  });
});
