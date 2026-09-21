/**
 * Issue #732 (Epic #725) — schema-aware context for Sally (the database agent).
 *
 * Covers the contracts the orchestrator's `database` branch relies on:
 *   (a) flag off (explicit `enabled:false` OR `ANALYSIS_SCHEMA_CONTEXT=false`) ⇒
 *       `[]` AND the introspector is never called — Sally's docs-only behaviour
 *       is reproduced exactly. NOTE: as of #752 the CONFIG DEFAULT is ON, so an
 *       unset flag now DOES introspect (see the default-on test);
 *   (b) flag on ⇒ the introspected tables map to a single citable
 *       `RetrievalContextChunk` (`live-schema:<projectId>`) carrying a labelled,
 *       token-budgeted schema summary;
 *   (c) rendering is deterministic (stable ordering) and the token budget /
 *       max-tables cap truncate the tail with an explicit marker;
 *   (d) a persisted usage classification annotates tables (best-effort);
 *   (e) no connector, an empty schema, or an introspection failure ⇒ clean `[]`
 *       (never throws) so Sally falls back to docs-only retrieval.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbTableInfo } from "@metis/shared";
import { __resetConfigSingleton } from "../config/config-service.js";

// Mocks for the production default seams (`defaultIntrospect` / `defaultReadUsage`),
// exercised only by the no-`deps` path below.
const listDbConnectorsMock = vi.fn();
const inspectDbConnectorMock = vi.fn();
const readUsageClassificationMock = vi.fn();
vi.mock("../connectors/db/db-service.js", () => ({
  listDbConnectors: (...args: unknown[]) => listDbConnectorsMock(...args),
  inspectDbConnector: (...args: unknown[]) => inspectDbConnectorMock(...args),
}));
vi.mock("../impact-analysis/used-schema-classifier.js", () => ({
  readUsageClassification: (...args: unknown[]) => readUsageClassificationMock(...args),
}));
vi.mock("../prisma.js", () => ({ prisma: {} }));
import {
  buildSchemaSummary,
  DEFAULT_SCHEMA_MAX_TABLES,
  DEFAULT_SCHEMA_OVERFLOW_INDEX_TOKEN_BUDGET,
  DEFAULT_SCHEMA_TOKEN_BUDGET,
  estimateSchemaTokens,
  extractRelevanceTerms,
  MAX_RELEVANCE_TEXT_CHARS,
  renderTableBlock,
  retrieveSchemaContextChunks,
  SCHEMA_CONTEXT_FILENAME,
  SCHEMA_DOCUMENT_PREFIX,
  schemaSummaryToContextChunk,
  type AnalysisSchemaContextDeps,
} from "./schema-context.js";

function table(overrides: Partial<DbTableInfo> = {}): DbTableInfo {
  return {
    schema: "public",
    name: "users",
    columns: [
      { name: "id", dataType: "int", nullable: false, isPrimaryKey: true, isForeignKey: false },
      {
        name: "email",
        dataType: "varchar",
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
      },
    ],
    foreignKeys: [],
    indexes: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  __resetConfigSingleton();
});

describe("estimateSchemaTokens", () => {
  it("returns 0 for empty text and ~len/4 otherwise", () => {
    expect(estimateSchemaTokens("")).toBe(0);
    expect(estimateSchemaTokens("abcd")).toBe(1);
    expect(estimateSchemaTokens("abcde")).toBe(2);
  });
});

describe("renderTableBlock (#732)", () => {
  it("renders qualified name, pk/nullable column flags and column count", () => {
    const block = renderTableBlock(table());
    expect(block).toContain("TABLE public.users");
    expect(block).toContain("2 col(s)");
    expect(block).toContain("id (int, pk)");
    expect(block).toContain("email (varchar, nullable)");
  });

  it("omits the schema prefix when schema is blank", () => {
    expect(renderTableBlock(table({ schema: "" }))).toContain("TABLE users");
  });

  it("annotates a usage tag when supplied", () => {
    expect(renderTableBlock(table(), "unreferenced")).toContain(
      "TABLE public.users [unreferenced]",
    );
  });

  it("renders outbound foreign-key relationships", () => {
    const block = renderTableBlock(
      table({
        name: "orders",
        columns: [
          {
            name: "user_id",
            dataType: "int",
            nullable: false,
            isPrimaryKey: false,
            isForeignKey: true,
          },
        ],
        foreignKeys: [
          {
            name: "fk_user",
            columns: ["user_id"],
            refTable: "users",
            refSchema: "public",
            refColumns: ["id"],
          },
        ],
      }),
    );
    expect(block).toContain("user_id (int, fk)");
    expect(block).toContain("fks: user_id → public.users.id");
  });

  it("omits refSchema from the FK target when absent", () => {
    const block = renderTableBlock(
      table({
        foreignKeys: [{ name: "fk", columns: ["a"], refTable: "t", refColumns: ["b"] }],
      }),
    );
    expect(block).toContain("fks: a → t.b");
  });
});

describe("buildSchemaSummary (#732)", () => {
  it("returns an empty summary for no tables", () => {
    expect(buildSchemaSummary([])).toEqual({
      text: "",
      includedCount: 0,
      totalCount: 0,
      truncated: false,
      indexedCount: 0,
    });
  });

  it("orders tables deterministically by qualified name", () => {
    const summary = buildSchemaSummary([table({ name: "zebra" }), table({ name: "apple" })]);
    expect(summary.truncated).toBe(false);
    expect(summary.text.indexOf("public.apple")).toBeLessThan(summary.text.indexOf("public.zebra"));
  });

  it("caps at maxTables and marks the summary truncated", () => {
    const tables = [table({ name: "a" }), table({ name: "b" }), table({ name: "c" })];
    const summary = buildSchemaSummary(tables, { maxTables: 2 });
    expect(summary.includedCount).toBe(2);
    expect(summary.totalCount).toBe(3);
    expect(summary.truncated).toBe(true);
    expect(summary.text).toContain("1 more table(s) omitted");
  });

  it("truncates deterministically when the token budget is exceeded", () => {
    const tables = Array.from({ length: 10 }, (_, i) =>
      table({ name: `table_${String(i).padStart(2, "0")}` }),
    );
    const summary = buildSchemaSummary(tables, { tokenBudget: 40 });
    expect(summary.includedCount).toBeGreaterThan(0);
    expect(summary.includedCount).toBeLessThan(10);
    expect(summary.truncated).toBe(true);
    // Deterministic: the same input yields the same cut.
    const again = buildSchemaSummary(tables, { tokenBudget: 40 });
    expect(again.includedCount).toBe(summary.includedCount);
    expect(again.text).toBe(summary.text);
  });

  it("always includes at least one table even if it overflows the budget", () => {
    const summary = buildSchemaSummary([table(), table({ name: "b" })], { tokenBudget: 1 });
    expect(summary.includedCount).toBe(1);
    expect(summary.truncated).toBe(true);
  });

  it("names the budget-dropped tail so the agent knows those tables exist", () => {
    const tables = Array.from({ length: 40 }, (_, i) =>
      table({ name: `table_${String(i).padStart(2, "0")}` }),
    );
    const summary = buildSchemaSummary(tables, { tokenBudget: 40 });

    expect(summary.truncated).toBe(true);
    expect(summary.indexedCount).toBe(40 - summary.includedCount);
    expect(summary.text).toContain("NAMES OF OMITTED TABLES");
    // A table dropped from the detail is still named.
    expect(summary.text).toContain("public.table_39");
    expect(summary.text).not.toContain("further table name(s) not listed");
  });

  it("caps the name index with its own budget and reports the unlisted remainder", () => {
    const tables = Array.from({ length: 40 }, (_, i) =>
      table({ name: `table_${String(i).padStart(2, "0")}` }),
    );
    const summary = buildSchemaSummary(tables, {
      tokenBudget: 40,
      overflowIndexTokenBudget: 10,
    });

    expect(summary.indexedCount).toBeGreaterThan(0);
    expect(summary.indexedCount).toBeLessThan(40 - summary.includedCount);
    const unlisted = 40 - summary.includedCount - summary.indexedCount;
    expect(summary.text).toContain(`and ${unlisted} further table name(s) not listed`);
  });

  it("emits no name index when nothing was dropped", () => {
    const summary = buildSchemaSummary([table()]);
    expect(summary.truncated).toBe(false);
    expect(summary.indexedCount).toBe(0);
    expect(summary.text).not.toContain("NAMES OF OMITTED TABLES");
  });

  it("keeps the name index deterministic across identical builds", () => {
    const tables = Array.from({ length: 40 }, (_, i) =>
      table({ name: `table_${String(i).padStart(2, "0")}` }),
    );
    const a = buildSchemaSummary(tables, { tokenBudget: 40 });
    const b = buildSchemaSummary(tables, { tokenBudget: 40 });
    expect(b.text).toBe(a.text);
    expect(b.indexedCount).toBe(a.indexedCount);
  });

  it("applies usage tags via a tolerant lookup (qualified or bare name)", () => {
    const usage = new Map([
      ["public.users", "used"],
      ["orders", "unreferenced"],
    ]);
    const summary = buildSchemaSummary([table(), table({ name: "orders" })], { usage });
    expect(summary.text).toContain("public.users [used]");
    expect(summary.text).toContain("public.orders [unreferenced]");
  });
});

describe("#1312 — requirement-relevance ranking", () => {
  it("extracts meaningful terms and drops boilerplate and short tokens", () => {
    const terms = extractRelevanceTerms("The system shall record regional hub jobs for invoicing.");
    expect(terms.has("regional")).toBe(true);
    expect(terms.has("invoicing")).toBe(true);
    // Requirements boilerplate and sub-4-character tokens carry no ranking signal.
    expect(terms.has("shall")).toBe(false);
    expect(terms.has("system")).toBe(false);
    expect(terms.has("the")).toBe(false);
    expect(terms.has("hub")).toBe(false);
  });

  it("normalises plurals identically on both sides so JOBS matches 'jobs'", () => {
    const terms = extractRelevanceTerms("jobs");
    const summary = buildSchemaSummary([table({ name: "transaction_jobs" })], {
      relevanceTerms: terms,
    });
    expect(summary.text).toContain("public.transaction_jobs");
  });

  it("bounds the scanned text so a huge corpus cannot dominate extraction", () => {
    const noise = `${"z".repeat(MAX_RELEVANCE_TEXT_CHARS)} needlewordhere`;
    expect(extractRelevanceTerms(noise).has("needlewordhere")).toBe(false);
  });

  it("keeps a requirement's own table when an alphabetically earlier one would win", () => {
    // The real #1312 failure: TRANSACTION_JOBS is untagged and alphabetically
    // last, so budget truncation demoted it while admin tables kept their columns.
    const tables = [
      table({ name: "admin_audit" }),
      table({ name: "admin_config" }),
      table({ name: "transaction_jobs" }),
    ];
    const opts = { tokenBudget: 40 };

    const blind = buildSchemaSummary(tables, opts);
    expect(blind.text).not.toContain("TABLE public.transaction_jobs —");

    const ranked = buildSchemaSummary(tables, {
      ...opts,
      relevanceTerms: extractRelevanceTerms("Chain the regional hub jobs together"),
    });
    expect(ranked.text).toContain("TABLE public.transaction_jobs —");
  });

  it("ranks a usage-tagged relevant table ahead of a merely relevant one", () => {
    const tables = [table({ name: "zeta_jobs" }), table({ name: "alpha_jobs" })];
    const summary = buildSchemaSummary(tables, {
      tokenBudget: 40,
      usage: new Map([["public.zeta_jobs", "used"]]),
      relevanceTerms: extractRelevanceTerms("jobs"),
    });
    expect(summary.text.indexOf("public.zeta_jobs")).toBeLessThan(
      summary.text.indexOf("public.alpha_jobs"),
    );
  });

  it("prefers the table matching more requirement terms within a group", () => {
    const tables = [table({ name: "alpha_jobs" }), table({ name: "pending_jobs" })];
    const summary = buildSchemaSummary(tables, {
      relevanceTerms: extractRelevanceTerms("pending jobs"),
    });
    expect(summary.text.indexOf("public.pending_jobs")).toBeLessThan(
      summary.text.indexOf("public.alpha_jobs"),
    );
  });

  it("is byte-identical to usage-only ordering when no terms are supplied", () => {
    const tables = [table({ name: "b" }), table({ name: "a" }), table({ name: "c" })];
    const usage = new Map([["public.c", "used"]]);
    const withEmpty = buildSchemaSummary(tables, { usage, relevanceTerms: new Set<string>() });
    const without = buildSchemaSummary(tables, { usage });
    expect(withEmpty.text).toBe(without.text);
    // The usage-tagged table still leads despite sorting last alphabetically.
    expect(without.text.indexOf("public.c")).toBeLessThan(without.text.indexOf("public.a"));
  });

  it("stays deterministic across identical ranked builds", () => {
    const tables = Array.from({ length: 20 }, (_, i) => table({ name: `bids_${i}` }));
    const terms = extractRelevanceTerms("jobs");
    const a = buildSchemaSummary(tables, { tokenBudget: 60, relevanceTerms: terms });
    const b = buildSchemaSummary(tables, { tokenBudget: 60, relevanceTerms: terms });
    expect(b.text).toBe(a.text);
  });
});

describe("schemaSummaryToContextChunk (#732)", () => {
  it("returns null for an empty summary", () => {
    expect(schemaSummaryToContextChunk("p1", buildSchemaSummary([]))).toBeNull();
  });

  it("wraps the summary in a citable, labelled chunk", () => {
    const chunk = schemaSummaryToContextChunk("proj-1", buildSchemaSummary([table()]));
    expect(chunk).not.toBeNull();
    expect(chunk!.documentId).toBe(`${SCHEMA_DOCUMENT_PREFIX}proj-1`);
    expect(chunk!.chunkIndex).toBe(0);
    expect(chunk!.filename).toBe(SCHEMA_CONTEXT_FILENAME);
    expect(chunk!.text).toContain("LIVE DATABASE SCHEMA");
    expect(chunk!.text).toContain(`documentId=${SCHEMA_DOCUMENT_PREFIX}proj-1`);
    expect(chunk!.text).toContain("TABLE public.users");
  });
});

describe("retrieveSchemaContextChunks (#732)", () => {
  function makeDeps(
    tables: DbTableInfo[] | null,
    usage?: Map<string, string>,
  ): AnalysisSchemaContextDeps & { introspect: ReturnType<typeof vi.fn> } {
    return {
      introspect: vi.fn(async () => (tables === null ? null : { tables })),
      readUsage: usage ? vi.fn(async () => usage) : undefined,
    };
  }

  it("returns [] and never introspects when disabled explicitly", async () => {
    const deps = makeDeps([table()]);
    const out = await retrieveSchemaContextChunks({
      projectId: "p1",
      actorId: "u1",
      enabled: false,
      deps,
    });
    expect(out).toEqual([]);
    expect(deps.introspect).not.toHaveBeenCalled();
  });

  it("returns [] when ANALYSIS_SCHEMA_CONTEXT=false (operator opt-out, tunable)", async () => {
    vi.stubEnv("ANALYSIS_SCHEMA_CONTEXT", "false");
    __resetConfigSingleton();
    const deps = makeDeps([table()]);
    const out = await retrieveSchemaContextChunks({ projectId: "p1", actorId: "u1", deps });
    expect(out).toEqual([]);
    expect(deps.introspect).not.toHaveBeenCalled();
  });

  it("introspects by default when the config flag is unset (default ON, #752)", async () => {
    __resetConfigSingleton();
    const deps = makeDeps([table()]);
    const out = await retrieveSchemaContextChunks({ projectId: "p1", actorId: "u1", deps });
    expect(out).toHaveLength(1);
    expect(deps.introspect).toHaveBeenCalledWith("p1", "u1");
  });

  it("honours the config flag when set", async () => {
    vi.stubEnv("ANALYSIS_SCHEMA_CONTEXT", "true");
    const deps = makeDeps([table()]);
    const out = await retrieveSchemaContextChunks({ projectId: "p1", actorId: "u1", deps });
    expect(out).toHaveLength(1);
    expect(deps.introspect).toHaveBeenCalledWith("p1", "u1");
  });

  it("returns a single citable chunk when tables exist", async () => {
    const deps = makeDeps([table()]);
    const out = await retrieveSchemaContextChunks({
      projectId: "proj-9",
      actorId: "u1",
      enabled: true,
      deps,
    });
    expect(out).toHaveLength(1);
    expect(out[0].documentId).toBe(`${SCHEMA_DOCUMENT_PREFIX}proj-9`);
    expect(out[0].text).toContain("TABLE public.users");
  });

  it("returns [] when the project has no introspectable connector", async () => {
    const deps = makeDeps(null);
    const out = await retrieveSchemaContextChunks({
      projectId: "p1",
      actorId: "u1",
      enabled: true,
      deps,
    });
    expect(out).toEqual([]);
  });

  it("returns [] when the schema has no tables", async () => {
    const deps = makeDeps([]);
    const out = await retrieveSchemaContextChunks({
      projectId: "p1",
      actorId: "u1",
      enabled: true,
      deps,
    });
    expect(out).toEqual([]);
  });

  it("applies persisted usage tags when a usage reader is supplied", async () => {
    const deps = makeDeps([table()], new Map([["public.users", "used"]]));
    const out = await retrieveSchemaContextChunks({
      projectId: "p1",
      actorId: "u1",
      enabled: true,
      deps,
    });
    expect(out[0].text).toContain("public.users [used]");
  });

  it("still returns the chunk when the usage reader throws (best-effort)", async () => {
    const deps: AnalysisSchemaContextDeps = {
      introspect: async () => ({ tables: [table()] }),
      readUsage: async () => {
        throw new Error("classification read failed");
      },
    };
    const out = await retrieveSchemaContextChunks({
      projectId: "p1",
      actorId: "u1",
      enabled: true,
      deps,
    });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("TABLE public.users");
  });

  it("degrades to [] (never throws) when introspection fails", async () => {
    const deps: AnalysisSchemaContextDeps = {
      introspect: async () => {
        throw new Error("connector unreachable");
      },
    };
    const out = await retrieveSchemaContextChunks({
      projectId: "p1",
      actorId: "u1",
      enabled: true,
      deps,
    });
    expect(out).toEqual([]);
  });

  it("passes explicit budget/maxTables through to the summary", async () => {
    const tables = [table({ name: "a" }), table({ name: "b" }), table({ name: "c" })];
    const deps = makeDeps(tables);
    const out = await retrieveSchemaContextChunks({
      projectId: "p1",
      actorId: "u1",
      enabled: true,
      maxTables: 1,
      deps,
    });
    expect(out[0].text).toContain("2 more table(s) omitted");
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_SCHEMA_TOKEN_BUDGET).toBeGreaterThan(0);
    expect(DEFAULT_SCHEMA_MAX_TABLES).toBeGreaterThan(0);
    expect(DEFAULT_SCHEMA_OVERFLOW_INDEX_TOKEN_BUDGET).toBeGreaterThan(0);
  });

  describe("default production seams (no injected deps)", () => {
    afterEach(() => {
      listDbConnectorsMock.mockReset();
      inspectDbConnectorMock.mockReset();
      readUsageClassificationMock.mockReset();
    });

    it("introspects the primary connector and annotates persisted usage", async () => {
      listDbConnectorsMock.mockResolvedValue([{ id: "conn-1" }, { id: "conn-2" }]);
      inspectDbConnectorMock.mockResolvedValue({ tables: [table()] });
      readUsageClassificationMock.mockResolvedValue([
        { kind: "table", tableName: "public.users", usageClass: "used", overriddenClass: null },
        { kind: "column", tableName: "public.users", usageClass: "used", overriddenClass: null },
      ]);

      const out = await retrieveSchemaContextChunks({
        projectId: "p-live",
        actorId: "actor-1",
        enabled: true,
      });

      expect(out).toHaveLength(1);
      expect(out[0].text).toContain("public.users [used]");
      // Uses the FIRST (primary) connector under the given actor.
      expect(inspectDbConnectorMock).toHaveBeenCalledWith("p-live", "conn-1", "actor-1");
    });

    it("prefers an override class over the computed usage class", async () => {
      listDbConnectorsMock.mockResolvedValue([{ id: "conn-1" }]);
      inspectDbConnectorMock.mockResolvedValue({ tables: [table()] });
      readUsageClassificationMock.mockResolvedValue([
        {
          kind: "table",
          tableName: "public.users",
          usageClass: "unreferenced",
          overriddenClass: "used",
        },
      ]);

      const out = await retrieveSchemaContextChunks({
        projectId: "p-live",
        actorId: "actor-1",
        enabled: true,
      });
      expect(out[0].text).toContain("public.users [used]");
    });

    it("returns [] when the project has no connector (default introspect)", async () => {
      listDbConnectorsMock.mockResolvedValue([]);
      const out = await retrieveSchemaContextChunks({
        projectId: "p-none",
        actorId: "actor-1",
        enabled: true,
      });
      expect(out).toEqual([]);
      expect(inspectDbConnectorMock).not.toHaveBeenCalled();
    });
  });
});

/**
 * Relevance-ranked truncation.
 *
 * Purely alphabetical truncation made the schema summary useless on a large
 * schema: a real 641-table Oracle schema rendered only its ~20 alphabetically
 * first tables (administrative/organization ones), so the data-modeling agent
 * reported it "could not cite a single relevant table". Usage tags were already
 * read to RENDER a per-table annotation but were ignored when deciding what
 * survived, so the one relevance signal available was thrown away.
 */
describe("buildSchemaSummary relevance ranking", () => {
  const table = (name: string): DbTableInfo =>
    ({
      name,
      schema: "SALESDB",
      columns: [{ name: "ID", type: "NUMBER" }],
      foreignKeys: [],
    }) as unknown as DbTableInfo;

  it("keeps usage-tagged tables when truncation drops alphabetically earlier ones", () => {
    // `aaa_admin` sorts first alphabetically but is untagged; `zzz_jobs` is the
    // one the code actually touches.
    const summary = buildSchemaSummary([table("aaa_admin"), table("zzz_jobs")], {
      maxTables: 1,
      usage: new Map([["zzz_jobs", "read-write"]]),
    });

    const detail = summary.text.split("NAMES OF OMITTED TABLES")[0];
    expect(detail).toContain("zzz_jobs");
    expect(detail).not.toContain("aaa_admin");
    // Dropped from the detail, but still named so the agent knows it exists.
    expect(summary.text).toContain("aaa_admin");
    expect(summary.truncated).toBe(true);
  });

  it("stays alphabetical among tables of equal usage, so output is deterministic", () => {
    const tables = [table("m_b"), table("m_a"), table("m_c")];
    const first = buildSchemaSummary(tables, { maxTables: 2 });
    const second = buildSchemaSummary([...tables].reverse(), { maxTables: 2 });

    const detail = first.text.split("NAMES OF OMITTED TABLES")[0];
    expect(first.text).toBe(second.text);
    expect(detail.indexOf("m_a")).toBeLessThan(detail.indexOf("m_b"));
    expect(detail).not.toContain("m_c");
    expect(first.text).toContain("m_c");
  });
});
