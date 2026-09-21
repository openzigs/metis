/**
 * Issue #861 (Epic #852 Phase 5b) — the CAPSTONE reachability proof for the
 * whole epic: ONE per-project `databaseAwareAnalysis` setting must flip BOTH
 * the analysis RUN path (#855) and the gap-report path (#856) TOGETHER, and
 * the recorded ran/skipped `reason` must be observable on both.
 *
 * #856's `database-aware-coupling.test.ts` already proves the two paths
 * resolve to the SAME `{setting,enabled,ran,reason}` DECISION object across 5
 * setting/schema-data combinations. This suite is the stronger claim #861
 * asks for: that the decision produces the same OBSERVABLE OUTCOME on both
 * halves — the run-side database agent's ACTUAL prompt carries the AFFECTED
 * SCHEMA fenced block (not just that a flag flipped), AND the gap-report's
 * `databaseChanges` section is populated with the SAME affected table (not
 * just that a producer function got wired) — using ONE shared mocked
 * `../prisma.js` module so a divergence can only be a genuine wiring bug, not
 * a fixture mismatch. See `database-aware-run-path.test.ts` (#855) and
 * `schema-impact-producer.test.ts` (#847/#856) for the two seam patterns this
 * suite composes; nothing here reimplements their fixtures, it reuses the
 * exact seam shapes with one shared affected table.
 *
 * Reachability discipline (#750/#797/#847): drives the REAL
 * `AnalysisOrchestrator.runPipeline` (run path) and the REAL
 * `resolveGapReportDeps` + `getGapReport` (gap-report path) end-to-end.
 * Nothing private is stubbed on `AnalysisOrchestrator` — only the documented
 * I/O seams (Prisma, the Copilot-SDK provider boundary, the
 * `affectedSchemaMapping`/`SchemaImpactProducerDeps` dependency seams).
 *
 * Dogfood table-name discipline (epic #820): this suite makes up its own
 * fixture table (`widget_audit_861`), not a METIS table, so the `@@map`
 * gotcha does not apply here.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { SchemaEdgeKind } from "@metis/shared";
import { InMemoryCodeGraphDataSource } from "../impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { SchemaImpactDataSource } from "../impact-analysis/schema-impact.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import type { RunAffectedSchemaDeps } from "./affected-schema-context.js";

const ANALYSIS_ID = "an_861";
const PROJECT_ID = "pr_861";
const REQ_ID = "REQ-861-WIDGET";

/** The physical table the fixture requirement's code writes to. */
const AFFECTED_TABLE = "widget_audit_861";
const SEED_SYMBOL_ID = "seed-widget-861";
const TABLE_SYMBOL_ID = "sym-widget-861";

interface FakeAnalysisRow {
  id: string;
  projectId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorMessage: string | null;
  metadata: string | null;
}
const analysisRows = new Map<string, FakeAnalysisRow>();
function seedAnalysisRow(id: string): void {
  analysisRows.set(id, {
    id,
    projectId: PROJECT_ID,
    status: "running",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    errorMessage: null,
    metadata: null,
  });
}
function seedAndReturn(id: string): FakeAnalysisRow {
  seedAnalysisRow(id);
  return analysisRows.get(id)!;
}

/**
 * The ONE persisted requirement both halves read through the REAL
 * `getAnalysisSnapshot` (via the shared `prisma.analysis.findFirst` mock
 * below) — the run path never reads it, but the gap-report path's
 * `getGapReport`/`loadAnalysisSchemaImpact` do, exactly as production does
 * (the route never hand-builds a snapshot loader).
 */
function requirementRow() {
  return {
    id: REQ_ID,
    type: "functional",
    title: "Persist widget audit results",
    body: `Persist widget audit results to a new ${AFFECTED_TABLE} audit table.`,
    priority: "high",
    labels: "[]",
    storyPoints: null,
    reviewStatus: "draft",
    coverage: "no_evidence",
    verdict: null,
    version: 1,
  };
}

// Mutable schema-data signal — the SAME `databaseConnection.count` mock backs
// BOTH the run path's `resolveDatabaseAware` probe AND the gap-report path's
// `resolveProjectDatabaseAware` probe.
let dbConnectionCount = 0;
// Mutable per-project setting — read by the gap-report path's
// `project.findUnique` AND handed to the run path's `runPipeline` explicitly,
// mirroring how `startAnalysis` reads the SAME project row in production.
let projectSetting = "auto";

vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async (args: { where: { id: string }; select?: { metadata?: boolean } }) => {
        const row = analysisRows.get(args.where.id);
        if (!row) return null;
        if (args.select?.metadata) return { metadata: row.metadata };
        return { ...row, agentResults: [], requirements: [requirementRow()] };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { metadata: string } }) => {
        const row = analysisRows.get(args.where.id) ?? seedAndReturn(args.where.id);
        analysisRows.set(args.where.id, { ...row, metadata: args.data.metadata });
        return { id: args.where.id };
      }),
    },
    crossDocFinding: { findMany: vi.fn(async () => []) },
    codeGraph: { findFirst: vi.fn(async () => null) },
    // #854's `hasSchemaData` probe — the SAME mock instance backs the run path
    // (orchestrator.ts's `resolveDatabaseAware`) AND the gap-report path
    // (schema-impact-producer.ts's `resolveProjectDatabaseAware`).
    databaseConnection: {
      count: vi.fn(async () => dbConnectionCount),
      // Cross-project consumer enumeration (#822) reads this; empty means no
      // workspace linkage, so `identityResolved` stays false — irrelevant to
      // this suite's assertions (it only asserts the `databaseChanges`
      // section's presence/table, not the cross-project blast radius).
      findMany: vi.fn(async () => []),
    },
    codeSymbol: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    codeEdge: { count: vi.fn(async () => 0) },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
    // Only the gap-report path reads this directly for the setting (the run
    // path receives its setting pre-loaded, mirroring `startAnalysis`).
    project: {
      findUnique: vi.fn(async () => ({ databaseAwareAnalysis: projectSetting })),
    },
  },
}));

vi.mock("./analysis-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./analysis-service.js")>();
  return {
    ...actual,
    createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
    finalizeAnalysisDelta: vi.fn(async () => undefined),
    getAnalysisCapability: vi.fn(async () => null),
    getStructuredRequirements: vi.fn(async () => null),
    markAnalysisCancelled: vi.fn(async () => undefined),
    markAnalysisCompleted: vi.fn(async () => undefined),
    markAnalysisFailed: vi.fn(async () => undefined),
    persistAgentResult: vi.fn(async (input: Record<string, unknown>) => ({
      id: "ar_1",
      agentKey: input.agentKey,
      findingIds: [],
    })),
    persistAnalysisEnhancement: vi.fn(async () => undefined),
    persistAnalysisCapability: vi.fn(async () => undefined),
    persistAnalysisAffectedCode: vi.fn(async () => undefined),
    persistAnalysisEscalation: vi.fn(async () => undefined),
    persistRequirements: vi.fn(async () => []),
    persistCrossDocFindings: vi.fn(async () => undefined),
    readFlattenedFindings: vi.fn(async () => []),
    // `persistAnalysisDatabaseAware`, `getAnalysisDatabaseAware`,
    // `getAnalysisSnapshot` are the REAL implementations from `actual` —
    // deliberately not overridden. Both halves read/write through them for
    // real: the run path's decision round trip, and the gap-report path's
    // snapshot (which carries the seeded `requirementRow()` above).
  };
});

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("./synthesis.js", () => ({
  runSynthesis: vi.fn(async () => ({
    output: { summary: "s", requirements: [], risks: [], recommendations: [] },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })),
}));
vi.mock("./cross-doc-detection.js", () => ({ runCrossDocDetection: vi.fn(async () => null) }));
vi.mock("./custom-agent-phase.js", () => ({
  runEnabledCustomAgents: vi.fn(async () => ({
    results: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })),
}));
vi.mock("../teams/notification-hooks.js", () => ({
  notifyAnalysisComplete: vi.fn(async () => undefined),
}));
vi.mock("../traceability/seed-code-links-from-findings.js", () => ({
  seedRequirementCodeLinksFromFindings: vi.fn(async () => undefined),
}));
vi.mock("./approval-checkpoint.js", () => ({
  createApprovalRequests: vi.fn(async () => undefined),
  canCreateTickets: vi.fn(async () => false),
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");
const { getAnalysisDatabaseAware } = await import("./analysis-service.js");
const { getGapReport } = await import("./gap-report-service.js");
const { resolveGapReportDeps } = await import("./schema-impact-producer.js");

/** One mapped code symbol whose id seeds the schema crossing (no blast radius). */
const ONE_MATCH: RequirementCodeMatch[] = [
  {
    codeSymbolId: SEED_SYMBOL_ID,
    filePath: "server/src/widgets/audit.ts",
    qualifiedName: "recordWidgetAudit",
    startLine: 1,
    endLine: 20,
    confidence: 0.9,
  },
];
const EMPTY_GRAPH = new InMemoryCodeGraphDataSource([], []);
const emptyGraphFor = (): CodeGraphDataSource => EMPTY_GRAPH;

/** A schema graph where the seed symbol `writes` the affected table. */
function schemaDataSourceWithTable(): SchemaImpactDataSource {
  const edges = [
    { fromSymbolId: SEED_SYMBOL_ID, toSymbolId: TABLE_SYMBOL_ID, kind: "writes" as SchemaEdgeKind },
  ];
  const symbols = [
    {
      id: TABLE_SYMBOL_ID,
      kind: "table" as const,
      name: AFFECTED_TABLE,
      qualifiedName: AFFECTED_TABLE,
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
 * A genuinely-empty schema graph — no edges, no table symbols — modelling a
 * project with no schema data to cross into, independent of the resolved
 * setting. Used for the "on + no schema data" (skipped) case so the absence
 * of `databaseChanges` is a REAL empty crossing, not an artifact of the gate.
 */
function emptySchemaDataSource(): SchemaImpactDataSource {
  return {
    async getSchemaEdgesFrom() {
      return [];
    },
    async getSchemaSymbolsByIds() {
      return [];
    },
  };
}

interface CapturedChatCall {
  userMessage: string;
}
function makeProvider(calls: CapturedChatCall[]) {
  return {
    chat: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      calls.push({ userMessage: messages[messages.length - 1]?.content ?? "" });
      return {
        content: JSON.stringify({ summary: "investigated", findings: [], notes: [] }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        provider: "bedrock" as const,
      };
    }),
  };
}

/**
 * Drive the REAL run path end-to-end. `withCrossing` seeds the deterministic
 * AFFECTED SCHEMA extractor with `extraInstructions` + the injected mapper
 * (mirrors `database-aware-run-path.test.ts`); omitted for the "no schema
 * data" case so the extractor never even attempts a crossing (matching a
 * genuinely data-less project).
 */
async function runPathResult(
  setting: string,
  opts: { withCrossing: boolean },
): Promise<{ calls: CapturedChatCall[]; decision: unknown }> {
  __resetConfigSingleton();
  const calls: CapturedChatCall[] = [];
  const affectedSchemaMapping: RunAffectedSchemaDeps | undefined = opts.withCrossing
    ? {
        mapRequirement: async () => ONE_MATCH,
        dataSourceFor: emptyGraphFor,
        schemaDataSourceFor: schemaDataSourceWithTable,
      }
    : undefined;
  const orch = new AnalysisOrchestrator({
    provider: makeProvider(calls) as never,
    retrieve: async () => [],
    knowledge: {} as never,
    affectedSchemaMapping,
  });
  await (
    orch as unknown as {
      runPipeline: (
        analysisId: string,
        projectName: string,
        projectDescription: string,
        agentKeys: string[],
        opts: Record<string, unknown>,
        databaseAwareAnalysisSetting: string,
      ) => Promise<void>;
    }
  ).runPipeline(
    ANALYSIS_ID,
    "Metis",
    "A test project",
    ["database"],
    {
      projectId: PROJECT_ID,
      startedById: "u1",
      model: "test-model",
      ...(opts.withCrossing
        ? {
            extraInstructions: `Persist widget audit results to a new ${AFFECTED_TABLE} audit table.`,
          }
        : {}),
    },
    setting,
  );
  return { calls, decision: await getAnalysisDatabaseAware(ANALYSIS_ID) };
}

/**
 * Drive the REAL gap-report path end-to-end through the EXACT production
 * shape (`getGapReport(id, await resolveGapReportDeps(projectId, ...))`) —
 * the false-green #847 exists to kill. Only the producer's documented I/O
 * seams are injected (requirement mapper, in-memory code/schema graphs); the
 * snapshot itself comes from the REAL `getAnalysisSnapshot`, reading the
 * shared `requirementRow()` fixture via the shared mocked Prisma module.
 */
async function gapReportResult(opts: { withCrossing: boolean }): Promise<{
  databaseAware: unknown;
  loadSchemaImpactWired: boolean;
  databaseChanges: unknown;
  reportReason: unknown;
}> {
  __resetConfigSingleton();
  const deps = await resolveGapReportDeps(PROJECT_ID, {
    mapRequirement: async () => ONE_MATCH,
    dataSourceFor: emptyGraphFor,
    schemaDataSourceFor: opts.withCrossing ? schemaDataSourceWithTable : emptySchemaDataSource,
    liveIndexFor: () => null,
  });
  const report = await getGapReport(ANALYSIS_ID, deps);
  const req = report?.requirements.find((r) => r.requirementId === REQ_ID);
  return {
    databaseAware: deps.databaseAware,
    loadSchemaImpactWired: typeof deps.loadSchemaImpact === "function",
    databaseChanges: req?.databaseChanges,
    reportReason: report?.databaseAware?.reason,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  analysisRows.clear();
  seedAnalysisRow(ANALYSIS_ID);
  dbConnectionCount = 0;
  projectSetting = "auto";
  __resetConfigSingleton();
});

afterEach(() => {
  __resetConfigSingleton();
});

describe("#861 — one per-project setting flips BOTH the run path and the gap-report path together", () => {
  it("resolved ON + real schema data: BOTH the run-side AFFECTED SCHEMA prompt block and the gap-report databaseChanges section are produced, with the same reason", async () => {
    projectSetting = "auto";
    dbConnectionCount = 1;

    const run = await runPathResult("auto", { withCrossing: true });
    // Run-side reachability: the database agent's ACTUAL prompt carries the
    // AFFECTED SCHEMA block for the SAME table the gap-report will assert below.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.userMessage).toContain("BEGIN AFFECTED SCHEMA");
    expect(run.calls[0]?.userMessage).toContain(AFFECTED_TABLE);
    expect(run.decision).toEqual({
      setting: "auto",
      enabled: true,
      ran: true,
      reason: "auto->resolved-on",
    });

    const gap = await gapReportResult({ withCrossing: true });
    // Coupling: the gap-report path resolves the IDENTICAL decision object.
    expect(gap.databaseAware).toEqual(run.decision);
    // Gap-report reachability: the section is populated with the SAME table.
    expect(gap.loadSchemaImpactWired).toBe(true);
    expect(gap.databaseChanges).toBeDefined();
    expect(gap.databaseChanges).toHaveLength(1);
    expect((gap.databaseChanges as Array<{ tableName: string }>)[0]?.tableName).toBe(
      AFFECTED_TABLE,
    );
    expect(gap.reportReason).toBe("auto->resolved-on");
  });

  it("OFF: BOTH halves are suppressed even though real schema data exists, reason 'off' on both", async () => {
    projectSetting = "off";
    dbConnectionCount = 1; // data present but the explicit override wins.

    const run = await runPathResult("off", { withCrossing: true });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.userMessage).not.toContain("BEGIN AFFECTED SCHEMA");
    expect(run.decision).toEqual({ setting: "off", enabled: false, ran: false, reason: "off" });

    const gap = await gapReportResult({ withCrossing: true });
    expect(gap.databaseAware).toEqual(run.decision);
    expect(gap.loadSchemaImpactWired).toBe(false);
    expect(gap.databaseChanges).toBeUndefined();
    expect(gap.reportReason).toBe("off");
  });

  it("ON + NO schema data: BOTH halves produce no content, but the skip is RECORDED (not a silent no-op)", async () => {
    projectSetting = "on";
    dbConnectionCount = 0;

    const run = await runPathResult("on", { withCrossing: false });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.userMessage).not.toContain("BEGIN AFFECTED SCHEMA");
    expect(run.decision).toEqual({
      setting: "on",
      enabled: true,
      ran: false,
      reason: "skipped-no-schema-data",
    });

    const gap = await gapReportResult({ withCrossing: false });
    expect(gap.databaseAware).toEqual(run.decision);
    // `enabled` is true (an explicit `on` override is always reachable), so the
    // gate DOES wire the real producer — the empty result below is a genuine
    // empty crossing (no schema graph to cross into), never a gate artifact.
    expect(gap.loadSchemaImpactWired).toBe(true);
    expect(gap.databaseChanges).toBeUndefined();
    // The skip is observable via the reason, not a silent no-op.
    expect(gap.reportReason).toBe("skipped-no-schema-data");
  });
});
