/**
 * Issue #856 (Epic #852 Phase 2c) — the COUPLING INVARIANT between the analysis
 * RUN path (#855, `orchestrator.ts`'s private `resolveDatabaseAware`) and the
 * GAP-REPORT path (#856, `schema-impact-producer.ts`'s `resolveGapReportDeps`).
 *
 * This is the central promise of epic #852: for the SAME project (the same
 * `Project.databaseAwareAnalysis` setting and the same schema-data signal), the
 * two independently-implemented call sites must resolve to the SAME
 * `{ setting, enabled, ran, reason }` decision — they can no longer read
 * different inputs into #854's resolver and diverge into a half-on state
 * (report section on but run prompts off, or vice-versa).
 *
 * Both paths run through ONE shared mocked `../prisma.js` module — the SAME
 * `databaseConnection.count` mock backs BOTH `hasSchemaData` probes, and the
 * SAME `project.findUnique` mock backs the gap-report path's setting read
 * (the run path receives its setting the way `AnalysisOrchestrator.startAnalysis`
 * does in production: already-loaded off the project row, threaded as
 * `runPipeline`'s explicit 6th arg — see orchestrator.ts L618-L627). A
 * divergence in this suite can only be a genuine implementation bug in one of
 * the two wiring points, never a fixture mismatch.
 *
 * Reachability discipline (#750/#797/#847): drives the REAL
 * `AnalysisOrchestrator.runPipeline` (run path) and the REAL
 * `resolveGapReportDeps` (gap-report path) — nothing private is stubbed, only
 * the documented I/O seams (Prisma, the AI provider boundary).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_856_coupling";
const PROJECT_ID = "pr_856_coupling";

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

// Mutable schema-data signal — ONE shared fixture read by BOTH resolvers' probe.
let dbConnectionCount = 0;
// Mutable per-project setting — read by the gap-report path's `project.findUnique`
// AND handed to the run path's `runPipeline` explicitly (mirroring how
// `startAnalysis` reads the SAME project row in production).
let projectSetting = "auto";

vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async (args: { where: { id: string }; select?: { metadata?: boolean } }) => {
        const row = analysisRows.get(args.where.id);
        if (!row) return null;
        if (args.select?.metadata) return { metadata: row.metadata };
        return { ...row, agentResults: [], requirements: [] };
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
    databaseConnection: { count: vi.fn(async () => dbConnectionCount) },
    codeSymbol: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    codeEdge: { count: vi.fn(async () => 0) },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
    // #856 — only the gap-report path reads this directly (the run path
    // receives its setting pre-loaded, mirroring `startAnalysis` in production).
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
    // `persistAnalysisDatabaseAware`, `getAnalysisDatabaseAware`, `getAnalysisSnapshot`
    // are the REAL implementations from `actual` — deliberately not overridden
    // (both paths read/write through them for real).
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
const { resolveGapReportDeps } = await import("./schema-impact-producer.js");

function makeProvider() {
  return {
    chat: vi.fn(async () => ({
      content: JSON.stringify({ summary: "investigated", findings: [], notes: [] }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model",
      provider: "bedrock" as const,
    })),
  };
}

/**
 * Drive the REAL run path's resolved decision. `agentKeys: ["database"]` alone
 * satisfies `computeAffectedSchema`'s applicability condition
 * (`hasCodeAgent || agentKeys.includes("database")`); no `extraInstructions`
 * means `computeRunAffectedSchemaContext` short-circuits to
 * `EMPTY_AFFECTED_SCHEMA_CONTEXT` regardless of the resolved decision — this
 * suite only asserts the DECISION, not the schema-crossing content (that is
 * `database-aware-run-path.test.ts`'s job).
 */
async function runPathDecision(setting: string): Promise<unknown> {
  __resetConfigSingleton();
  const orch = new AnalysisOrchestrator({
    provider: makeProvider() as never,
    retrieve: async () => [],
    knowledge: {} as never,
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
    "Coupling",
    "A test project",
    ["database"],
    { projectId: PROJECT_ID, startedById: "u1", model: "test-model" },
    setting,
  );
  return getAnalysisDatabaseAware(ANALYSIS_ID);
}

/** Drive the REAL gap-report path's resolved decision. */
async function gapReportPathDecision(): Promise<unknown> {
  __resetConfigSingleton();
  const deps = await resolveGapReportDeps(PROJECT_ID);
  return deps.databaseAware;
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

describe("#856 coupling invariant — run path and gap-report path resolve identically", () => {
  it.each([
    { label: "explicit ON, no schema data (unconditional override)", setting: "on", dbCount: 0 },
    { label: "explicit ON, with schema data", setting: "on", dbCount: 1 },
    { label: "explicit OFF, WITH schema data (off is unconditional)", setting: "off", dbCount: 1 },
    { label: "auto, with schema data (resolves on)", setting: "auto", dbCount: 1 },
    { label: "auto, no schema data (resolves off)", setting: "auto", dbCount: 0 },
  ])("$label", async ({ setting, dbCount }) => {
    dbConnectionCount = dbCount;
    projectSetting = setting;

    const runDecision = await runPathDecision(setting);
    const gapReportDecision = await gapReportPathDecision();

    // The load-bearing assertion: two independently-implemented call sites,
    // same inputs, same decision object (setting + enabled + ran + reason).
    expect(gapReportDecision).toEqual(runDecision);
    expect(runDecision).not.toBeNull();
  });
});

describe("#849 platform kill-switch — both paths honour an EXPLICITLY disabled flag", () => {
  afterEach(() => {
    delete process.env.ANALYSIS_SCHEMA_IMPACT;
    delete process.env.ANALYSIS_AFFECTED_SCHEMA_MAPPING;
    __resetConfigSingleton();
  });

  it("an operator's ANALYSIS_SCHEMA_IMPACT=0 disables an `auto` project WITH schema data — on both paths, identically", async () => {
    // Pre-#849 this env var was silently overridden: `auto` + schema data
    // resolved ON regardless, leaving operators no fleet-wide opt-out. Both
    // production wirings must now read the SAME explicit-configuration signal.
    process.env.ANALYSIS_SCHEMA_IMPACT = "0";
    dbConnectionCount = 1;
    projectSetting = "auto";

    const runDecision = await runPathDecision("auto");
    const gapReportDecision = await gapReportPathDecision();

    expect(runDecision).toEqual({
      setting: "auto",
      enabled: false,
      ran: false,
      reason: "auto->platform-disabled",
    });
    expect(gapReportDecision).toEqual(runDecision);
  });

  it("the SAME project resolves ON once the operator's flag is removed — the kill-switch is the only difference", async () => {
    dbConnectionCount = 1;
    projectSetting = "auto";

    const runDecision = await runPathDecision("auto");
    const gapReportDecision = await gapReportPathDecision();

    expect(runDecision).toEqual({
      setting: "auto",
      enabled: true,
      ran: true,
      reason: "auto->resolved-on",
    });
    expect(gapReportDecision).toEqual(runDecision);
  });

  it("a per-project explicit `on` still overrides the platform kill-switch on both paths", async () => {
    process.env.ANALYSIS_SCHEMA_IMPACT = "0";
    dbConnectionCount = 1;
    projectSetting = "on";

    const runDecision = await runPathDecision("on");
    const gapReportDecision = await gapReportPathDecision();

    expect(runDecision).toEqual({ setting: "on", enabled: true, ran: true, reason: "on" });
    expect(gapReportDecision).toEqual(runDecision);
  });
});
