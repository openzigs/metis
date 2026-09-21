/**
 * Issue #826 (Epic #820 Phase 1) — schema-impact reconciliation feeds the
 * three-state requirement verdict (#773) through the REAL pipeline.
 *
 * Driven end-to-end through `AnalysisOrchestrator.runPipeline`: the fake MODEL is
 * scripted at the provider boundary and the run's AFFECTED SCHEMA reconciliation is
 * supplied through the documented `affectedSchemaMapping` dependency seam (#823/#824)
 * — a real `LiveSchemaIndex` + in-memory schema graph, exactly the boundary the
 * production code crosses. NOTHING private is stubbed (the verdict gate, the agentic
 * pass, and the reconciliation are all the real thing) — stubbing those is the
 * anti-pattern that hid P0 #750.
 *
 * Two scenarios, one per acceptance criterion:
 *   1. A finding proposing DDL against a table ABSENT from the live schema is
 *      capped at `could-not-verify` — even though healthy retrieval would have
 *      confirmed the gap.
 *   2. The SAME finding against a table the live schema HAS (matched) keeps its
 *      `gap-confirmed` verdict — a change that caps everything is honest and
 *      worthless (the #773 scenario-2 bar), so fully-reconciled evidence must not
 *      downgrade.
 *
 * Updated for #855 (Epic #852 Phase 2b): the run path now gates
 * `computeAffectedSchema` on the RESOLVED database-aware-analysis decision
 * (#854), not the bare `ANALYSIS_AFFECTED_SCHEMA_MAPPING` flag directly — the
 * flag is now only `computeRunAffectedSchemaContext`'s fallback for callers
 * that pass no resolved `enabled`. `runPipeline` here threads an explicit
 * per-project setting (`"on"` / `"off"`) as the 6th arg so the "schema mapping
 * is/isn't active" scenarios stay deterministic regardless of the (now
 * fallback-only) env flag.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { AgentFindingPayload, AnalysisCapability, SchemaEdgeKind } from "@metis/shared";
import { LiveSchemaIndex, type LiveTable } from "../impact-analysis/live-schema-ingest.js";
import type { SchemaImpactDataSource } from "../impact-analysis/schema-impact.js";
import { InMemoryCodeGraphDataSource } from "../impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import type { RunAffectedSchemaDeps } from "./affected-schema-context.js";

const ANALYSIS_ID = "an_826";
const PROJECT_ID = "pr_826";

/** The physical table the operator's new requirement implies a DDL change to. */
const AFFECTED_TABLE = "drift_severity";

interface SynthRequirement {
  title: string;
  body: string;
  priority: string;
  evidenceFindingIndexes: number[];
}

const DEFAULT_REQUIREMENTS = [
  { id: "REQ-001", text: "Drift severity must be classified from a commit-SHA baseline." },
];
const DEFAULT_SYNTHESIS: SynthRequirement[] = [
  { title: "Drift severity", body: "b", priority: "high", evidenceFindingIndexes: [0] },
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
 * "drift severity" HITS (so the #773 retrieval gate is HEALTHY and would let the
 * gap through), which is exactly what makes the schema cap observable.
 */
const INDEXED_SYMBOLS = [
  {
    qualifiedName: "server/src/drift/severity.ts::computeSeverity",
    kind: "function",
    filePath: "server/src/drift/severity.ts",
    startLine: 10,
    endLine: 42,
    language: "typescript",
  },
];

const persistedAgentResults: Array<Record<string, unknown>> = [];
const persistedRequirements: Array<Record<string, unknown>> = [];
const persistedCapabilities: AnalysisCapability[] = [];
const persistedEnhancements: Array<Record<string, unknown>> = [];

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    // #855 — `databaseConnection.count` / `codeSymbol.count` / `codeEdge.count`
    // back `hasSchemaData` (#854), the resolver's schema-data probe. This suite
    // drives the setting explicitly via the `runPipeline` helper's 6th arg
    // (`"on"`/`"off"`), so `hasSchemaData` never needs to resolve `true` — an
    // explicit `on` is unconditionally enabled regardless of this probe.
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

vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
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
  persistAnalysisCapability: vi.fn(async (_id: string, capability: AnalysisCapability) => {
    persistedCapabilities.push(capability);
  }),
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
 * The code agent's final answer: a CONFIRMED GAP whose body proposes DDL against
 * the `drift_severity` table (the object the deterministic schema impact flags).
 */
const GAP_ANSWER = JSON.stringify({
  summary: "investigated",
  findings: [
    {
      requirementId: "REQ-001",
      verdict: "gap-confirmed",
      category: "architecture",
      severity: "high",
      title: "No commit-SHA baselining for drift severity (REQ-001)",
      body: `The codebase has no commit-SHA baseline for drift severity, and the ${AFFECTED_TABLE} audit table it would persist to does not exist. A new ${AFFECTED_TABLE} table must be created.`,
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

/** Healthy retrieval: the search HITS, so #773 alone would confirm the gap. */
const HEALTHY_SCRIPT = [
  DOC_ANSWER,
  JSON.stringify({ tool: "search_code_graph", query: "drift severity" }),
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

// ---- Affected-schema dependency seam (#823/#824) ---------------------------

/** One mapped code symbol whose id seeds the schema crossing. */
const ONE_MATCH: RequirementCodeMatch[] = [
  {
    codeSymbolId: "seed-1",
    filePath: "server/src/drift/severity.ts",
    qualifiedName: "computeSeverity",
    startLine: 10,
    endLine: 42,
    confidence: 0.92,
  },
];

/** Empty code graph → the mapper's direct hit is the only seed (no blast radius). */
const EMPTY_GRAPH = new InMemoryCodeGraphDataSource([], []);
const emptyGraphFor = (): CodeGraphDataSource => EMPTY_GRAPH;

/** An in-memory schema graph: `seed-1` writes the `drift_severity` table. */
function schemaDataSourceFor(): SchemaImpactDataSource {
  const edges = [
    { fromSymbolId: "seed-1", toSymbolId: "t-audit", kind: "writes" as SchemaEdgeKind },
  ];
  const symbols = [
    {
      id: "t-audit",
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

/** A live schema that HAS `drift_severity` → the object reconciles `matched`. */
function liveIndexWithTable(): LiveSchemaIndex {
  const tables: LiveTable[] = [{ schema: "public", name: AFFECTED_TABLE, columns: new Map() }];
  return new LiveSchemaIndex(tables);
}

/** An empty live schema → `drift_severity` reconciles `table-not-found`. */
function emptyLiveIndex(): LiveSchemaIndex {
  return new LiveSchemaIndex([]);
}

function affectedSchemaDeps(liveIndex: LiveSchemaIndex): RunAffectedSchemaDeps {
  return {
    mapRequirement: async () => ONE_MATCH,
    dataSourceFor: emptyGraphFor,
    schemaDataSourceFor,
    liveIndex,
  };
}

async function runPipeline(
  script: string[],
  opts: { liveIndex: LiveSchemaIndex; schemaEnabled?: boolean },
): Promise<void> {
  // #855 — the bare env flag is now only `computeRunAffectedSchemaContext`'s
  // FALLBACK (reached only when no resolved `enabled` is threaded through);
  // kept set here for documentation parity with pre-#855 behaviour, but the
  // explicit `databaseAwareAnalysisSetting` 6th arg below is what actually
  // governs the resolved decision in this suite.
  process.env.ANALYSIS_AFFECTED_SCHEMA_MAPPING = opts.schemaEnabled === false ? "false" : "true";
  __resetConfigSingleton();

  const orch = new AnalysisOrchestrator({
    provider: makeProvider(script) as never,
    retrieve: async () => [],
    knowledge: {} as never,
    affectedSchemaMapping: affectedSchemaDeps(opts.liveIndex),
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
      // Non-empty → the deterministic AFFECTED SCHEMA extractor produces a candidate
      // (the injected mapper then seeds the crossing). This is the operator's new
      // requirement — a DDL change against the audit table.
      extraInstructions: `Persist drift severity results to a new ${AFFECTED_TABLE} audit table.`,
    },
    // #855 — explicit per-project override so the resolved decision is
    // deterministic regardless of the (fallback-only) env flag / schema-data probe.
    opts.schemaEnabled === false ? "off" : "on",
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
  persistedCapabilities.length = 0;
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

describe("#826 — a DDL claim against a table absent from the live schema is could-not-verify", () => {
  it("caps the otherwise-confirmed gap at could-not-verify (AC1)", async () => {
    await runPipeline(HEALTHY_SCRIPT, { liveIndex: emptyLiveIndex() });

    const findings = codeFindings();
    expect(findings).toHaveLength(1);
    // Retrieval was HEALTHY (the search hit) so #773 alone would confirm the gap —
    // it is the SCHEMA gate that must weaken it, because the live schema has no
    // `drift_severity` table to support the proposed DDL.
    expect(findings[0]?.verdict).toBe("could-not-verify");
    // The assertive headline is corrected and severity dropped (the #773 flattening).
    expect(findings[0]?.title).toMatch(/^Could not verify:/);
    expect(findings[0]?.severity).toBe("info");
  });

  it("rolls the requirement up to could-not-verify, never a gap (AC1)", async () => {
    await runPipeline(HEALTHY_SCRIPT, { liveIndex: emptyLiveIndex() });

    expect(requirementVerdicts()).toEqual(["could-not-verify"]);
  });
});

describe("#826 — fully-reconciled schema evidence does NOT downgrade the verdict", () => {
  it("keeps the gap-confirmed verdict when the table exists in the live schema (AC2)", async () => {
    await runPipeline(HEALTHY_SCRIPT, { liveIndex: liveIndexWithTable() });

    const findings = codeFindings();
    expect(findings).toHaveLength(1);
    // The live schema HAS `drift_severity` → matched → the schema gate is a no-op,
    // and the healthy-retrieval gap stands. A change that capped this too would be
    // honest and worthless (the #773 scenario-2 bar).
    expect(findings[0]?.verdict).toBe("gap-confirmed");
    expect(findings[0]?.severity).toBe("high");
    expect(requirementVerdicts()).toEqual(["gap-confirmed"]);
  });

  it("is inert when the feature flag is OFF — the gap stands even without reconciliation", async () => {
    await runPipeline(HEALTHY_SCRIPT, { liveIndex: emptyLiveIndex(), schemaEnabled: false });

    // Flag OFF ⇒ no AFFECTED SCHEMA rows ⇒ empty evidence ⇒ the schema gate never
    // runs, so behaviour is byte-identical to pre-#826 (the gap is confirmed).
    expect(codeFindings()[0]?.verdict).toBe("gap-confirmed");
    expect(requirementVerdicts()).toEqual(["gap-confirmed"]);
  });
});
