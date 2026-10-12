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
}));
const connectors = vi.hoisted(() => ({
  listDbConnectors: vi.fn(),
  inspectDbConnector: vi.fn(),
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("../connectors/db/db-service.js", () => connectors);

import {
  isTypedInventory,
  NO_SCHEMA_INVENTORY,
  plainSchemaText,
  renderSchemaPromptBlock,
  renderSchemaReference,
  tablesFromIntrospection,
  tablesFromRepositorySql,
  tablesFromSchemaGraph,
  type SchemaInventory,
} from "./schema-inventory.js";
import { loadSchemaInventory, type SchemaInventoryDeps } from "./schema-inventory-loader.js";

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
    ...over,
  });
  const load = (over: Partial<SchemaInventoryDeps> = {}, actorId: string | undefined = "u1") =>
    loadSchemaInventory({ projectId: "p", actorId, timeoutMs: 20 }, deps(over));

  it("reads every connector live and calls the result current", async () => {
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
    expect(inventory.current).toBe(true);
    expect(inventory.label).toBe('the live schema of "one", "c2"');
    // Sorted, so the same schema hashes the same whatever order it was read in.
    expect(inventory.tables.map((t) => t.name)).toEqual(["feeds", "users"]);
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
    expect(inventory.current).toBe(false);
    expect(inventory.label).toBe('the stored schema graph of "miniflux-pg" generated 2026-10-10');
    expect(inventory.tables).toHaveLength(2);
  });

  it("is not current when one of several databases was read from a stored graph", async () => {
    const inventory = await load({
      listConnectors: async () => [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
      introspect: async (_p, connectorId) => {
        if (connectorId !== "c1") throw new Error("down");
        return [USERS];
      },
      readSchemaGraphs: async () => [{ dbConnectorId: "c2", graph: GRAPH, generatedAt: null }],
    });
    expect(inventory.source).toBe("schema-graph");
    expect(inventory.current).toBe(false);
    expect(inventory.label).toBe(
      'the live schema of "c1"; the stored schema graph of "c2"; 1 further database(s) could not be read',
    );
  });

  it("is not current when a database could not be read at all", async () => {
    const inventory = await load({
      listConnectors: async () => [{ id: "c1" }, { id: "c2" }],
      introspect: async (_p, connectorId) => {
        if (connectorId === "c2") throw new Error("down");
        return [USERS];
      },
    });
    expect(inventory.source).toBe("live-schema");
    expect(inventory.current).toBe(false);
  });

  it("gives up on a slow introspection and uses the stored graph", async () => {
    const inventory = await load({
      introspect: () => new Promise(() => undefined),
      readSchemaGraphs: async () => [{ dbConnectorId: "c1", graph: GRAPH, generatedAt: null }],
    });
    expect(inventory.source).toBe("schema-graph");
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
    expect(inventory.current).toBe(false);
    expect(inventory.tables).toHaveLength(2);
    expect(inventory.label).toBe(
      "the stored schema graph of a database document generated 2026-09-01",
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
    expect(inventory).toMatchObject({ source: "repository-sql", current: false });
    expect(isTypedInventory(inventory)).toBe(false);
  });

  it("falls through an empty live schema instead of trusting it", async () => {
    const inventory = await load({
      introspect: async () => [],
      readRepositorySql: async () => [{ kind: "table", name: "users", qualifiedName: "users" }],
    });
    expect(inventory.source).toBe("repository-sql");
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
    });

    it("introspects through the database document's own call, as the acting user", async () => {
      const inventory = await loadSchemaInventory({ projectId: "p", actorId: "u1" });
      expect(connectors.inspectDbConnector).toHaveBeenCalledWith("p", "c1", "u1");
      expect(inventory.source).toBe("live-schema");
      expect(inventory.tables[0].name).toBe("users");
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
  });
});

describe("rendering", () => {
  const typed: SchemaInventory = {
    source: "live-schema",
    label: 'the live schema of "miniflux-pg"',
    current: true,
    tables: tablesFromIntrospection([FEEDS, USERS]),
  };
  const untyped: SchemaInventory = {
    source: "repository-sql",
    label: "the SQL found in the repository",
    current: false,
    tables: tablesFromRepositorySql([
      { kind: "column", name: "id", qualifiedName: "users.id" },
      { kind: "column", name: "theme", qualifiedName: "users.theme" },
    ]),
  };

  it("gives the model each table's columns with their types and keys", () => {
    expect(renderSchemaPromptBlock(typed)).toBe(
      '=== DATABASE SCHEMA — from the live schema of "miniflux-pg". Format: table: column type [PK|FK], ... ===\n' +
        "- feeds: id bigint PK, user_id integer FK\n" +
        "- users: id integer PK, theme text\n" +
        "=== END SCHEMA ===",
    );
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
      '### Schema Reference\n\n> Rendered from the live schema of "miniflux-pg", not written by the model.',
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

  it("keeps a hostile identifier inside its cell", () => {
    expect(plainSchemaText("a`b|c\nd")).toBe("a b c d");
  });
});
