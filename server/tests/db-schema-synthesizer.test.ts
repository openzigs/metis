/**
 * DB Schema Synthesizer — unit tests.
 * Epic #672 / Issue #677.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbSchemaSnapshot, DbTableInfo } from "@metis/shared";

// ---------------------------------------------------------------------------
// Hoist mock functions before vi.mock factory runs
// ---------------------------------------------------------------------------
const { mockInspect, mockGetConnector } = vi.hoisted(() => ({
  mockInspect: vi.fn(),
  mockGetConnector: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock inspectDbConnector and db-service
// ---------------------------------------------------------------------------
vi.mock("../src/lib/connectors/db/db-service.js", () => ({
  inspectDbConnector: mockInspect,
  getDbConnector: mockGetConnector,
}));

// Mock AI provider — no LLM calls in unit tests.
//
// #1228: this stub used to answer with a FIXED `{"users":…,"orders":…}` payload
// regardless of what it was asked about, so in every test using other table
// names it described nothing — and the assertions still passed, because the
// banner counted attempts rather than descriptions. It now echoes back the
// tables named in the prompt, which is what a working model does.
vi.mock("../src/lib/ai/index.js", () => ({
  loadAIConfig: vi.fn(() => ({})),
  buildProvider: vi.fn(() => ({
    model: "us.anthropic.claude-sonnet-4-6-v1:0",
    chat: vi.fn(async (messages: Array<{ content: string }>) => {
      const prompt = messages[0]?.content ?? "";
      const descriptions: Record<string, string> = {};
      for (const m of prompt.matchAll(/^Table: (.+)$/gm)) {
        descriptions[m[1] as string] = `Stores rows for ${m[1] as string}.`;
      }
      return { content: JSON.stringify({ descriptions }), finishReason: "stop" };
    }),
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  synthesizeDbSchemaDocument,
  buildErDiagram,
  buildSchemaGraph,
  loadSynthConfig,
  MAX_TABLES_ER,
  DEFAULT_LLM_BATCH_SIZE,
  DEFAULT_LLM_CALL_BUDGET,
  DEFAULT_LLM_TOKEN_BUDGET,
} from "../../src/lib/docs-gen/db-schema-synthesizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTable(
  name: string,
  columns: Array<{
    name: string;
    dataType: string;
    isPrimaryKey?: boolean;
    isForeignKey?: boolean;
    nullable?: boolean;
  }>,
  foreignKeys: Array<{
    name: string;
    columns: string[];
    refTable: string;
    refColumns: string[];
  }> = [],
): DbTableInfo {
  return {
    schema: "public",
    name,
    columns: columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      isPrimaryKey: c.isPrimaryKey ?? false,
      isForeignKey: c.isForeignKey ?? false,
      nullable: c.nullable ?? true,
    })),
    foreignKeys: foreignKeys.map((fk) => ({
      ...fk,
      refSchema: "public",
    })),
    indexes: [],
  };
}

function makeSnapshot(tables: DbTableInfo[]): DbSchemaSnapshot {
  return {
    connectorId: "db_1",
    driver: "postgres",
    tables,
    extractedAt: new Date().toISOString(),
    durationMs: 42,
  };
}

// ---------------------------------------------------------------------------
// Tests: buildErDiagram
// ---------------------------------------------------------------------------

describe("buildErDiagram", () => {
  it("generates entity blocks for each table", () => {
    const tables = [
      makeTable("users", [
        { name: "id", dataType: "uuid", isPrimaryKey: true },
        { name: "email", dataType: "varchar(255)", nullable: false },
      ]),
    ];
    const diagram = buildErDiagram(tables);
    expect(diagram).toContain("erDiagram");
    expect(diagram).toContain("users {");
    expect(diagram).toContain('uuid id "PK"');
    expect(diagram).toContain("varchar email");
  });

  it("generates relationship lines from foreign keys", () => {
    const tables = [
      makeTable(
        "orders",
        [
          { name: "id", dataType: "uuid", isPrimaryKey: true },
          { name: "user_id", dataType: "uuid", isForeignKey: true },
        ],
        [{ name: "fk_orders_user", columns: ["user_id"], refTable: "users", refColumns: ["id"] }],
      ),
      makeTable("users", [{ name: "id", dataType: "uuid", isPrimaryKey: true }]),
    ];
    const diagram = buildErDiagram(tables);
    expect(diagram).toContain("orders }o--|| users");
    expect(diagram).toContain('"fk_orders_user"');
  });

  it("handles empty tables array", () => {
    const diagram = buildErDiagram([]);
    expect(diagram).toBe("erDiagram");
  });

  it("sanitizes table names with special characters", () => {
    const tables = [makeTable("public.orders", [{ name: "id", dataType: "int" }])];
    const diagram = buildErDiagram(tables);
    expect(diagram).toContain("public_orders {");
    expect(diagram).not.toContain("public.orders");
  });
});

// ---------------------------------------------------------------------------
// Tests: synthesizeDbSchemaDocument
// ---------------------------------------------------------------------------

describe("synthesizeDbSchemaDocument", () => {
  beforeEach(() => {
    mockGetConnector.mockResolvedValue({
      id: "db_1",
      projectId: "proj_1",
      label: "Production DB",
      driver: "postgres",
      host: "db.example.com",
      port: 5432,
      databaseName: "metis",
      username: "metis",
      secretRef: null,
      options: null,
      status: "connected",
      createdById: "u_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns a markdown document with overview, ER diagram, and table reference", async () => {
    const tables = [
      makeTable("users", [
        { name: "id", dataType: "uuid", isPrimaryKey: true },
        { name: "email", dataType: "varchar", nullable: false },
      ]),
      makeTable(
        "orders",
        [
          { name: "id", dataType: "uuid", isPrimaryKey: true },
          { name: "user_id", dataType: "uuid", isForeignKey: true },
        ],
        [{ name: "fk_orders_user", columns: ["user_id"], refTable: "users", refColumns: ["id"] }],
      ),
    ];
    mockInspect.mockResolvedValue(makeSnapshot(tables));

    const { markdown } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "My Schema");

    expect(markdown).toContain("# My Schema");
    expect(markdown).toContain("## Overview");
    expect(markdown).toContain("Production DB");
    expect(markdown).toContain("2 tables");
    expect(markdown).toContain("## Entity Relationship Diagram");
    expect(markdown).toContain("```mermaid");
    expect(markdown).toContain("erDiagram");
    expect(markdown).toContain("## Table Reference");
    expect(markdown).toContain("### users");
    expect(markdown).toContain("### orders");
  });

  it("returns empty document when no tables are found", async () => {
    mockInspect.mockResolvedValue(makeSnapshot([]));
    const { markdown } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Empty DB");
    expect(markdown).toContain("# Empty DB");
    expect(markdown).toContain("No tables were found");
    expect(markdown).not.toContain("erDiagram");
  });

  it("returns an error document when inspectDbConnector throws", async () => {
    mockInspect.mockRejectedValue(new Error("Connection refused"));
    const { markdown } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Bad DB");
    expect(markdown).toContain("# Bad DB");
    expect(markdown).toContain("Generation Error");
    expect(markdown).toContain("Connection refused");
    // Should NOT propagate — returns markdown instead
    expect(markdown).not.toContain("erDiagram");
  });

  it("embeds column constraints (PK, FK, NOT NULL) in the table reference", async () => {
    const tables = [
      makeTable("users", [
        { name: "id", dataType: "uuid", isPrimaryKey: true, nullable: false },
        { name: "email", dataType: "varchar", nullable: false },
        { name: "bio", dataType: "text", nullable: true },
      ]),
    ];
    mockInspect.mockResolvedValue(makeSnapshot(tables));

    const { markdown } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Users");

    expect(markdown).toContain("| id | uuid | PK, NOT NULL |");
    expect(markdown).toContain("| email | varchar | NOT NULL |");
    expect(markdown).toContain("| bio | text |  |");
  });

  it("handles singular table count grammar", async () => {
    const tables = [makeTable("config", [{ name: "key", dataType: "text" }])];
    mockInspect.mockResolvedValue(makeSnapshot(tables));
    const { markdown } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Config");
    expect(markdown).toContain("1 table");
    expect(markdown).not.toContain("1 tables");
  });
});

// ---------------------------------------------------------------------------
// Tests: loadSynthConfig (Issue #890)
// ---------------------------------------------------------------------------

describe("loadSynthConfig", () => {
  it("returns documented defaults when env is empty", () => {
    const cfg = loadSynthConfig({});
    expect(cfg.batchSize).toBe(DEFAULT_LLM_BATCH_SIZE);
    expect(cfg.maxTablesEr).toBe(MAX_TABLES_ER);
    expect(cfg.llmCallBudget).toBe(DEFAULT_LLM_CALL_BUDGET);
    expect(cfg.llmTokenBudget).toBe(DEFAULT_LLM_TOKEN_BUDGET);
  });

  it("honors env overrides", () => {
    const cfg = loadSynthConfig({
      DB_SCHEMA_SYNTH_BATCH_SIZE: "40",
      DB_SCHEMA_SYNTH_MAX_TABLES_ER: "25",
      DB_SCHEMA_SYNTH_LLM_CALL_BUDGET: "5",
      DB_SCHEMA_SYNTH_LLM_TOKEN_BUDGET: "1000",
    } as NodeJS.ProcessEnv);
    expect(cfg.batchSize).toBe(40);
    expect(cfg.maxTablesEr).toBe(25);
    expect(cfg.llmCallBudget).toBe(5);
    expect(cfg.llmTokenBudget).toBe(1000);
  });

  it("clamps batch size to 100 and ignores invalid values", () => {
    expect(
      loadSynthConfig({ DB_SCHEMA_SYNTH_BATCH_SIZE: "5000" } as NodeJS.ProcessEnv).batchSize,
    ).toBe(100);
    expect(
      loadSynthConfig({ DB_SCHEMA_SYNTH_BATCH_SIZE: "0" } as NodeJS.ProcessEnv).batchSize,
    ).toBe(DEFAULT_LLM_BATCH_SIZE);
    expect(
      loadSynthConfig({ DB_SCHEMA_SYNTH_BATCH_SIZE: "abc" } as NodeJS.ProcessEnv).batchSize,
    ).toBe(DEFAULT_LLM_BATCH_SIZE);
  });
});

// ---------------------------------------------------------------------------
// Tests: budget-bounded prose + ER cap (Issue #890)
// ---------------------------------------------------------------------------

describe("synthesizeDbSchemaDocument — budget bounding (#890)", () => {
  const ENV_KEYS = [
    "DB_SCHEMA_SYNTH_BATCH_SIZE",
    "DB_SCHEMA_SYNTH_MAX_TABLES_ER",
    "DB_SCHEMA_SYNTH_LLM_CALL_BUDGET",
    "DB_SCHEMA_SYNTH_LLM_TOKEN_BUDGET",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    mockGetConnector.mockResolvedValue({
      id: "db_1",
      projectId: "proj_1",
      label: "Big DB",
      driver: "postgres",
      host: "db.example.com",
      port: 5432,
      databaseName: "metis",
      username: "metis",
      secretRef: null,
      options: null,
      status: "connected",
      createdById: "u_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetAllMocks();
  });

  function manyTables(count: number): DbTableInfo[] {
    return Array.from({ length: count }, (_, i) =>
      makeTable(`t_${i}`, [{ name: "id", dataType: "uuid", isPrimaryKey: true }]),
    );
  }

  it("documents EVERY table in the Table Reference even when prose budget is exhausted", async () => {
    process.env.DB_SCHEMA_SYNTH_BATCH_SIZE = "5";
    process.env.DB_SCHEMA_SYNTH_LLM_CALL_BUDGET = "1"; // only first 5 tables get prose
    const tables = manyTables(20);
    mockInspect.mockResolvedValue(makeSnapshot(tables));

    const { markdown, warnings } = await synthesizeDbSchemaDocument(
      "proj_1",
      "db_1",
      "system",
      "Big",
    );

    // #1228 — the note reports tables actually DESCRIBED (the one batch that
    // ran), not tables attempted, and a graceful budget stop is not a warning.
    expect(markdown).toContain("prose descriptions were produced for 5 of 20 tables");
    expect(markdown).toContain("generation budget was reached");
    expect(warnings).toEqual([]);
    // Every table still documented in the reference
    for (let i = 0; i < 20; i++) {
      expect(markdown).toContain(`### t_${i}`);
    }
  });

  it("does NOT emit a budget note when all tables fit within budget", async () => {
    const tables = manyTables(3);
    mockInspect.mockResolvedValue(makeSnapshot(tables));
    const { markdown } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Small");
    expect(markdown).not.toContain("generation budget was reached");
    expect(markdown).toContain("### t_0");
  });

  it("caps the ER diagram at MAX_TABLES_ER and notes it, but lists all tables in the reference", async () => {
    process.env.DB_SCHEMA_SYNTH_MAX_TABLES_ER = "3";
    const tables = manyTables(6);
    mockInspect.mockResolvedValue(makeSnapshot(tables));

    const { markdown } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "ER");

    expect(markdown).toContain("Showing the first 3 of 6 tables");
    // ER block only includes first 3 entity blocks
    const erBlock = markdown.split("```mermaid")[1].split("```")[0];
    expect(erBlock).toContain("t_0 {");
    expect(erBlock).toContain("t_2 {");
    expect(erBlock).not.toContain("t_3 {");
    // All 6 tables in reference
    for (let i = 0; i < 6; i++) {
      expect(markdown).toContain(`### t_${i}`);
    }
  });

  it("never throws and produces a complete reference for a large schema with tiny budgets", async () => {
    process.env.DB_SCHEMA_SYNTH_BATCH_SIZE = "10";
    process.env.DB_SCHEMA_SYNTH_LLM_CALL_BUDGET = "2";
    process.env.DB_SCHEMA_SYNTH_LLM_TOKEN_BUDGET = "1";
    const tables = manyTables(200);
    mockInspect.mockResolvedValue(makeSnapshot(tables));

    const { markdown } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Huge");
    expect(markdown).toContain("### t_0");
    expect(markdown).toContain("### t_199");
    expect(markdown).toContain("200 tables");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildSchemaGraph (Epic #895)
// ---------------------------------------------------------------------------

describe("buildSchemaGraph", () => {
  it("maps every table to a node with columns and PK/FK/nullable flags", () => {
    const tables = [
      makeTable("users", [
        { name: "id", dataType: "uuid", isPrimaryKey: true, nullable: false },
        { name: "email", dataType: "varchar", nullable: false },
      ]),
    ];
    const descriptions = new Map<string, string>([["users", "Stores user accounts."]]);

    const graph = buildSchemaGraph(tables, descriptions);

    expect(graph.tables).toHaveLength(1);
    const [node] = graph.tables;
    expect(node.id).toBe("public.users");
    expect(node.schema).toBe("public");
    expect(node.name).toBe("users");
    expect(node.description).toBe("Stores user accounts.");
    expect(node.columns).toEqual([
      { name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true, isForeignKey: false },
      {
        name: "email",
        dataType: "varchar",
        nullable: false,
        isPrimaryKey: false,
        isForeignKey: false,
      },
    ]);
  });

  it("derives a directed edge for each foreign key", () => {
    const tables = [
      makeTable(
        "orders",
        [
          { name: "id", dataType: "uuid", isPrimaryKey: true },
          { name: "user_id", dataType: "uuid", isForeignKey: true },
        ],
        [{ name: "fk_orders_user", columns: ["user_id"], refTable: "users", refColumns: ["id"] }],
      ),
      makeTable("users", [{ name: "id", dataType: "uuid", isPrimaryKey: true }]),
    ];

    const graph = buildSchemaGraph(tables, new Map());

    expect(graph.edges).toEqual([
      {
        source: "public.orders",
        target: "public.users",
        sourceSchema: "public",
        targetSchema: "public",
        columns: ["user_id"],
        refColumns: ["id"],
      },
    ]);
  });

  it("defaults description to empty string when none is provided", () => {
    const tables = [makeTable("config", [{ name: "key", dataType: "text" }])];
    const graph = buildSchemaGraph(tables, new Map());
    expect(graph.tables[0].description).toBe("");
  });

  it("returns empty tables and edges for an empty schema", () => {
    const graph = buildSchemaGraph([], new Map());
    expect(graph.tables).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it("produces a multi-column composite-key edge", () => {
    const tables = [
      makeTable(
        "order_items",
        [
          { name: "order_id", dataType: "uuid", isForeignKey: true },
          { name: "sku", dataType: "varchar", isForeignKey: true },
        ],
        [
          {
            name: "fk_oi_order",
            columns: ["order_id", "sku"],
            refTable: "orders",
            refColumns: ["id", "sku"],
          },
        ],
      ),
    ];
    const graph = buildSchemaGraph(tables, new Map());
    expect(graph.edges[0]).toEqual({
      source: "public.order_items",
      target: "public.orders",
      sourceSchema: "public",
      targetSchema: "public",
      columns: ["order_id", "sku"],
      refColumns: ["id", "sku"],
    });
  });

  it("keeps same-named tables in different schemas distinct with correctly-routed FK edges", () => {
    // Two tables both named "account" living in different schemas, plus a
    // "ledger" in sales whose FK references sales.account specifically. On the
    // multi-schema Oracle target these must NOT collapse into one node.
    const tables: DbTableInfo[] = [
      {
        schema: "sales",
        name: "account",
        columns: [
          {
            name: "id",
            dataType: "number",
            nullable: false,
            isPrimaryKey: true,
            isForeignKey: false,
          },
        ],
        foreignKeys: [],
        indexes: [],
      },
      {
        schema: "hr",
        name: "account",
        columns: [
          {
            name: "id",
            dataType: "number",
            nullable: false,
            isPrimaryKey: true,
            isForeignKey: false,
          },
        ],
        foreignKeys: [],
        indexes: [],
      },
      {
        schema: "sales",
        name: "ledger",
        columns: [
          {
            name: "id",
            dataType: "number",
            nullable: false,
            isPrimaryKey: true,
            isForeignKey: false,
          },
          {
            name: "account_id",
            dataType: "number",
            nullable: false,
            isPrimaryKey: false,
            isForeignKey: true,
          },
        ],
        foreignKeys: [
          {
            name: "fk_ledger_account",
            columns: ["account_id"],
            refTable: "account",
            refSchema: "sales",
            refColumns: ["id"],
          },
        ],
        indexes: [],
      },
    ];

    const graph = buildSchemaGraph(tables, new Map());

    // Two distinct nodes for the same-named tables, keyed by schema.
    const ids = graph.tables.map((t) => t.id);
    expect(ids).toEqual(["sales.account", "hr.account", "sales.ledger"]);
    expect(new Set(ids).size).toBe(3);

    // The FK routes to sales.account (its refSchema) — never to hr.account.
    expect(graph.edges).toEqual([
      {
        source: "sales.ledger",
        target: "sales.account",
        sourceSchema: "sales",
        targetSchema: "sales",
        columns: ["account_id"],
        refColumns: ["id"],
      },
    ]);
  });

  it("falls back to the source table's schema when refSchema is absent", () => {
    const tables: DbTableInfo[] = [
      {
        schema: "inventory",
        name: "item",
        columns: [
          {
            name: "id",
            dataType: "number",
            nullable: false,
            isPrimaryKey: true,
            isForeignKey: false,
          },
        ],
        foreignKeys: [],
        indexes: [],
      },
      {
        schema: "inventory",
        name: "stock",
        columns: [
          {
            name: "item_id",
            dataType: "number",
            nullable: false,
            isPrimaryKey: false,
            isForeignKey: true,
          },
        ],
        foreignKeys: [
          {
            name: "fk_stock_item",
            columns: ["item_id"],
            refTable: "item",
            // refSchema intentionally omitted → falls back to source schema.
            refColumns: ["id"],
          },
        ],
        indexes: [],
      },
    ];

    const graph = buildSchemaGraph(tables, new Map());

    expect(graph.edges).toEqual([
      {
        source: "inventory.stock",
        target: "inventory.item",
        sourceSchema: "inventory",
        targetSchema: "inventory",
        columns: ["item_id"],
        refColumns: ["id"],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests: synthesizeDbSchemaDocument schema-graph output (Epic #895)
// ---------------------------------------------------------------------------

describe("synthesizeDbSchemaDocument — schema graph", () => {
  beforeEach(() => {
    mockGetConnector.mockResolvedValue({ id: "db_1", projectId: "proj_1", label: "Prod" });
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns a structured schema graph alongside the markdown", async () => {
    const tables = [
      makeTable(
        "orders",
        [
          { name: "id", dataType: "uuid", isPrimaryKey: true },
          { name: "user_id", dataType: "uuid", isForeignKey: true },
        ],
        [{ name: "fk_orders_user", columns: ["user_id"], refTable: "users", refColumns: ["id"] }],
      ),
      makeTable("users", [{ name: "id", dataType: "uuid", isPrimaryKey: true }]),
    ];
    mockInspect.mockResolvedValue(makeSnapshot(tables));

    const { schemaGraph } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Schema");

    expect(schemaGraph).not.toBeNull();
    expect(schemaGraph?.tables.map((t) => t.name)).toEqual(["orders", "users"]);
    expect(schemaGraph?.edges).toEqual([
      {
        source: "public.orders",
        target: "public.users",
        sourceSchema: "public",
        targetSchema: "public",
        columns: ["user_id"],
        refColumns: ["id"],
      },
    ]);
  });

  it("returns a null schema graph for an empty schema", async () => {
    mockInspect.mockResolvedValue(makeSnapshot([]));
    const { schemaGraph } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Empty");
    expect(schemaGraph).toBeNull();
  });

  it("returns a null schema graph when inspection fails", async () => {
    mockInspect.mockRejectedValue(new Error("boom"));
    const { schemaGraph } = await synthesizeDbSchemaDocument("proj_1", "db_1", "system", "Bad");
    expect(schemaGraph).toBeNull();
  });
});
