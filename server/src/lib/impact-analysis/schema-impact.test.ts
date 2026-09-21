import { describe, expect, it, vi } from "vitest";
import { SCHEMA_IMPACT_EDGE_KINDS } from "@metis/shared";
import {
  crossToSchema,
  detectAdditiveColumnIntent,
  DEFAULT_MAX_DOWNSTREAM_DEPTH,
  DIRECT_SCHEMA_HIT_CONFIDENCE,
  DOWNSTREAM_DATA_LAYER_DECAY,
  PrismaSchemaImpactDataSource,
  suggestDdl,
  type SchemaImpactDataSource,
} from "./schema-impact.js";
import { LiveSchemaIndex } from "./live-schema-ingest.js";
import type { DbSchemaSnapshot } from "@metis/shared";

function liveIndex(): LiveSchemaIndex {
  const snapshot: DbSchemaSnapshot = {
    connectorId: "c",
    driver: "postgres",
    extractedAt: new Date().toISOString(),
    durationMs: 1,
    tables: [
      {
        schema: "crm",
        name: "customers",
        columns: [
          {
            name: "id",
            dataType: "bigint",
            nullable: false,
            isPrimaryKey: true,
            isForeignKey: false,
          },
          {
            name: "email_address",
            dataType: "varchar(255)",
            nullable: false,
            isPrimaryKey: false,
            isForeignKey: false,
          },
        ],
        foreignKeys: [],
        indexes: [],
      },
    ],
  };
  return LiveSchemaIndex.fromSnapshot(snapshot);
}

describe("suggestDdl", () => {
  it("suggests add-table for a table-not-found ref", () => {
    const out = suggestDdl({
      tableName: "crm.ghosts",
      columnName: null,
      reconciliation: "table-not-found",
      columnType: null,
    });
    expect(out.changeKind).toBe("add-table");
    expect(out.suggestedDdl).toContain("CREATE TABLE crm.ghosts");
  });

  it("suggests add-column with the live type for a column-not-found ref", () => {
    const out = suggestDdl({
      tableName: "crm.customers",
      columnName: "nickname",
      reconciliation: "column-not-found",
      columnType: "varchar(64)",
    });
    expect(out.changeKind).toBe("add-column");
    expect(out.suggestedDdl).toBe("ALTER TABLE crm.customers ADD COLUMN nickname varchar(64);");
  });

  it("falls back to a reference comment for matched refs", () => {
    expect(
      suggestDdl({
        tableName: "crm.customers",
        columnName: "id",
        reconciliation: "matched",
        columnType: "bigint",
      }).changeKind,
    ).toBe("reference");
    expect(
      suggestDdl({
        tableName: "crm.customers",
        columnName: null,
        reconciliation: null,
        columnType: null,
      }).suggestedDdl,
    ).toContain("Verify table crm.customers");
  });

  // #923 — additive-intent suggestion (no live schema). suggestDdl emits a
  // TEXT-ONLY ADD COLUMN suggestion when an additive intent is supplied for the
  // matched TABLE row and there is no live reconciliation to diff against.
  it("suggests a text-only ADD COLUMN from additive intent when there is no live schema", () => {
    const out = suggestDdl({
      tableName: "account",
      columnName: null,
      reconciliation: null,
      columnType: null,
      additive: {
        columnName: "status",
        columnType: "BOOLEAN",
        entity: "account",
        confidence: "medium",
      },
    });
    expect(out.changeKind).toBe("add-column");
    expect(out.suggestedDdl).toContain("ALTER TABLE account ADD COLUMN status BOOLEAN;");
    // Clearly marked as a suggestion, not an executed change.
    expect(out.suggestedDdl.toUpperCase()).toContain("SUGGESTED");
  });

  it("uses a placeholder type when the additive intent could not infer one", () => {
    const out = suggestDdl({
      tableName: "account",
      columnName: null,
      reconciliation: null,
      columnType: null,
      additive: { columnName: "note", columnType: null, entity: "account", confidence: "low" },
    });
    expect(out.changeKind).toBe("add-column");
    expect(out.suggestedDdl).toContain("ALTER TABLE account ADD COLUMN note <type>;");
  });

  it("does NOT apply additive intent when a live reconciliation exists (live path unchanged)", () => {
    // reconciliation === "matched" means a live schema diff already ran; the
    // additive text suggestion must never override the live-DB path.
    const out = suggestDdl({
      tableName: "crm.customers",
      columnName: null,
      reconciliation: "matched",
      columnType: null,
      additive: {
        columnName: "status",
        columnType: "BOOLEAN",
        entity: "customers",
        confidence: "medium",
      },
    });
    expect(out.changeKind).toBe("reference");
    expect(out.suggestedDdl).toContain("Verify table crm.customers");
  });

  it("does NOT apply additive intent to a COLUMN row (add-column suggestion is table-scoped)", () => {
    const out = suggestDdl({
      tableName: "account",
      columnName: "email",
      reconciliation: null,
      columnType: null,
      additive: {
        columnName: "status",
        columnType: "BOOLEAN",
        entity: "account",
        confidence: "medium",
      },
    });
    expect(out.changeKind).toBe("reference");
    expect(out.suggestedDdl).toContain("Verify column account.email");
  });
});

describe("detectAdditiveColumnIntent (#923)", () => {
  it("detects 'add a <field> flag to <entity>' and infers a BOOLEAN type", () => {
    const intent = detectAdditiveColumnIntent("Add a status flag to account");
    expect(intent).not.toBeNull();
    expect(intent!.columnName).toBe("status");
    expect(intent!.columnType).toBe("BOOLEAN");
    expect(intent!.entity).toBe("account");
    expect(intent!.confidence).toBe("medium");
  });

  it("snake_cases a camelCase / hyphenated field name and singular/plural is preserved on entity", () => {
    const intent = detectAdditiveColumnIntent("Introduce a soft-delete flag on the account entity");
    expect(intent!.columnName).toBe("soft_delete");
    expect(intent!.columnType).toBe("BOOLEAN");
    expect(intent!.entity).toBe("account");

    const camel = detectAdditiveColumnIntent("add a lastLogin field for users");
    expect(camel!.columnName).toBe("last_login");
    expect(camel!.entity).toBe("users");
  });

  it("infers a TIMESTAMP for date/time-ish names and INTEGER for count-ish names", () => {
    expect(detectAdditiveColumnIntent("add a deleted_at column to orders")!.columnType).toBe(
      "TIMESTAMP",
    );
    expect(detectAdditiveColumnIntent("add a login_count field to account")!.columnType).toBe(
      "INTEGER",
    );
  });

  it("uses a placeholder type (null) when the name is ambiguous → low confidence", () => {
    const intent = detectAdditiveColumnIntent("add a nickname column to account");
    expect(intent!.columnName).toBe("nickname");
    expect(intent!.columnType).toBeNull();
    expect(intent!.confidence).toBe("low");
  });

  it("detects the descriptor-less 'add <field> to <entity>' form at low confidence", () => {
    const intent = detectAdditiveColumnIntent("Add nickname to account");
    expect(intent!.columnName).toBe("nickname");
    expect(intent!.entity).toBe("account");
    expect(intent!.confidence).toBe("low");
  });

  it("returns null for non-additive requirement text", () => {
    expect(detectAdditiveColumnIntent("Update the account status validation logic")).toBeNull();
    expect(detectAdditiveColumnIntent("Remove the legacy signon table")).toBeNull();
    expect(detectAdditiveColumnIntent("")).toBeNull();
    expect(detectAdditiveColumnIntent(null)).toBeNull();
  });

  it("returns null when the field reduces to a bare descriptor (no real column name)", () => {
    // "add a column to account" carries add-intent but names no field → ambiguous.
    expect(detectAdditiveColumnIntent("add a column to account")).toBeNull();
  });

  it("does NOT fire on 'create a <thing> for <thing>' without an add descriptor", () => {
    // create + 'for' with no field descriptor must not be mistaken for a column add.
    expect(detectAdditiveColumnIntent("Create a report for admins")).toBeNull();
  });

  it("never emits a name containing SQL metacharacters (sanitized identifier only)", () => {
    const intent = detectAdditiveColumnIntent("add a status;DROP TABLE users-- flag to account");
    // Whatever is parsed, the column name is a bare [a-z0-9_] identifier.
    expect(intent === null || /^[a-z0-9_]+$/.test(intent.columnName)).toBe(true);
  });
});

function mockSchemaDataSource(
  edges: Array<{
    fromSymbolId: string;
    toSymbolId: string;
    kind: "reads" | "writes" | "persists-to" | "executes";
  }>,
  symbols: Array<{
    id: string;
    kind: "table" | "column" | "procedure" | "function";
    name: string;
    qualifiedName: string;
    source: "live-db" | "mybatis" | "orm" | "ddl-file" | null;
  }>,
): SchemaImpactDataSource {
  return {
    async getSchemaEdgesFrom(ids) {
      return edges.filter((e) => ids.includes(e.fromSymbolId));
    },
    async getSchemaSymbolsByIds(ids) {
      return symbols.filter((s) => ids.includes(s.id));
    },
  };
}

describe("crossToSchema", () => {
  it("returns [] when there are no seed symbols", async () => {
    const ds = mockSchemaDataSource([], []);
    expect(await crossToSchema([], ds)).toEqual([]);
  });

  it("crosses code symbols to tables/columns and reconciles against live schema", async () => {
    const ds = mockSchemaDataSource(
      [
        { fromSymbolId: "code-1", toSymbolId: "tbl-1", kind: "reads" },
        { fromSymbolId: "code-1", toSymbolId: "col-1", kind: "reads" },
        { fromSymbolId: "code-1", toSymbolId: "col-2", kind: "writes" },
      ],
      [
        {
          id: "tbl-1",
          kind: "table",
          name: "customers",
          qualifiedName: "crm.customers",
          source: "mybatis",
        },
        {
          id: "col-1",
          kind: "column",
          name: "email_address",
          qualifiedName: "crm.customers.email_address",
          source: "mybatis",
        },
        {
          id: "col-2",
          kind: "column",
          name: "nickname",
          qualifiedName: "crm.customers.nickname",
          source: "mybatis",
        },
      ],
    );

    const rows = await crossToSchema(["code-1"], ds, liveIndex());

    const table = rows.find((r) => r.columnName === null);
    expect(table?.tableName).toBe("crm.customers");
    expect(table?.reconciliation).toBe("matched");

    const email = rows.find((r) => r.columnName === "email_address");
    expect(email?.reconciliation).toBe("matched");
    expect(email?.columnType).toBe("varchar(255)");

    const nickname = rows.find((r) => r.columnName === "nickname");
    expect(nickname?.reconciliation).toBe("column-not-found");
    expect(nickname?.changeKind).toBe("add-column");
  });

  it("dedupes by (table, column), keeping the highest confidence", async () => {
    const ds = mockSchemaDataSource(
      [
        { fromSymbolId: "code-1", toSymbolId: "tbl-1", kind: "reads" },
        { fromSymbolId: "code-1", toSymbolId: "tbl-1b", kind: "writes" },
      ],
      [
        {
          id: "tbl-1",
          kind: "table",
          name: "customers",
          qualifiedName: "crm.customers",
          source: "mybatis",
        },
        {
          id: "tbl-1b",
          kind: "table",
          name: "customers",
          qualifiedName: "crm.customers",
          source: "live-db",
        },
      ],
    );
    const rows = await crossToSchema(["code-1"], ds, liveIndex());
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("live-db");
    expect(rows[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("flags table-not-found without a live index match", async () => {
    const ds = mockSchemaDataSource(
      [{ fromSymbolId: "code-1", toSymbolId: "tbl-1", kind: "reads" }],
      [{ id: "tbl-1", kind: "table", name: "ghosts", qualifiedName: "crm.ghosts", source: "orm" }],
    );
    const rows = await crossToSchema(["code-1"], ds, liveIndex());
    expect(rows[0].reconciliation).toBe("table-not-found");
    expect(rows[0].changeKind).toBe("add-table");
  });

  it("tags table/column rows with their objectKind (#302)", async () => {
    const ds = mockSchemaDataSource(
      [
        { fromSymbolId: "code-1", toSymbolId: "tbl-1", kind: "reads" },
        { fromSymbolId: "code-1", toSymbolId: "col-1", kind: "reads" },
      ],
      [
        {
          id: "tbl-1",
          kind: "table",
          name: "customers",
          qualifiedName: "crm.customers",
          source: "mybatis",
        },
        {
          id: "col-1",
          kind: "column",
          name: "email_address",
          qualifiedName: "crm.customers.email_address",
          source: "mybatis",
        },
      ],
    );
    const rows = await crossToSchema(["code-1"], ds, liveIndex());
    expect(rows.find((r) => r.columnName === null)?.objectKind).toBe("table");
    expect(rows.find((r) => r.columnName === "email_address")?.objectKind).toBe("column");
  });

  it("surfaces a routine reached via an executes edge as a procedure/function row with a verify-only note (#302)", async () => {
    const ds = mockSchemaDataSource(
      [{ fromSymbolId: "code-1", toSymbolId: "fn-1", kind: "executes" }],
      [
        {
          id: "fn-1",
          kind: "function",
          name: "calc_total",
          qualifiedName: "app.calc_total",
          source: "live-db",
        },
      ],
    );
    const rows = await crossToSchema(["code-1"], ds, liveIndex());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      objectKind: "function",
      tableName: "app.calc_total",
      columnName: null,
      changeKind: "reference",
    });
    // METIS never recommends dropping/altering a routine — the note is verify-only.
    expect(rows[0].suggestedDdl).toContain("Verify function app.calc_total");
    expect(rows[0].suggestedDdl).not.toMatch(/DROP|ALTER/);
  });
});

// #923 — additive (ADD COLUMN) suggestion driven by requirement TEXT, so a
// source-only project (MyBatis/ORM lineage, no live connection) still gets an
// actionable add-column suggestion instead of only a verify-comment.
describe("crossToSchema — additive-intent ADD COLUMN without a live schema (#923)", () => {
  function accountDs(): SchemaImpactDataSource {
    return mockSchemaDataSource(
      [{ fromSymbolId: "code-1", toSymbolId: "t-account", kind: "reads" }],
      [
        {
          id: "t-account",
          kind: "table",
          name: "account",
          qualifiedName: "account",
          source: "mybatis",
        },
      ],
    );
  }

  it("emits a text-only ADD COLUMN suggestion for an add-a-field requirement mapped to the matched table", async () => {
    const rows = await crossToSchema(["code-1"], accountDs(), null, null, {
      requirementText: "Add a status flag to the account",
    });
    const account = rows.find((r) => r.tableName === "account")!;
    expect(account.changeKind).toBe("add-column");
    expect(account.suggestedDdl).toContain("ALTER TABLE account ADD COLUMN status BOOLEAN;");
    expect(account.suggestedDdl.toUpperCase()).toContain("SUGGESTED");
    // Suggestion confidence stays in the low/medium band.
    expect(account.confidence).toBeLessThanOrEqual(0.6);
  });

  it("preserves the existing reference / verify behavior when NO additive intent is present", async () => {
    const rows = await crossToSchema(["code-1"], accountDs(), null, null, {
      requirementText: "Update the account status validation logic",
    });
    const account = rows.find((r) => r.tableName === "account")!;
    expect(account.changeKind).toBe("reference");
    expect(account.suggestedDdl).toContain("Verify table account");
  });

  it("does not emit ADD COLUMN when the additive intent's entity does not match the impacted table", async () => {
    // The requirement adds a field to `customer`, but the impacted table is `account`.
    const rows = await crossToSchema(["code-1"], accountDs(), null, null, {
      requirementText: "Add a loyalty_points column to the customer",
    });
    const account = rows.find((r) => r.tableName === "account")!;
    expect(account.changeKind).toBe("reference");
  });

  it("is byte-identical to before #923 when no requirementText is supplied", async () => {
    const rows = await crossToSchema(["code-1"], accountDs(), null);
    expect(rows[0].changeKind).toBe("reference");
    expect(rows[0].suggestedDdl).toContain("Verify table account");
  });

  it("leaves the live-DB reconciliation path unchanged even when additive intent is present", async () => {
    // With a live index, `crm.customers` matches; additive intent must NOT override it.
    const ds = mockSchemaDataSource(
      [{ fromSymbolId: "code-1", toSymbolId: "tbl-1", kind: "reads" }],
      [
        {
          id: "tbl-1",
          kind: "table",
          name: "customers",
          qualifiedName: "crm.customers",
          source: "mybatis",
        },
      ],
    );
    const rows = await crossToSchema(["code-1"], ds, liveIndex(), null, {
      requirementText: "Add a status flag to the customers",
    });
    const table = rows.find((r) => r.columnName === null)!;
    expect(table.reconciliation).toBe("matched");
    expect(table.changeKind).toBe("reference");
  });

  it("engine executes no DDL — the suggestion is a plain string only", async () => {
    const rows = await crossToSchema(["code-1"], accountDs(), null, null, {
      requirementText: "Add a status flag to the account",
    });
    expect(typeof rows[0].suggestedDdl).toBe("string");
  });
});

describe("PrismaSchemaImpactDataSource", () => {
  function fakePrisma() {
    return {
      codeSymbol: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "tbl-1",
            kind: "table",
            name: "customers",
            qualifiedName: "crm.customers",
            source: "live-db",
          },
        ]),
      },
      codeEdge: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ fromSymbolId: "code-1", toSymbolId: "tbl-1", kind: "reads" }]),
      },
    };
  }

  it("filters edges to schema kinds and scopes to the project", async () => {
    const prisma = fakePrisma();
    const ds = new PrismaSchemaImpactDataSource(prisma as never, "proj-7");

    expect(await ds.getSchemaEdgesFrom([])).toEqual([]);
    const edges = await ds.getSchemaEdgesFrom(["code-1"]);
    expect(edges[0]).toMatchObject({ toSymbolId: "tbl-1", kind: "reads" });
    // #302 — the impact crossing now also follows the code→routine `executes`
    // edge (but NOT the routine-originating `calls` edge).
    expect(prisma.codeEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-7",
          kind: { in: ["reads", "writes", "persists-to", "executes"] },
        }),
      }),
    );

    expect(await ds.getSchemaSymbolsByIds([])).toEqual([]);
    const syms = await ds.getSchemaSymbolsByIds(["tbl-1"]);
    expect(syms[0]).toMatchObject({ kind: "table", source: "live-db" });
    expect(prisma.codeSymbol.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-7",
          kind: { in: ["table", "column", "procedure", "function"] },
        }),
      }),
    );
  });
});

// Epic #295 Phase 4 (#308) — crossToSchema associates affected rows with their
// canonical SchemaObjectIdentity when (and only when) a resolver is supplied.
describe("crossToSchema — cross-project identity association (#308)", () => {
  function ds(): SchemaImpactDataSource {
    return mockSchemaDataSource(
      [{ fromSymbolId: "code-1", toSymbolId: "tbl-1", kind: "reads" }],
      [
        {
          id: "tbl-1",
          kind: "table",
          name: "orders",
          qualifiedName: "public.orders",
          source: "mybatis",
        },
      ],
    );
  }

  it("leaves schemaObjectIdentityId undefined when no resolver is passed (backward compatible)", async () => {
    const rows = await crossToSchema(["code-1"], ds(), null);
    expect(rows).toHaveLength(1);
    expect(rows[0].schemaObjectIdentityId).toBeUndefined();
  });

  it("populates schemaObjectIdentityId from the resolver, once per distinct object", async () => {
    const resolver = vi.fn(async () => "identity-42");
    const rows = await crossToSchema(["code-1"], ds(), null, resolver);
    expect(rows[0].schemaObjectIdentityId).toBe("identity-42");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith({
      objectKind: "table",
      tableName: "public.orders",
      columnName: null,
    });
  });

  it("leaves the row unlinked when the resolver returns null (object not in registry)", async () => {
    const resolver = vi.fn(async () => null);
    const rows = await crossToSchema(["code-1"], ds(), null, resolver);
    expect(rows[0].schemaObjectIdentityId).toBeNull();
  });
});

// #922 — DAO/mapper sibling expansion: a requirement mapping to ONE method of a
// mapper surfaces the OTHER tables that mapper's sibling methods touch, at
// reduced/marked confidence, without demoting the directly-crossed table.
describe("crossToSchema — DAO/mapper sibling expansion (#922)", () => {
  type Edge = {
    fromSymbolId: string;
    toSymbolId: string;
    kind: "reads" | "writes" | "persists-to" | "executes";
  };
  type SchemaSym = {
    id: string;
    kind: "table" | "column" | "procedure" | "function";
    name: string;
    qualifiedName: string;
    source: "live-db" | "mybatis" | "orm" | "ddl-file" | null;
  };
  type CodeSym = { id: string; kind: string; qualifiedName: string };

  const enclosingOf = (qn: string): string => qn.slice(0, qn.lastIndexOf("."));

  function daoDataSource(opts: {
    edges: Edge[];
    schemaSymbols: SchemaSym[];
    codeSymbols: CodeSym[];
  }): SchemaImpactDataSource {
    return {
      async getSchemaEdgesFrom(ids) {
        return opts.edges.filter((e) => ids.includes(e.fromSymbolId));
      },
      async getSchemaSymbolsByIds(ids) {
        return opts.schemaSymbols.filter((s) => ids.includes(s.id));
      },
      async getCodeSymbolsByIds(ids) {
        return opts.codeSymbols.filter((c) => ids.includes(c.id));
      },
      async getSiblingMethodIds(enclosingTypes) {
        return opts.codeSymbols.filter(
          (c) =>
            c.kind === "method" &&
            c.qualifiedName.includes(".") &&
            enclosingTypes.includes(enclosingOf(c.qualifiedName)),
        );
      },
    };
  }

  const NS = "org.jpetstore.mapper.AccountMapper";
  function jpetstore(): SchemaImpactDataSource {
    return daoDataSource({
      codeSymbols: [
        { id: "m-get", kind: "method", qualifiedName: `${NS}.getAccountByUsernameAndPassword` },
        { id: "m-prof", kind: "method", qualifiedName: `${NS}.updateProfile` },
        { id: "m-signon", kind: "method", qualifiedName: `${NS}.updateSignon` },
      ],
      edges: [
        { fromSymbolId: "m-get", toSymbolId: "t-account", kind: "reads" },
        { fromSymbolId: "m-prof", toSymbolId: "t-profile", kind: "writes" },
        { fromSymbolId: "m-signon", toSymbolId: "t-signon", kind: "persists-to" },
      ],
      schemaSymbols: [
        {
          id: "t-account",
          kind: "table",
          name: "account",
          qualifiedName: "account",
          source: "mybatis",
        },
        {
          id: "t-profile",
          kind: "table",
          name: "profile",
          qualifiedName: "profile",
          source: "mybatis",
        },
        {
          id: "t-signon",
          kind: "table",
          name: "signon",
          qualifiedName: "signon",
          source: "mybatis",
        },
      ],
    });
  }

  it("without the option, a single-method seed surfaces only that method's table", async () => {
    const rows = await crossToSchema(["m-get"], jpetstore(), null);
    expect(rows.map((r) => r.tableName)).toEqual(["account"]);
    expect(rows[0].siblingDerived).toBeUndefined();
  });

  it("expands a single-method seed to the mapper's sibling-method tables", async () => {
    const rows = await crossToSchema(["m-get"], jpetstore(), null, null, {
      expandDaoSiblings: true,
    });
    expect(rows.map((r) => r.tableName).sort()).toEqual(["account", "profile", "signon"]);
  });

  it("marks sibling tables at reduced confidence, below the directly-crossed table", async () => {
    const rows = await crossToSchema(["m-get"], jpetstore(), null, null, {
      expandDaoSiblings: true,
    });
    const account = rows.find((r) => r.tableName === "account")!;
    const profile = rows.find((r) => r.tableName === "profile")!;
    const signon = rows.find((r) => r.tableName === "signon")!;

    // Directly crossed — full confidence, not marked.
    expect(account.siblingDerived).toBeUndefined();
    // Sibling-derived — marked and reduced.
    expect(profile.siblingDerived).toBe(true);
    expect(signon.siblingDerived).toBe(true);
    expect(profile.confidence).toBeLessThanOrEqual(0.5);
    expect(signon.confidence).toBeLessThanOrEqual(0.5);
    // Confidence ordering: every sibling ranks below the direct table.
    expect(account.confidence).toBeGreaterThan(profile.confidence);
    expect(account.confidence).toBeGreaterThan(signon.confidence);
    // The reduced-confidence provenance is visible in the suggestion text.
    expect(profile.suggestedDdl).toContain("sibling method");
  });

  it("keeps a directly-crossed table's higher confidence even when a sibling also touches it", async () => {
    // A sibling method ALSO reads `account`; the direct row must still win.
    const ds = daoDataSource({
      codeSymbols: [
        { id: "m-get", kind: "method", qualifiedName: `${NS}.getAccount` },
        { id: "m-list", kind: "method", qualifiedName: `${NS}.listAccounts` },
      ],
      edges: [
        { fromSymbolId: "m-get", toSymbolId: "t-account", kind: "reads" },
        { fromSymbolId: "m-list", toSymbolId: "t-account", kind: "reads" },
        { fromSymbolId: "m-list", toSymbolId: "t-profile", kind: "writes" },
      ],
      schemaSymbols: [
        {
          id: "t-account",
          kind: "table",
          name: "account",
          qualifiedName: "account",
          source: "mybatis",
        },
        {
          id: "t-profile",
          kind: "table",
          name: "profile",
          qualifiedName: "profile",
          source: "mybatis",
        },
      ],
    });
    const rows = await crossToSchema(["m-get"], ds, null, null, { expandDaoSiblings: true });
    const account = rows.find((r) => r.tableName === "account")!;
    const profile = rows.find((r) => r.tableName === "profile")!;
    expect(account.siblingDerived).toBeUndefined();
    expect(account.confidence).toBeGreaterThan(profile.confidence);
    expect(profile.siblingDerived).toBe(true);
  });

  it("leaves a NON-DAO seed unaffected even with the option enabled", async () => {
    // Enclosing type `com.app.OrderService` is not a mapper/DAO — no expansion.
    const ds = daoDataSource({
      codeSymbols: [
        { id: "svc-place", kind: "method", qualifiedName: "com.app.OrderService.placeOrder" },
        { id: "svc-cancel", kind: "method", qualifiedName: "com.app.OrderService.cancelOrder" },
      ],
      edges: [
        { fromSymbolId: "svc-place", toSymbolId: "t-orders", kind: "reads" },
        { fromSymbolId: "svc-cancel", toSymbolId: "t-audit", kind: "writes" },
      ],
      schemaSymbols: [
        {
          id: "t-orders",
          kind: "table",
          name: "orders",
          qualifiedName: "orders",
          source: "mybatis",
        },
        { id: "t-audit", kind: "table", name: "audit", qualifiedName: "audit", source: "mybatis" },
      ],
    });
    const rows = await crossToSchema(["svc-place"], ds, null, null, { expandDaoSiblings: true });
    expect(rows.map((r) => r.tableName)).toEqual(["orders"]);
    expect(rows.every((r) => !r.siblingDerived)).toBe(true);
  });

  it("no-ops when the option is on but the data source lacks the sibling hooks", async () => {
    // A bare data source (only the two required methods) must not throw.
    const bare = mockSchemaDataSource(
      [{ fromSymbolId: "m-get", toSymbolId: "t-account", kind: "reads" }],
      [
        {
          id: "t-account",
          kind: "table",
          name: "account",
          qualifiedName: "account",
          source: "mybatis",
        },
      ],
    );
    const rows = await crossToSchema(["m-get"], bare, null, null, { expandDaoSiblings: true });
    expect(rows.map((r) => r.tableName)).toEqual(["account"]);
  });
});

describe("PrismaSchemaImpactDataSource — sibling resolution (#922)", () => {
  it("resolves code symbols by id, project-scoped, for any kind", async () => {
    const prisma = {
      codeSymbol: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "m-1", kind: "method", qualifiedName: "pkg.AccountMapper.updateProfile" },
          ]),
      },
      codeEdge: { findMany: vi.fn() },
    };
    const ds = new PrismaSchemaImpactDataSource(prisma as never, "proj-9");
    expect(await ds.getCodeSymbolsByIds!([])).toEqual([]);
    const syms = await ds.getCodeSymbolsByIds!(["m-1"]);
    expect(syms[0]).toMatchObject({ id: "m-1", kind: "method" });
    expect(prisma.codeSymbol.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "proj-9", id: { in: ["m-1"] } }),
      }),
    );
  });

  it("returns sibling methods via a prefix query and re-checks the exact enclosing type in JS", async () => {
    const prisma = {
      codeSymbol: {
        findMany: vi.fn().mockResolvedValue([
          // Genuine sibling.
          { id: "m-prof", kind: "method", qualifiedName: "pkg.AccountMapper.updateProfile" },
          // Prefix collision — a DIFFERENT type that happens to share the prefix.
          { id: "m-x", kind: "method", qualifiedName: "pkg.AccountMapperExtra.foo" },
          // Nested method — enclosing type is `pkg.AccountMapper.Inner`, not the target.
          { id: "m-nested", kind: "method", qualifiedName: "pkg.AccountMapper.Inner.helper" },
        ]),
      },
      codeEdge: { findMany: vi.fn() },
    };
    const ds = new PrismaSchemaImpactDataSource(prisma as never, "proj-9");
    expect(await ds.getSiblingMethodIds!([])).toEqual([]);
    const rows = await ds.getSiblingMethodIds!(["pkg.AccountMapper"]);
    expect(rows.map((r) => r.id)).toEqual(["m-prof"]);
    expect(prisma.codeSymbol.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-9",
          kind: "method",
          OR: [{ qualifiedName: { startsWith: "pkg.AccountMapper." } }],
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// #928 — downstream "code → data layer → schema" crossing.
//
// The MyBatis chain lives in the graph as
//   service --calls--> mapper method --executes--> SQL statement (kind=method,
//   language=sql) --reads--> table
// but the code-impact blast radius walks UPSTREAM, so the mapper method + its
// statement symbol are rarely in the impacted set, and even when they are, the
// single-hop crossing dropped the statement (kind=method) and never followed its
// reads->table 2nd hop. These tests prove the downstream walk + statement
// pass-through close both gaps.
// ---------------------------------------------------------------------------
describe("crossToSchema — downstream data-layer crossing (#928)", () => {
  interface RawEdge {
    fromSymbolId: string;
    toSymbolId: string;
    kind: "calls" | "reads" | "writes" | "persists-to" | "executes";
  }
  /** The JPetStore-shaped chain: service -calls-> mapper -executes-> stmt -reads-> product. */
  const MYBATIS_EDGES: RawEdge[] = [
    { fromSymbolId: "svc", toSymbolId: "mapper", kind: "calls" },
    { fromSymbolId: "mapper", toSymbolId: "stmt", kind: "executes" },
    { fromSymbolId: "stmt", toSymbolId: "product", kind: "reads" },
  ];
  const PRODUCT_TABLE = {
    id: "product",
    kind: "table" as const,
    name: "product",
    qualifiedName: "product",
    source: "mybatis" as const,
  };

  /**
   * A data source over `edges` that (like the real Prisma one) exposes the same
   * codeEdge rows through two lenses: `getSchemaEdgesFrom` (reads/writes/persists-
   * to/executes) and `getDownstreamCallEdgesFrom` (calls/executes). `stmt` is a
   * kind=method symbol, so it is deliberately absent from `symbols` — exactly why
   * the single-hop crossing dropped it. Set `withDownstream=false` to model a data
   * source that predates #928 (no downstream hook).
   */
  function graph(
    edges: RawEdge[] = MYBATIS_EDGES,
    symbols: Array<{
      id: string;
      kind: "table" | "column" | "procedure" | "function";
      name: string;
      qualifiedName: string;
      source: "live-db" | "mybatis" | "orm" | null;
    }> = [PRODUCT_TABLE],
    withDownstream = true,
  ): SchemaImpactDataSource {
    const ds: SchemaImpactDataSource = {
      async getSchemaEdgesFrom(ids) {
        return edges
          .filter(
            (e) =>
              ids.includes(e.fromSymbolId) &&
              (SCHEMA_IMPACT_EDGE_KINDS as readonly string[]).includes(e.kind),
          )
          .map((e) => ({ fromSymbolId: e.fromSymbolId, toSymbolId: e.toSymbolId, kind: e.kind }));
      },
      async getSchemaSymbolsByIds(ids) {
        return symbols.filter((s) => ids.includes(s.id));
      },
    };
    if (withDownstream) {
      ds.getDownstreamCallEdgesFrom = async (ids) =>
        edges
          .filter(
            (e) => ids.includes(e.fromSymbolId) && (e.kind === "calls" || e.kind === "executes"),
          )
          .map((e) => ({ fromSymbolId: e.fromSymbolId, toSymbolId: e.toSymbolId }));
    }
    return ds;
  }

  it("crosses a service that transitively calls a MyBatis mapper to the mapper's table", async () => {
    // `svc` owns NO schema edge directly; only the downstream walk (calls ->
    // mapper, executes -> stmt) puts `stmt` in the crossing set so its reads ->
    // product surfaces. This is the exact 9/10 gap in the recall probe.
    const rows = await crossToSchema(["svc"], graph());
    expect(rows.map((r) => r.tableName)).toEqual(["product"]);
    expect(rows[0].objectKind).toBe("table");
  });

  it("crosses an impacted mapper method through the executes->statement pass-through", async () => {
    // Gap 1 in isolation: the mapper method IS impacted, but the table hangs off
    // its statement symbol one `executes` hop away.
    const rows = await crossToSchema(["mapper"], graph());
    expect(rows.map((r) => r.tableName)).toEqual(["product"]);
  });

  it("never surfaces the SQL statement symbol as a terminal affected object", async () => {
    const rows = await crossToSchema(["svc"], graph());
    // The kind=method statement symbol is dropped by the schema-symbol filter; only
    // its downstream table survives.
    expect(rows.every((r) => r.objectKind === "table" || r.objectKind === "column")).toBe(true);
    expect(rows.some((r) => r.tableName === "stmt")).toBe(false);
  });

  it("decays confidence with downstream distance (statement > mapper > service)", async () => {
    const fromStmt = (await crossToSchema(["stmt"], graph()))[0].confidence; // depth 0
    const fromMapper = (await crossToSchema(["mapper"], graph()))[0].confidence; // depth 1
    const fromSvc = (await crossToSchema(["svc"], graph()))[0].confidence; // depth 2
    expect(fromStmt).toBeGreaterThan(fromMapper);
    expect(fromMapper).toBeGreaterThan(fromSvc);
    // Exactly one decay factor per hop.
    expect(fromMapper).toBeCloseTo(fromStmt * DOWNSTREAM_DATA_LAYER_DECAY, 5);
    expect(fromSvc).toBeCloseTo(fromStmt * DOWNSTREAM_DATA_LAYER_DECAY ** 2, 5);
  });

  it("respects the maxDownstreamDepth bound (statement out of reach yields no table)", async () => {
    // Depth 1 reaches `mapper` but not `stmt` (2 hops), so the statement's reads
    // are never queried and no table surfaces.
    const shallow = await crossToSchema(["svc"], graph(), null, null, { maxDownstreamDepth: 1 });
    expect(shallow).toEqual([]);
    // Depth 2 reaches `stmt`.
    const deep = await crossToSchema(["svc"], graph(), null, null, { maxDownstreamDepth: 2 });
    expect(deep.map((r) => r.tableName)).toEqual(["product"]);
    // Depth 0 disables the walk entirely (pre-#928 single-hop crossing).
    expect(await crossToSchema(["svc"], graph(), null, null, { maxDownstreamDepth: 0 })).toEqual(
      [],
    );
  });

  it("degrades to the single-hop crossing when the data source has no downstream hook", async () => {
    // A pre-#928 data source: `svc` owns no schema edge, so nothing surfaces — the
    // downstream walk (not a code change elsewhere) is what unlocks the table.
    const rows = await crossToSchema(["svc"], graph(MYBATIS_EDGES, [PRODUCT_TABLE], false));
    expect(rows).toEqual([]);
  });

  it("preserves the previously-working case: a directly-owned reads edge still crosses at full confidence", async () => {
    // The 1/10 that worked (BM25 ranked the statement symbol directly) and the ORM
    // pattern (edges anchored on the code symbol) are both depth-0 — undecayed.
    const rows = await crossToSchema(["stmt"], graph());
    expect(rows.map((r) => r.tableName)).toEqual(["product"]);
    // depth 0 => scale 1 => the un-decayed mybatis confidence (0.6, no live index).
    expect(rows[0].confidence).toBeCloseTo(0.6, 5);
  });

  it("does not double-count a table reachable by both a direct and a downstream path", async () => {
    // svc -calls-> mapper -executes-> stmt -reads-> product AND stmt is itself seeded.
    const rows = await crossToSchema(["svc", "stmt"], graph());
    expect(rows).toHaveLength(1);
    // The shallower (direct, depth-0) path wins the dedupe.
    expect(rows[0].confidence).toBeCloseTo(0.6, 5);
  });

  it("audit: an ORM-style code symbol that directly owns reads is unaffected (no regression, no decay)", async () => {
    // ORM/jOOQ/SQLAlchemy/GORM/EF anchor reads/writes ON the code symbol, so they
    // are depth-0 direct rows regardless of the downstream walk being available.
    const ormEdges: RawEdge[] = [{ fromSymbolId: "repo", toSymbolId: "orders", kind: "writes" }];
    const ormTable = {
      id: "orders",
      kind: "table" as const,
      name: "orders",
      qualifiedName: "orders",
      source: "orm" as const,
    };
    const rows = await crossToSchema(["repo"], graph(ormEdges, [ormTable]));
    expect(rows).toHaveLength(1);
    expect(rows[0].tableName).toBe("orders");
    expect(rows[0].confidence).toBeCloseTo(0.6, 5);
  });

  // #953 — the PL/SQL package-body analogue of the MyBatis chain. Before #953,
  // Oracle package bodies were `routine-body-unanalyzed` (whole-body sqlglot
  // failed on PL/SQL scaffolding), so a member reached via `executes` had NO
  // reads/writes edges and this crossing dead-ended. Now that ingest wires
  // extractPlsqlPackageLineage, a package member owns real member-attributed
  // reads/writes edges, so requirement -> code -executes-> package member
  // (procedure) -reads/writes-> table crosses end-to-end.
  const PLSQL_EDGES: RawEdge[] = [
    { fromSymbolId: "code", toSymbolId: "member", kind: "executes" },
    { fromSymbolId: "member", toSymbolId: "accounts", kind: "writes" },
  ];
  const PLSQL_MEMBER = {
    id: "member",
    kind: "procedure" as const,
    name: "apply_fee",
    qualifiedName: "app.apply_fee",
    source: "live-db" as const,
  };
  const ACCOUNTS_TABLE = {
    id: "accounts",
    kind: "table" as const,
    name: "accounts",
    qualifiedName: "app.accounts",
    source: "live-db" as const,
  };

  it("crosses requirement->code through an `executes` PL/SQL package member to the body's table (#953)", async () => {
    // `code` owns NO schema edge directly; only the downstream walk (executes ->
    // member) plus the member's now-existing `writes -> accounts` edge (the #953
    // fix) puts the table in the crossing set.
    const rows = await crossToSchema(["code"], graph(PLSQL_EDGES, [PLSQL_MEMBER, ACCOUNTS_TABLE]));
    const accounts = rows.find((r) => r.objectKind === "table" && r.tableName.endsWith("accounts"));
    expect(accounts).toBeTruthy();
    // The member itself also surfaces (verify-only routine row), but the crossing
    // now REACHES the body's table — the whole point of #953.
    expect(rows.some((r) => r.objectKind === "procedure")).toBe(true);
  });

  it("dead-ends at the routine (no table) when the PL/SQL member body was never analyzed — the pre-#953 state", async () => {
    // Model the bug #953 fixes: the member is reached via `executes`, but its
    // body produced NO reads/writes edges, so no downstream table surfaces —
    // only the verify-only routine row.
    const unanalyzed: RawEdge[] = [
      { fromSymbolId: "code", toSymbolId: "member", kind: "executes" },
    ];
    const rows = await crossToSchema(["code"], graph(unanalyzed, [PLSQL_MEMBER, ACCOUNTS_TABLE]));
    expect(rows.some((r) => r.objectKind === "table")).toBe(false);
    expect(rows.some((r) => r.objectKind === "procedure")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #942 — two crossing defects on top of #928/#936:
//   FIX 1: a schema symbol (table/column) that is DIRECTLY in the blast radius
//          (matched itself, not only reached via the downstream code→mapper walk)
//          must surface — and for a column, its parent table — at HIGH confidence.
//   FIX 2: the downstream fan-out is dampened (default depth 3 → 2) so a DEEP
//          tangential table (a far web-action reaching a mapper 3 hops away) drops
//          out, without sacrificing the #928 near/depth-2 crossing or recall.
// ---------------------------------------------------------------------------
describe("crossToSchema — direct schema-symbol hits promote at HIGH confidence (#942)", () => {
  /** A data source whose GET-SYMBOLS lens resolves the seed ids that ARE schema symbols. */
  function directHitDs(
    schemaSymbols: Array<{
      id: string;
      kind: "table" | "column" | "procedure" | "function";
      name: string;
      qualifiedName: string;
      source: "live-db" | "mybatis" | "orm" | "ddl-file" | null;
    }>,
    edges: Array<{
      fromSymbolId: string;
      toSymbolId: string;
      kind: "reads" | "writes" | "persists-to" | "executes";
    }> = [],
  ): SchemaImpactDataSource {
    return {
      async getSchemaEdgesFrom(ids) {
        return edges.filter((e) => ids.includes(e.fromSymbolId));
      },
      async getSchemaSymbolsByIds(ids) {
        return schemaSymbols.filter((s) => ids.includes(s.id));
      },
    };
  }

  it("surfaces a directly-hit COLUMN and its parent TABLE at high confidence", async () => {
    // Live repro: "Add a status flag to account" directly hits the account.status
    // column symbol; the account table must surface even though no reads/writes edge
    // was crossed to it.
    const ds = directHitDs([
      {
        id: "col-account-status",
        kind: "column",
        name: "status",
        qualifiedName: "account.status",
        source: "mybatis",
      },
    ]);
    const rows = await crossToSchema(["col-account-status"], ds);

    const table = rows.find((r) => r.objectKind === "table" && r.tableName === "account");
    const column = rows.find((r) => r.objectKind === "column" && r.columnName === "status");
    expect(table).toBeDefined();
    expect(column).toBeDefined();
    // Direct hits are the strongest signal → HIGH confidence.
    expect(table!.confidence).toBe(DIRECT_SCHEMA_HIT_CONFIDENCE);
    expect(column!.confidence).toBe(DIRECT_SCHEMA_HIT_CONFIDENCE);
    expect(table!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("surfaces a directly-hit TABLE at high confidence", async () => {
    const ds = directHitDs([
      {
        id: "t-account",
        kind: "table",
        name: "account",
        qualifiedName: "account",
        source: "mybatis",
      },
    ]);
    const rows = await crossToSchema(["t-account"], ds);
    expect(rows).toHaveLength(1);
    expect(rows[0].tableName).toBe("account");
    expect(rows[0].confidence).toBe(DIRECT_SCHEMA_HIT_CONFIDENCE);
  });

  it("a direct hit outranks the same table reached via a decayed downstream walk", async () => {
    // `account.status` is a DIRECT column hit; `mapper` also reaches the account
    // table two hops downstream (statement -> account). The direct row must win the
    // dedupe with HIGH confidence, not the decayed downstream one.
    const ds: SchemaImpactDataSource = {
      async getSchemaEdgesFrom(ids) {
        const edges = [{ fromSymbolId: "stmt", toSymbolId: "t-account", kind: "reads" as const }];
        return edges.filter((e) => ids.includes(e.fromSymbolId));
      },
      async getSchemaSymbolsByIds(ids) {
        const syms = [
          {
            id: "col-account-status",
            kind: "column" as const,
            name: "status",
            qualifiedName: "account.status",
            source: "mybatis" as const,
          },
          {
            id: "t-account",
            kind: "table" as const,
            name: "account",
            qualifiedName: "account",
            source: "mybatis" as const,
          },
        ];
        return syms.filter((s) => ids.includes(s.id));
      },
      getDownstreamCallEdgesFrom: async (ids) =>
        [{ fromSymbolId: "mapper", toSymbolId: "stmt" }].filter((e) =>
          ids.includes(e.fromSymbolId),
        ),
    };
    const rows = await crossToSchema(["col-account-status", "mapper"], ds);
    const account = rows.find((r) => r.objectKind === "table" && r.tableName === "account")!;
    expect(account.confidence).toBe(DIRECT_SCHEMA_HIT_CONFIDENCE);
  });

  it("applies the additive ADD COLUMN suggestion to a directly-hit table at high confidence", async () => {
    const ds = directHitDs([
      {
        id: "t-account",
        kind: "table",
        name: "account",
        qualifiedName: "account",
        source: "mybatis",
      },
    ]);
    const rows = await crossToSchema(["t-account"], ds, null, null, {
      requirementText: "Add a status flag to account",
    });
    const account = rows.find((r) => r.tableName === "account")!;
    expect(account.changeKind).toBe("add-column");
    expect(account.suggestedDdl).toContain("ALTER TABLE account ADD COLUMN status BOOLEAN;");
    // The additive intent does NOT lower a direct hit below HIGH confidence.
    expect(account.confidence).toBe(DIRECT_SCHEMA_HIT_CONFIDENCE);
  });

  it("does not trigger for ordinary (non-schema) code seeds — behaviour unchanged", async () => {
    // `code-1` is a normal code symbol (not returned by getSchemaSymbolsByIds), so
    // no direct-hit row is manufactured; only the crossed table surfaces.
    const ds = directHitDs(
      [
        {
          id: "t-orders",
          kind: "table",
          name: "orders",
          qualifiedName: "orders",
          source: "mybatis",
        },
      ],
      [{ fromSymbolId: "code-1", toSymbolId: "t-orders", kind: "reads" }],
    );
    const rows = await crossToSchema(["code-1"], ds);
    expect(rows).toHaveLength(1);
    expect(rows[0].tableName).toBe("orders");
    // Crossed (not direct) → the ordinary decayed/blended confidence, not the high floor.
    expect(rows[0].confidence).toBeLessThan(DIRECT_SCHEMA_HIT_CONFIDENCE);
  });
});

describe("crossToSchema — deep tangential fan-out is dampened (#942 FIX 2)", () => {
  interface RawEdge {
    fromSymbolId: string;
    toSymbolId: string;
    kind: "calls" | "reads" | "writes" | "persists-to" | "executes";
  }
  // A layered chain: web -calls-> service -calls-> mapper -executes-> stmt -reads-> table.
  // The table's edge owner (stmt) sits 3 downstream hops from `web`.
  const LAYERED: RawEdge[] = [
    { fromSymbolId: "web", toSymbolId: "service", kind: "calls" },
    { fromSymbolId: "service", toSymbolId: "mapper", kind: "calls" },
    { fromSymbolId: "mapper", toSymbolId: "stmt", kind: "executes" },
    { fromSymbolId: "stmt", toSymbolId: "t-deep", kind: "reads" },
  ];
  const DEEP_TABLE = {
    id: "t-deep",
    kind: "table" as const,
    name: "inventory",
    qualifiedName: "inventory",
    source: "mybatis" as const,
  };
  function layeredDs(edges: RawEdge[] = LAYERED): SchemaImpactDataSource {
    return {
      async getSchemaEdgesFrom(ids) {
        return edges
          .filter(
            (e) =>
              ids.includes(e.fromSymbolId) &&
              (SCHEMA_IMPACT_EDGE_KINDS as readonly string[]).includes(e.kind),
          )
          .map((e) => ({ fromSymbolId: e.fromSymbolId, toSymbolId: e.toSymbolId, kind: e.kind }));
      },
      async getSchemaSymbolsByIds(ids) {
        return [DEEP_TABLE].filter((s) => ids.includes(s.id));
      },
      getDownstreamCallEdgesFrom: async (ids) =>
        edges
          .filter(
            (e) => ids.includes(e.fromSymbolId) && (e.kind === "calls" || e.kind === "executes"),
          )
          .map((e) => ({ fromSymbolId: e.fromSymbolId, toSymbolId: e.toSymbolId })),
    };
  }

  it("defaults the downstream depth cap to 2 (one fewer than #928's original 3)", () => {
    expect(DEFAULT_MAX_DOWNSTREAM_DEPTH).toBe(2);
  });

  it("drops a table reachable only 3 downstream hops away (deep tangential) by default", async () => {
    // `web` reaches the table's statement at depth 3 — beyond the default depth-2
    // cap — so the deep tangential table never surfaces.
    const rows = await crossToSchema(["web"], layeredDs());
    expect(rows).toEqual([]);
  });

  it("still surfaces the #928 near crossing: a service two hops from the table (depth 2)", async () => {
    // The service reaches the statement at depth 2 (within the cap) — the #928
    // service→mapper→table capability is preserved, NOT sacrificed.
    const rows = await crossToSchema(["service"], layeredDs());
    expect(rows.map((r) => r.tableName)).toEqual(["inventory"]);
  });

  it("a directly-seeded mapper still surfaces its own table (depth 1)", async () => {
    const rows = await crossToSchema(["mapper"], layeredDs());
    expect(rows.map((r) => r.tableName)).toEqual(["inventory"]);
  });

  it("the deep table can still be reached when the caller explicitly opts into a deeper walk", async () => {
    // FIX 2 changes the DEFAULT only — an explicit maxDownstreamDepth still governs.
    const rows = await crossToSchema(["web"], layeredDs(), null, null, { maxDownstreamDepth: 3 });
    expect(rows.map((r) => r.tableName)).toEqual(["inventory"]);
  });
});

describe("PrismaSchemaImpactDataSource — downstream call edges (#928)", () => {
  it("queries calls/executes edges out of the given symbols, project-scoped", async () => {
    const prisma = {
      codeSymbol: { findMany: vi.fn() },
      codeEdge: {
        findMany: vi.fn().mockResolvedValue([{ fromSymbolId: "svc", toSymbolId: "mapper" }]),
      },
    };
    const ds = new PrismaSchemaImpactDataSource(prisma as never, "proj-1");
    expect(await ds.getDownstreamCallEdgesFrom!([])).toEqual([]);
    const rows = await ds.getDownstreamCallEdgesFrom!(["svc"]);
    expect(rows).toEqual([{ fromSymbolId: "svc", toSymbolId: "mapper" }]);
    expect(prisma.codeEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj-1",
          fromSymbolId: { in: ["svc"] },
          kind: { in: ["calls", "executes"] },
          toSymbolId: { not: null },
        }),
      }),
    );
  });
});
