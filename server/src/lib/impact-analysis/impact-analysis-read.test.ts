/**
 * #936 (epic #929) — end-to-end PERSIST → READ test for the LLM output-relevance
 * filter's secondary bucket.
 *
 * The filter prunes tangential (`unlikely`) tables from the primary set in
 * memory, but the product boundary is the persistence/read path. This test
 * drives the FULL path — `executeImpactAnalysis` crosses the blast radius into
 * the schema graph, a (mocked) relevance filter demotes one table to the
 * secondary bucket, the engine PERSISTS every row with its `relevanceTier`
 * discriminator, and `getImpactAnalysisDetail` reads them back and SPLITS
 * primary from secondary. It proves the exact defect the reviewer found: a
 * persisted `unlikely` table must be EXCLUDED from the primary `affectedTables`
 * and PRESENT in `affectedTablesSecondary`.
 *
 * A reconstructing fake Prisma (no real DB, no SQL executed) backs the store so
 * the same rows the engine writes are what the read path loads.
 */
import { describe, expect, it, vi } from "vitest";
import type { CodeGraphDataSource, GraphSymbol } from "../code-graph/query-service.js";
import type { SchemaImpactDataSource, AffectedTableInput } from "./schema-impact.js";
import type { TableRelevanceFilterResult } from "./table-relevance-filter.js";
import { executeImpactAnalysis } from "./impact-analysis-engine.js";
import {
  computeSharedTableImpacts,
  computeWritePathGaps,
  getImpactAnalysisDetail,
  WRITE_PATH_BRIDGE_MAX_DEPTH,
  WRITE_PATH_SERVICE_CALL_MAX_DEPTH,
} from "./impact-analysis-read.js";
import type { ImpactItemView } from "@metis/shared";

// ── Minimal code graph: one impacted symbol A, no callers ────────────────────

function sym(id: string): GraphSymbol {
  return {
    id,
    qualifiedName: `pkg.${id}`,
    kind: "function",
    filePath: `${id}.ts`,
    language: "ts",
    startLine: 1,
    endLine: 10,
  };
}

function codeGraph(): CodeGraphDataSource {
  const symbols: Record<string, GraphSymbol> = { A: sym("A") };
  return {
    async getSymbol(id) {
      return symbols[id] ?? null;
    },
    async getEdgesFrom() {
      return [];
    },
    async getEdgesTo() {
      return [];
    },
    async getSymbolsByFile(fp) {
      return Object.values(symbols).filter((s) => s.filePath === fp);
    },
    async getSymbolsByIds(ids) {
      return ids.map((id) => symbols[id]).filter(Boolean) as GraphSymbol[];
    },
  };
}

// ── Schema graph: A reaches TWO tables (orders + audit_log) ───────────────────

function schemaGraph(): SchemaImpactDataSource {
  return {
    getSchemaEdgesFrom: async (ids: string[]) =>
      ids.includes("A")
        ? [
            { fromSymbolId: "A", toSymbolId: "tbl-orders", kind: "reads" as const },
            { fromSymbolId: "A", toSymbolId: "tbl-audit", kind: "reads" as const },
          ]
        : [],
    getSchemaSymbolsByIds: async (ids: string[]) =>
      [
        {
          id: "tbl-orders",
          kind: "table" as const,
          name: "orders",
          qualifiedName: "shop.orders",
          source: "mybatis" as const,
        },
        {
          id: "tbl-audit",
          kind: "table" as const,
          name: "audit_log",
          qualifiedName: "shop.audit_log",
          source: "mybatis" as const,
        },
      ].filter((s) => ids.includes(s.id)),
  };
}

/**
 * A mock relevance filter that mimics the real one at the boundary: any table
 * whose name contains `audit` is judged `unlikely` (secondary, capped
 * confidence + own rationale column); everything else is `likely` (primary).
 * Deterministic regardless of crossing order.
 */
async function partitioningFilter(
  _requirement: string,
  tables: AffectedTableInput[],
): Promise<TableRelevanceFilterResult> {
  const primary: AffectedTableInput[] = [];
  const secondary: AffectedTableInput[] = [];
  for (const t of tables) {
    if (t.objectKind === "table" && t.tableName.includes("audit")) {
      secondary.push({
        ...t,
        relevanceTier: "unlikely",
        relevanceRationale: "tangential fan-out; not implied by the requirement",
        confidence: Math.min(t.confidence, 0.2),
      });
    } else {
      primary.push({ ...t, relevanceTier: "likely", relevanceRationale: "clearly implied" });
    }
  }
  return { primary, secondary, decisions: [], applied: true };
}

// ── Reconstructing fake Prisma: createMany writes → findFirst reads them back ─

interface Store {
  analyses: Map<string, Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  symbols: Array<Record<string, unknown>>;
  tables: Array<Record<string, unknown>>;
  consumers: Array<Record<string, unknown>>;
}

function reconstructingPrisma(store: Store) {
  return {
    impactAnalysis: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "ia-1", startedAt: new Date(), completedAt: null, ...data };
        store.analyses.set(row.id as string, row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = store.analyses.get(where.id);
        if (!row) return null;
        // Rebuild the nested include the read path asks for, applying the same
        // orderBy (tableName asc) the real ITEM_INCLUDE uses.
        const items = store.items.map((it) => ({
          ...it,
          requirement: null,
          affectedSymbols: store.symbols.filter((s) => s.impactItemId === it.id),
          affectedTables: store.tables
            .filter((t) => t.impactItemId === it.id)
            .sort((a, b) => String(a.tableName).localeCompare(String(b.tableName)))
            .map((t) => ({
              ...t,
              consumers: store.consumers.filter((c) => c.affectedTableId === t.id),
            })),
        }));
        return { ...row, items };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...store.analyses.get(where.id), ...data };
          store.analyses.set(where.id, row);
          return row;
        },
      ),
    },
    impactItem: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `item-${store.items.length}`, ...data };
        store.items.push(row);
        return row;
      }),
    },
    impactAffectedSymbol: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        store.symbols.push(
          ...data.map((d, i) => ({ id: `sym-${store.symbols.length + i}`, ...d })),
        );
        return { count: data.length };
      }),
    },
    impactAffectedTable: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        store.tables.push(...data.map((d, i) => ({ id: `tbl-${store.tables.length + i}`, ...d })));
        return { count: data.length };
      }),
    },
    impactAffectedTableConsumer: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        store.consumers.push(
          ...data.map((d, i) => ({ id: `con-${store.consumers.length + i}`, ...d })),
        );
        return { count: data.length };
      }),
    },
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    quarantineChunk: { findMany: vi.fn(async () => []) },
  };
}

function emptyStore(): Store {
  return { analyses: new Map(), items: [], symbols: [], tables: [], consumers: [] };
}

async function runWithFilter(
  store: Store,
  tableRelevanceFilter?: (
    r: string,
    t: AffectedTableInput[],
  ) => Promise<TableRelevanceFilterResult>,
) {
  const prisma = reconstructingPrisma(store);
  store.analyses.set("ia-1", {
    id: "ia-1",
    status: "pending",
    sourceText: "Add a discontinued flag",
    documentId: null,
    summary: null,
    errorMessage: null,
    totalImpactedSymbols: 0,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
  });
  await executeImpactAnalysis("ia-1", ["proj-1"], {
    prisma: prisma as never,
    extractor: {
      extract: async () => [
        {
          requirementId: null,
          title: "flag",
          body: "add flag",
          changeType: "added",
          bodyDelta: 10,
        },
      ],
    },
    mapRequirement: async () => [
      {
        codeSymbolId: "A",
        filePath: "A.ts",
        qualifiedName: "pkg.A",
        startLine: 1,
        endLine: 5,
        confidence: 0.8,
      },
    ],
    dataSourceFor: () => codeGraph(),
    schemaDataSourceFor: () => schemaGraph(),
    tableRelevanceFilter,
  });
  return getImpactAnalysisDetail("ia-1", prisma as never);
}

describe("#936 persist → read: relevance secondary bucket", () => {
  it("excludes a PERSISTED unlikely table from primary and surfaces it in the secondary bucket", async () => {
    const store = emptyStore();
    const detail = await runWithFilter(store, partitioningFilter);

    // Sanity: BOTH tables were persisted into the same table with a tier tag.
    const persistedNames = store.tables.map((t) => t.tableName).sort();
    expect(persistedNames).toContain("shop.orders");
    expect(persistedNames).toContain("shop.audit_log");
    const auditRow = store.tables.find((t) => t.tableName === "shop.audit_log");
    expect(auditRow?.relevanceTier).toBe("unlikely");
    expect(auditRow?.relevanceRationale).toMatch(/tangential/);

    const item = detail?.items[0];
    expect(item).toBeDefined();

    const primaryNames = item!.affectedTables.map((t) => t.tableName);
    const secondaryNames = item!.affectedTablesSecondary.map((t) => t.tableName);

    // The pruned `unlikely` table must NOT leak into the primary response...
    expect(primaryNames).toContain("shop.orders");
    expect(primaryNames).not.toContain("shop.audit_log");
    // ...but must remain visible in the secondary bucket (recall safety).
    expect(secondaryNames).toEqual(["shop.audit_log"]);

    const secondary = item!.affectedTablesSecondary[0];
    expect(secondary.relevanceTier).toBe("unlikely");
    expect(secondary.confidence).toBeLessThanOrEqual(0.2);
    // The rationale rides its own column, never folded into the DDL-typed field.
    expect(secondary.relevanceRationale).toMatch(/tangential/);
    expect(secondary.suggestedDdl ?? "").not.toContain("[relevance");
  });

  it("with no filter, all crossed tables persist NULL tiers and read as primary (legacy passthrough)", async () => {
    const store = emptyStore();
    const detail = await runWithFilter(store); // no tableRelevanceFilter

    // Every persisted row carries a NULL tier (filter never ran).
    expect(store.tables.every((t) => t.relevanceTier === null)).toBe(true);

    const item = detail?.items[0];
    const primaryNames = item!.affectedTables.map((t) => t.tableName).sort();
    expect(primaryNames).toEqual(["shop.audit_log", "shop.orders"]);
    // Null-tier rows never populate the secondary bucket.
    expect(item!.affectedTablesSecondary).toHaveLength(0);
    expect(item!.affectedTables.every((t) => t.relevanceTier === null)).toBe(true);
  });
});

// ── #940 — columns inherit their parent table's tier + bucket ─────────────────

/** A persisted affected-table/column row as the read path receives it from Prisma. */
function rawRow(over: Partial<RawAffectedTableLike> & { tableName: string }): RawAffectedTableLike {
  return {
    id: `row-${Math.random().toString(36).slice(2)}`,
    objectKind: "table",
    columnName: null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: null,
    source: "mybatis",
    reconciliation: null,
    confidence: 0.6,
    riskClass: null,
    relevanceTier: null,
    relevanceRationale: null,
    ...over,
  };
}

interface RawAffectedTableLike {
  id: string;
  objectKind: string;
  tableName: string;
  columnName: string | null;
  columnType: string | null;
  changeKind: string;
  suggestedDdl: string | null;
  source: string;
  reconciliation: string | null;
  confidence: number;
  riskClass: string | null;
  relevanceTier: string | null;
  relevanceRationale: string | null;
}

/** A findFirst-only fake prisma that returns ONE item wrapping the given rows verbatim. */
function fixedItemPrisma(affectedTables: RawAffectedTableLike[]) {
  return {
    impactAnalysis: {
      findFirst: vi.fn(async () => ({
        id: "ia-940",
        status: "completed",
        documentId: null,
        sourceText: "Add a status flag to account",
        summary: null,
        errorMessage: null,
        totalImpactedSymbols: affectedTables.length,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: null,
        items: [
          {
            id: "item-0",
            projectId: "p1",
            requirementId: null,
            changeType: "added",
            severity: "low",
            impactScore: 0.4,
            confidence: 0.8,
            affectedFileCount: 1,
            affectedSymbolCount: 0,
            requirement: null,
            affectedSymbols: [],
            affectedTables,
          },
        ],
      })),
    },
  };
}

describe("#940 columns inherit their parent table's bucket + tier", () => {
  it("moves an unlikely table AND all of its column rows to secondary with the same tier", async () => {
    // The live repro: `inventory` table is judged `unlikely` (→ secondary) but its
    // `inventory.qty` column persisted with a NULL tier — it must NOT stay in primary.
    const rows = [
      rawRow({
        tableName: "inventory",
        objectKind: "table",
        relevanceTier: "unlikely",
        confidence: 0.2,
      }),
      rawRow({
        tableName: "inventory",
        objectKind: "column",
        columnName: "qty",
        relevanceTier: null,
      }),
    ];
    const detail = await getImpactAnalysisDetail("ia-940", fixedItemPrisma(rows) as never);
    const item = detail!.items[0];

    // No inventory row leaks into primary...
    expect(item.affectedTables.some((t) => t.tableName === "inventory")).toBe(false);
    // ...both the table AND its column ride together in secondary, tier unlikely.
    const invSecondary = item.affectedTablesSecondary.filter((t) => t.tableName === "inventory");
    expect(invSecondary).toHaveLength(2);
    expect(invSecondary.every((t) => t.relevanceTier === "unlikely")).toBe(true);
    expect(new Set(invSecondary.map((t) => t.columnName))).toEqual(new Set(["qty", null]));
  });

  it("keeps a primary table AND its column rows together in primary with the table's tier", async () => {
    const rows = [
      rawRow({ tableName: "account", objectKind: "table", relevanceTier: "likely" }),
      rawRow({
        tableName: "account",
        objectKind: "column",
        columnName: "status",
        relevanceTier: null,
      }),
    ];
    const detail = await getImpactAnalysisDetail("ia-940", fixedItemPrisma(rows) as never);
    const item = detail!.items[0];

    expect(item.affectedTablesSecondary).toHaveLength(0);
    const acct = item.affectedTables.filter((t) => t.tableName === "account");
    expect(acct).toHaveLength(2);
    // The column inherits the table's `likely` tier instead of its own null.
    expect(acct.every((t) => t.relevanceTier === "likely")).toBe(true);
  });

  it("routes a mixed multi-table set so no tableName spans both buckets", async () => {
    const rows = [
      rawRow({ tableName: "account", objectKind: "table", relevanceTier: "likely" }),
      rawRow({
        tableName: "account",
        objectKind: "column",
        columnName: "status",
        relevanceTier: null,
      }),
      rawRow({
        tableName: "inventory",
        objectKind: "table",
        relevanceTier: "unlikely",
        confidence: 0.2,
      }),
      rawRow({
        tableName: "inventory",
        objectKind: "column",
        columnName: "qty",
        relevanceTier: null,
      }),
      rawRow({ tableName: "orders", objectKind: "table", relevanceTier: "possible" }),
      rawRow({
        tableName: "orders",
        objectKind: "column",
        columnName: "total",
        relevanceTier: null,
      }),
    ];
    const detail = await getImpactAnalysisDetail("ia-940", fixedItemPrisma(rows) as never);
    const item = detail!.items[0];

    const primaryTables = new Set(item.affectedTables.map((t) => t.tableName));
    const secondaryTables = new Set(item.affectedTablesSecondary.map((t) => t.tableName));

    // Invariant: the primary and secondary table-name sets are DISJOINT.
    for (const name of primaryTables) expect(secondaryTables.has(name)).toBe(false);
    for (const name of secondaryTables) expect(primaryTables.has(name)).toBe(false);

    // account (likely) + orders (possible) with their columns → primary (2 rows each).
    expect(item.affectedTables.filter((t) => t.tableName === "account")).toHaveLength(2);
    expect(item.affectedTables.filter((t) => t.tableName === "orders")).toHaveLength(2);
    // inventory (unlikely) with its column → secondary (2 rows).
    expect(item.affectedTablesSecondary.filter((t) => t.tableName === "inventory")).toHaveLength(2);
    expect(item.affectedTablesSecondary.every((t) => t.relevanceTier === "unlikely")).toBe(true);
  });
});

describe("#957 read path surfaces the persisted DDL risk class", () => {
  it("maps each recognised risk class onto the affected-table view", async () => {
    const rows = [
      rawRow({
        tableName: "account",
        objectKind: "table",
        changeKind: "reference",
        riskClass: "neutral",
      }),
      rawRow({
        tableName: "account",
        objectKind: "column",
        columnName: "status",
        changeKind: "add-column",
        riskClass: "expanding",
      }),
      rawRow({
        tableName: "account",
        objectKind: "column",
        columnName: "ssn",
        changeKind: "drop-column",
        riskClass: "breaking",
      }),
    ];
    const detail = await getImpactAnalysisDetail("ia-957", fixedItemPrisma(rows) as never);
    const tables = detail!.items[0].affectedTables;
    expect(tables.find((t) => t.columnName === null)?.riskClass).toBe("neutral");
    expect(tables.find((t) => t.columnName === "status")?.riskClass).toBe("expanding");
    expect(tables.find((t) => t.columnName === "ssn")?.riskClass).toBe("breaking");
  });

  it("reads a legacy null risk class as null (no crash, no fabricated value)", async () => {
    const rows = [rawRow({ tableName: "orders", riskClass: null })];
    const detail = await getImpactAnalysisDetail("ia-957b", fixedItemPrisma(rows) as never);
    expect(detail!.items[0].affectedTables[0].riskClass).toBeNull();
  });

  it("treats an unrecognised persisted value as null (forward-compatible)", async () => {
    const rows = [rawRow({ tableName: "orders", riskClass: "totally-new-kind" })];
    const detail = await getImpactAnalysisDetail("ia-957c", fixedItemPrisma(rows) as never);
    expect(detail!.items[0].affectedTables[0].riskClass).toBeNull();
  });
});

describe("#956 engine persists cross-project consumers end-to-end", () => {
  it("persists consumerResolution + consumer child rows and reads them back", async () => {
    const store = emptyStore();
    const prisma = reconstructingPrisma(store);
    store.analyses.set("ia-1", {
      id: "ia-1",
      status: "pending",
      sourceText: "Add a loyalty tier to account",
      documentId: null,
      summary: null,
      errorMessage: null,
      totalImpactedSymbols: 0,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: null,
    });

    const identityResolver = vi.fn(async () => "identity-id-1");
    await executeImpactAnalysis("ia-1", ["proj-1"], {
      prisma: prisma as never,
      extractor: {
        extract: async () => [
          { requirementId: null, title: "tier", body: "add", changeType: "added", bodyDelta: 5 },
        ],
      },
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 5,
          confidence: 0.8,
        },
      ],
      dataSourceFor: () => codeGraph(),
      schemaDataSourceFor: () => schemaGraph(),
      // Inject the two #956 seams so the engine links identities + resolves consumers
      // without a live workspace.
      identityResolverFor: async () => identityResolver,
      consumerResolver: async ({ affected }) =>
        affected
          .filter((t) => t.tableName === "shop.orders")
          .slice(0, 1)
          .map(() => ({
            tableName: "shop.orders",
            resolution: "string-match" as const,
            consumers: [
              {
                projectId: "reporting",
                projectName: "Reporting",
                usage: "writtenBy" as const,
                objectQualifiedName: "shop.orders",
              },
            ],
          })),
    });

    // The identity resolver was threaded into crossToSchema (rows carry the FK).
    expect(identityResolver).toHaveBeenCalled();
    const ordersRow = store.tables.find((t) => t.tableName === "shop.orders");
    expect(ordersRow?.schemaObjectIdentityId).toBe("identity-id-1");
    expect(ordersRow?.consumerResolution).toBe("string-match");
    // #957 — every persisted row carries a deterministic DDL risk class.
    expect(["breaking", "expanding", "neutral"]).toContain(ordersRow?.riskClass);
    expect(store.tables.every((t) => t.riskClass != null)).toBe(true);
    // A consumer child row was persisted against the orders row.
    expect(store.consumers).toHaveLength(1);
    expect(store.consumers[0]).toMatchObject({
      affectedTableId: ordersRow?.id,
      consumerProjectId: "reporting",
      usage: "writtenBy",
    });

    // Read path surfaces the consumer on the orders table view.
    const detail = await getImpactAnalysisDetail("ia-1", prisma as never);
    const ordersView = detail!.items[0].affectedTables.find((t) => t.tableName === "shop.orders");
    expect(ordersView?.consumerResolution).toBe("string-match");
    // #957 — the risk class round-trips to the read view.
    expect(["breaking", "expanding", "neutral"]).toContain(ordersView?.riskClass);
    expect(ordersView?.consumers).toEqual([
      {
        projectId: "reporting",
        projectName: "Reporting",
        usage: "writtenBy",
        objectQualifiedName: "shop.orders",
      },
    ]);
  });
});

// ── #956 — cross-project consumers surface on the table view ─────────────────

/** A findFirst-only fake returning ONE item whose tables carry consumer data. */
function consumerItemPrisma(affectedTables: Array<Record<string, unknown>>) {
  return {
    impactAnalysis: {
      findFirst: vi.fn(async () => ({
        id: "ia-956",
        status: "completed",
        documentId: null,
        sourceText: "Add a loyalty tier to account",
        summary: null,
        errorMessage: null,
        totalImpactedSymbols: affectedTables.length,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: null,
        items: [
          {
            id: "item-0",
            projectId: "p1",
            requirementId: null,
            changeType: "added",
            severity: "low",
            impactScore: 0.4,
            confidence: 0.8,
            affectedFileCount: 1,
            affectedSymbolCount: 0,
            requirement: null,
            affectedSymbols: [],
            affectedTables,
          },
        ],
      })),
    },
  };
}

function consumerRow(over: Record<string, unknown> & { tableName: string }) {
  return {
    id: `row-${Math.random().toString(36).slice(2)}`,
    objectKind: "table",
    columnName: null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: null,
    source: "mybatis",
    reconciliation: null,
    confidence: 0.6,
    relevanceTier: null,
    relevanceRationale: null,
    consumerResolution: null,
    consumers: [],
    ...over,
  };
}

describe("#956 read path surfaces cross-project consumers", () => {
  it("attaches consumers + resolution from the representative row onto the table view", async () => {
    const rows = [
      consumerRow({
        tableName: "account",
        objectKind: "table",
        consumerResolution: "identity",
        consumers: [
          {
            consumerProjectId: "reporting",
            consumerProjectName: "Reporting",
            usage: "readBy",
            objectQualifiedName: "account",
          },
        ],
      }),
      // A column row of the same table carries no consumer data of its own; it
      // must still surface the table's consumers (grouped in the UI).
      consumerRow({ tableName: "account", objectKind: "column", columnName: "tier" }),
    ];
    const detail = await getImpactAnalysisDetail("ia-956", consumerItemPrisma(rows) as never);
    const tables = detail!.items[0].affectedTables.filter((t) => t.tableName === "account");
    expect(tables).toHaveLength(2);
    for (const t of tables) {
      expect(t.consumerResolution).toBe("identity");
      expect(t.consumers).toEqual([
        {
          projectId: "reporting",
          projectName: "Reporting",
          usage: "readBy",
          objectQualifiedName: "account",
        },
      ]);
    }
  });

  it("surfaces the could-not-verify (`unverifiable`) state distinctly from zero consumers", async () => {
    const rows = [
      consumerRow({ tableName: "orders", consumerResolution: "unverifiable", consumers: [] }),
    ];
    const detail = await getImpactAnalysisDetail("ia-956", consumerItemPrisma(rows) as never);
    const view = detail!.items[0].affectedTables[0];
    expect(view.consumerResolution).toBe("unverifiable");
    expect(view.consumers).toEqual([]);
  });

  it("leaves consumer fields undefined when not computed (single-project unchanged)", async () => {
    const rows = [consumerRow({ tableName: "orders" })]; // consumerResolution null
    const detail = await getImpactAnalysisDetail("ia-956", consumerItemPrisma(rows) as never);
    const view = detail!.items[0].affectedTables[0];
    expect(view.consumerResolution ?? null).toBeNull();
    expect(view.consumers ?? []).toEqual([]);
  });

  it("normalizes a legacy consumer usage value to readBy", async () => {
    const rows = [
      consumerRow({
        tableName: "orders",
        consumerResolution: "string-match",
        consumers: [
          {
            consumerProjectId: "x",
            consumerProjectName: "X",
            usage: "weird",
            objectQualifiedName: "orders",
          },
        ],
      }),
    ];
    const detail = await getImpactAnalysisDetail("ia-956", consumerItemPrisma(rows) as never);
    expect(detail!.items[0].affectedTables[0].consumers?.[0].usage).toBe("readBy");
  });
});

function feedbackItemPrisma(feedback: Array<Record<string, unknown>>) {
  return {
    impactAnalysis: {
      findFirst: vi.fn(async () => ({
        id: "ia-966",
        status: "completed",
        documentId: null,
        sourceText: "Add a loyalty tier to account",
        summary: null,
        errorMessage: null,
        totalImpactedSymbols: 0,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: null,
        items: [
          {
            id: "item-0",
            projectId: "p1",
            requirementId: null,
            changeType: "added",
            severity: "low",
            impactScore: 0.4,
            confidence: 0.8,
            affectedFileCount: 1,
            affectedSymbolCount: 0,
            requirement: null,
            affectedSymbols: [],
            affectedTables: [],
            feedback,
          },
        ],
      })),
    },
  };
}

function feedbackRow(over: Record<string, unknown> = {}) {
  return {
    id: `fb-${Math.random().toString(36).slice(2)}`,
    impactItemId: "item-0",
    tableName: "account",
    columnName: null,
    verdict: "relevant",
    userId: "user-1",
    userDisplayName: "alice",
    createdAt: new Date("2026-07-20T00:00:00Z"),
    ...over,
  };
}

describe("#966 read path surfaces feedback", () => {
  it("maps persisted feedback rows onto the item view", async () => {
    const rows = [feedbackRow()];
    const detail = await getImpactAnalysisDetail("ia-966", feedbackItemPrisma(rows) as never);
    expect(detail!.items[0].feedback).toEqual([
      {
        id: rows[0].id,
        impactItemId: "item-0",
        tableName: "account",
        columnName: null,
        verdict: "relevant",
        userId: "user-1",
        userDisplayName: "alice",
        createdAt: "2026-07-20T00:00:00.000Z",
      },
    ]);
  });

  it("preserves a column-level verdict's columnName", async () => {
    const rows = [feedbackRow({ columnName: "email", verdict: "not-relevant" })];
    const detail = await getImpactAnalysisDetail("ia-966", feedbackItemPrisma(rows) as never);
    expect(detail!.items[0].feedback[0]).toMatchObject({
      columnName: "email",
      verdict: "not-relevant",
    });
  });

  it("normalizes an unrecognised verdict to relevant", async () => {
    const rows = [feedbackRow({ verdict: "garbage" })];
    const detail = await getImpactAnalysisDetail("ia-966", feedbackItemPrisma(rows) as never);
    expect(detail!.items[0].feedback[0].verdict).toBe("relevant");
  });

  it("defaults to an empty array when no one has marked anything", async () => {
    const detail = await getImpactAnalysisDetail("ia-966", feedbackItemPrisma([]) as never);
    expect(detail!.items[0].feedback).toEqual([]);
  });
});

describe("#966 non-goal: feedback has ZERO effect on the deterministic result", () => {
  // v1 is CAPTURE + EXPORT ONLY — persisted feedback rows must never change the
  // deterministic engine/filter output. Assert the full analysis view is
  // byte-identical WITH and WITHOUT feedback rows present, aside from the
  // `feedback` field itself (which is the only thing feedback is allowed to
  // change).
  function itemPrisma(affectedTables: Array<Record<string, unknown>>, feedback: unknown[]) {
    return {
      impactAnalysis: {
        findFirst: vi.fn(async () => ({
          id: "ia-966-nogoal",
          status: "completed",
          documentId: null,
          sourceText: "Add a loyalty tier to account",
          summary: "Deterministic run summary.",
          errorMessage: null,
          totalImpactedSymbols: affectedTables.length,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: new Date("2026-01-01T00:05:00Z"),
          items: [
            {
              id: "item-0",
              projectId: "p1",
              requirementId: null,
              changeType: "added",
              severity: "low",
              impactScore: 0.4,
              confidence: 0.8,
              affectedFileCount: 1,
              affectedSymbolCount: 0,
              summary: "Deterministic per-item narrative.",
              requirement: null,
              affectedSymbols: [],
              affectedTables,
              feedback,
            },
          ],
        })),
      },
    };
  }

  it("produces an identical detail view with and without feedback rows", async () => {
    const tables = [
      consumerRow({ tableName: "account", objectKind: "table" }),
      consumerRow({ tableName: "account", objectKind: "column", columnName: "tier" }),
    ];
    const withoutFeedback = await getImpactAnalysisDetail(
      "ia-966-nogoal",
      itemPrisma(tables, []) as never,
    );
    const withFeedback = await getImpactAnalysisDetail(
      "ia-966-nogoal",
      itemPrisma(tables, [
        feedbackRow({ verdict: "relevant" }),
        feedbackRow({ verdict: "not-relevant", userId: "user-2", userDisplayName: "bob" }),
      ]) as never,
    );

    // The feedback rows themselves must actually differ (sanity — proves the
    // fixture is exercising the code path)...
    expect(withoutFeedback!.items[0].feedback).toEqual([]);
    expect(withFeedback!.items[0].feedback).toHaveLength(2);

    // ...but every OTHER field of the analysis must be byte-identical.
    const strip = (d: NonNullable<Awaited<ReturnType<typeof getImpactAnalysisDetail>>>) => ({
      ...d,
      items: d.items.map(({ feedback: _feedback, ...rest }) => rest),
    });
    expect(strip(withFeedback!)).toEqual(strip(withoutFeedback!));
  });
});

describe("#956 computeSharedTableImpacts (run-level rollup)", () => {
  function item(projectId: string, tableNames: string[]): ImpactItemView {
    return {
      id: `it-${projectId}-${tableNames.join("_")}`,
      projectId,
      requirementId: null,
      requirementTitle: null,
      changeType: "added",
      severity: "low",
      impactScore: 0.4,
      confidence: 0.8,
      matchQuality: "strong",
      matchQualityReason: null,
      affectedFileCount: 1,
      affectedSymbolCount: 1,
      summary: null,
      affectedSymbols: [],
      affectedTests: [],
      writePathGaps: [],
      feedback: [],
      affectedTablesSecondary: [],
      affectedTables: tableNames.map((tableName) => ({
        id: `${projectId}-${tableName}`,
        objectKind: "table" as const,
        tableName,
        columnName: null,
        columnType: null,
        changeKind: "reference" as const,
        suggestedDdl: null,
        source: "mybatis" as const,
        reconciliation: null,
        confidence: 0.6,
      })),
    };
  }

  it("flags a physical table impacted in ≥2 projects (schema prefix stripped)", () => {
    const shared = computeSharedTableImpacts([
      item("storefront", ["shop.account", "cart"]),
      item("reporting", ["public.account", "report_run"]),
    ]);
    expect(shared).toEqual([{ tableName: "account", projectIds: ["reporting", "storefront"] }]);
  });

  it("omits single-project tables and returns [] for a single-project run", () => {
    expect(computeSharedTableImpacts([item("solo", ["a", "b"])])).toEqual([]);
  });
});

describe("#936 legacy split robustness", () => {
  it("treats an unrecognized persisted tier string as primary (null-tier safe)", async () => {
    // Read-path robustness: a stray/legacy tier value must not vanish a row.
    const prisma = {
      impactAnalysis: {
        findFirst: vi.fn(async () => ({
          id: "ia-9",
          status: "completed",
          documentId: null,
          sourceText: "t",
          summary: null,
          errorMessage: null,
          totalImpactedSymbols: 1,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: null,
          items: [
            {
              id: "item-0",
              projectId: "p1",
              requirementId: null,
              changeType: "added",
              severity: "low",
              impactScore: 0.4,
              confidence: 0.8,
              affectedFileCount: 1,
              affectedSymbolCount: 0,
              requirement: null,
              affectedSymbols: [],
              affectedTables: [
                {
                  id: "t1",
                  objectKind: "table",
                  tableName: "shop.orders",
                  columnName: null,
                  columnType: null,
                  changeKind: "reference",
                  suggestedDdl: null,
                  source: "mybatis",
                  reconciliation: null,
                  confidence: 0.6,
                  relevanceTier: "bogus",
                  relevanceRationale: null,
                },
              ],
            },
          ],
        })),
      },
    };
    const detail = await getImpactAnalysisDetail("ia-9", prisma as never);
    const item = detail?.items[0];
    expect(item!.affectedTables.map((t) => t.tableName)).toEqual(["shop.orders"]);
    expect(item!.affectedTables[0].relevanceTier).toBeNull();
    expect(item!.affectedTablesSecondary).toHaveLength(0);
  });
});

describe("#961/#994 read path derives matchQuality(+reason) from the persisted DIRECT-seed confidences+paths", () => {
  /** A findFirst-only fake returning ONE item with the given direct seeds. */
  function seedPrisma(directSeeds: Array<{ confidence: number; filePath?: string }>) {
    return {
      impactAnalysis: {
        findFirst: vi.fn(async () => ({
          id: "ia-961",
          status: "completed",
          documentId: null,
          sourceText: "t",
          summary: null,
          errorMessage: null,
          totalImpactedSymbols: directSeeds.length,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: null,
          items: [
            {
              id: "item-0",
              projectId: "p1",
              requirementId: null,
              changeType: "added",
              severity: "low",
              impactScore: 0.4,
              confidence: directSeeds[0]?.confidence ?? 0,
              affectedFileCount: 1,
              affectedSymbolCount: directSeeds.length,
              requirement: null,
              affectedSymbols: [
                // A transitive (non-direct) symbol must be ignored by the derivation.
                {
                  id: "sym-radius",
                  codeSymbolId: "R",
                  filePath: "R.ts",
                  qualifiedName: "pkg.R",
                  startLine: null,
                  endLine: null,
                  relation: "caller",
                  depth: 1,
                  confidence: 0.99,
                },
                ...directSeeds.map(({ confidence, filePath }, i) => ({
                  id: `sym-${i}`,
                  codeSymbolId: `S${i}`,
                  filePath: filePath ?? `S${i}.ts`,
                  qualifiedName: `pkg.S${i}`,
                  startLine: null,
                  endLine: null,
                  relation: "direct",
                  depth: 0,
                  confidence,
                })),
              ],
              affectedTables: [],
            },
          ],
        })),
      },
    };
  }

  it("strong: one confident standout seed (transitive callers ignored)", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-961",
      seedPrisma([{ confidence: 0.85 }]) as never,
    );
    expect(detail!.items[0].matchQuality).toBe("strong");
    expect(detail!.items[0].matchQualityReason).toBeNull();
  });

  it("weak/scattered: many near-tied seeds with no dominant shared entity (generic wording)", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-961",
      seedPrisma([
        { confidence: 0.5 },
        { confidence: 0.49 },
        { confidence: 0.48 },
        { confidence: 0.48 },
        { confidence: 0.47 },
      ]) as never,
    );
    expect(detail!.items[0].matchQuality).toBe("weak");
    expect(detail!.items[0].matchQualityReason).toBe("scattered");
  });

  it("weak/no-entity: no direct seeds at all", async () => {
    const detail = await getImpactAnalysisDetail("ia-961", seedPrisma([]) as never);
    expect(detail!.items[0].matchQuality).toBe("weak");
    expect(detail!.items[0].matchQualityReason).toBe("no-entity");
  });

  it("#994 regression: the live order-cancellation seed shape must NOT be weak", async () => {
    // Exact live confidences from the #994 report (1.00/0.98/0.98/0.95/0.95/0.92/0.92/0.92)
    // over Order*/LineItem*-coherent paths — a precise, multi-entity requirement
    // that the old rule mis-flagged `weak`.
    const detail = await getImpactAnalysisDetail(
      "ia-961",
      seedPrisma([
        { confidence: 1.0, filePath: "server/src/services/order-service.ts" },
        { confidence: 0.98, filePath: "server/src/services/order-cancellation-handler.ts" },
        { confidence: 0.98, filePath: "server/src/repositories/order-repository.ts" },
        { confidence: 0.95, filePath: "server/src/services/order-status-history.ts" },
        { confidence: 0.95, filePath: "server/src/validators/order-validator.ts" },
        { confidence: 0.92, filePath: "server/src/mappers/order-line-item-mapper.ts" },
        { confidence: 0.92, filePath: "server/src/services/line-item-service.ts" },
        { confidence: 0.92, filePath: "server/src/services/inventory-adjuster.ts" },
      ]) as never,
    );
    expect(detail!.items[0].matchQuality).not.toBe("weak");
    expect(detail!.items[0].matchQualityReason).toBeNull();
  });
});

// ── #962 — affected-tests grouping + write-path coverage gaps ─────────────────

interface RawSymbolLike {
  id: string;
  codeSymbolId: string | null;
  filePath: string;
  qualifiedName: string;
  startLine: number | null;
  endLine: number | null;
  relation: string;
  depth: number;
  confidence: number;
}

function rawSymbol(over: Partial<RawSymbolLike> & { filePath: string }): RawSymbolLike {
  return {
    id: `sym-${Math.random().toString(36).slice(2)}`,
    codeSymbolId: null,
    qualifiedName: over.qualifiedName ?? over.filePath,
    startLine: null,
    endLine: null,
    relation: "caller",
    depth: 1,
    confidence: 0.6,
    ...over,
  };
}

/** A findFirst-only fake returning ONE item with the given symbols/tables (no code graph). */
function symbolItemPrisma(
  affectedSymbols: RawSymbolLike[],
  affectedTables: RawAffectedTableLike[] = [],
) {
  return {
    impactAnalysis: {
      findFirst: vi.fn(async () => ({
        id: "ia-962",
        status: "completed",
        documentId: null,
        sourceText: "Change the account write path",
        summary: null,
        errorMessage: null,
        totalImpactedSymbols: affectedSymbols.length,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: null,
        items: [
          {
            id: "item-0",
            projectId: "p1",
            requirementId: null,
            changeType: "modified",
            severity: "medium",
            impactScore: 0.5,
            confidence: 0.8,
            affectedFileCount: 1,
            affectedSymbolCount: affectedSymbols.length,
            requirement: null,
            affectedSymbols,
            affectedTables,
          },
        ],
      })),
    },
  };
}

describe("#962 groups impacted test files out of the prod blast radius", () => {
  it("splits JPetStore-style mapper/service tests into affectedTests with a count; prod unpolluted", async () => {
    const symbols = [
      rawSymbol({
        filePath: "src/main/java/org/jpetstore/mapper/AccountMapper.java",
        qualifiedName: "org.jpetstore.mapper.AccountMapper.updateAccount",
        relation: "direct",
        depth: 0,
      }),
      rawSymbol({
        filePath: "src/main/java/org/jpetstore/service/AccountService.java",
        qualifiedName: "org.jpetstore.service.AccountService.updateAccount",
      }),
      // A mapper test + a service test — both live under a /test/ dir (isTestFilePath).
      rawSymbol({
        filePath: "src/test/java/org/jpetstore/mapper/AccountMapperTest.java",
        qualifiedName: "org.jpetstore.mapper.AccountMapperTest.testUpdate",
      }),
      rawSymbol({
        filePath: "src/test/java/org/jpetstore/service/AccountServiceTest.java",
        qualifiedName: "org.jpetstore.service.AccountServiceTest.testUpdate",
      }),
    ];
    const detail = await getImpactAnalysisDetail("ia-962", symbolItemPrisma(symbols) as never);
    const item = detail!.items[0];

    // Prod symbols carry NO test file; the two tests are grouped out.
    expect(item.affectedSymbols.map((s) => s.qualifiedName).sort()).toEqual([
      "org.jpetstore.mapper.AccountMapper.updateAccount",
      "org.jpetstore.service.AccountService.updateAccount",
    ]);
    expect(item.affectedSymbols.every((s) => !s.filePath.includes("/test/"))).toBe(true);

    expect(item.affectedTests).toHaveLength(2);
    expect(item.affectedTests.map((s) => s.qualifiedName).sort()).toEqual([
      "org.jpetstore.mapper.AccountMapperTest.testUpdate",
      "org.jpetstore.service.AccountServiceTest.testUpdate",
    ]);
  });

  it("emits an empty affectedTests list when no impacted symbol is a test file", async () => {
    const symbols = [rawSymbol({ filePath: "src/main/Foo.ts", qualifiedName: "Foo.bar" })];
    const detail = await getImpactAnalysisDetail("ia-962", symbolItemPrisma(symbols) as never);
    expect(detail!.items[0].affectedTests).toEqual([]);
    expect(detail!.items[0].affectedSymbols).toHaveLength(1);
  });

  it("defaults writePathGaps to [] when the prisma exposes no code graph", async () => {
    const symbols = [rawSymbol({ filePath: "src/main/Foo.ts", qualifiedName: "Foo.bar" })];
    const detail = await getImpactAnalysisDetail("ia-962", symbolItemPrisma(symbols) as never);
    expect(detail!.items[0].writePathGaps).toEqual([]);
  });
});

describe("#962 computeWritePathGaps (pure)", () => {
  it("flags a table whose write path no test reaches", () => {
    const gaps = computeWritePathGaps(
      [
        {
          targetTableName: "account",
          fromSymbolId: "w1",
          fromQualifiedName: "org.AccountMapper.update",
          fromFilePath: "src/main/AccountMapper.java",
        },
      ],
      [], // no incoming edges into the writer ⇒ untested
    );
    expect(gaps).toEqual([
      {
        tableName: "account",
        writingSymbols: ["org.AccountMapper.update"],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("does NOT flag a table whose writing symbol a TEST reaches", () => {
    const gaps = computeWritePathGaps(
      [
        {
          targetTableName: "account",
          fromSymbolId: "w1",
          fromQualifiedName: "org.AccountMapper.update",
          fromFilePath: "src/main/AccountMapper.java",
        },
      ],
      [
        // A test-path caller of the writer ⇒ covered.
        { toSymbolId: "w1", fromFilePath: "src/test/AccountMapperTest.java" },
        // A prod caller must NOT count as coverage.
        { toSymbolId: "w1", fromFilePath: "src/main/AccountService.java" },
      ],
    );
    expect(gaps).toEqual([]);
  });

  it("treats a test-AUTHORED write as setup, not a prod write path (no gap)", () => {
    const gaps = computeWritePathGaps(
      [
        {
          targetTableName: "account",
          fromSymbolId: "t1",
          fromQualifiedName: "org.AccountSeed.insert",
          fromFilePath: "src/test/AccountSeed.java",
        },
      ],
      [],
    );
    expect(gaps).toEqual([]);
  });

  it("reports multiple untested tables sorted, with deduped writing symbols", () => {
    const gaps = computeWritePathGaps(
      [
        {
          targetTableName: "orders",
          fromSymbolId: "o1",
          fromQualifiedName: "O.a",
          fromFilePath: "src/O.java",
        },
        {
          targetTableName: "orders",
          fromSymbolId: "o1",
          fromQualifiedName: "O.a",
          fromFilePath: "src/O.java",
        },
        {
          targetTableName: "account",
          fromSymbolId: "a1",
          fromQualifiedName: "A.z",
          fromFilePath: "src/A.java",
        },
        {
          targetTableName: "account",
          fromSymbolId: "a2",
          fromQualifiedName: "A.b",
          fromFilePath: "src/A2.java",
        },
      ],
      [],
    );
    expect(gaps).toEqual([
      { tableName: "account", writingSymbols: ["A.b", "A.z"], coveredWritingSymbols: [] },
      { tableName: "orders", writingSymbols: ["O.a"], coveredWritingSymbols: [] },
    ]);
  });
});

// ── #962 — write-path gaps end-to-end through getImpactAnalysisDetail ─────────

interface FakeCodeSymbol {
  id: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
}
interface FakeCodeEdge {
  fromSymbolId: string;
  toSymbolId: string;
  kind: string;
}

/**
 * A findFirst + code-graph fake prisma: `impactAnalysis` returns ONE item, and
 * `codeSymbol`/`codeEdge` back the write-path coverage pass with the given graph.
 */
function graphPrisma(
  affectedTables: RawAffectedTableLike[],
  codeSymbols: FakeCodeSymbol[],
  codeEdges: FakeCodeEdge[],
  affectedSymbols: RawSymbolLike[] = [],
) {
  const byId = new Map(codeSymbols.map((s) => [s.id, s]));
  return {
    impactAnalysis: {
      findFirst: vi.fn(async () => ({
        id: "ia-962e",
        status: "completed",
        documentId: null,
        sourceText: "Add a status flag to account",
        summary: null,
        errorMessage: null,
        totalImpactedSymbols: affectedSymbols.length,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: null,
        items: [
          {
            id: "item-0",
            projectId: "p1",
            requirementId: null,
            changeType: "modified",
            severity: "medium",
            impactScore: 0.5,
            confidence: 0.8,
            affectedFileCount: 1,
            affectedSymbolCount: affectedSymbols.length,
            requirement: null,
            affectedSymbols,
            affectedTables,
          },
        ],
      })),
    },
    codeSymbol: {
      findMany: vi.fn(
        async ({ where }: { where: { kind: { in: string[] }; qualifiedName: { in: string[] } } }) =>
          codeSymbols
            .filter(
              (s) =>
                where.kind.in.includes(s.kind) && where.qualifiedName.in.includes(s.qualifiedName),
            )
            .map((s) => ({ id: s.id, qualifiedName: s.qualifiedName })),
      ),
    },
    codeEdge: {
      findMany: vi.fn(
        async ({ where }: { where: { kind: { in: string[] }; toSymbolId: { in: string[] } } }) =>
          codeEdges
            .filter(
              (e) => where.kind.in.includes(e.kind) && where.toSymbolId.in.includes(e.toSymbolId),
            )
            .map((e) => {
              const from = byId.get(e.fromSymbolId);
              return {
                fromSymbolId: e.fromSymbolId,
                toSymbolId: e.toSymbolId,
                kind: e.kind,
                fromSymbol: from
                  ? { qualifiedName: from.qualifiedName, filePath: from.filePath }
                  : null,
              };
            }),
      ),
    },
  };
}

describe("#962 write-path gaps surface through getImpactAnalysisDetail", () => {
  const accountTable = rawRow({ tableName: "account", objectKind: "table" });
  const accountTableSym: FakeCodeSymbol = {
    id: "cs-account",
    qualifiedName: "account",
    kind: "table",
    filePath: "",
  };
  const mapperSym: FakeCodeSymbol = {
    id: "cs-mapper",
    qualifiedName: "org.AccountMapper.updateAccount",
    kind: "method",
    filePath: "src/main/java/org/AccountMapper.java",
  };

  it("emits a gap when the account write path has NO covering test", async () => {
    const prisma = graphPrisma(
      [accountTable],
      [accountTableSym, mapperSym],
      // mapper writes account; nothing calls the mapper from a test file.
      [{ fromSymbolId: "cs-mapper", toSymbolId: "cs-account", kind: "writes" }],
    );
    const detail = await getImpactAnalysisDetail("ia-962e", prisma as never);
    expect(detail!.items[0].writePathGaps).toEqual([
      {
        tableName: "account",
        writingSymbols: ["org.AccountMapper.updateAccount"],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("emits NO gap when a test covers the writing symbol", async () => {
    const testSym: FakeCodeSymbol = {
      id: "cs-mappertest",
      qualifiedName: "org.AccountMapperTest.testUpdate",
      kind: "method",
      filePath: "src/test/java/org/AccountMapperTest.java",
    };
    const prisma = graphPrisma(
      [accountTable],
      [accountTableSym, mapperSym, testSym],
      [
        { fromSymbolId: "cs-mapper", toSymbolId: "cs-account", kind: "writes" },
        // The mapper test calls the writing symbol ⇒ write path is covered.
        { fromSymbolId: "cs-mappertest", toSymbolId: "cs-mapper", kind: "calls" },
      ],
    );
    const detail = await getImpactAnalysisDetail("ia-962e", prisma as never);
    expect(detail!.items[0].writePathGaps).toEqual([]);
  });

  it("degrades to empty gaps (never throws) when the schema-graph query fails", async () => {
    const prisma = graphPrisma(
      [accountTable],
      [accountTableSym, mapperSym],
      [{ fromSymbolId: "cs-mapper", toSymbolId: "cs-account", kind: "writes" }],
    );
    prisma.codeSymbol.findMany = vi.fn(async () => {
      throw new Error("boom");
    });
    const detail = await getImpactAnalysisDetail("ia-962e", prisma as never);
    expect(detail!.items[0].writePathGaps).toEqual([]);
  });

  it("emits no gap for a read-only affected table (no write edge)", async () => {
    const prisma = graphPrisma(
      [accountTable],
      [accountTableSym, mapperSym],
      // Only a `reads` edge — not a write path.
      [{ fromSymbolId: "cs-mapper", toSymbolId: "cs-account", kind: "reads" }],
    );
    const detail = await getImpactAnalysisDetail("ia-962e", prisma as never);
    expect(detail!.items[0].writePathGaps).toEqual([]);
  });
});

// ── #1000 — coverage across the java→sql `executes` bridge ───────────────────

/**
 * #1000 regression fixture — the REAL JPetStore symbol ids/paths queried from the
 * ingested project `cmrqrf1sd0002y89k6hj6ph66`. The writing symbol is the
 * `language=sql` MyBatis statement in `OrderMapper.xml`; the symbol the test calls
 * is the `language=java` mapper method in `OrderMapper.java`. DIFFERENT ids — the
 * identity split that made every MyBatis write path a false-positive gap.
 */
const JPETSTORE = {
  sqlWriterId: "cmrqrffe803uyy89kmbn0vgv5",
  sqlWriterQn: "org.mybatis.jpetstore.mapper.OrderMapper.insertOrder",
  sqlWriterPath: "src/main/resources/org/mybatis/jpetstore/mapper/OrderMapper.xml",
  javaMapperId: "cmrqrfe5z00cly89kmozj2gnt",
  javaMapperPath: "src/main/java/org/mybatis/jpetstore/mapper/OrderMapper.java",
  testPath: "src/test/java/org/mybatis/jpetstore/mapper/OrderMapperTest.java",
} as const;

describe("#1000 computeWritePathGaps propagates coverage across the `executes` bridge", () => {
  const ordersWrite = {
    targetTableName: "orders",
    fromSymbolId: JPETSTORE.sqlWriterId,
    fromQualifiedName: JPETSTORE.sqlWriterQn,
    fromFilePath: JPETSTORE.sqlWriterPath,
  };

  it("counts a test on the JAVA mapper method as covering the SQL statement it executes", () => {
    // The two symbols are genuinely distinct — that is the whole bug.
    expect(JPETSTORE.sqlWriterId).not.toBe(JPETSTORE.javaMapperId);

    const gaps = computeWritePathGaps(
      [ordersWrite],
      // The test calls the JAVA method, never the SQL statement id.
      [{ toSymbolId: JPETSTORE.javaMapperId, fromFilePath: JPETSTORE.testPath }],
      // OrderMapper.java::insertOrder --executes--> OrderMapper.xml::insertOrder
      [{ fromSymbolId: JPETSTORE.javaMapperId, toSymbolId: JPETSTORE.sqlWriterId }],
    );
    expect(gaps).toEqual([]);
  });

  it("REGRESSION: reports a gap when the bridge is absent (pre-#1000 behaviour)", () => {
    const gaps = computeWritePathGaps(
      [ordersWrite],
      [{ toSymbolId: JPETSTORE.javaMapperId, fromFilePath: JPETSTORE.testPath }],
      [], // no bridge edge ⇒ the java/sql ids never meet
    );
    expect(gaps).toEqual([
      { tableName: "orders", writingSymbols: [JPETSTORE.sqlWriterQn], coveredWritingSymbols: [] },
    ]);
  });

  it("STILL reports a gap when the bridged java facade has NO covering test", () => {
    const gaps = computeWritePathGaps(
      [
        ordersWrite,
        {
          targetTableName: "audit_log",
          fromSymbolId: "sql-audit",
          fromQualifiedName: "org.jpetstore.mapper.AuditMapper.insertAudit",
          fromFilePath: "src/main/resources/org/jpetstore/mapper/AuditMapper.xml",
        },
      ],
      [{ toSymbolId: JPETSTORE.javaMapperId, fromFilePath: JPETSTORE.testPath }],
      [
        { fromSymbolId: JPETSTORE.javaMapperId, toSymbolId: JPETSTORE.sqlWriterId },
        // The audit mapper is bridged too — but nothing tests its java facade.
        { fromSymbolId: "java-audit", toSymbolId: "sql-audit" },
      ],
    );
    expect(gaps).toEqual([
      {
        tableName: "audit_log",
        writingSymbols: ["org.jpetstore.mapper.AuditMapper.insertAudit"],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("does NOT let a PROD-only caller of the java facade suppress the gap", () => {
    const gaps = computeWritePathGaps(
      [ordersWrite],
      [
        {
          toSymbolId: JPETSTORE.javaMapperId,
          fromFilePath: "src/main/java/org/mybatis/jpetstore/service/OrderService.java",
        },
      ],
      [{ fromSymbolId: JPETSTORE.javaMapperId, toSymbolId: JPETSTORE.sqlWriterId }],
    );
    expect(gaps).toEqual([
      { tableName: "orders", writingSymbols: [JPETSTORE.sqlWriterQn], coveredWritingSymbols: [] },
    ]);
  });

  it(`bounds the bridge walk at ${WRITE_PATH_BRIDGE_MAX_DEPTH} hops`, () => {
    const chain = [
      { fromSymbolId: "java", toSymbolId: "s1" },
      { fromSymbolId: "s1", toSymbolId: "s2" },
      { fromSymbolId: "s2", toSymbolId: "s3" },
    ];
    const writeEdge = (id: string, table: string) => ({
      targetTableName: table,
      fromSymbolId: id,
      fromQualifiedName: `Q.${id}`,
      fromFilePath: `src/main/${id}.xml`,
    });
    const coverage = [{ toSymbolId: "java", fromFilePath: "src/test/T.java" }];

    // s1 (1 hop) and s2 (2 hops) are within the bound…
    expect(computeWritePathGaps([writeEdge("s1", "t1")], coverage, chain)).toEqual([]);
    expect(computeWritePathGaps([writeEdge("s2", "t2")], coverage, chain)).toEqual([]);
    // …s3 (3 hops) is beyond it, so its table is still reported.
    expect(computeWritePathGaps([writeEdge("s3", "t3")], coverage, chain)).toEqual([
      { tableName: "t3", writingSymbols: ["Q.s3"], coveredWritingSymbols: [] },
    ]);
  });

  it("terminates on a cyclic bridge", () => {
    const gaps = computeWritePathGaps(
      [
        {
          targetTableName: "orders",
          fromSymbolId: "a",
          fromQualifiedName: "Q.a",
          fromFilePath: "src/main/a.xml",
        },
      ],
      [{ toSymbolId: "a", fromFilePath: "src/test/T.java" }],
      [
        { fromSymbolId: "a", toSymbolId: "b" },
        { fromSymbolId: "b", toSymbolId: "a" },
      ],
    );
    expect(gaps).toEqual([]);
  });

  it("is a no-op when no bridge edges are supplied (pure default)", () => {
    expect(
      computeWritePathGaps(
        [
          {
            targetTableName: "orders",
            fromSymbolId: "w1",
            fromQualifiedName: "Q.w1",
            fromFilePath: "src/main/w1.xml",
          },
        ],
        [{ toSymbolId: "w1", fromFilePath: "src/test/T.java" }],
      ),
    ).toEqual([]);
  });
});

describe("#1000 write-path gaps across the bridge, end-to-end", () => {
  const ordersTable = rawRow({ tableName: "orders", objectKind: "table" });
  const auditTable = rawRow({ tableName: "audit_log", objectKind: "table" });
  const symbols: FakeCodeSymbol[] = [
    { id: "cs-orders", qualifiedName: "orders", kind: "table", filePath: "" },
    { id: "cs-audit", qualifiedName: "audit_log", kind: "table", filePath: "" },
    // MyBatis statement symbols (language=sql) — these hold the write edges.
    {
      id: JPETSTORE.sqlWriterId,
      qualifiedName: JPETSTORE.sqlWriterQn,
      kind: "method",
      filePath: JPETSTORE.sqlWriterPath,
    },
    {
      id: "sql-audit",
      qualifiedName: "org.jpetstore.mapper.AuditMapper.insertAudit",
      kind: "method",
      filePath: "src/main/resources/org/jpetstore/mapper/AuditMapper.xml",
    },
    // Java mapper facades (language=java) — what callers and tests actually call.
    {
      id: JPETSTORE.javaMapperId,
      qualifiedName: "org.mybatis.jpetstore.mapper.OrderMapper::insertOrder",
      kind: "method",
      filePath: JPETSTORE.javaMapperPath,
    },
    {
      id: "java-audit",
      qualifiedName: "org.jpetstore.mapper.AuditMapper::insertAudit",
      kind: "method",
      filePath: "src/main/java/org/jpetstore/mapper/AuditMapper.java",
    },
    {
      id: "test-order",
      qualifiedName: "org.mybatis.jpetstore.mapper.OrderMapperTest::insertOrder",
      kind: "method",
      filePath: JPETSTORE.testPath,
    },
  ];
  const edges: FakeCodeEdge[] = [
    { fromSymbolId: JPETSTORE.sqlWriterId, toSymbolId: "cs-orders", kind: "persists-to" },
    { fromSymbolId: "sql-audit", toSymbolId: "cs-audit", kind: "persists-to" },
    { fromSymbolId: JPETSTORE.javaMapperId, toSymbolId: JPETSTORE.sqlWriterId, kind: "executes" },
    { fromSymbolId: "java-audit", toSymbolId: "sql-audit", kind: "executes" },
    // OrderMapperTest calls the JAVA mapper method; nothing tests the audit mapper.
    { fromSymbolId: "test-order", toSymbolId: JPETSTORE.javaMapperId, kind: "calls" },
  ];

  it("clears the OrderMapper false positive but keeps the genuinely untested audit write", async () => {
    const prisma = graphPrisma([ordersTable, auditTable], symbols, edges);
    const detail = await getImpactAnalysisDetail("ia-962e", prisma as never);
    expect(detail!.items[0].writePathGaps).toEqual([
      {
        tableName: "audit_log",
        writingSymbols: ["org.jpetstore.mapper.AuditMapper.insertAudit"],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("leaves no contradictory state: a test in the Tests panel is not also an untested write", async () => {
    const prisma = graphPrisma([ordersTable], symbols, edges, [
      rawSymbol({
        filePath: JPETSTORE.testPath,
        qualifiedName: "org.mybatis.jpetstore.mapper.OrderMapperTest.insertOrder",
      }),
    ]);
    const item = (await getImpactAnalysisDetail("ia-962e", prisma as never))!.items[0];
    expect(item.affectedTests.map((s) => s.qualifiedName)).toEqual([
      "org.mybatis.jpetstore.mapper.OrderMapperTest.insertOrder",
    ]);
    expect(item.writePathGaps).toEqual([]);
  });
});

// ── #1012 — gaps are per WRITING SYMBOL, not per table ───────────────────────

describe("#1012 computeWritePathGaps reports gaps per writer, not per table", () => {
  /**
   * The real `account` shape in the JPetStore fixture (project
   * cmrqrf1sd0002y89k6hj6ph66): TWO prod writers of one table, each with its own
   * java facade. Pre-#1012, covering EITHER one cleared the table entirely.
   */
  const insertWrite = {
    targetTableName: "account",
    fromSymbolId: "sql-insert",
    fromQualifiedName: "org.mybatis.jpetstore.mapper.AccountMapper.insertAccount",
    fromFilePath: "src/main/resources/org/mybatis/jpetstore/mapper/AccountMapper.xml",
  };
  const updateWrite = {
    targetTableName: "account",
    fromSymbolId: "sql-update",
    fromQualifiedName: "org.mybatis.jpetstore.mapper.AccountMapper.updateAccount",
    fromFilePath: "src/main/resources/org/mybatis/jpetstore/mapper/AccountMapper.xml",
  };
  const bridge = [
    { fromSymbolId: "java-insert", toSymbolId: "sql-insert" },
    { fromSymbolId: "java-update", toSymbolId: "sql-update" },
  ];
  const testPath = "src/test/java/org/mybatis/jpetstore/mapper/AccountMapperTest.java";

  it("REGRESSION: a covered writer no longer masks its untested sibling writer", () => {
    const gaps = computeWritePathGaps(
      [insertWrite, updateWrite],
      // ONLY insertAccount is tested. Pre-#1012 the `.some()` short-circuit cleared
      // `account` outright and updateAccount vanished from the report.
      [{ toSymbolId: "java-insert", fromFilePath: testPath }],
      bridge,
    );
    expect(gaps).toEqual([
      {
        tableName: "account",
        writingSymbols: ["org.mybatis.jpetstore.mapper.AccountMapper.updateAccount"],
        coveredWritingSymbols: ["org.mybatis.jpetstore.mapper.AccountMapper.insertAccount"],
      },
    ]);
  });

  it("reports BOTH writers, with no covered siblings, when neither is tested", () => {
    const gaps = computeWritePathGaps([insertWrite, updateWrite], [], bridge);
    expect(gaps).toEqual([
      {
        tableName: "account",
        writingSymbols: [
          "org.mybatis.jpetstore.mapper.AccountMapper.insertAccount",
          "org.mybatis.jpetstore.mapper.AccountMapper.updateAccount",
        ],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("emits NO gap once every writer of the table is covered", () => {
    const gaps = computeWritePathGaps(
      [insertWrite, updateWrite],
      [
        { toSymbolId: "java-insert", fromFilePath: testPath },
        { toSymbolId: "java-update", fromFilePath: testPath },
      ],
      bridge,
    );
    expect(gaps).toEqual([]);
  });

  it("keeps a duplicate qualified name out of the covered list when it is also uncovered", () => {
    // Two symbol ids can carry one qualified name; the uncovered listing must win
    // so a name is never presented as covered while an id of it is untested.
    const gaps = computeWritePathGaps(
      [
        { ...insertWrite, fromSymbolId: "sql-a" },
        { ...insertWrite, fromSymbolId: "sql-b" },
      ],
      [{ toSymbolId: "sql-a", fromFilePath: testPath }],
    );
    expect(gaps).toEqual([
      {
        tableName: "account",
        writingSymbols: ["org.mybatis.jpetstore.mapper.AccountMapper.insertAccount"],
        coveredWritingSymbols: [],
      },
    ]);
  });
});

describe("#1012 partial write-path coverage, end-to-end", () => {
  const accountTable = rawRow({ tableName: "account", objectKind: "table" });
  const symbols: FakeCodeSymbol[] = [
    { id: "cs-account", qualifiedName: "account", kind: "table", filePath: "" },
    {
      id: "sql-insert",
      qualifiedName: "org.mybatis.jpetstore.mapper.AccountMapper.insertAccount",
      kind: "method",
      filePath: "src/main/resources/org/mybatis/jpetstore/mapper/AccountMapper.xml",
    },
    {
      id: "sql-update",
      qualifiedName: "org.mybatis.jpetstore.mapper.AccountMapper.updateAccount",
      kind: "method",
      filePath: "src/main/resources/org/mybatis/jpetstore/mapper/AccountMapper.xml",
    },
    {
      id: "java-insert",
      qualifiedName: "org.mybatis.jpetstore.mapper.AccountMapper::insertAccount",
      kind: "method",
      filePath: "src/main/java/org/mybatis/jpetstore/mapper/AccountMapper.java",
    },
    {
      id: "java-update",
      qualifiedName: "org.mybatis.jpetstore.mapper.AccountMapper::updateAccount",
      kind: "method",
      filePath: "src/main/java/org/mybatis/jpetstore/mapper/AccountMapper.java",
    },
    {
      id: "test-insert",
      qualifiedName: "org.mybatis.jpetstore.mapper.AccountMapperTest::insertAccount",
      kind: "method",
      filePath: "src/test/java/org/mybatis/jpetstore/mapper/AccountMapperTest.java",
    },
  ];
  const edges: FakeCodeEdge[] = [
    { fromSymbolId: "sql-insert", toSymbolId: "cs-account", kind: "persists-to" },
    { fromSymbolId: "sql-update", toSymbolId: "cs-account", kind: "writes" },
    { fromSymbolId: "java-insert", toSymbolId: "sql-insert", kind: "executes" },
    { fromSymbolId: "java-update", toSymbolId: "sql-update", kind: "executes" },
    // Only the INSERT path has a test.
    { fromSymbolId: "test-insert", toSymbolId: "java-insert", kind: "calls" },
  ];

  it("surfaces the untested sibling writer through getImpactAnalysisDetail", async () => {
    const prisma = graphPrisma([accountTable], symbols, edges);
    const detail = await getImpactAnalysisDetail("ia-962e", prisma as never);
    expect(detail!.items[0].writePathGaps).toEqual([
      {
        tableName: "account",
        writingSymbols: ["org.mybatis.jpetstore.mapper.AccountMapper.updateAccount"],
        coveredWritingSymbols: ["org.mybatis.jpetstore.mapper.AccountMapper.insertAccount"],
      },
    ]);
  });
});

// ── #1011 — one bounded `calls` hop through a service layer ──────────────────

describe("#1011 computeWritePathGaps credits a service-layer test", () => {
  const ordersWrite = {
    targetTableName: "orders",
    fromSymbolId: "sql-insert-order",
    fromQualifiedName: "org.mybatis.jpetstore.mapper.OrderMapper.insertOrder",
    fromFilePath: "src/main/resources/org/mybatis/jpetstore/mapper/OrderMapper.xml",
  };
  const bridge = [{ fromSymbolId: "java-insert-order", toSymbolId: "sql-insert-order" }];
  // OrderService.insertOrder --calls--> OrderMapper.java::insertOrder
  const serviceCall = [{ fromSymbolId: "svc-insert-order", toSymbolId: "java-insert-order" }];
  const serviceTestPath = "src/test/java/org/mybatis/jpetstore/service/OrderServiceTest.java";

  it("clears the gap for OrderServiceTest -> OrderService -> OrderMapper -> xml", () => {
    const gaps = computeWritePathGaps([ordersWrite], [], bridge, {
      callEdges: serviceCall,
      coverageEdges: [
        { toSymbolId: "svc-insert-order", kind: "calls", fromFilePath: serviceTestPath },
      ],
    });
    expect(gaps).toEqual([]);
  });

  it("STILL reports the gap when the service itself has no test (anti-suppression)", () => {
    const gaps = computeWritePathGaps([ordersWrite], [], bridge, {
      callEdges: serviceCall,
      // Only a PROD caller of the service — an action bean, not a test.
      coverageEdges: [
        {
          toSymbolId: "svc-insert-order",
          kind: "calls",
          fromFilePath: "src/main/java/org/mybatis/jpetstore/web/actions/OrderActionBean.java",
        },
      ],
    });
    expect(gaps).toEqual([
      {
        tableName: "orders",
        writingSymbols: ["org.mybatis.jpetstore.mapper.OrderMapper.insertOrder"],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("does NOT open the hop on an `imports`/`references` edge from a test", () => {
    for (const kind of ["imports", "references"]) {
      const gaps = computeWritePathGaps([ordersWrite], [], bridge, {
        callEdges: serviceCall,
        coverageEdges: [{ toSymbolId: "svc-insert-order", kind, fromFilePath: serviceTestPath }],
      });
      expect(gaps, `kind=${kind} must not count as coverage`).toEqual([
        {
          tableName: "orders",
          writingSymbols: ["org.mybatis.jpetstore.mapper.OrderMapper.insertOrder"],
          coveredWritingSymbols: [],
        },
      ]);
    }
  });

  it(`takes exactly ${WRITE_PATH_SERVICE_CALL_MAX_DEPTH} calls hop — a 2-hop chain is NOT covered`, () => {
    // OrderServiceTest -> Facade -> OrderService -> OrderMapper is two `calls` hops.
    // Only the LAST hop is in callEdges (it is the only edge INTO the write path),
    // and the test does not call its source, so the writer stays reported.
    const gaps = computeWritePathGaps([ordersWrite], [], bridge, {
      callEdges: serviceCall,
      coverageEdges: [
        {
          toSymbolId: "svc-insert-order",
          kind: "calls",
          fromFilePath: "src/main/java/org/mybatis/jpetstore/service/OrderFacade.java",
        },
      ],
    });
    expect(gaps).toEqual([
      {
        tableName: "orders",
        writingSymbols: ["org.mybatis.jpetstore.mapper.OrderMapper.insertOrder"],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("never spreads coverage sideways to an UNRELATED writer the same service calls", () => {
    // The #1000 hazard the bound exists to avoid: a tested service that also calls
    // an audit mapper must not clear the audit table just by association — the hop
    // only fires for writers the service actually calls, edge by edge.
    const auditWrite = {
      targetTableName: "audit_log",
      fromSymbolId: "sql-audit",
      fromQualifiedName: "org.jpetstore.mapper.AuditMapper.insertAudit",
      fromFilePath: "src/main/resources/org/jpetstore/mapper/AuditMapper.xml",
    };
    const gaps = computeWritePathGaps(
      [ordersWrite, auditWrite],
      [],
      [...bridge, { fromSymbolId: "java-audit", toSymbolId: "sql-audit" }],
      {
        // The tested service calls the ORDER mapper only; the audit mapper is
        // reached from an untested service.
        callEdges: [...serviceCall, { fromSymbolId: "svc-audit", toSymbolId: "java-audit" }],
        coverageEdges: [
          { toSymbolId: "svc-insert-order", kind: "calls", fromFilePath: serviceTestPath },
        ],
      },
    );
    expect(gaps).toEqual([
      {
        tableName: "audit_log",
        writingSymbols: ["org.jpetstore.mapper.AuditMapper.insertAudit"],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("is a no-op when no service-layer facts are supplied (pure default)", () => {
    expect(computeWritePathGaps([ordersWrite], [], bridge)).toEqual([
      {
        tableName: "orders",
        writingSymbols: ["org.mybatis.jpetstore.mapper.OrderMapper.insertOrder"],
        coveredWritingSymbols: [],
      },
    ]);
  });
});

describe("#1011 service-layer coverage, end-to-end", () => {
  const ordersTable = rawRow({ tableName: "orders", objectKind: "table" });
  const auditTable = rawRow({ tableName: "audit_log", objectKind: "table" });
  const serviceTestPath = "src/test/java/org/mybatis/jpetstore/service/OrderServiceTest.java";
  const symbols: FakeCodeSymbol[] = [
    { id: "cs-orders", qualifiedName: "orders", kind: "table", filePath: "" },
    { id: "cs-audit", qualifiedName: "audit_log", kind: "table", filePath: "" },
    {
      id: "sql-order",
      qualifiedName: "org.mybatis.jpetstore.mapper.OrderMapper.insertOrder",
      kind: "method",
      filePath: "src/main/resources/org/mybatis/jpetstore/mapper/OrderMapper.xml",
    },
    {
      id: "sql-audit",
      qualifiedName: "org.jpetstore.mapper.AuditMapper.insertAudit",
      kind: "method",
      filePath: "src/main/resources/org/jpetstore/mapper/AuditMapper.xml",
    },
    {
      id: "java-order",
      qualifiedName: "org.mybatis.jpetstore.mapper.OrderMapper::insertOrder",
      kind: "method",
      filePath: "src/main/java/org/mybatis/jpetstore/mapper/OrderMapper.java",
    },
    {
      id: "java-audit",
      qualifiedName: "org.jpetstore.mapper.AuditMapper::insertAudit",
      kind: "method",
      filePath: "src/main/java/org/jpetstore/mapper/AuditMapper.java",
    },
    {
      id: "svc-order",
      qualifiedName: "org.mybatis.jpetstore.service.OrderService::insertOrder",
      kind: "method",
      filePath: "src/main/java/org/mybatis/jpetstore/service/OrderService.java",
    },
    {
      id: "svc-audit",
      qualifiedName: "org.jpetstore.service.AuditService::record",
      kind: "method",
      filePath: "src/main/java/org/jpetstore/service/AuditService.java",
    },
    {
      id: "test-svc",
      qualifiedName: "org.mybatis.jpetstore.service.OrderServiceTest::shouldCallTheMapperToInsert",
      kind: "method",
      filePath: serviceTestPath,
    },
  ];
  const edges: FakeCodeEdge[] = [
    { fromSymbolId: "sql-order", toSymbolId: "cs-orders", kind: "persists-to" },
    { fromSymbolId: "sql-audit", toSymbolId: "cs-audit", kind: "persists-to" },
    { fromSymbolId: "java-order", toSymbolId: "sql-order", kind: "executes" },
    { fromSymbolId: "java-audit", toSymbolId: "sql-audit", kind: "executes" },
    // The service layer sits between the test and BOTH mappers…
    { fromSymbolId: "svc-order", toSymbolId: "java-order", kind: "calls" },
    { fromSymbolId: "svc-audit", toSymbolId: "java-audit", kind: "calls" },
    // …but only the ORDER service is tested. NOTHING tests the mapper directly.
    { fromSymbolId: "test-svc", toSymbolId: "svc-order", kind: "calls" },
  ];

  it("clears the service-layer false positive and keeps the untested audit write", async () => {
    const prisma = graphPrisma([ordersTable, auditTable], symbols, edges);
    const detail = await getImpactAnalysisDetail("ia-962e", prisma as never);
    expect(detail!.items[0].writePathGaps).toEqual([
      {
        tableName: "audit_log",
        writingSymbols: ["org.jpetstore.mapper.AuditMapper.insertAudit"],
        coveredWritingSymbols: [],
      },
    ]);
  });

  it("ANTI-SUPPRESSION: deleting the test→service edge re-fires the orders gap", async () => {
    const withoutTestEdge = edges.filter((e) => e.fromSymbolId !== "test-svc");
    const prisma = graphPrisma([ordersTable, auditTable], symbols, withoutTestEdge);
    const detail = await getImpactAnalysisDetail("ia-962e", prisma as never);
    expect(detail!.items[0].writePathGaps.map((g) => g.tableName)).toEqual(["audit_log", "orders"]);
  });

  it("leaves no contradictory state: the covering service test is in the Tests panel", async () => {
    const prisma = graphPrisma([ordersTable], symbols, edges, [
      rawSymbol({
        filePath: serviceTestPath,
        qualifiedName: "org.mybatis.jpetstore.service.OrderServiceTest.shouldCallTheMapperToInsert",
      }),
    ]);
    const item = (await getImpactAnalysisDetail("ia-962e", prisma as never))!.items[0];
    expect(item.affectedTests).toHaveLength(1);
    expect(item.writePathGaps).toEqual([]);
  });
});

/**
 * #1013 — the item's requirement title on the read projection.
 *
 * A pasted-text run has no `Requirement` row to join, so before #1013 this
 * always resolved to null and the export had to infer a heading from run-level
 * state. The projection now falls back to the per-item snapshot the engine
 * wrote, with the TRACKED requirement's live title still taking precedence
 * (it can be renamed after the run, and the joined row is authoritative).
 */
describe("#1013 read path resolves the per-item requirement title", () => {
  function titlePrisma(
    items: Array<{
      id: string;
      projectId: string;
      requirementId: string | null;
      requirementTitle: string | null;
      requirement: { title: string } | null;
    }>,
  ) {
    return {
      impactAnalysis: {
        findFirst: vi.fn(async () => ({
          id: "ia-1013",
          status: "completed",
          documentId: null,
          sourceText: "Cancel an order within 24 hours. Support partial shipments.",
          summary: null,
          errorMessage: null,
          totalImpactedSymbols: 0,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: null,
          items: items.map((i) => ({
            ...i,
            changeType: "added",
            severity: "low",
            impactScore: 0.4,
            confidence: 0.8,
            affectedFileCount: 0,
            affectedSymbolCount: 0,
            affectedSymbols: [],
            affectedTables: [],
          })),
        })),
      },
    };
  }

  it("uses the persisted snapshot when there is no tracked requirement to join", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-1013",
      titlePrisma([
        {
          id: "item-1",
          projectId: "p1",
          requirementId: null,
          requirementTitle: "Cancel an order within 24 hours.",
          requirement: null,
        },
      ]) as never,
    );
    expect(detail!.items[0].requirementTitle).toBe("Cancel an order within 24 hours.");
  });

  it("prefers the tracked requirement's live title over the snapshot", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-1013",
      titlePrisma([
        {
          id: "item-1",
          projectId: "p1",
          requirementId: "req-1",
          requirementTitle: "Title as it read at analysis time",
          requirement: { title: "Title after a rename" },
        },
      ]) as never,
    );
    expect(detail!.items[0].requirementTitle).toBe("Title after a rename");
  });

  it("stays null for a legacy row written before the column existed", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-1013",
      titlePrisma([
        {
          id: "legacy-1",
          projectId: "p1",
          requirementId: null,
          requirementTitle: null,
          requirement: null,
        },
      ]) as never,
    );
    expect(detail!.items[0].requirementTitle).toBeNull();
  });

  it("keeps distinct titles on distinct items of one multi-change run", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-1013",
      titlePrisma([
        {
          id: "item-1",
          projectId: "p1",
          requirementId: null,
          requirementTitle: "Cancel an order within 24 hours.",
          requirement: null,
        },
        {
          id: "item-2",
          projectId: "p1",
          requirementId: null,
          requirementTitle: "Support partial shipments.",
          requirement: null,
        },
      ]) as never,
    );
    expect(detail!.items.map((i) => i.requirementTitle)).toEqual([
      "Cancel an order within 24 hours.",
      "Support partial shipments.",
    ]);
  });
});
