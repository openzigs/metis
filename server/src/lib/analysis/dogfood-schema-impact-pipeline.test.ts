/**
 * Issue #832 (Epic #820 Phase 4) — METIS-on-METIS DOGFOOD known-answer test for
 * the database-aware schema-impact pipeline.
 *
 * A known-answer benchmark (the #735/#742/#773 style) run against METIS's OWN
 * schema: a requirement that forces a real schema change — "persist an evidence
 * snapshot per requirement" — is driven through the deterministic database-aware
 * chain, and the assertions pin the KNOWN ANSWERS:
 *
 *   - the affected-schema output names the PHYSICAL/MAPPED table `requirements`
 *     (the Prisma model `Requirement` `@@map`s to it — `schema.prisma` L1339),
 *     never the model name `Requirement`;
 *   - the suggested DDL is plausible, TEXT-ONLY `ALTER TABLE requirements ADD
 *     COLUMN …` for the new column, reconciled `column-not-found` against the
 *     live `requirements` table (the column does not exist yet — that IS the
 *     gap) and classified `expanding` (additive) risk;
 *   - the gap report carries that in its `databaseChanges` section behind the
 *     mandatory "review only, never executed" label; and
 *   - the requirement verdict follows #773 discipline through the REAL pipeline
 *     (`AnalysisOrchestrator.runPipeline`): a healthy retrieval confirms the gap,
 *     a degraded retrieval cannot, and a finding that cites the unreconciled
 *     physical column is capped by the #826 schema gate.
 *
 * Testing discipline (from P0 #750 / #773 / #826): the pipeline half is driven
 * end-to-end — the fake MODEL is scripted at the AI provider boundary
 * and the run's AFFECTED SCHEMA is supplied through the documented
 * `affectedSchemaMapping` dependency seam (a REAL `LiveSchemaIndex` + in-memory
 * schema graph). NOTHING private is stubbed; the assertions are on what crossed
 * real boundaries (the persisted findings + requirement verdicts, and the report
 * built by the real gap-report builder from the real impact rows). The gap
 * report is assembled by the SAME `computeRunAffectedSchemaContext` producer the
 * orchestrator calls (`orchestrator.ts` `computeAffectedSchema`) fed into the
 * real `buildGapReport` + markdown serializer — it is not re-derived by hand.
 *
 * Fully deterministic: no network, no live DB (Prisma mocked, schema injected),
 * no real LLM. Runs cleanly under `pnpm test`.
 *
 * Updated for #855 (Epic #852 Phase 2b): `computeAffectedSchema` is now gated
 * on the RESOLVED database-aware-analysis decision (#854), not the bare
 * `ANALYSIS_AFFECTED_SCHEMA_MAPPING` flag directly. `runPipeline` here threads
 * an explicit per-project `"on"` setting as the 6th arg so the AC4 pipeline
 * scenarios stay deterministic regardless of the (now fallback-only) env flag.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import type {
  AgentFindingPayload,
  GapReport,
  SchemaEdgeKind,
  TraceabilityMatrix,
} from "@metis/shared";
import {
  LiveSchemaIndex,
  type LiveColumn,
  type LiveTable,
} from "../impact-analysis/live-schema-ingest.js";
import type {
  AffectedTableInput,
  SchemaImpactDataSource,
} from "../impact-analysis/schema-impact.js";
import { InMemoryCodeGraphDataSource } from "../impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import {
  computeRunAffectedSchemaContext,
  type RunAffectedSchemaDeps,
} from "./affected-schema-context.js";
import {
  buildGapReport,
  type GapReportFindingInput,
  type GapReportRequirementInput,
} from "./gap-report.js";
import { serializeAnalysisReportMarkdown } from "./analysis-export.js";
import { getGapReport } from "./gap-report-service.js";
import { resolveGapReportDeps, SCHEMA_IMPACT_FLAG } from "./schema-impact-producer.js";

// ── The dogfood KNOWN ANSWER ────────────────────────────────────────────────

/** Prisma model `Requirement` `@@map`s to this physical table (`schema.prisma`). */
const REQUIREMENTS_TABLE = "requirements";
/**
 * The new column the requirement implies. Physical name in METIS's convention:
 * Prisma preserves camelCase FIELD names as column names (only the TABLE is
 * `@@map`-ed) — the real `requirements` columns are `projectId`, `storyPoints`,
 * … (migration `20260424201859_init`), so the new column is `evidenceSnapshot`.
 */
const NEW_COLUMN = "evidenceSnapshot";
/** `suggestDdl`'s `column-not-found` branch (`schema-impact.ts`): type unknown ⇒ `<type>`. */
const EXPECTED_DDL = `ALTER TABLE ${REQUIREMENTS_TABLE} ADD COLUMN ${NEW_COLUMN} <type>;`;

const ANALYSIS_ID = "an_832";
const PROJECT_ID = "pr_832";
const REQ_ID = "REQ-EVIDENCE-SNAPSHOT";

/** The operator's free-text new requirement — the known-answer schema delta. */
const NEW_REQUIREMENT_TEXT =
  "The system must persist an evidence snapshot (an array of strings) on each " +
  "requirement so analysts can audit why it was flagged.";

// ── Affected-schema dependency seam (the METIS-derived dogfood fixture) ──────

/** The impacted code symbol the requirement maps to (its id seeds the crossing). */
const SEED_SYMBOL_ID = "seed-requirement-persist";
/** The `requirements.evidenceSnapshot` column the impacted code persists to. */
const COLUMN_SYMBOL_ID = "col-requirements-evidence-snapshot";

/** One mapped code symbol whose id seeds the schema crossing (no blast radius). */
const ONE_MATCH: RequirementCodeMatch[] = [
  {
    codeSymbolId: SEED_SYMBOL_ID,
    filePath: "server/src/lib/requirements/requirement-service.ts",
    qualifiedName: "persistRequirement",
    startLine: 1,
    endLine: 40,
    confidence: 0.9,
  },
];

/** Empty code graph → the mapper's direct hit is the only seed (no blast radius). */
const EMPTY_GRAPH = new InMemoryCodeGraphDataSource([], []);
const emptyGraphFor = (): CodeGraphDataSource => EMPTY_GRAPH;

/**
 * An in-memory schema graph: the impacted code `persists-to` the
 * `requirements.evidenceSnapshot` column (`source: "orm"` — METIS's Prisma ORM).
 * `crossToSchema` follows this edge to name the physical mapped object.
 */
function requirementsSchemaDataSource(): SchemaImpactDataSource {
  const edges = [
    {
      fromSymbolId: SEED_SYMBOL_ID,
      toSymbolId: COLUMN_SYMBOL_ID,
      kind: "persists-to" as SchemaEdgeKind,
    },
  ];
  const symbols = [
    {
      id: COLUMN_SYMBOL_ID,
      kind: "column" as const,
      name: NEW_COLUMN,
      // Physical/mapped identity as the schema graph carries it: `<table>.<column>`.
      qualifiedName: `${REQUIREMENTS_TABLE}.${NEW_COLUMN}`,
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

/** One authoritative column of the live `requirements` table. */
function liveColumn(
  name: string,
  dataType: string,
  opts: { pk?: boolean; nullable?: boolean } = {},
): LiveColumn {
  return { name, dataType, nullable: opts.nullable ?? false, isPrimaryKey: opts.pk ?? false };
}

/**
 * The live `requirements` table as ground truth knows it — a faithful subset of
 * the REAL physical columns (`migration 20260424201859_init` + later coverage /
 * verdict migrations), deliberately WITHOUT `evidenceSnapshot`. Reconciling the
 * new column against this yields `column-not-found`: the column does not exist
 * yet, which is exactly the confirmed gap.
 */
function metisRequirementsLiveIndex(): LiveSchemaIndex {
  const columns = new Map<string, LiveColumn>();
  for (const c of [
    liveColumn("id", "text", { pk: true }),
    liveColumn("projectId", "text"),
    liveColumn("analysisId", "text"),
    liveColumn("type", "text"),
    liveColumn("title", "text"),
    liveColumn("body", "text"),
    liveColumn("priority", "text"),
    liveColumn("labels", "text"),
    liveColumn("coverage", "text", { nullable: true }),
    liveColumn("verdict", "text", { nullable: true }),
    liveColumn("storyPoints", "integer", { nullable: true }),
    liveColumn("createdAt", "datetime"),
    liveColumn("updatedAt", "datetime"),
  ]) {
    // Keyed lowercased, matching LiveSchemaIndex's `norm()` addressing.
    columns.set(c.name.toLowerCase(), c);
  }
  const table: LiveTable = { schema: "public", name: REQUIREMENTS_TABLE, columns };
  return new LiveSchemaIndex([table]);
}

/** The documented affected-schema seam wired with the METIS-derived fixture. */
function affectedSchemaDeps(): RunAffectedSchemaDeps {
  return {
    mapRequirement: async () => ONE_MATCH,
    dataSourceFor: emptyGraphFor,
    schemaDataSourceFor: requirementsSchemaDataSource,
    liveIndex: metisRequirementsLiveIndex(),
  };
}

/**
 * Compute the run's AFFECTED SCHEMA the SAME way the orchestrator does
 * (`computeAffectedSchema` → `computeRunAffectedSchemaContext`), so the rows the
 * gap report is built from are the rows the pipeline itself would produce.
 */
async function computeDogfoodContext() {
  __resetConfigSingleton();
  return computeRunAffectedSchemaContext({
    projectId: PROJECT_ID,
    extraInstructions: NEW_REQUIREMENT_TEXT,
    enabled: true,
    deps: affectedSchemaDeps(),
  });
}

/** Build the real gap report for the schema delta from the real impact rows. */
function gapReportFor(rows: AffectedTableInput[]): GapReport {
  const requirement: GapReportRequirementInput = {
    id: REQ_ID,
    title: "Persist an evidence snapshot per requirement",
    body: "Each requirement must store an evidence snapshot so analysts can audit why it was flagged.",
    priority: "high",
    coverage: "no_evidence",
    verdict: "gap-confirmed",
    storyPoints: null,
    evidenceFindingIds: [],
  };
  return buildGapReport({
    analysisId: ANALYSIS_ID,
    projectId: PROJECT_ID,
    requirements: [requirement],
    findingsById: new Map<string, GapReportFindingInput>(),
    // No cross-project consumers enumerated for a single-project dogfood run.
    schemaImpactByRequirementId: new Map([[REQ_ID, { rows, consumers: [] }]]),
  });
}

/** A minimal (empty) traceability matrix so the report serializer can stitch. */
function emptyMatrix(): TraceabilityMatrix {
  return { analysisId: ANALYSIS_ID, projectId: PROJECT_ID, testsDetection: "heuristic", rows: [] };
}

// ── Pipeline harness (mirrors #826 `verdict-schema-pipeline.test.ts`) ─────────

interface SynthRequirement {
  title: string;
  body: string;
  priority: string;
  evidenceFindingIndexes: number[];
}

const DEFAULT_REQUIREMENTS = [
  // The document requirement the per-claim retrieval gate (#773) matches the
  // search query against — it shares the significant terms `persist` + `snapshot`
  // with the HEALTHY_SCRIPT query (`evidence`/`requirement` are stopwords).
  { id: "REQ-001", text: "Each requirement must persist an evidence snapshot for audit." },
];
const DEFAULT_SYNTHESIS: SynthRequirement[] = [
  { title: "Evidence snapshot", body: "b", priority: "high", evidenceFindingIndexes: [0] },
];

const state: {
  documentRequirements: Array<{ id: string; text: string }>;
  synthesisRequirements: SynthRequirement[];
} = {
  documentRequirements: [...DEFAULT_REQUIREMENTS],
  synthesisRequirements: [...DEFAULT_SYNTHESIS],
};

/**
 * Symbols the project's code graph ACTUALLY contains — a `search_code_graph` for
 * "persist requirement" HITS, so the #773 retrieval gate is HEALTHY and would let
 * the gap through, which is what makes the schema behaviour observable.
 */
const INDEXED_SYMBOLS = [
  {
    qualifiedName:
      "server/src/lib/requirements/evidence-snapshot-store.ts::persistEvidenceSnapshot",
    kind: "function",
    filePath: "server/src/lib/requirements/evidence-snapshot-store.ts",
    startLine: 10,
    endLine: 60,
    language: "typescript",
  },
];

const persistedAgentResults: Array<Record<string, unknown>> = [];
const persistedRequirements: Array<Record<string, unknown>> = [];
const persistedEnhancements: Array<Record<string, unknown>> = [];

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    // #855 — `databaseConnection.count` / `codeSymbol.count` / `codeEdge.count`
    // back `hasSchemaData` (#854), the resolver's schema-data probe. This suite
    // drives the setting explicitly via `runPipeline`'s 6th arg (`"on"`), so
    // `hasSchemaData` never needs to resolve `true` — an explicit `on` is
    // unconditionally enabled regardless of this probe.
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      findMany: vi.fn(async (args?: { where?: { qualifiedName?: { contains?: string } } }) => {
        const needle = args?.where?.qualifiedName?.contains;
        if (!needle) return INDEXED_SYMBOLS;
        const tokens = needle
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 3);
        if (tokens.length === 0) return INDEXED_SYMBOLS;
        return INDEXED_SYMBOLS.filter((s) => {
          const hay = s.qualifiedName.toLowerCase();
          return tokens.every((t) => hay.includes(t));
        });
      }),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    codeEdge: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) => {
        if (where.agentKey === "document") {
          return { output: JSON.stringify({ requirements: state.documentRequirements }) };
        }
        return { status: "completed" };
      }),
    },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
  },
}));

function flattenPersistedFindings(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of persistedAgentResults) {
    const output = r.output as { findings?: AgentFindingPayload[] } | null;
    for (const [i, f] of (output?.findings ?? []).entries()) {
      out.push({ ...f, agentKey: r.agentKey, findingId: `f_${r.agentKey}_${i}` });
    }
  }
  return out;
}

/**
 * #847 complement — the snapshot the REACHABLE producer + getGapReport read
 * through. Carries the schema-changing requirement so the real producer crosses
 * it and the gap report's `databaseChanges` becomes reachable WITHOUT injecting
 * `loadSchemaImpact` (the false-green #847 kills). The orchestrator never reads
 * `getAnalysisSnapshot`, so adding it here does not affect the pipeline tests.
 */
function reachableSnapshot() {
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
        title: "Persist an evidence snapshot per requirement",
        body: NEW_REQUIREMENT_TEXT,
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
  };
}

vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
  getAnalysisSnapshot: vi.fn(async () => reachableSnapshot()),
  getStructuredRequirements: vi.fn(async () => null),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => undefined),
  markAnalysisFailed: vi.fn(async () => undefined),
  persistAgentResult: vi.fn(async (input: Record<string, unknown>) => {
    persistedAgentResults.push(input);
    return { id: "ar_1", agentKey: input.agentKey, findingIds: [] };
  }),
  persistAnalysisEnhancement: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    persistedEnhancements.push(patch);
  }),
  persistAnalysisCapability: vi.fn(async () => undefined),
  persistAnalysisAffectedCode: vi.fn(async () => undefined),
  persistAnalysisDatabaseAware: vi.fn(async () => undefined),
  persistAnalysisEscalation: vi.fn(async () => undefined),
  persistRequirements: vi.fn(async (input: Record<string, unknown>) => {
    persistedRequirements.push(input);
    return ["rq_1"];
  }),
  persistCrossDocFindings: vi.fn(async () => undefined),
  readFlattenedFindings: vi.fn(async () => flattenPersistedFindings()),
}));

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("./synthesis.js", () => ({
  runSynthesis: vi.fn(async () => ({
    output: { summary: "s", requirements: state.synthesisRequirements },
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
  canCreateTickets: vi.fn(async () => ({ allowed: true, pendingCount: 0, rejectedCount: 0 })),
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

const DOC_ANSWER = JSON.stringify({ summary: "docs", findings: [], notes: [] });

/**
 * The code agent's final answer: a CONFIRMED GAP for the evidence-snapshot
 * feature. It names the `requirements` table (natural narrative) but NOT the
 * physical column identifier `evidenceSnapshot` — so the #826 schema gate, which
 * treats a column-level object as relied-on ONLY when BOTH the table AND the
 * column name appear, leaves this feature-gap verdict standing.
 */
const GAP_ANSWER = JSON.stringify({
  summary: "investigated",
  findings: [
    {
      requirementId: "REQ-001",
      verdict: "gap-confirmed",
      category: "architecture",
      severity: "high",
      title: "No evidence snapshot is persisted for requirements (REQ-001)",
      body:
        "The requirements persistence path stores no evidence snapshot per requirement, so an " +
        "analyst cannot audit why a requirement was flagged. A new column must be added to the " +
        "requirements table to hold the audit array.",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

/**
 * The SAME confirmed gap, but this finding CITES the unreconciled physical column
 * `evidenceSnapshot` by name — so it relies on an object the live schema cannot
 * support (`column-not-found`) and the #826 schema gate caps it, proving the
 * mapped column identity flows all the way into the verdict gate.
 */
const GAP_ANSWER_NAMES_COLUMN = JSON.stringify({
  summary: "investigated",
  findings: [
    {
      requirementId: "REQ-001",
      verdict: "gap-confirmed",
      category: "architecture",
      severity: "high",
      title: "Missing requirements.evidenceSnapshot column (REQ-001)",
      body:
        "The requirements table has no evidenceSnapshot column; a new column " +
        "requirements.evidenceSnapshot must be added to store the audit array.",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

/** Healthy retrieval: the search HITS a real symbol AND bears on REQ-001 (shares
 * `persist` + `snapshot`), so #773 alone would confirm the gap. */
const HEALTHY_SCRIPT = [
  DOC_ANSWER,
  JSON.stringify({ tool: "search_code_graph", query: "persist evidence snapshot" }),
  GAP_ANSWER,
];

/** Healthy retrieval, but the finding names the physical column (schema-gate case). */
const HEALTHY_SCRIPT_NAMES_COLUMN = [
  DOC_ANSWER,
  JSON.stringify({ tool: "search_code_graph", query: "persist evidence snapshot" }),
  GAP_ANSWER_NAMES_COLUMN,
];

/** Degraded retrieval: every tool call is malformed → the run cannot confirm absence. */
const DEGRADED_SCRIPT = [
  DOC_ANSWER,
  JSON.stringify({ tool: "search_code_symbols", limit: 5 }), // no `query` → Error
  JSON.stringify({ tool: "read_file_slice", startLine: 1 }), // no `filePath` → Error
  GAP_ANSWER,
];

function makeProvider(script: string[]) {
  let n = 0;
  return {
    chat: vi.fn(async () => {
      const content = script[Math.min(n, script.length - 1)] ?? GAP_ANSWER;
      n += 1;
      return {
        content,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        provider: "bedrock" as const,
      };
    }),
  };
}

async function runPipeline(script: string[]): Promise<void> {
  // #855 — the bare env flag is now only `computeRunAffectedSchemaContext`'s
  // FALLBACK; kept set here for documentation parity, but the explicit `"on"`
  // 6th arg below is what actually governs the resolved decision.
  process.env.ANALYSIS_AFFECTED_SCHEMA_MAPPING = "true";
  __resetConfigSingleton();

  const orch = new AnalysisOrchestrator({
    provider: makeProvider(script) as never,
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
    ["document", "code"],
    {
      projectId: PROJECT_ID,
      startedById: "u1",
      model: "test-model",
      // The operator's new requirement — drives the deterministic AFFECTED SCHEMA
      // extractor (the injected mapper then seeds the crossing).
      extraInstructions: NEW_REQUIREMENT_TEXT,
    },
    // #855 — explicit per-project override so the resolved decision is
    // deterministic regardless of the (fallback-only) env flag / schema-data probe.
    "on",
  );
}

const codeFindings = (): AgentFindingPayload[] =>
  (
    (persistedAgentResults.find((r) => r.agentKey === "code")?.output ?? {}) as {
      findings?: AgentFindingPayload[];
    }
  ).findings ?? [];

const requirementVerdicts = (): unknown[] =>
  (persistedRequirements[0]?.verdicts as unknown[]) ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  persistedAgentResults.length = 0;
  persistedRequirements.length = 0;
  persistedEnhancements.length = 0;
  state.documentRequirements = [...DEFAULT_REQUIREMENTS];
  state.synthesisRequirements = [...DEFAULT_SYNTHESIS];
  // Isolate the tool loop from the passive fused-code seed (#729) so the gap is
  // confirmed by the REAL search — matching the #773 healthy fixture.
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AFFECTED_SCHEMA_MAPPING;
  __resetConfigSingleton();
});

// ── AC1 / AC2 — the affected-schema known answer (mapped table + DDL) ─────────

describe("#832 dogfood — affected schema names the mapped physical table, not the model", () => {
  it("maps the Requirement model to the physical `requirements` table (AC1)", async () => {
    const { rows } = await computeDogfoodContext();

    expect(rows).toHaveLength(1);
    // The KNOWN ANSWER: the physical mapped name, never the Prisma model name.
    expect(rows[0]?.tableName).toBe("requirements");
    expect(rows[0]?.tableName).not.toBe("Requirement");
    expect(rows[0]?.objectKind).toBe("column");
    expect(rows[0]?.columnName).toBe("evidenceSnapshot");
  });

  it("suggests plausible, TEXT-ONLY ALTER TABLE … ADD COLUMN DDL for the new column (AC2)", async () => {
    const ctx = await computeDogfoodContext();
    const row = ctx.rows[0];

    expect(row?.changeKind).toBe("add-column");
    expect(row?.suggestedDdl).toBe(EXPECTED_DDL);
    expect(row?.suggestedDdl).toMatch(/^ALTER TABLE requirements ADD COLUMN evidenceSnapshot /);
    // The DDL targets the mapped table, never the model name.
    expect(row?.suggestedDdl).not.toMatch(/ALTER TABLE Requirement\b/);
    // The rendered block carries the safety label — the DDL is never executed.
    expect(ctx.block).toContain("TEXT ONLY");
    expect(ctx.block).toContain("never executed");
  });

  it("reconciles the new column as column-not-found against the live requirements table (AC3)", async () => {
    const { rows } = await computeDogfoodContext();

    // The `requirements` table exists in the live schema, but `evidenceSnapshot`
    // does not yet — the reconciliation confirms the gap is real.
    expect(rows[0]?.reconciliation).toBe("column-not-found");
    expect(rows[0]?.confidence).toBeCloseTo(0.4);
  });
});

// ── AC2 / AC3 — the gap report databaseChanges section ───────────────────────

describe("#832 dogfood — gap report carries the databaseChanges section for the delta", () => {
  it("classifies the additive column as expanding, column-not-found, no cross-project escalation (AC3)", async () => {
    const { rows } = await computeDogfoodContext();
    const report = gapReportFor(rows);
    const req = report.requirements[0];

    expect(req?.databaseChanges).toBeDefined();
    expect(req?.databaseChanges).toHaveLength(1);
    const change = req?.databaseChanges?.[0];
    expect(change?.tableName).toBe("requirements");
    expect(change?.columnName).toBe("evidenceSnapshot");
    expect(change?.changeKind).toBe("add-column");
    expect(change?.reconciliation).toBe("column-not-found");
    // 3a (#830): an additive column with no NOT NULL is expanding, not breaking.
    expect(change?.riskClass).toBe("expanding");
    expect(change?.suggestedDdl).toBe(EXPECTED_DDL);
    // No cross-project consumers → identity unresolved, never a spurious CRITICAL.
    expect(change?.identityResolved).toBe(false);
    expect(change?.crossProjectBreaking).toBeUndefined();
  });

  it("renders the suggested DDL under the review-only-never-executed label (AC2)", async () => {
    const { rows } = await computeDogfoodContext();
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReportFor(rows),
      matrix: emptyMatrix(),
    });

    expect(md).toContain("### Database changes (suggested DDL — review only, never executed)");
    // The suggested DDL is rendered inert (the `<type>` placeholder is HTML-escaped
    // by the sanitizing serializer); assert the mapped-table prefix crossed through.
    expect(md).toContain("ALTER TABLE requirements ADD COLUMN evidenceSnapshot");
    // A column-not-found object is speculative → surfaced under the unverified head.
    expect(md).toContain("#### Unverified against live schema");
    // #991 — gap-report bullets render the shared human label, not the raw enum.
    expect(md).toContain("risk: Additive");
  });
});

// ── AC4 — the verdict follows #773 discipline through the REAL pipeline ───────

describe("#832 dogfood — requirement verdict is honest through the real pipeline", () => {
  it("confirms the schema gap with healthy retrieval (AC4)", async () => {
    await runPipeline(HEALTHY_SCRIPT);

    const findings = codeFindings();
    expect(findings).toHaveLength(1);
    // Healthy retrieval + a genuine feature gap → the gap IS confirmed. The
    // column-not-found evidence is present, but this feature-gap finding does not
    // cite the physical column, so the #826 schema gate leaves it standing.
    expect(findings[0]?.verdict).toBe("gap-confirmed");
    expect(findings[0]?.severity).toBe("high");
    expect(requirementVerdicts()).toEqual(["gap-confirmed"]);
  });

  it("cannot verify the gap when retrieval is degraded (AC4)", async () => {
    await runPipeline(DEGRADED_SCRIPT);

    const findings = codeFindings();
    expect(findings).toHaveLength(1);
    // Retrieval failed → an absence claim cannot be confirmed, so the honest
    // verdict is could-not-verify (never a fabricated gap), mirroring #773.
    expect(findings[0]?.verdict).toBe("could-not-verify");
    expect(findings[0]?.verificationStatus).toBe("could-not-verify");
    expect(findings[0]?.title).toMatch(/^Could not verify:/);
    expect(requirementVerdicts()).toEqual(["could-not-verify"]);
  });

  it("caps the verdict when the finding cites the unreconciled physical column (#826 schema gate)", async () => {
    await runPipeline(HEALTHY_SCRIPT_NAMES_COLUMN);

    const findings = codeFindings();
    expect(findings).toHaveLength(1);
    // Retrieval was HEALTHY (so #773 alone would confirm), but this finding relies
    // on `requirements.evidenceSnapshot`, which the live schema cannot support
    // (column-not-found) → the #826 schema gate caps it at could-not-verify. This
    // proves the mapped physical column name flows end-to-end into the verdict.
    expect(findings[0]?.verdict).toBe("could-not-verify");
    expect(findings[0]?.title).toMatch(/^Could not verify:/);
    expect(findings[0]?.severity).toBe("info");
    expect(requirementVerdicts()).toEqual(["could-not-verify"]);
  });
});

// ── #847 complement — the SAME known answer through the REACHABLE producer ────

/**
 * Single-project stub Prisma for the REAL `enumerateSchemaConsumers`: the project
 * has no workspace and no linked resource, so identity is unresolved (no
 * cross-project consumers) — the correct answer for a single-project dogfood.
 *
 * #856 — also serves the #854 resolver's per-project setting read
 * (`project.findUnique`) and schema-data probe (`databaseConnection.count` /
 * `codeSymbol.count` / `codeEdge.count`). `databaseAwareAnalysisSetting`
 * defaults to `"on"` so the known-answer test is deterministic regardless of
 * `hasSchemaData` — mirroring the run-path dogfood's explicit `"on"` 6th arg
 * above (`runPipeline`).
 */
function singleProjectStubPrisma(opts: { databaseAwareAnalysisSetting?: string } = {}) {
  return {
    project: {
      findUnique: vi.fn(async () => ({
        workspaceId: null,
        databaseAwareAnalysis: opts.databaseAwareAnalysisSetting ?? "on",
      })),
    },
    databaseConnection: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    codeSymbol: { count: vi.fn(async () => 0) },
    codeEdge: { count: vi.fn(async () => 0) },
    schemaObjectIdentity: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    schemaUsageClassification: { findMany: vi.fn(async () => []) },
    databaseResource: { findMany: vi.fn(async () => []) },
  } as never;
}

describe("#847/#856 dogfood complement — the known answer is REACHABLE via the real producer", () => {
  afterEach(() => {
    delete process.env[SCHEMA_IMPACT_FLAG];
    __resetConfigSingleton();
  });

  it("getGapReport through resolveGapReportDeps (project ON, NO injected loadSchemaImpact) carries the databaseChanges", async () => {
    // #856 — the legacy env flag no longer gates this path (dead weight on the
    // resolver's decision); the deterministic gate is the project's explicit
    // "on" setting baked into singleProjectStubPrisma() below.
    __resetConfigSingleton();

    // The route's exact wiring — resolveGapReportDeps builds the REAL producer;
    // we inject only its I/O seams (the METIS-derived schema fixture + stub
    // Prisma), never a hand-built `loadSchemaImpact`.
    const deps = await resolveGapReportDeps(PROJECT_ID, {
      mapRequirement: async () => ONE_MATCH,
      dataSourceFor: emptyGraphFor,
      schemaDataSourceFor: requirementsSchemaDataSource,
      liveIndexFor: () => metisRequirementsLiveIndex(),
      prisma: singleProjectStubPrisma(),
    });
    expect(deps.loadSchemaImpact).toBeTypeOf("function");
    expect(deps.databaseAware).toEqual({
      setting: "on",
      enabled: true,
      ran: false, // no connected DatabaseConnection / schema graph in this fixture
      reason: "skipped-no-schema-data",
    });

    const report = await getGapReport(ANALYSIS_ID, deps);
    const req = report?.requirements.find((r) => r.requirementId === REQ_ID);

    // The KNOWN ANSWER reaches the report unchanged — the mapped physical table
    // `requirements`, the new column, column-not-found, and the TEXT-ONLY DDL.
    // `enabled: true` alone gates `loadSchemaImpact`; `ran` above is only the
    // resolver's OWN best-effort data-presence signal and does not block the
    // deterministic crossing this producer performs from its injected fixture.
    expect(req?.databaseChanges).toHaveLength(1);
    const change = req?.databaseChanges?.[0];
    expect(change?.tableName).toBe(REQUIREMENTS_TABLE);
    expect(change?.columnName).toBe(NEW_COLUMN);
    expect(change?.changeKind).toBe("add-column");
    expect(change?.reconciliation).toBe("column-not-found");
    expect(change?.suggestedDdl).toBe(EXPECTED_DDL);
    // Single-project run → identity unresolved, no cross-project escalation.
    expect(change?.identityResolved).toBe(false);
    expect(change?.crossProjectBreaking).toBeUndefined();
  });

  it("project OFF ⇒ the same report carries NO databaseChanges (byte-identical to today)", async () => {
    delete process.env[SCHEMA_IMPACT_FLAG];
    __resetConfigSingleton();

    const deps = await resolveGapReportDeps(PROJECT_ID, {
      mapRequirement: async () => ONE_MATCH,
      dataSourceFor: emptyGraphFor,
      schemaDataSourceFor: requirementsSchemaDataSource,
      liveIndexFor: () => metisRequirementsLiveIndex(),
      prisma: singleProjectStubPrisma({ databaseAwareAnalysisSetting: "off" }),
    });
    const report = await getGapReport(ANALYSIS_ID, deps);
    const req = report?.requirements.find((r) => r.requirementId === REQ_ID);
    expect(req).toBeDefined();
    expect(req?.databaseChanges).toBeUndefined();
    expect(report?.databaseAware).toEqual({
      setting: "off",
      enabled: false,
      ran: false,
      reason: "off",
    });
  });
});
