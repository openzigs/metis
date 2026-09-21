/**
 * Issue #847 — the REACHABILITY test that kills epic #820's "green over an
 * unreachable path" trap.
 *
 * It drives the REAL {@link getGapReport} through the SAME production seam the
 * route uses — {@link resolveGapReportDeps} (the flag gate + real
 * {@link loadAnalysisSchemaImpact} producer) — and asserts the resulting gap
 * report carries a populated `databaseChanges` section AND cross-project
 * consumers for a shared-DB table. Critically it does NOT hand-build a
 * `loadSchemaImpact` dependency: the false-green #847 exists to kill. The only
 * injected seams are the producer's I/O boundaries (snapshot loader, requirement
 * mapper, in-memory code/schema graphs, in-memory Prisma) — the SAME seams the
 * #832 dogfood injects via `affectedSchemaMapping`. The heavy lifting —
 * `computeProjectImpact` → `crossToSchema` and the REAL `enumerateSchemaConsumers`
 * — runs unstubbed against that in-memory data.
 *
 * On `main` the route supplies NO producer (the bug), so `databaseChanges` is
 * absent from every report; this test therefore FAILS on `main` and passes only
 * once the producer is wired. The flag-OFF case proves the off path is
 * byte-identical to today (no `databaseChanges`).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisSnapshot, SchemaEdgeKind } from "@metis/shared";
import { __resetConfigSingleton } from "../config/config-service.js";
import { InMemoryCodeGraphDataSource } from "../impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { SchemaImpactDataSource } from "../impact-analysis/schema-impact.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";

const ANALYSIS_ID = "an_847";
const PROJECT_ID = "pr_analyzed";
const WORKSPACE_ID = "ws_1";
const RESOURCE_ID = "res_shared";
const SIBLING_PROJECT_ID = "pr_billing";
const SIBLING_PROJECT_NAME = "Billing";
const REQ_ID = "REQ-ORDERS";

/** The shared physical table the requirement's impacted code writes. */
const SHARED_TABLE = "orders";

/** The impacted code symbol the requirement maps to (seeds the crossing). */
const SEED_SYMBOL_ID = "seed-orders-writer";
/** The `orders` table symbol the impacted code `writes`. */
const TABLE_SYMBOL_ID = "sym-orders-table";

// getAnalysisSnapshot is the snapshot boundary BOTH getGapReport and the producer
// read through — mock it once (the only module-level mock, an I/O boundary).
vi.mock("./analysis-service.js", () => ({
  getAnalysisSnapshot: vi.fn(async () => snapshotFixture()),
}));

/** A minimal completed analysis with one schema-changing requirement, no findings. */
function snapshotFixture(): AnalysisSnapshot {
  return {
    id: ANALYSIS_ID,
    projectId: PROJECT_ID,
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    errorMessage: null,
    metadata: null,
    agents: [],
    requirements: [
      {
        id: REQ_ID,
        type: "functional",
        title: "Orders must record a fulfilment status",
        body: "The orders table must record a fulfilment status so operations can audit shipments.",
        priority: "high",
        labels: [],
        storyPoints: null,
        reviewStatus: "pending",
        evidenceFindingIds: [],
        coverage: "no_evidence",
        verdict: "gap-confirmed",
        version: 1,
      },
    ],
    // retrieval is optional on the snapshot; omit for a report with no agentic pass.
  } as unknown as AnalysisSnapshot;
}

/** One mapped code symbol whose id seeds the schema crossing (no blast radius). */
const ONE_MATCH: RequirementCodeMatch[] = [
  {
    codeSymbolId: SEED_SYMBOL_ID,
    filePath: "server/src/lib/orders/order-service.ts",
    qualifiedName: "recordFulfilment",
    startLine: 1,
    endLine: 40,
    confidence: 0.9,
  },
];

/** Empty code graph → the mapper's direct hit is the only seed (no blast radius). */
const EMPTY_GRAPH = new InMemoryCodeGraphDataSource([], []);
const emptyGraphFor = (): CodeGraphDataSource => EMPTY_GRAPH;

/** In-memory schema graph: impacted code `writes` the `orders` table. */
function ordersSchemaDataSource(): SchemaImpactDataSource {
  const edges = [
    { fromSymbolId: SEED_SYMBOL_ID, toSymbolId: TABLE_SYMBOL_ID, kind: "writes" as SchemaEdgeKind },
  ];
  const symbols = [
    {
      id: TABLE_SYMBOL_ID,
      kind: "table" as const,
      name: SHARED_TABLE,
      qualifiedName: SHARED_TABLE,
      source: "orm" as const,
    },
  ];
  return {
    async getSchemaEdgesFrom(ids: string[]) {
      return edges.filter((e) => ids.includes(e.fromSymbolId));
    },
    async getSchemaSymbolsByIds(ids: string[]) {
      return symbols.filter((s) => ids.includes(s.id));
    },
  };
}

/**
 * In-memory Prisma serving the REAL `enumerateSchemaConsumers` +
 * `resolveProjectDatabaseIdentities` + `whichProjectsUseObject` chain, PLUS
 * (#856) the resolver's per-project setting read (`project.findUnique`) and
 * schema-data probe (`databaseConnection.count` / `codeSymbol.count` /
 * `codeEdge.count`). The analyzed project is linked to a shared resource (one
 * connected `DatabaseConnection`, `dbc_1` below) and a sibling project
 * (`Billing`) reads the same `orders` table. Only the exact reads those
 * functions issue are implemented; unexpected calls throw so the fixture never
 * silently under-serves.
 *
 * `databaseAwareAnalysisSetting` defaults to `"auto"` — with the connected
 * `dbc_1` connection making `hasSchemaData` true, `auto` resolves ON with NO
 * explicit override needed, exercising #851's headline intent (per-project
 * reachability without operator env config).
 */
function stubPrisma(
  opts: { databaseAwareAnalysisSetting?: string; lineageEdges?: unknown[] } = {},
) {
  const identityRow = {
    id: "soid_orders",
    databaseResourceId: RESOURCE_ID,
    schemaName: null as string | null,
    objectName: SHARED_TABLE,
    objectType: "table",
  };
  const siblingUsage = {
    projectId: SIBLING_PROJECT_ID,
    tableName: SHARED_TABLE,
    usageClass: "used",
    evidence: JSON.stringify([{ edgeKind: "reads" }]),
  };
  return {
    project: {
      findUnique: vi.fn(async (_args: { where: { id: string } }) => ({
        workspaceId: WORKSPACE_ID,
        databaseAwareAnalysis: opts.databaseAwareAnalysisSetting ?? "auto",
      })),
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        // listAccessibleProjectsInWorkspace (admin) → all workspace projects; or
        // projectsUsingObject's id→name lookup. Both satisfied by the two rows.
        const where = args?.where ?? {};
        if ("workspaceId" in where) {
          return [
            { id: PROJECT_ID, createdById: "u1", name: "Analyzed" },
            { id: SIBLING_PROJECT_ID, createdById: "u1", name: SIBLING_PROJECT_NAME },
          ];
        }
        return [
          { id: PROJECT_ID, name: "Analyzed" },
          { id: SIBLING_PROJECT_ID, name: SIBLING_PROJECT_NAME },
        ];
      }),
    },
    databaseConnection: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};
        // loadSharingProjects (sibling connections) — irrelevant to consumers.
        if ("project" in where) return [];
        // resolveProjectDatabaseIdentities — the analyzed project's linked conn.
        return [
          {
            id: "dbc_1",
            driver: "postgres",
            host: "db.internal",
            port: 5432,
            databaseName: "app",
            databaseResourceId: RESOURCE_ID,
          },
        ];
      }),
      // #856 — `hasSchemaData`'s (#854) connected-`DatabaseConnection` probe: the
      // analyzed project's `dbc_1` above IS a connected connection, so `auto`
      // resolves ON without any explicit per-project override.
      count: vi.fn(async () => 1),
    },
    // #856 — the other half of `hasSchemaData`'s OR (non-empty schema graph).
    // Zero here so the "connected `DatabaseConnection`" signal is the ONLY thing
    // making `hasSchemaData` true — an unambiguous, single-cause fixture.
    codeSymbol: { count: vi.fn(async () => 0) },
    // #895 — `computeSqlLineageCoverage` reads schema lineage edges here. Empty
    // by default ⇒ null coverage (byte-identical to pre-#895); a per-test
    // override supplies rows to exercise the threading.
    codeEdge: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => opts.lineageEdges ?? []),
    },
    databaseResource: {
      findMany: vi.fn(async () => [{ id: RESOURCE_ID }]),
    },
    schemaObjectIdentity: {
      findMany: vi.fn(async () => [
        {
          schemaName: identityRow.schemaName,
          objectName: identityRow.objectName,
          objectType: identityRow.objectType,
        },
      ]),
      findFirst: vi.fn(async () => identityRow),
    },
    schemaUsageClassification: {
      findMany: vi.fn(async () => [siblingUsage]),
    },
  };
}

/** The producer's I/O seams wired with the in-memory fixture (NOT loadSchemaImpact). */
function producerDeps(
  opts: { databaseAwareAnalysisSetting?: string; lineageEdges?: unknown[] } = {},
) {
  return {
    mapRequirement: async () => ONE_MATCH,
    dataSourceFor: emptyGraphFor,
    schemaDataSourceFor: ordersSchemaDataSource,
    liveIndexFor: () => null,
    prisma: stubPrisma(opts) as never,
  };
}

// getGapReport + resolveGapReportDeps are the REAL production symbols under test.
const { getGapReport } = await import("./gap-report-service.js");
const {
  resolveGapReportDeps,
  loadAnalysisSchemaImpact,
  isSchemaImpactEnabled,
  SCHEMA_IMPACT_FLAG,
} = await import("./schema-impact-producer.js");

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env[SCHEMA_IMPACT_FLAG];
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env[SCHEMA_IMPACT_FLAG];
  __resetConfigSingleton();
});

describe("#847/#856 reachability — real getGapReport through the route seam yields databaseChanges", () => {
  it("populates databaseChanges + cross-project consumers via resolveGapReportDeps (resolver AUTO-enables on schema data, NO injected loadSchemaImpact)", async () => {
    // #856 — the legacy env flag is deliberately LEFT UNSET here: since #856,
    // `resolveGapReportDeps` gates on the #854 resolver, not
    // `isSchemaImpactEnabled()`. The project's `databaseAwareAnalysis` defaults to
    // "auto" (stubPrisma) and the fixture's connected `dbc_1` connection makes
    // `hasSchemaData` true, so `auto` resolves ON with zero operator env config —
    // #851's headline intent, proven end-to-end. Since #849 the unset flag also
    // reads ON (the platform default flipped); the gate is still the resolver.
    expect(isSchemaImpactEnabled()).toBe(true);

    // The EXACT shape the route uses: getGapReport(id, await resolveGapReportDeps(projectId, ...)).
    // resolveGapReportDeps builds the real loadSchemaImpact producer — we never
    // hand one in.
    const deps = await resolveGapReportDeps(PROJECT_ID, producerDeps());
    expect(deps.loadSchemaImpact).toBeTypeOf("function"); // the real producer is wired
    expect(deps.databaseAware).toEqual({
      setting: "auto",
      enabled: true,
      ran: true,
      reason: "auto->resolved-on",
    });

    const report = await getGapReport(ANALYSIS_ID, deps);
    expect(report).not.toBeNull();
    // #856 — the resolved decision is surfaced on the report too, so a user can
    // see WHY `databaseChanges` is populated.
    expect(report?.databaseAware).toEqual(deps.databaseAware);

    const req = report?.requirements.find((r) => r.requirementId === REQ_ID);
    expect(req?.databaseChanges).toBeDefined();
    expect(req?.databaseChanges).toHaveLength(1);

    const change = req?.databaseChanges?.[0];
    expect(change?.tableName).toBe(SHARED_TABLE);
    // The suggested DDL is TEXT-ONLY, never executed.
    expect(change?.suggestedDdl).toContain(SHARED_TABLE);

    // The cross-project (shared-DB) blast radius: the sibling project appears.
    expect(change?.identityResolved).toBe(true);
    expect(change?.consumers).toBeDefined();
    expect(change?.consumers).toEqual([
      {
        projectId: SIBLING_PROJECT_ID,
        projectName: SIBLING_PROJECT_NAME,
        usage: "readBy",
        objectQualifiedName: SHARED_TABLE,
      },
    ]);
  });

  it("drives the REAL enumerateSchemaConsumers — the producer is not a canned map", async () => {
    const prisma = stubPrisma();

    const map = await loadAnalysisSchemaImpact(ANALYSIS_ID, {
      ...producerDeps(),
      prisma: prisma as never,
    });

    // The producer actually issued the shared-DB consumer reads (proves #822 runs).
    expect(prisma.schemaObjectIdentity.findMany).toHaveBeenCalled();
    expect(prisma.schemaUsageClassification.findMany).toHaveBeenCalled();
    const entry = map.get(REQ_ID);
    expect(entry?.rows[0]?.tableName).toBe(SHARED_TABLE);
    expect(entry?.consumers[0]?.consumers[0]?.projectId).toBe(SIBLING_PROJECT_ID);
  });

  it("REACHABILITY + neuter-sensitivity: an explicit per-project OFF suppresses databaseChanges even though hasSchemaData is true", async () => {
    // Same connected-`DatabaseConnection` fixture as the AUTO-enables test above
    // (hasSchemaData: true) — the ONLY difference is the per-project setting. If
    // the gate were neutered back to the bare `ANALYSIS_SCHEMA_IMPACT` env flag
    // (#847's pre-#856 behaviour) or to a hardcoded `enabled: true`, this project's
    // explicit "off" would be ignored and `databaseChanges` would still appear —
    // this assertion is what catches that regression.
    const deps = await resolveGapReportDeps(
      PROJECT_ID,
      producerDeps({ databaseAwareAnalysisSetting: "off" }),
    );
    expect(deps.loadSchemaImpact).toBeUndefined();
    expect(deps.databaseAware).toEqual({
      setting: "off",
      enabled: false,
      ran: false,
      reason: "off",
    });

    const report = await getGapReport(ANALYSIS_ID, deps);
    const req = report?.requirements.find((r) => r.requirementId === REQ_ID);
    expect(req?.databaseChanges).toBeUndefined();
    // #856 — the suppression reason is still observable, never a silent no-op.
    expect(report?.databaseAware?.reason).toBe("off");
  });
});

describe("#847/#856 flag-OFF / no-schema-data regression — byte-identical to pre-#847 (no databaseChanges)", () => {
  it("the ANALYSIS_SCHEMA_IMPACT flag alone does not enable the section — even set 'true', a project with no schema data stays off", async () => {
    // Since #849 the unset flag reads ON (platform default flipped), and an
    // explicit `true` is an operator opt-IN — but neither can manufacture
    // schema data, so this project still resolves auto->resolved-off-no-data.
    expect(isSchemaImpactEnabled()).toBe(true);
    process.env[SCHEMA_IMPACT_FLAG] = "true";
    __resetConfigSingleton();
    const noDataPrisma = {
      ...stubPrisma({ databaseAwareAnalysisSetting: "auto" }),
      databaseConnection: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
      codeSymbol: { count: vi.fn(async () => 0) },
      codeEdge: { count: vi.fn(async () => 0) },
    };
    const deps = await resolveGapReportDeps(PROJECT_ID, {
      mapRequirement: async () => ONE_MATCH,
      dataSourceFor: emptyGraphFor,
      schemaDataSourceFor: ordersSchemaDataSource,
      liveIndexFor: () => null,
      prisma: noDataPrisma as never,
    });
    expect(deps.loadSchemaImpact).toBeUndefined();
    expect(deps.databaseAware?.reason).toBe("auto->resolved-off-no-data");
  });

  it("auto resolves OFF (no databaseChanges, reason surfaced) when the project has no schema data at all", async () => {
    const noDataPrisma = {
      ...stubPrisma({ databaseAwareAnalysisSetting: "auto" }),
      databaseConnection: {
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      },
      codeSymbol: { count: vi.fn(async () => 0) },
      codeEdge: { count: vi.fn(async () => 0) },
    };
    const deps = await resolveGapReportDeps(PROJECT_ID, {
      mapRequirement: async () => ONE_MATCH,
      dataSourceFor: emptyGraphFor,
      schemaDataSourceFor: ordersSchemaDataSource,
      liveIndexFor: () => null,
      prisma: noDataPrisma as never,
    });
    expect(deps.loadSchemaImpact).toBeUndefined();
    expect(deps.databaseAware).toEqual({
      setting: "auto",
      enabled: false,
      ran: false,
      reason: "auto->resolved-off-no-data",
    });

    const report = await getGapReport(ANALYSIS_ID, deps);
    const req = report?.requirements.find((r) => r.requirementId === REQ_ID);
    expect(req).toBeDefined();
    expect(req?.databaseChanges).toBeUndefined();
  });

  it("getGapReport(analysisId) with no deps at all is unchanged (main's call shape)", async () => {
    const report = await getGapReport(ANALYSIS_ID);
    const req = report?.requirements.find((r) => r.requirementId === REQ_ID);
    expect(req?.databaseChanges).toBeUndefined();
    expect(report?.databaseAware).toBeUndefined();
  });

  it("#895 — computes SQL-lineage coverage and threads it onto the gap report", async () => {
    const deps = await resolveGapReportDeps(
      PROJECT_ID,
      producerDeps({
        lineageEdges: [
          {
            id: "e1",
            kind: "reads",
            source: "sqlglot",
            metadata: null,
            toQualifiedName: "app.orders",
            filePath: "src/A.java",
          },
          {
            id: "e2",
            kind: "reads",
            source: "mybatis",
            metadata: JSON.stringify({
              unresolved: true,
              placeholder: "tableName",
              statementId: "M.find",
              mapper: "com.acme.M",
            }),
            toQualifiedName: "?dynamic:tableName",
            filePath: "src/M.xml",
          },
          {
            id: "e3",
            kind: "calls",
            source: "catalog-deps",
            metadata: null,
            toQualifiedName: "app.audit",
            filePath: "<oracle-all-dependencies>",
          },
        ],
      }),
    );
    expect(deps.sqlLineageCoverage).toMatchObject({
      totalEdges: 3,
      resolvedEdges: 1,
      unresolvedEdges: 2,
    });

    const report = await getGapReport(ANALYSIS_ID, deps);
    expect(report?.sqlLineageCoverage?.unresolvedEdges).toBe(2);
    expect(report?.sqlLineageCoverage?.coveragePercent).toBeCloseTo(33.3, 1);
  });

  it("#895 — coverage is null (omitted) when the project has no schema lineage edges", async () => {
    const deps = await resolveGapReportDeps(PROJECT_ID, producerDeps());
    expect(deps.sqlLineageCoverage).toBeNull();
    const report = await getGapReport(ANALYSIS_ID, deps);
    expect(report?.sqlLineageCoverage).toBeNull();
  });
});

describe("#847 producer internals — total, best-effort, and default-deps paths", () => {
  it("returns an empty map when the analysis snapshot is not visible", async () => {
    const map = await loadAnalysisSchemaImpact(ANALYSIS_ID, {
      loadSnapshot: async () => null,
    });
    expect(map.size).toBe(0);
  });

  it("skips a requirement whose mapping throws — one failure never sinks the report", async () => {
    const map = await loadAnalysisSchemaImpact(ANALYSIS_ID, {
      loadSnapshot: async () => snapshotFixture(),
      mapRequirement: async () => {
        throw new Error("mapper boom");
      },
      dataSourceFor: emptyGraphFor,
      schemaDataSourceFor: ordersSchemaDataSource,
      liveIndexFor: () => null,
      prisma: stubPrisma() as never,
    });
    expect(map.size).toBe(0);
  });

  it("exercises the production default factories (BM25 mapper + Prisma data sources)", async () => {
    // Inject ONLY the snapshot + a Prisma whose code-symbol search returns nothing,
    // so the real mapRequirementToCode / PrismaSchemaImpactDataSource defaults run
    // and the requirement resolves to no schema impact (empty map).
    const prisma = {
      ...stubPrisma(),
      codeSymbol: { findMany: vi.fn(async () => []) },
      codeEdge: { findMany: vi.fn(async () => []) },
    };
    const map = await loadAnalysisSchemaImpact(ANALYSIS_ID, {
      loadSnapshot: async () => snapshotFixture(),
      prisma: prisma as never,
    });
    expect(map.size).toBe(0);
    expect(prisma.codeSymbol.findMany).toHaveBeenCalled();
  });

  it("honours the maxRequirements cost cap (0 ⇒ no crossing)", async () => {
    const map = await loadAnalysisSchemaImpact(ANALYSIS_ID, {
      loadSnapshot: async () => snapshotFixture(),
      mapRequirement: async () => ONE_MATCH,
      dataSourceFor: emptyGraphFor,
      schemaDataSourceFor: ordersSchemaDataSource,
      liveIndexFor: () => null,
      prisma: stubPrisma() as never,
      maxRequirements: 0,
    });
    expect(map.size).toBe(0);
  });
});
