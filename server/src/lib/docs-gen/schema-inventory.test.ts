/**
 * #1061 — the schema inventory: what each source is turned into, how it is
 * read (live, then a stored graph, then repository SQL, then nothing), and
 * what is rendered from it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbTableInfo, SchemaGraph } from "@metis/shared";

const db = vi.hoisted(() => ({
  generatedDocument: { findMany: vi.fn() },
  codeSymbol: { findMany: vi.fn() },
  codeEdge: { findMany: vi.fn() },
}));
const connectors = vi.hoisted(() => ({
  listDbConnectors: vi.fn(),
  inspectDbConnector: vi.fn(),
}));
/** The loader's logger, so what it writes about a failure can be read back. */
const logged = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("../connectors/db/db-service.js", () => connectors);
vi.mock("../logger.js", async (original) => ({
  ...(await original<typeof import("../logger.js")>()),
  createChildLogger: () => logged,
}));

import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  isTypedInventory,
  NO_SCHEMA_INVENTORY,
  plainConnectorLabel,
  plainSchemaText,
  renderSchemaCoverage,
  renderSchemaPromptBlock,
  renderSchemaReference,
  schemaComparisonWords,
  SCHEMA_REFERENCE_MAX_CHARS,
  tablesFromIntrospection,
  tablesFromRepositorySql,
  tablesFromSchemaGraph,
  type SchemaInventory,
} from "./schema-inventory.js";
import {
  breakAutolinks,
  buildErDiagram,
  escapeMarkdownCell,
  renderColumnTable,
} from "./schema-render.js";
import {
  datasetNamesFromLineage,
  LIVE_INTROSPECTION_CONCURRENCY,
  loadSchemaInventory,
  type SchemaInventoryDeps,
} from "./schema-inventory-loader.js";

const USERS: DbTableInfo = {
  schema: "public",
  name: "users",
  estimatedRowCount: 12,
  columns: [
    { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, isForeignKey: false },
    {
      name: "theme",
      dataType: "text",
      nullable: true,
      isPrimaryKey: false,
      isForeignKey: false,
      defaultValue: "'light'",
    },
  ],
  foreignKeys: [],
  indexes: [{ name: "users_pkey", columns: ["id"], isUnique: true }],
};
const FEEDS: DbTableInfo = {
  schema: "public",
  name: "feeds",
  columns: [
    { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true, isForeignKey: false },
    {
      name: "user_id",
      dataType: "integer",
      nullable: false,
      isPrimaryKey: false,
      isForeignKey: true,
    },
  ],
  foreignKeys: [
    { name: "feeds_user_id_fkey", columns: ["user_id"], refTable: "users", refColumns: ["id"] },
  ],
  indexes: [],
};
const GRAPH: SchemaGraph = {
  tables: [
    {
      id: "public.users",
      schema: "public",
      name: "users",
      description: "Accounts.",
      columns: [
        {
          name: "id",
          dataType: "integer",
          nullable: false,
          isPrimaryKey: true,
          isForeignKey: false,
        },
      ],
    },
    {
      id: "public.feeds",
      schema: "public",
      name: "feeds",
      description: "",
      columns: [
        {
          name: "user_id",
          dataType: "integer",
          nullable: false,
          isPrimaryKey: false,
          isForeignKey: true,
        },
      ],
    },
  ],
  edges: [
    {
      source: "public.feeds",
      target: "public.users",
      sourceSchema: "public",
      targetSchema: "public",
      columns: ["user_id"],
      refColumns: ["id"],
    },
  ],
};

describe("conversions into the inventory", () => {
  it("keeps what the section reads from introspection and drops what changes per run", () => {
    const [users, feeds] = tablesFromIntrospection([USERS, FEEDS]);
    expect(users).toEqual({
      schema: "public",
      name: "users",
      columns: [
        {
          name: "id",
          dataType: "integer",
          nullable: false,
          isPrimaryKey: true,
          isForeignKey: false,
        },
        {
          name: "theme",
          dataType: "text",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
          defaultValue: "'light'",
        },
      ],
      foreignKeys: [],
    });
    // A row count would change the section's reuse hash on every run.
    expect(JSON.stringify(users)).not.toContain("estimatedRowCount");
    expect(feeds.foreignKeys).toEqual([
      { name: "feeds_user_id_fkey", columns: ["user_id"], refTable: "users" },
    ]);
    // Without a read to point at, a table carries none; with one, it does.
    expect("read" in users).toBe(false);
    expect(tablesFromIntrospection([USERS], 3)[0].read).toBe(3);
    expect(tablesFromSchemaGraph(GRAPH, 2).map((t) => t.read)).toEqual([2, 2]);
  });

  it("reads a stored schema graph, with its foreign keys from the edges", () => {
    const [users, feeds] = tablesFromSchemaGraph(GRAPH);
    expect(users.columns.map((c) => c.name)).toEqual(["id"]);
    expect(feeds.foreignKeys).toEqual([
      { name: "feeds_user_id_fkey", columns: ["user_id"], refTable: "users" },
    ]);
  });

  it("returns nothing for stored JSON that is not a schema graph", () => {
    for (const bad of [null, undefined, "x", 3, {}, { tables: "no" }, { tables: [null, {}] }]) {
      expect(tablesFromSchemaGraph(bad)).toEqual([]);
    }
    const partial = tablesFromSchemaGraph({
      tables: [{ id: "t", name: "t", columns: [null, { name: "c" }] }],
    });
    expect(partial).toEqual([
      {
        schema: "",
        name: "t",
        columns: [
          { name: "c", dataType: "", nullable: true, isPrimaryKey: false, isForeignKey: false },
        ],
        foreignKeys: [],
      },
    ]);
    const dangling = tablesFromSchemaGraph({
      tables: [{ id: "a.t", name: "t", columns: [] }],
      edges: [{ source: "a.t", target: "other.gone", columns: ["x"] }, null],
    });
    expect(dangling[0].foreignKeys[0].refTable).toBe("gone");
  });

  it("builds untyped tables from the code graph's SQL symbols", () => {
    const tables = tablesFromRepositorySql([
      { kind: "table", name: "users", qualifiedName: "users" },
      { kind: "column", name: "theme", qualifiedName: "users.theme" },
      { kind: "column", name: "id", qualifiedName: "users.id" },
      { kind: "column", name: "id", qualifiedName: "users.id" },
      // A column whose table has no symbol of its own still names a table.
      { kind: "column", name: "title", qualifiedName: "public.feeds.title" },
      // The engine's catalogue and unresolved dynamic names are not the schema.
      { kind: "table", name: "columns", qualifiedName: "information_schema.columns" },
      { kind: "column", name: "x", qualifiedName: "information_schema.columns.x" },
      { kind: "table", name: "?dynamic:t", qualifiedName: "?dynamic:t" },
      { kind: "column", name: "?dynamic:c", qualifiedName: "users.?dynamic:c" },
      { kind: "column", name: "orphan", qualifiedName: "does-not-end-with-name" },
      { kind: "function", name: "f", qualifiedName: "f" },
    ]);
    expect(tables.map((t) => `${t.schema}|${t.name}|${t.columns.map((c) => c.name)}`)).toEqual([
      "|users|id,theme",
      "public|feeds|title",
    ]);
    expect(tables[0].columns[0].dataType).toBe("");
  });
});

describe("loadSchemaInventory", () => {
  const deps = (over: Partial<SchemaInventoryDeps> = {}): SchemaInventoryDeps => ({
    listConnectors: async () => [{ id: "c1", label: "miniflux-pg" }],
    introspect: async () => [USERS, FEEDS],
    readSchemaGraphs: async () => [],
    readRepositorySql: async () => [],
    readDatasetNames: async () => [],
    ...over,
  });
  const load = (over: Partial<SchemaInventoryDeps> = {}, actorId: string | undefined = "u1") =>
    loadSchemaInventory({ projectId: "p", actorId, timeoutMs: 20 }, deps(over));
  const never = (): Promise<never> => new Promise(() => undefined);

  beforeEach(() => {
    logged.warn.mockClear();
  });

  it("reads every connector live, and records which schemas each returned", async () => {
    const seen: string[] = [];
    const inventory = await load({
      listConnectors: async () => [{ id: "c1", label: "one" }, { id: "c2" }],
      introspect: async (_p, connectorId, actorId) => {
        seen.push(`${connectorId}:${actorId}`);
        return connectorId === "c1" ? [USERS] : [FEEDS];
      },
    });
    expect(seen).toEqual(["c1:u1", "c2:u1"]);
    expect(inventory.source).toBe("live-schema");
    expect(inventory.reads).toEqual([
      { connector: "one", how: "live", schemas: ["public"] },
      { connector: "c2", how: "live", schemas: ["public"] },
    ]);
    // The label names the schemas: "the live schema of X" alone would read as
    // the whole database when only its default schema was read.
    expect(inventory.label).toBe('the live schema of "one" (public), "c2" (public)');
    // Sorted, so the same schema hashes the same whatever order it was read in.
    expect(inventory.tables.map((t) => `${t.name}@${t.read}`)).toEqual(["feeds@1", "users@0"]);
  });

  it("records every schema a connector returned, and only those", async () => {
    const inventory = await load({
      introspect: async () => [USERS, { ...FEEDS, schema: "audit" }],
    });
    expect(inventory.reads).toEqual([
      { connector: "miniflux-pg", how: "live", schemas: ["audit", "public"] },
    ]);
    expect(inventory.label).toBe('the live schema of "miniflux-pg" (audit, public)');
  });

  it("an empty result beside a non-empty one is NOT a live read (#1061 review, blocking)", async () => {
    // B answers with no tables and no error: what a role without grants gets.
    const inventory = await load({
      listConnectors: async () => [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      introspect: async (_p, connectorId) => (connectorId === "a" ? [USERS] : []),
    });
    expect(inventory.reads).toEqual([
      { connector: "A", how: "live", schemas: ["public"] },
      { connector: "B", how: "unread", schemas: [] },
    ]);
    expect(inventory.label).toBe(
      'the live schema of "A" (public); 1 further database(s) could not be read',
    );
  });

  it("an empty live result falls back to that connector's stored graph", async () => {
    const inventory = await load({
      introspect: async () => [],
      readSchemaGraphs: async () => [{ dbConnectorId: "c1", graph: GRAPH, generatedAt: null }],
    });
    expect(inventory.source).toBe("schema-graph");
    expect(inventory.reads).toEqual([
      { connector: "miniflux-pg", how: "stored", schemas: ["public"] },
    ]);
  });

  it("falls back to that connector's stored graph when it cannot be read now", async () => {
    const inventory = await load({
      introspect: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
      },
      readSchemaGraphs: async () => [
        { dbConnectorId: "other", graph: { tables: [] }, generatedAt: null },
        { dbConnectorId: "c1", graph: GRAPH, generatedAt: new Date("2026-10-10T08:00:00Z") },
      ],
    });
    expect(inventory.source).toBe("schema-graph");
    expect(inventory.reads).toEqual([
      { connector: "miniflux-pg", how: "stored", schemas: ["public"], storedOn: "2026-10-10" },
    ]);
    expect(inventory.label).toBe(
      'the stored schema graph of "miniflux-pg" (public) generated 2026-10-10',
    );
    expect(inventory.tables).toHaveLength(2);
  });

  it("says which databases were read how when they differ", async () => {
    const inventory = await load({
      listConnectors: async () => [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
      introspect: async (_p, connectorId) => {
        if (connectorId !== "c1") throw new Error("down");
        return [USERS];
      },
      readSchemaGraphs: async () => [{ dbConnectorId: "c2", graph: GRAPH, generatedAt: null }],
    });
    expect(inventory.source).toBe("schema-graph");
    expect(inventory.reads.map((read) => read.how)).toEqual(["live", "stored", "unread"]);
    expect(inventory.label).toBe(
      'the live schema of "c1" (public); the stored schema graph of "c2" (public); ' +
        "1 further database(s) could not be read",
    );
    // Each table points at the read it came from.
    expect(inventory.tables.map((t) => `${t.name}@${t.read}`).sort()).toEqual([
      "feeds@1",
      "users@0",
      "users@1",
    ]);
  });

  it("logs a failed introspection by error class only, never its message (#1061 panel)", async () => {
    // A driver message names the host, the port and the database.
    class ConnectionRefused extends Error {
      override name = "ConnectionRefused";
    }
    await load({
      introspect: async () => {
        throw new ConnectionRefused("connect ECONNREFUSED 10.0.0.5:5432 db=payroll user=svc");
      },
      listConnectors: async () => [{ id: "c1", label: "miniflux-pg" }],
    });
    expect(logged.warn).toHaveBeenCalledWith("Schema inventory: live introspection failed", {
      projectId: "p",
      error: "ConnectionRefused",
    });
    const everything = JSON.stringify(logged.warn.mock.calls);
    for (const secret of ["10.0.0.5", "5432", "payroll", "svc", "ECONNREFUSED"]) {
      expect(everything).not.toContain(secret);
    }
    // A rejection that is not an Error has no class to name.
    logged.warn.mockClear();
    await load({ listConnectors: () => Promise.reject("postgres://svc:hunter2@10.0.0.5/payroll") });
    expect(logged.warn).toHaveBeenCalledWith("Schema inventory: listing connectors failed", {
      projectId: "p",
      error: "unknown",
    });
    expect(JSON.stringify(logged.warn.mock.calls)).not.toContain("hunter2");
  });

  it("gives up on a slow introspection and uses the stored graph", async () => {
    const inventory = await load({
      introspect: never,
      readSchemaGraphs: async () => [{ dbConnectorId: "c1", graph: GRAPH, generatedAt: null }],
    });
    expect(inventory.source).toBe("schema-graph");
    expect(logged.warn).toHaveBeenCalledWith("Schema inventory: live introspection abandoned", {
      projectId: "p",
      at: "its own limit",
    });
  });

  describe("a read the driver reports as cut (#1096)", () => {
    const APP: DbTableInfo = { ...USERS, schema: "APP", name: "T1" };
    const cutRead = (truncation: { tablesRead: number; tablesTotal?: number }) =>
      load({
        listConnectors: async () => [{ id: "c1", label: "ora", driver: "oracle" }],
        introspect: async () => ({
          tables: [APP],
          truncation: { rowsRead: 250_000, rowCeiling: 250_000, ...truncation },
        }),
      });

    it("is recorded with N of M tables, and the prompt says so", async () => {
      const inventory = await cutRead({ tablesRead: 1_200, tablesTotal: 4_000 });
      expect(inventory.reads).toEqual([
        {
          connector: "ora",
          how: "live",
          schemas: ["APP"],
          truncation: { tablesRead: 1_200, tablesTotal: 4_000 },
        },
      ]);
      expect(renderSchemaCoverage(inventory)).toContain(
        '- "ora": schema APP, read from the database now. This read was cut at the driver\'s ' +
          "row ceiling: only 1,200 of 4,000 tables were read, so tables are missing from it " +
          "and may still exist.",
      );
    });

    it("says so at the top of the Schema Reference", async () => {
      const inventory = await cutRead({ tablesRead: 1_200, tablesTotal: 4_000 });
      const reference = renderSchemaReference(inventory);
      expect(reference).toContain(
        "> **The schema was read partially.** The database catalog held more rows than one " +
          'read takes, so only some tables were read ("ora": 1,200 of 4,000 tables).',
      );
      expect(reference.indexOf("read partially")).toBeLessThan(reference.indexOf("```mermaid"));
    });

    it("names no total it does not have", async () => {
      const inventory = await cutRead({ tablesRead: 1_200 });
      expect(inventory.reads[0].truncation).toEqual({ tablesRead: 1_200 });
      expect(renderSchemaCoverage(inventory)).toContain(
        "only 1,200 tables (the total could not be counted) were read",
      );
    });

    it("is not recorded for a complete read, plain list or not", async () => {
      const plain = await load({ introspect: async () => [USERS] });
      expect(plain.reads[0].truncation).toBeUndefined();
      const complete = await load({
        introspect: async () => ({ tables: [USERS] }),
      });
      expect(complete.reads[0]).toEqual({
        connector: "miniflux-pg",
        how: "live",
        schemas: ["public"],
      });
      expect(renderSchemaReference(complete)).not.toContain("read partially");
    });

    it("is carried by a stored graph built from a cut read, and only a valid one", async () => {
      const stored = (truncation: unknown) =>
        load({
          introspect: async () => [],
          readSchemaGraphs: async () => [
            {
              dbConnectorId: "c1",
              graph: { ...GRAPH, truncation },
              generatedAt: null,
            },
          ],
        });
      expect((await stored({ tablesRead: 2, tablesTotal: 9 })).reads[0]).toEqual({
        connector: "miniflux-pg",
        how: "stored",
        schemas: ["public"],
        truncation: { tablesRead: 2, tablesTotal: 9 },
      });
      expect(renderSchemaCoverage(await stored({ tablesRead: 2, tablesTotal: 9 }))).toContain(
        "it may be out of date. This read was cut at the driver's row ceiling: only 2 of 9 tables",
      );
      expect((await stored({ tablesRead: 2, tablesTotal: "9" })).reads[0].truncation).toEqual({
        tablesRead: 2,
      });
      expect((await stored({ tablesRead: -1 })).reads[0].truncation).toBeUndefined();
      expect((await stored("cut")).reads[0].truncation).toBeUndefined();
      expect((await stored(null)).reads[0].truncation).toBeUndefined();
    });
  });

  describe("time (#1061 review)", () => {
    const five = async () => ["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id }));

    it("reads connectors concurrently, a bounded number at a time", async () => {
      let running = 0;
      let peak = 0;
      const order: string[] = [];
      const inventory = await loadSchemaInventory(
        { projectId: "p", actorId: "u1", concurrency: 2 },
        deps({
          listConnectors: five,
          introspect: async (_p, connectorId) => {
            order.push(connectorId);
            peak = Math.max(peak, ++running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running -= 1;
            return [USERS];
          },
        }),
      );
      expect(peak).toBe(2);
      expect(order).toEqual(["c1", "c2", "c3", "c4", "c5"]);
      expect(inventory.reads.map((read) => read.how)).toEqual(Array(5).fill("live"));
    });

    it("five connectors that never answer cost one timeout, not five", async () => {
      const started = performance.now();
      const inventory = await loadSchemaInventory(
        { projectId: "p", actorId: "u1", timeoutMs: 300 },
        deps({ listConnectors: five, introspect: never }),
      );
      // Sequential was 5 x 300 ms. With four at a time it is two rounds.
      expect(performance.now() - started).toBeLessThan(1_200);
      // Nothing was read, and the five databases stay on the record.
      expect(inventory).toEqual({
        source: "none",
        label: "no schema source; 5 database(s) could not be read",
        reads: ["c1", "c2", "c3", "c4", "c5"].map((connector) => ({
          connector,
          how: "unread",
          schemas: [],
        })),
        tables: [],
      });
    });

    it("stops at the overall deadline: what has not answered is not read", async () => {
      const started = performance.now();
      const calls: string[] = [];
      const inventory = await loadSchemaInventory(
        { projectId: "p", actorId: "u1", timeoutMs: 10_000, deadlineMs: 60, concurrency: 2 },
        deps({
          listConnectors: five,
          introspect: (_p, connectorId) => {
            calls.push(connectorId);
            return connectorId === "c1" ? Promise.resolve([USERS]) : never();
          },
        }),
      );
      expect(performance.now() - started).toBeLessThan(2_000);
      // c1 answered; c2 and c3 were in flight; c4 and c5 were never started.
      expect(calls).toEqual(["c1", "c2", "c3"]);
      expect(inventory.reads.map((read) => read.how)).toEqual([
        "live",
        "unread",
        "unread",
        "unread",
        "unread",
      ]);
    });

    it("leaves at most one abandoned read per worker behind (#1061 second review)", async () => {
      // Ten connectors that never answer. A worker whose read ran past its own
      // limit starts no other, so four are started and six are never touched.
      // Before, each worker went on to a second one: eight.
      const calls: string[] = [];
      const ten = async () => Array.from({ length: 10 }, (_, n) => ({ id: `c${n + 1}` }));
      const inventory = await loadSchemaInventory(
        { projectId: "p", actorId: "u1", timeoutMs: 20, deadlineMs: 300 },
        deps({
          listConnectors: ten,
          introspect: (_p, connectorId) => {
            calls.push(connectorId);
            return never();
          },
        }),
      );
      expect(LIVE_INTROSPECTION_CONCURRENCY).toBe(4);
      expect(calls).toEqual(["c1", "c2", "c3", "c4"]);
      expect(inventory.source).toBe("none");
      expect(inventory.reads.map((read) => read.how)).toEqual(Array(10).fill("unread"));
    });

    it("a read that fails, rather than hangs, does not stop its worker", async () => {
      const calls: string[] = [];
      await loadSchemaInventory(
        { projectId: "p", actorId: "u1", concurrency: 1 },
        deps({
          listConnectors: five,
          introspect: async (_p, connectorId) => {
            calls.push(connectorId);
            throw new Error("refused");
          },
        }),
      );
      expect(calls).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    });

    it("ends at once when the generation is cancelled, and returns nothing", async () => {
      const controller = new AbortController();
      const started = performance.now();
      const pending = loadSchemaInventory(
        { projectId: "p", actorId: "u1", timeoutMs: 10_000, signal: controller.signal },
        deps({
          introspect: never,
          readSchemaGraphs: async () => [{ dbConnectorId: "c1", graph: GRAPH, generatedAt: null }],
        }),
      );
      setTimeout(() => controller.abort(), 20);
      // Not the stored graph: a cancelled run has no use for an inventory.
      expect(await pending).toBe(NO_SCHEMA_INVENTORY);
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    it("does not start reading for a generation that is already cancelled", async () => {
      const controller = new AbortController();
      controller.abort();
      const introspect = vi.fn(async () => [USERS]);
      const inventory = await loadSchemaInventory(
        { projectId: "p", actorId: "u1", signal: controller.signal },
        deps({ introspect, listConnectors: never }),
      );
      expect(inventory).toBe(NO_SCHEMA_INVENTORY);
      expect(introspect).not.toHaveBeenCalled();
    });

    it("lets an abandoned introspection settle later without an unhandled rejection", async () => {
      let fail: (err: Error) => void = () => undefined;
      const inventory = await load({
        introspect: () => new Promise<never>((_, reject) => (fail = reject)),
      });
      expect(inventory.source).toBe("none");
      expect(inventory.reads).toEqual([{ connector: "miniflux-pg", how: "unread", schemas: [] }]);
      const unhandled = vi.fn();
      process.once("unhandledRejection", unhandled);
      fail(new Error("the driver gave up 90 s later"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.removeListener("unhandledRejection", unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });
  });

  it("skips the live tier without a user to run it as", async () => {
    const introspect = vi.fn(async () => [USERS]);
    const inventory = await load(
      {
        introspect,
        readSchemaGraphs: async () => [{ dbConnectorId: "c1", graph: GRAPH, generatedAt: null }],
      },
      "",
    );
    expect(introspect).not.toHaveBeenCalled();
    expect(inventory.source).toBe("schema-graph");
  });

  it("uses a database document's graph when the connector is gone", async () => {
    const inventory = await load({
      listConnectors: async () => [],
      readSchemaGraphs: async () => [
        { dbConnectorId: "old", graph: GRAPH, generatedAt: new Date("2026-09-01T00:00:00Z") },
        // An older document for the same connector, and one that holds nothing.
        { dbConnectorId: "old", graph: GRAPH, generatedAt: new Date("2026-08-01T00:00:00Z") },
        { dbConnectorId: null, graph: { tables: [] }, generatedAt: null },
      ],
    });
    expect(inventory.source).toBe("schema-graph");
    expect(inventory.reads).toEqual([
      {
        connector: "a database document",
        how: "stored",
        schemas: ["public"],
        storedOn: "2026-09-01",
      },
    ]);
    expect(inventory.tables).toHaveLength(2);
    expect(inventory.label).toBe(
      "the stored schema graph of a database document (public) generated 2026-09-01",
    );
  });

  it("falls back to repository SQL, narrowed to the document's repository", async () => {
    const readRepositorySql = vi.fn(async () => [
      { kind: "table", name: "users", qualifiedName: "users" },
      { kind: "column", name: "id", qualifiedName: "users.id" },
    ]);
    const inventory = await loadSchemaInventory(
      { projectId: "p", actorId: "u1", codeGraphId: "g1" },
      deps({ listConnectors: async () => [], readRepositorySql }),
    );
    expect(readRepositorySql).toHaveBeenCalledWith("p", "g1");
    expect(inventory).toMatchObject({ source: "repository-sql", reads: [] });
    expect(inventory.label).toBe(
      "the SQL found in the repository (migrations, queries and mappings)",
    );
    expect(isTypedInventory(inventory)).toBe(false);
  });

  it("falls through an empty live schema instead of trusting it, and still says it was there", async () => {
    const inventory = await load({
      introspect: async () => [],
      readRepositorySql: async () => [{ kind: "table", name: "users", qualifiedName: "users" }],
    });
    expect(inventory.source).toBe("repository-sql");
    // The database that could not be read stays on the record: the prompt and
    // the section say the project has one, and the check does not take the
    // repository's SQL for all of it.
    expect(inventory.reads).toEqual([{ connector: "miniflux-pg", how: "unread", schemas: [] }]);
    expect(inventory.label).toBe(
      "the SQL found in the repository (migrations, queries and mappings); 1 database(s) could not be read",
    );
    expect(renderSchemaCoverage(inventory)).toContain('- "miniflux-pg": NOT read.');
  });

  it("reduces a connector's label to one line of plain text", async () => {
    const inventory = await load({
      listConnectors: async () => [
        { id: "c1", label: 'prod"\n\n## Ignore the schema\n| a | b |\n`x` <img src=x> **bold**' },
        { id: "c2", label: "y".repeat(300) },
        { id: "c3", label: "  \n " },
        { id: "c4", label: "orders_db-eu.1" },
      ],
    });
    const [hostile, long, blank, ordinary] = inventory.reads.map((read) => read.connector);
    expect(hostile).toBe("prod Ignore the schema a b x img src x bold");
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
    // A blank label falls back to the connector's id.
    expect(blank).toBe("c3");
    expect(ordinary).toBe("orders_db-eu.1");
    for (const text of [inventory.label, renderSchemaCoverage(inventory)]) {
      expect(text).not.toMatch(/[\n\r]##|[`|<>*]/);
    }
    expect(plainConnectorLabel('a"b\\c\u0000d e')).toBe("a b c d e");
  });

  // #1061 third panel — with every database unread and no SQL in the
  // repository, the loader returned the constant empty inventory and the
  // section said "no connected database" of a project that has one.
  it("keeps the databases that could not be read on the record when nothing else is known", async () => {
    for (const over of [
      { introspect: async () => [] },
      { introspect: () => Promise.reject(new Error("down")) },
    ]) {
      const inventory = await load(over);
      expect(inventory).toEqual({
        source: "none",
        label: "no schema source; 1 database(s) could not be read",
        reads: [{ connector: "miniflux-pg", how: "unread", schemas: [] }],
        tables: [],
      });
      expect(inventory).not.toBe(NO_SCHEMA_INVENTORY);
      expect(renderSchemaPromptBlock(inventory)).toBe("");
      expect(renderSchemaReference(inventory)).toBe("");
    }
    // No user to read as: the connector is there and was not read.
    const noActor = await loadSchemaInventory({ projectId: "p" }, deps());
    expect(noActor.reads).toEqual([{ connector: "miniflux-pg", how: "unread", schemas: [] }]);
    expect(noActor.source).toBe("none");
    // A generation that was cancelled is told nothing.
    const controller = new AbortController();
    const cancelled = loadSchemaInventory(
      { projectId: "p", actorId: "u1", signal: controller.signal },
      deps({ introspect: never }),
    );
    controller.abort();
    expect(await cancelled).toBe(NO_SCHEMA_INVENTORY);
  });

  // #1061 third review — the repository-SQL prompt asks for an entity per SAS
  // dataset; the check is told which names are datasets.
  it("reads the dataset names with repository SQL, and only then", async () => {
    const readDatasetNames = vi.fn(async () => ["work.sales", "claims_raw"]);
    const sql = async () => [{ kind: "table", name: "users", qualifiedName: "users" }];
    const inventory = await loadSchemaInventory(
      { projectId: "p", actorId: "u1", codeGraphId: "g1" },
      deps({ listConnectors: async () => [], readRepositorySql: sql, readDatasetNames }),
    );
    expect(readDatasetNames).toHaveBeenCalledWith("p", "g1");
    expect(inventory.source).toBe("repository-sql");
    expect(inventory.datasets).toEqual(["work.sales", "claims_raw"]);
    // None: the field is absent, so the section's reuse hash is what it was.
    const none = await load({ listConnectors: async () => [], readRepositorySql: sql });
    expect("datasets" in none).toBe(false);
    // A failing read costs the dataset names, not the inventory.
    const failed = await load({
      listConnectors: async () => [],
      readRepositorySql: sql,
      readDatasetNames: () => Promise.reject(new Error("db down")),
    });
    expect(failed.source).toBe("repository-sql");
    expect("datasets" in failed).toBe(false);
    // Not read on the live tier or when there is nothing to compare with.
    readDatasetNames.mockClear();
    await load({ readDatasetNames });
    await load({ introspect: async () => [], readDatasetNames });
    expect(readDatasetNames).not.toHaveBeenCalled();
  });

  it("datasetNamesFromLineage keeps the lineage edges' dataset names, distinct and sorted", () => {
    const edge = (metadata: string | null, toQualifiedName: string | null = null) => ({
      metadata,
      toQualifiedName,
    });
    expect(
      datasetNamesFromLineage([
        edge('{"lineage":"output","dataset":"work.sales"}'),
        edge('{"lineage":"input","dataset":" claims_raw "}'),
        edge('{"lineage":"input","dataset":"work.sales"}'),
        // The name falls back to the edge's target.
        edge('{"lineage":"input"}', "lib.members"),
        // Not lineage, not JSON, not an object, no name: skipped.
        edge('{"typeOnly":true,"note":"lineage"}', "x"),
        edge('{"lineage":"sideways","dataset":"y"}'),
        edge("{not json", "z"),
        edge("null", "w"),
        edge(null, "v"),
        edge('{"lineage":"output","dataset":"  "}'),
        edge('{"lineage":"output","dataset":7}', null),
      ]),
    ).toEqual(["claims_raw", "lib.members", "work.sales"]);
    const many = Array.from({ length: 6_000 }, (_, n) =>
      edge(JSON.stringify({ lineage: "output", dataset: `d${n}` })),
    );
    expect(datasetNamesFromLineage(many)).toHaveLength(5_000);
  });

  it("returns the empty inventory when there is no source, and never throws", async () => {
    expect(await load({ listConnectors: async () => [] })).toBe(NO_SCHEMA_INVENTORY);
    const failing = (): Promise<never> => Promise.reject(new Error("db down"));
    const inventory = await load({
      listConnectors: failing,
      introspect: failing,
      readSchemaGraphs: failing,
      readRepositorySql: failing,
    });
    expect(inventory).toBe(NO_SCHEMA_INVENTORY);
    expect(await load({ listConnectors: () => Promise.reject("not an error") })).toBe(
      NO_SCHEMA_INVENTORY,
    );
  });

  describe("production readers", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      connectors.listDbConnectors.mockResolvedValue([{ id: "c1", label: "miniflux-pg" }]);
      connectors.inspectDbConnector.mockResolvedValue({ tables: [USERS] });
      db.generatedDocument.findMany.mockResolvedValue([]);
      db.codeSymbol.findMany.mockResolvedValue([]);
      db.codeEdge.findMany.mockResolvedValue([]);
    });

    it("introspects through the database document's own call, as the acting user", async () => {
      const inventory = await loadSchemaInventory({ projectId: "p", actorId: "u1" });
      expect(connectors.inspectDbConnector).toHaveBeenCalledWith("p", "c1", "u1");
      expect(inventory.source).toBe("live-schema");
      expect(inventory.tables[0].name).toBe("users");
      expect(inventory.reads[0].truncation).toBeUndefined();
    });

    it("carries the snapshot's truncation into the read (#1096)", async () => {
      connectors.inspectDbConnector.mockResolvedValue({
        tables: [USERS],
        truncation: { rowsRead: 250_000, rowCeiling: 250_000, tablesRead: 1, tablesTotal: 7 },
      });
      const inventory = await loadSchemaInventory({ projectId: "p", actorId: "u1" });
      expect(inventory.reads[0].truncation).toEqual({ tablesRead: 1, tablesTotal: 7 });
    });

    it("reads stored graphs from database documents and tolerates a corrupt row", async () => {
      connectors.inspectDbConnector.mockRejectedValue(new Error("down"));
      db.generatedDocument.findMany.mockResolvedValue([
        { scopeFilter: "{not json", schemaGraph: "{}", generatedAt: null },
        { scopeFilter: '{"dbConnectorId":7}', schemaGraph: "null", generatedAt: null },
        {
          scopeFilter: '{"dbConnectorId":"c1"}',
          schemaGraph: JSON.stringify(GRAPH),
          generatedAt: null,
        },
      ]);
      const inventory = await loadSchemaInventory({ projectId: "p", actorId: "u1" });
      expect(db.generatedDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: "p", scope: "database", deletedAt: null, schemaGraph: { not: null } },
        }),
      );
      expect(inventory.source).toBe("schema-graph");
      expect(inventory.tables).toHaveLength(2);
    });

    it("reads the code graph's table and column symbols, scoped to a graph when given", async () => {
      connectors.listDbConnectors.mockResolvedValue([]);
      db.codeSymbol.findMany.mockResolvedValue([
        { kind: "table", name: "users", qualifiedName: "users" },
      ]);
      await loadSchemaInventory({ projectId: "p", codeGraphId: "g1" });
      expect(db.codeSymbol.findMany.mock.calls[0][0].where).toEqual({
        projectId: "p",
        kind: { in: ["table", "column"] },
        codeGraphId: "g1",
      });
      await loadSchemaInventory({ projectId: "p" });
      expect(db.codeSymbol.findMany.mock.calls[1][0].where).toEqual({
        projectId: "p",
        kind: { in: ["table", "column"] },
      });
    });

    it("reads the lineage edges for the dataset names, scoped the same way", async () => {
      connectors.listDbConnectors.mockResolvedValue([]);
      db.codeSymbol.findMany.mockResolvedValue([
        { kind: "table", name: "users", qualifiedName: "users" },
      ]);
      db.codeEdge.findMany.mockResolvedValue([
        { metadata: '{"lineage":"output","dataset":"work.sales"}', toQualifiedName: null },
        { metadata: '{"typeOnly":true}', toQualifiedName: "lineage" },
      ]);
      const inventory = await loadSchemaInventory({ projectId: "p", codeGraphId: "g1" });
      expect(inventory.datasets).toEqual(["work.sales"]);
      expect(db.codeEdge.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          projectId: "p",
          kind: "references",
          metadata: { contains: '"lineage"' },
          codeGraphId: "g1",
        },
        select: { metadata: true, toQualifiedName: true },
        take: 50_000,
      });
      await loadSchemaInventory({ projectId: "p" });
      expect(db.codeEdge.findMany.mock.calls[1][0].where).toEqual({
        projectId: "p",
        kind: "references",
        metadata: { contains: '"lineage"' },
      });
    });
  });
});

describe("schemaComparisonWords: what the names were compared with, per source (#1061 third panel)", () => {
  const read = (how: "live" | "stored" | "unread", storedOn?: string) => ({
    connector: "pg",
    how,
    schemas: how === "unread" ? [] : ["public"],
    ...(storedOn ? { storedOn } : {}),
  });

  it("a live read is the database schema, and can be incomplete", () => {
    expect(schemaComparisonWords({ source: "live-schema", reads: [read("live")] })).toEqual({
      what: "the database schema",
      caveat: "A database read can be incomplete",
    });
  });

  it("repository SQL is not called a database, and no read is mentioned", () => {
    for (const reads of [[], [read("unread")]]) {
      expect(schemaComparisonWords({ source: "repository-sql", reads })).toEqual({
        what: "the SQL found in the repository",
        caveat: "The repository's SQL is not the database",
      });
    }
  });

  it("a stored graph is the stored schema, with the day it is from", () => {
    expect(
      schemaComparisonWords({ source: "schema-graph", reads: [read("stored", "2026-10-10")] }),
    ).toEqual({
      what: "the stored schema from 2026-10-10",
      caveat: "A stored schema can be out of date, and the read it came from incomplete",
    });
    // Several graphs: each day once, in order. No day known: none is given.
    expect(
      schemaComparisonWords({
        source: "schema-graph",
        reads: [
          read("stored", "2026-10-10"),
          read("stored", "2026-09-01"),
          read("stored", "2026-10-10"),
          read("unread"),
        ],
      }).what,
    ).toBe("the stored schema from 2026-09-01, 2026-10-10");
    expect(schemaComparisonWords({ source: "schema-graph", reads: [read("stored")] }).what).toBe(
      "the stored schema",
    );
  });

  it("one database read now and another from a stored graph: both are said", () => {
    expect(
      schemaComparisonWords({
        source: "schema-graph",
        reads: [read("live"), read("stored", "2026-10-10")],
      }),
    ).toEqual({
      what: "the database schema, part of it the stored schema from 2026-10-10",
      caveat: "A database read can be incomplete, and a stored schema out of date",
    });
  });
});

describe("rendering", () => {
  const typed: SchemaInventory = {
    source: "live-schema",
    label: 'the live schema of "miniflux-pg" (public)',
    reads: [{ connector: "miniflux-pg", how: "live", schemas: ["public"] }],
    tables: tablesFromIntrospection([FEEDS, USERS], 0),
  };
  const untyped: SchemaInventory = {
    source: "repository-sql",
    label: "the SQL found in the repository",
    reads: [],
    tables: tablesFromRepositorySql([
      { kind: "column", name: "id", qualifiedName: "users.id" },
      { kind: "column", name: "theme", qualifiedName: "users.theme" },
    ]),
  };

  it("gives the model each table's columns with their types and keys", () => {
    expect(renderSchemaPromptBlock(typed)).toBe(
      '=== DATABASE SCHEMA — from the live schema of "miniflux-pg" (public). Format: table: column type [PK|FK], ... ===\n' +
        "- feeds: id bigint PK, user_id integer FK\n" +
        "- users: id integer PK, theme text\n" +
        "=== END SCHEMA ===",
    );
  });

  it("writes tables as schema.table when the list holds more than one schema", () => {
    const two: SchemaInventory = {
      ...typed,
      tables: [...typed.tables, { ...typed.tables[1], schema: "audit" }],
    };
    const block = renderSchemaPromptBlock(two);
    expect(block).toContain("- public.users: id integer PK, theme text");
    expect(block).toContain("- audit.users: id integer PK, theme text");
    expect(renderSchemaPromptBlock(two, 120)).toMatch(/Further tables .*audit\.users/);
  });

  it("tells the model what the schema covers, and that it is not the whole database", () => {
    expect(renderSchemaCoverage(typed)).toBe(
      "WHAT THE SCHEMA BELOW COVERS:\n" +
        '- "miniflux-pg": schema public, read from the database now.\n' +
        "Only each database's default schema is read, and a read lists only what the " +
        "connecting role may see. A table in any other schema, or in a database marked NOT " +
        "read, is absent from the list below and may still exist.",
    );
    const mixed = renderSchemaCoverage({
      ...typed,
      reads: [
        { connector: "A", how: "live", schemas: ["audit", "public"] },
        { connector: "B", how: "stored", schemas: ["dbo"], storedOn: "2026-10-10" },
        { connector: "C", how: "stored", schemas: [] },
        { connector: "D", how: "unread", schemas: [] },
      ],
    });
    expect(mixed).toContain('- "A": schemas audit, public, read from the database now.');
    expect(mixed).toContain(
      '- "B": schema dbo, from a schema graph stored on 2026-10-10; it may be out of date.',
    );
    expect(mixed).toContain(
      '- "C": its tables, from a schema graph stored earlier; it may be out of date.',
    );
    expect(mixed).toContain('- "D": NOT read.');
    // No database was involved: there is no coverage to state.
    expect(renderSchemaCoverage(untyped)).toBe("");
    expect(renderSchemaCoverage(NO_SCHEMA_INVENTORY)).toBe("");
  });

  it("says that names from repository SQL carry no types and may be historical", () => {
    const block = renderSchemaPromptBlock(untyped);
    expect(block).toContain("Types are not known");
    expect(block).toContain("a later migration dropped");
    expect(block).toContain("- users: id, theme");
  });

  it("renders nothing for an empty inventory", () => {
    expect(renderSchemaPromptBlock(NO_SCHEMA_INVENTORY)).toBe("");
    expect(renderSchemaReference(NO_SCHEMA_INVENTORY)).toBe("");
    expect(renderSchemaReference(untyped)).toBe("");
    expect(isTypedInventory({ ...typed, tables: [] })).toBe(false);
  });

  it("lists by name the tables that do not fit the prompt, and counts the rest", () => {
    const many: SchemaInventory = {
      ...typed,
      tables: Array.from({ length: 40 }, (_, n) => ({
        ...typed.tables[0],
        name: `table_number_${n}`,
      })),
    };
    const block = renderSchemaPromptBlock(many, 200);
    expect(block).toContain("- table_number_0: id bigint PK, user_id integer FK");
    expect(block).not.toContain("- table_number_5:");
    expect(block).toMatch(
      /Further tables \(columns not listed here\): table_number_\d+(, table_number_\d+)* and \d+ more/,
    );
    const roomy = renderSchemaPromptBlock({ ...many, tables: many.tables.slice(0, 5) }, 200);
    expect(roomy).toContain("Further tables (columns not listed here): table_number_");
    expect(roomy).not.toContain(" more");
  });

  it("renders the reference with the database document's own renderers", () => {
    const reference = renderSchemaReference(typed);
    expect(reference).toContain(
      '### Schema Reference\n\n> Rendered from the live schema of "miniflux-pg" (public), not written by the model.',
    );
    // Keys and relationships in the diagram; every column in the tables.
    expect(reference).toContain('  feeds }o--|| users : "feeds_user_id_fkey"');
    expect(reference).toContain('    integer user_id "FK"');
    expect(reference).not.toContain("text theme");
    expect(reference).toContain(
      "#### `users`\n\n| Column | Type | Constraints |\n|--------|------|-------------|\n" +
        "| id | integer | PK, NOT NULL |\n| theme | text | DEFAULT: 'light' |",
    );
  });

  it("writes no diagram for a schema with no primary or foreign key", () => {
    const keyless: SchemaInventory = {
      ...typed,
      tables: [
        {
          schema: "public",
          name: "events",
          read: 0,
          columns: [
            {
              name: "payload",
              dataType: "jsonb",
              nullable: true,
              isPrimaryKey: false,
              isForeignKey: false,
            },
          ],
          foreignKeys: [],
        },
      ],
    };
    const reference = renderSchemaReference(keyless);
    // A block holding only `erDiagram` does not render.
    expect(reference).not.toContain("```mermaid");
    expect(reference).not.toContain("erDiagram");
    expect(reference).toContain("#### `events`");
    expect(reference).toContain("| payload | jsonb |  |");
    // One key anywhere is enough to draw.
    expect(renderSchemaReference(typed)).toContain("```mermaid\nerDiagram\n  feeds {");
  });

  it("names the tables it does not list column by column", () => {
    const many: SchemaInventory = {
      ...typed,
      tables: Array.from({ length: 60 }, (_, n) => ({ ...typed.tables[0], name: `t${n}` })),
    };
    const reference = renderSchemaReference(many, 400);
    expect(reference).toContain("> The diagram shows the first 50 of 60 tables.");
    expect(reference).toContain("#### `t0`");
    expect(reference).not.toContain("#### `t30`");
    expect(reference).toMatch(/> \d+ further table\(s\) are not listed column by column here/);
    expect(reference).toContain("and ");
    expect(reference).toContain("The database document lists every column.");
  });

  it("is bounded on its own, since it is added after the section cap", () => {
    const wide: SchemaInventory = {
      ...typed,
      tables: Array.from({ length: 400 }, (_, n) => ({
        ...typed.tables[1],
        name: `table_${n}`,
        columns: Array.from({ length: 40 }, (_, c) => ({
          name: `column_${c}`,
          dataType: "character varying",
          nullable: true,
          isPrimaryKey: c === 0,
          isForeignKey: false,
        })),
      })),
    };
    // 30,000 characters of column tables, a 50-table diagram of key columns,
    // and the note naming at most 40 of the tables left out.
    expect(renderSchemaReference(wide).length).toBeLessThan(SCHEMA_REFERENCE_MAX_CHARS + 6_000);
  });

  it("keeps a hostile identifier inside its cell", () => {
    expect(plainSchemaText("a`b|c\nd")).toBe("a b c d");
  });

  it("keeps hostile schema text inside its table cell (#1061 review)", () => {
    const column = (name: string, dataType: string, defaultValue?: string) => ({
      name,
      dataType,
      nullable: true,
      isPrimaryKey: name === "id",
      isForeignKey: false,
      ...(defaultValue == null ? {} : { defaultValue }),
    });
    const hostile: SchemaInventory = {
      ...typed,
      tables: [
        {
          schema: "public",
          name: "notes",
          read: 0,
          columns: [
            column("id", "integer"),
            column("a|b", "text"),
            // The review's reproduction: a default that starts a new row.
            column("note", "text", "<img src=x>\n| injected | row |"),
            column("link", "te|xt\n## Heading", "[click](http://evil.example) `code` *bold*"),
            column("path", "text", "'C:\\temp\\|x'"),
          ],
          foreignKeys: [
            { name: 'fk"\n  evil }o--|| x : "y', columns: ["id"], refTable: "users\n}" },
          ],
        },
      ],
    };
    const reference = renderSchemaReference(hostile);
    const start = reference.indexOf("#### `notes`");
    const rows = reference.slice(start).split("\n").slice(2);
    // Header, delimiter and exactly one row per column: nothing injected one.
    expect(rows).toHaveLength(2 + 5);
    // Every row has exactly three cells once escaped pipes are set aside.
    for (const row of rows) {
      expect(row.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|")).toHaveLength(5);
    }
    expect(rows[3]).toBe("| a\\|b | text |  |");
    expect(rows[4]).toBe("| note | text | DEFAULT: &lt;img src=x> \\| injected \\| row \\| |");
    expect(rows[5]).toBe(
      "| link | te\\|xt ## Heading | DEFAULT: \\[click\\](http\u200b://evil.example) \\`code\\` \\*bold\\* |",
    );
    // A backslash before a pipe cannot un-escape it.
    expect(rows[6]).toBe("| path | text | DEFAULT: 'C:\\\\temp\\\\\\|x' |");
    expect(reference).not.toContain("<img");
    expect(reference).not.toContain("\n| injected | row |");
    expect(reference).not.toContain("\n## Heading");
    // The diagram: every name is reduced to word characters, on one line each.
    const diagram = reference.slice(
      reference.indexOf("```mermaid"),
      reference.indexOf("```\n\n####"),
    );
    expect(diagram.trimEnd().split("\n")).toEqual([
      "```mermaid",
      "erDiagram",
      "  notes {",
      '    integer id "PK"',
      "  }",
      '  notes }o--|| users__ : "fk____evil__o_____x____y"',
    ]);
    expect(escapeMarkdownCell("  plain_value  ")).toBe("plain_value");
    expect(escapeMarkdownCell("a\r\nb\tc\u2028d")).toBe("a b c d");
  });

  it("keeps a dollar sign, an entity and a bare URL as text (#1061 second review)", () => {
    // The viewer loads remark-math: two dollar signs would typeset what is between them.
    expect(escapeMarkdownCell("$9.99 to $19.99")).toBe("\\$9.99 to \\$19.99");
    expect(escapeMarkdownCell("$$x$$")).toBe("\\$\\$x\\$\\$");
    // A default holding the entity must not read like one holding the tag.
    expect(escapeMarkdownCell("&lt;b&gt;")).toBe("&amp;lt;b&amp;gt;");
    expect(escapeMarkdownCell("<b>")).toBe("&lt;b>");
    // GFM links a bare URL after escapes are resolved, so the trigger is split.
    const Z = "\u200b";
    expect(escapeMarkdownCell("https://evil.example/login")).toBe(`https${Z}://evil.example/login`);
    expect(breakAutolinks("see HTTP://x.y and www.evil.example or bob@evil.example")).toBe(
      `see HTTP${Z}://x.y and www${Z}.evil.example or bob${Z}@evil.example`,
    );
    for (const hostile of [
      "https://e.example",
      "http://e.example",
      "www.e.example",
      "a@e.example",
    ]) {
      const escaped = escapeMarkdownCell(hostile);
      expect(escaped).not.toMatch(/https?:\/\/|www\.|[\w.+-]@/);
      // Nothing is lost: the text is the same with the separator taken out.
      expect(escaped.split(Z).join("")).toBe(hostile);
    }
    expect(plainConnectorLabel("prod https://evil.example $$x$$ www.e.example")).toBe(
      `prod https${Z}://evil.example x www${Z}.e.example`,
    );
  });

  it("tells same-named tables apart in the reference (#1061 second review)", () => {
    const users = typed.tables.find((t) => t.name === "users")!;
    const feeds = typed.tables.find((t) => t.name === "feeds")!;
    const both: SchemaInventory = {
      ...typed,
      reads: [
        { connector: "prod", how: "live", schemas: ["public"] },
        { connector: "prod copy", how: "live", schemas: ["public"] },
      ],
      tables: [
        { ...users, read: 0 },
        { ...feeds, read: 0 },
        { ...users, read: 1 },
        { ...feeds, read: 1 },
      ],
    };
    const reference = renderSchemaReference(both);
    const headings = reference.split("\n").filter((line) => line.startsWith("#### "));
    expect(headings).toEqual([
      '#### `users` in "prod", schema `public`',
      '#### `feeds` in "prod", schema `public`',
      '#### `users` in "prod copy", schema `public`',
      '#### `feeds` in "prod copy", schema `public`',
    ]);
    // One entity per table in the diagram, and a key points inside its own database.
    const entities = reference.split("\n").filter((line) => line.trimEnd().endsWith("{"));
    expect(entities.map((line) => line.trim())).toEqual([
      "prod_public_users {",
      "prod_public_feeds {",
      "prod_copy_public_users {",
      "prod_copy_public_feeds {",
    ]);
    expect(reference).toContain("prod_public_feeds }o--|| prod_public_users :");
    expect(reference).toContain("prod_copy_public_feeds }o--|| prod_copy_public_users :");
    // A name held once is written as before.
    expect(renderSchemaReference(typed)).toContain("#### `users`\n");
    expect(renderSchemaReference(typed)).not.toContain(' in "');
  });

  describe("linear in what a database or a repository can hold (#1061 review)", () => {
    const one = (dataType: string): DbTableInfo => ({
      ...USERS,
      columns: [{ ...USERS.columns[0], dataType }],
    });

    it("a type of opening parentheses with no closing one", () => {
      // The pattern `\(.*\)` took 15.2 s here at 200 kB.
      expectLinearTime("sanitizeMermaidType", (size) => {
        const table = one("(".repeat(size));
        return () => buildErDiagram([table]);
      });
      expect(buildErDiagram([one("numeric(10,2)")])).toContain("    numeric id");
      expect(buildErDiagram([one("character varying(255)")])).toContain("    character_varying id");
      expect(buildErDiagram([one("a(b)c(d)e")])).toContain("    ae id");
      expect(buildErDiagram([one("(((")])).toContain("    ___ id");
      expect(buildErDiagram([one(")x(")])).toContain("    _x_ id");
      expect(buildErDiagram([one("")])).toContain("    text id");
    });

    it("hostile schema text through the column table", () => {
      expectLinearTime("renderColumnTable", (size) => {
        const table = one("|\\`".repeat(size / 3));
        return () => renderColumnTable(table);
      });
    });

    it("many columns of one table in the code graph", () => {
      // `columns.some` per symbol took 4.3 s at 50,000 columns.
      expectLinearTime("tablesFromRepositorySql", (size) => {
        const symbols = Array.from({ length: size / 4 }, (_, n) => ({
          kind: "column",
          name: `c${n}`,
          qualifiedName: `wide.c${n}`,
        }));
        return () => tablesFromRepositorySql(symbols);
      });
      const [wide] = tablesFromRepositorySql([
        { kind: "column", name: "b", qualifiedName: "wide.b" },
        { kind: "column", name: "a", qualifiedName: "wide.a" },
        { kind: "column", name: "b", qualifiedName: "wide.b" },
      ]);
      expect(wide.columns.map((c) => c.name)).toEqual(["a", "b"]);
    });

    it("a connector label of any length", () => {
      expectLinearTime("plainConnectorLabel", (size) => {
        const label = "`|*  ".repeat(size / 5);
        return () => plainConnectorLabel(label);
      });
    });
  });
});
