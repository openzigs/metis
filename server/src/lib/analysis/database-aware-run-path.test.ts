/**
 * Issue #855 (Epic #852 Phase 2b) — the database-aware-analysis resolver (#854)
 * threaded into the analysis RUN path, driven end-to-end through the REAL
 * `AnalysisOrchestrator.runPipeline`.
 *
 * REACHABILITY GUARD (this epic was bitten 3x by green tests over unreachable
 * paths: #750/#797/#847): this suite does NOT call `resolveDatabaseAwareAnalysis`
 * or `computeAffectedSchema` directly. It drives the real orchestrator wiring —
 * the fake MODEL is scripted at the AI provider boundary and the
 * schema-crossing fixture rides the documented `affectedSchemaMapping`
 * dependency seam (#823/#824), exactly like `verdict-schema-pipeline.test.ts`
 * and `dogfood-schema-impact-pipeline.test.ts`. The assertions are on what
 * crossed real boundaries:
 *   - the AFFECTED SCHEMA fenced block the database agent (Sally) actually
 *     received in its prompt (`provider.chat`'s `messages[0].content`) — proof
 *     schema reasoning genuinely ran, not just that a flag was set;
 *   - the resolved `{ setting, enabled, ran, reason }` decision read back
 *     through the REAL `persistAnalysisDatabaseAware` / `getAnalysisDatabaseAware`
 *     / `getAnalysisSnapshot` (imported via `importOriginal`, NOT re-implemented
 *     or stubbed) — the actual persistence + GET-response round trip, not a
 *     mock-call capture.
 *
 * `agentKeys: ["database"]` only (no code/document agent) keeps the harness
 * minimal: `computeAffectedSchema`'s applicability condition
 * (`hasCodeAgent || agentKeys.includes("database")`) is satisfied by the
 * database agent alone, so no document-sequencing or code-tool-loop fixtures
 * are needed.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { AnalysisSnapshot, SchemaEdgeKind } from "@metis/shared";
import { InMemoryCodeGraphDataSource } from "../impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { SchemaImpactDataSource } from "../impact-analysis/schema-impact.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import type { RunAffectedSchemaDeps } from "./affected-schema-context.js";

const ANALYSIS_ID = "an_855";
const PROJECT_ID = "pr_855";

/** The physical table the operator's new requirement implies a schema change to. */
const AFFECTED_TABLE = "widget_audit";

// ── In-memory `Analysis` row store — the REAL `persistAnalysisDatabaseAware` /
// `getAnalysisDatabaseAware` / `getAnalysisSnapshot` (via `importOriginal`)
// read and write through this, so the round trip is genuine, not re-implemented.
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

// Mutable failure toggles for the "best-effort, never blocks the run" tests
// below — `resolveDatabaseAware`'s schema-data probe and its metadata persist
// are each wrapped in their own try/catch (see `orchestrator.ts`); these let
// the suite exercise BOTH degrade paths against the real orchestrator without
// touching the happy-path mocks used by every other test in this file.
let failSchemaDataProbe = false;
let failDatabaseAwarePersist = false;

vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async (args: { where: { id: string }; select?: { metadata?: boolean } }) => {
        const row = analysisRows.get(args.where.id);
        if (!row) return null;
        // `getAnalysisDatabaseAware` selects only `metadata`; `getAnalysisSnapshot`
        // includes the full row + relations. Serve both real read shapes.
        if (args.select?.metadata) return { metadata: row.metadata };
        return { ...row, agentResults: [], requirements: [] };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { metadata: string } }) => {
        if (failDatabaseAwarePersist) throw new Error("simulated metadata write failure");
        const row = analysisRows.get(args.where.id) ?? seedAndReturn(args.where.id);
        analysisRows.set(args.where.id, { ...row, metadata: args.data.metadata });
        return { id: args.where.id };
      }),
    },
    crossDocFinding: { findMany: vi.fn(async () => []) },
    codeGraph: { findFirst: vi.fn(async () => null) },
    // #854 — `hasSchemaData`'s three probes. A connected `DatabaseConnection`
    // is present so `auto`/`on` resolve with `hasSchemaData: true` — the clean,
    // unambiguous "everything aligned" scenario for this suite's assertions.
    databaseConnection: {
      count: vi.fn(async () => {
        if (failSchemaDataProbe) throw new Error("simulated schema-data probe failure");
        return 1;
      }),
    },
    codeSymbol: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    codeEdge: { count: vi.fn(async () => 0) },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
  },
}));
function seedAndReturn(id: string): FakeAnalysisRow {
  seedAnalysisRow(id);
  return analysisRows.get(id)!;
}

// Preserve the REAL `persistAnalysisDatabaseAware` / `getAnalysisDatabaseAware` /
// `getAnalysisSnapshot` (they exercise this issue's actual persistence +
// extraction code against the faked `prisma.analysis` above); stub every other
// export the orchestrator touches, matching the established pipeline-test seam.
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
    // are the REAL implementations from `actual` — deliberately not overridden.
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
const { getAnalysisDatabaseAware, getAnalysisSnapshot } = await import("./analysis-service.js");

const DB_ANSWER = JSON.stringify({ summary: "investigated", findings: [], notes: [] });

// ── Affected-schema dependency seam (#823/#824), mirroring the established
// verdict-schema-pipeline.test.ts / dogfood-schema-impact-pipeline.test.ts
// fixture: a code symbol that `writes` a physical table.
const ONE_MATCH: RequirementCodeMatch[] = [
  {
    codeSymbolId: "seed-widget",
    filePath: "server/src/widgets/audit.ts",
    qualifiedName: "recordWidgetAudit",
    startLine: 1,
    endLine: 20,
    confidence: 0.9,
  },
];
const EMPTY_GRAPH = new InMemoryCodeGraphDataSource([], []);
const emptyGraphFor = (): CodeGraphDataSource => EMPTY_GRAPH;
function schemaDataSourceFor(): SchemaImpactDataSource {
  const edges = [
    { fromSymbolId: "seed-widget", toSymbolId: "t-widget", kind: "writes" as SchemaEdgeKind },
  ];
  const symbols = [
    {
      id: "t-widget",
      kind: "table" as const,
      name: AFFECTED_TABLE,
      qualifiedName: AFFECTED_TABLE,
      source: "mybatis" as const,
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
function affectedSchemaDeps(): RunAffectedSchemaDeps {
  return {
    mapRequirement: async () => ONE_MATCH,
    dataSourceFor: emptyGraphFor,
    schemaDataSourceFor,
  };
}

/** Every call `provider.chat` received: the messages array + system message. */
interface CapturedChatCall {
  userMessage: string;
  systemMessage?: string;
}
function makeProvider(calls: CapturedChatCall[]) {
  return {
    chat: vi.fn(
      async (
        messages: Array<{ role: string; content: string }>,
        opts?: { systemMessage?: string },
      ) => {
        calls.push({
          userMessage: messages[messages.length - 1]?.content ?? "",
          systemMessage: opts?.systemMessage,
        });
        return {
          content: DB_ANSWER,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "test-model",
          provider: "bedrock" as const,
        };
      },
    ),
  };
}

async function runPipeline(
  calls: CapturedChatCall[],
  databaseAwareAnalysisSetting: string,
): Promise<void> {
  __resetConfigSingleton();
  const orch = new AnalysisOrchestrator({
    provider: makeProvider(calls) as never,
    retrieve: async () => [],
    knowledge: {} as never,
    affectedSchemaMapping: affectedSchemaDeps(),
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
      // The operator's new requirement — drives the deterministic AFFECTED
      // SCHEMA extractor (the injected mapper then seeds the crossing).
      extraInstructions: `Persist widget audit results to a new ${AFFECTED_TABLE} audit table.`,
    },
    databaseAwareAnalysisSetting,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  analysisRows.clear();
  seedAnalysisRow(ANALYSIS_ID);
  failSchemaDataProbe = false;
  failDatabaseAwarePersist = false;
  __resetConfigSingleton();
});

afterEach(() => {
  __resetConfigSingleton();
});

describe("#855 — database-aware resolver threaded into the run path (reachability)", () => {
  it("project ON: schema reasoning actually runs and the recorded reason is 'on'", async () => {
    const calls: CapturedChatCall[] = [];
    await runPipeline(calls, "on");

    // Reachability: the database agent's ACTUAL prompt carries the AFFECTED
    // SCHEMA block (proves `computeAffectedSchema` ran end-to-end through the
    // real orchestrator wiring, not just that a decision object was computed).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userMessage).toContain("BEGIN AFFECTED SCHEMA");
    expect(calls[0]?.userMessage).toContain(AFFECTED_TABLE);

    // The resolved decision, read back through the REAL persistence +
    // narrow-getter round trip (not a mock-call capture).
    const decision = await getAnalysisDatabaseAware(ANALYSIS_ID);
    expect(decision).toEqual({ setting: "on", enabled: true, ran: true, reason: "on" });

    // AC4 — "persisted and returned by the analysis GET/create response":
    // the REAL `getAnalysisSnapshot` (the GET route's read path) carries it too.
    const snapshot = (await getAnalysisSnapshot(ANALYSIS_ID)) as AnalysisSnapshot;
    expect(snapshot.databaseAware).toEqual({
      setting: "on",
      enabled: true,
      ran: true,
      reason: "on",
    });
  });

  it("project OFF: schema reasoning is suppressed and the skip reason is recorded", async () => {
    const calls: CapturedChatCall[] = [];
    await runPipeline(calls, "off");

    // The database agent still ran (it's requested), but its prompt carries NO
    // affected-schema block — the resolved OFF decision actually suppressed it.
    // (`extraInstructions` is still echoed verbatim as OPERATOR NOTES — that's
    // unrelated raw input, not the deterministic AFFECTED SCHEMA crossing — so
    // the table name alone is not a meaningful negative assertion here.)
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userMessage).not.toContain("BEGIN AFFECTED SCHEMA");

    const decision = await getAnalysisDatabaseAware(ANALYSIS_ID);
    expect(decision).toEqual({ setting: "off", enabled: false, ran: false, reason: "off" });

    const snapshot = (await getAnalysisSnapshot(ANALYSIS_ID)) as AnalysisSnapshot;
    expect(snapshot.databaseAware).toEqual({
      setting: "off",
      enabled: false,
      ran: false,
      reason: "off",
    });
  });
});

describe("#855 — getAnalysisDatabaseAware degrades to null (real extraction function)", () => {
  it("returns null for an analysis with no persisted record", async () => {
    // No `databaseAware` key was ever written for this row (matches a
    // pre-#855 analysis, or one where the resolver was never applicable).
    expect(await getAnalysisDatabaseAware(ANALYSIS_ID)).toBeNull();
  });

  it("returns null for a malformed `metadata.databaseAware` blob", async () => {
    analysisRows.set(ANALYSIS_ID, {
      ...(analysisRows.get(ANALYSIS_ID) as FakeAnalysisRow),
      metadata: JSON.stringify({ databaseAware: { setting: "on" /* missing enabled/reason */ } }),
    });
    expect(await getAnalysisDatabaseAware(ANALYSIS_ID)).toBeNull();
  });

  it("returns null for an analysis id that does not exist", async () => {
    expect(await getAnalysisDatabaseAware("does-not-exist")).toBeNull();
  });
});

describe("#855 — resolveDatabaseAware is best-effort (a failure never blocks the run)", () => {
  it("a schema-data probe failure degrades to 'no schema data', not a thrown/rejected run", async () => {
    failSchemaDataProbe = true;
    const calls: CapturedChatCall[] = [];

    // `auto` (not an explicit override) depends on schema-data presence, so a
    // failed probe must fail CLOSED (treated as absent) rather than crash the
    // run or silently assume data is present.
    await expect(runPipeline(calls, "auto")).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.userMessage).not.toContain("BEGIN AFFECTED SCHEMA");
    expect(await getAnalysisDatabaseAware(ANALYSIS_ID)).toEqual({
      setting: "auto",
      enabled: false,
      ran: false,
      reason: "auto->resolved-off-no-data",
    });
  });

  it("a metadata persist failure never blocks the run (the decision still governs the block)", async () => {
    failDatabaseAwarePersist = true;
    const calls: CapturedChatCall[] = [];

    await expect(runPipeline(calls, "on")).resolves.toBeUndefined();

    // The persist failed, so nothing was recorded — but the resolved decision
    // still gated `computeAffectedSchema` correctly for THIS run.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userMessage).toContain("BEGIN AFFECTED SCHEMA");
    expect(await getAnalysisDatabaseAware(ANALYSIS_ID)).toBeNull();
  });
});
