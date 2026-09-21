/**
 * Issue #955 — the connection-link write point reconciles schema identities.
 *
 * Besides schema ingest, the SECOND natural write point (per the issue) is when
 * an operator links / re-resolves a DatabaseConnection to a DatabaseResource:
 * `reresolveConnectionResource` / `linkConnectionToResourceExplicit`
 * (analysis-database-identity.ts) now reconcile the project's schema objects into
 * canonical identities so an operator who links AFTER ingest gets identities
 * without re-ingesting.
 *
 * REACHABILITY GUARD: this drives the REAL `reresolveConnectionResource` mutation
 * and asserts identity rows appear. Remove the `reconcileAfterLink` call from
 * that function and the identity assertion goes red. Prisma + audit fully faked.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fake */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { reresolveConnectionResource } from "../src/lib/cross-project/analysis-database-identity.js";

interface IdRow {
  id: string;
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: string;
  usageClass: string | null;
}

function makeDb() {
  const project = { id: "p1", workspaceId: "w1" };
  const connection: any = {
    id: "c1",
    projectId: "p1",
    driver: "postgres",
    host: "db",
    port: 5432,
    databaseName: "app",
    databaseResourceId: null as string | null,
    deletedAt: null,
  };
  const resources: any[] = [];
  const symbols = [
    { projectId: "p1", kind: "table", qualifiedName: "app.accounts" },
    { projectId: "p1", kind: "table", qualifiedName: "app.orders" },
  ];
  const identities: IdRow[] = [];
  let seq = 0;
  const keyOf = (r: any) =>
    `${r.databaseResourceId}|${r.schemaName}|${r.objectName}|${r.objectType}`;

  const db: any = {
    project: {
      findUnique: async ({ where }: any) =>
        where.id === project.id ? { workspaceId: project.workspaceId } : null,
    },
    databaseResource: {
      findFirst: async ({ where }: any) =>
        resources.find(
          (r) =>
            r.workspaceId === where.workspaceId &&
            r.driver === where.driver &&
            r.host === where.host &&
            r.port === where.port &&
            r.databaseName === where.databaseName,
        ) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `res-${++seq}`, ...data };
        resources.push(row);
        return { id: row.id };
      },
    },
    databaseConnection: {
      findFirst: async ({ where }: any) => {
        if (where.id !== connection.id || where.projectId !== connection.projectId) return null;
        return {
          id: connection.id,
          driver: connection.driver,
          host: connection.host,
          port: connection.port,
          databaseName: connection.databaseName,
          databaseResourceId: connection.databaseResourceId,
          project: { workspaceId: project.workspaceId },
        };
      },
      findMany: async ({ where, select }: any) => {
        let rows = [connection].filter((c) => c.deletedAt == null);
        if (where.projectId != null) rows = rows.filter((c) => c.projectId === where.projectId);
        if (where.databaseResourceId?.not === null) {
          rows = rows.filter((c) => c.databaseResourceId != null);
        } else if (typeof where.databaseResourceId === "string") {
          rows = rows.filter((c) => c.databaseResourceId === where.databaseResourceId);
        }
        if (select?.projectId) return rows.map((c) => ({ projectId: c.projectId }));
        return rows.map((c) => ({ databaseResourceId: c.databaseResourceId }));
      },
      update: async ({ data }: any) => {
        connection.databaseResourceId = data.databaseResourceId;
        return connection;
      },
    },
    codeSymbol: {
      findMany: async ({ where }: any) => {
        const kinds: string[] = where?.kind?.in ?? [];
        return symbols
          .filter((s) => s.projectId === where.projectId && kinds.includes(s.kind))
          .map((s) => ({ kind: s.kind, qualifiedName: s.qualifiedName }));
      },
    },
    schemaObjectIdentity: {
      findFirst: async ({ where }: any) =>
        identities.find((r) => keyOf(r) === keyOf(where)) ?? null,
      create: async ({ data }: any) => {
        const row: IdRow = { id: `id_${++seq}`, usageClass: null, ...data };
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
  return { db, connection, identities };
}

describe("reresolveConnectionResource reconciles identities (#955 write point b)", () => {
  it("links the connection AND creates identities for the project's tables", async () => {
    const { db, connection, identities } = makeDb();

    const res = await reresolveConnectionResource(
      { projectId: "p1", connectionId: "c1", actorId: "u1" },
      db,
    );

    // The connection got linked to a freshly-created resource.
    expect(res.changed).toBe(true);
    expect(res.databaseResourceId).toBeTruthy();
    expect(connection.databaseResourceId).toBe(res.databaseResourceId);

    // #955 — identities now exist for the project's tables under that resource.
    // Remove reconcileAfterLink from reresolveConnectionResource → this goes red.
    expect(identities.map((i) => i.objectName).sort()).toEqual(["accounts", "orders"]);
    expect(identities.every((i) => i.databaseResourceId === res.databaseResourceId)).toBe(true);
  });

  it("an already-linked connection is a no-op and reconciles nothing new here", async () => {
    const { db, connection, identities } = makeDb();
    connection.databaseResourceId = "res-existing"; // pre-linked

    const res = await reresolveConnectionResource(
      { projectId: "p1", connectionId: "c1", actorId: "u1" },
      db,
    );

    expect(res.changed).toBe(false);
    // No link change → no reconcile from this path (ingest already owns it).
    expect(identities).toHaveLength(0);
  });
});
