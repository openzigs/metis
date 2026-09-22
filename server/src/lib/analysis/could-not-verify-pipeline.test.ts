/**
 * Issue #773 — "could not retrieve it" must never be reported as "it does not exist".
 *
 * Driven end-to-end through the REAL pipeline (`AnalysisOrchestrator.runPipeline`):
 * nothing private is stubbed — the fake MODEL is scripted at the provider boundary
 * and the assertions are made on what crossed real boundaries (what the service
 * layer was told to persist for the findings, the requirements, and the capability
 * record). Stubbing requirement extraction or the agentic pass is exactly the
 * anti-pattern that hid P0 #750, #769 and #774.
 *
 * Three scenarios, one per acceptance criterion:
 *   1. DEGRADED retrieval  → ZERO `gap-confirmed`; everything `could-not-verify`;
 *      `code-retrieval-degraded` on the capability record.
 *   2. HEALTHY retrieval + a genuinely missing feature → the gap IS still confirmed.
 *      (The anti-regression bar: a fix that marks everything `could-not-verify` is
 *      honest and worthless.)
 *   3. BUDGET-STARVED loop → `could-not-verify`, never a gap, even for a requirement
 *      the agent claims is missing.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { AgentFindingPayload, AnalysisCapability } from "@metis/shared";

const ANALYSIS_ID = "an_773";
const PROJECT_ID = "pr_773";

/**
 * Requirements the document agent "extracted", and the synthesis output that maps
 * them to the code agent's findings. Both are driven from here so a scenario can
 * run at PRODUCTION SCALE (20-30 requirements) instead of the single-requirement
 * toy case, which is the easiest point in the threshold's whole domain.
 */
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
  // Grounded in the code agent's single finding (flat index 0 — the document agent
  // emits none in this fixture)…
  { title: "Drift severity", body: "b", priority: "high", evidenceFindingIndexes: [0] },
  // …and one the code agent never produced a finding for at all (the
  // budget-starvation shape: the agent never got to it).
  { title: "Never investigated", body: "b", priority: "medium", evidenceFindingIndexes: [] },
];

const state: {
  documentRequirements: Array<{ id: string; text: string }>;
  synthesisRequirements: SynthRequirement[];
} = {
  documentRequirements: [...DEFAULT_REQUIREMENTS],
  synthesisRequirements: [...DEFAULT_SYNTHESIS],
};

/**
 * Symbols the project's code graph ACTUALLY contains. A search whose `contains`
 * filter matches one of these comes back as a HIT; anything else comes back as a
 * well-formed EMPTY result (`resultCount: 0`) — the tool worked, the code is
 * genuinely not there. That distinction is the whole point of #773's second fix,
 * and it can only be exercised through a code-graph mock that can say "no".
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
  {
    qualifiedName: "server/src/drift/baseline.ts::captureCommitShaBaseline",
    kind: "function",
    filePath: "server/src/drift/baseline.ts",
    startLine: 5,
    endLine: 30,
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
    // #855 — back `hasSchemaData` (#854), the database-aware resolver's
    // schema-data probe. This suite never sets a per-project override, so the
    // resolved setting defaults to `auto`; 0 counts resolve to "no schema data"
    // (schema mapping stays a no-op, matching pre-#855 default-off behaviour).
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      // The REAL `search_code_graph` tool runs against this: it filters by
      // `qualifiedName: { contains: query }`, so a query for something the codebase
      // does not have returns [] → the tool emits its structured EMPTY result.
      findMany: vi.fn(async (args?: { where?: { qualifiedName?: { contains?: string } } }) => {
        const needle = args?.where?.qualifiedName?.contains;
        if (!needle) return INDEXED_SYMBOLS;
        // Token-wise containment, standing in for the real index's matching: a
        // query for something the codebase HAS comes back with it; a query for
        // something it genuinely LACKS comes back empty.
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

/**
 * `readFlattenedFindings` is the real read path's shape — here it replays whatever
 * the run actually persisted, so the synthesis-time verdict roll-up is computed
 * from the SAME findings the agent produced (not from a hand-written fixture that
 * could disagree with the pipeline).
 */
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
    return ["rq_1", "rq_2"];
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

/** The code agent's final answer: it says the requirement is a CONFIRMED GAP. */
const GAP_ANSWER = JSON.stringify({
  summary: "investigated",
  findings: [
    {
      requirementId: "REQ-001",
      verdict: "gap-confirmed",
      category: "architecture",
      severity: "high",
      title: "No evidence found for commit-SHA baselining (REQ-001)",
      body: "The codebase has no commit-SHA baseline for drift severity. This must be built.",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

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

/**
 * The PASSIVE fused-symbol seed (#729): it hands the code agent symbol context —
 * and therefore CITATION PROVENANCE — without any search having run. Injected only
 * by the false-positive scenario, which needs exactly that: a run where every
 * search failed but a citation still grounds.
 */
const fusedCodeDeps = {
  searcher: {
    search: async () => [
      {
        symbolId: "sym_1",
        filePath: "server/src/drift/severity.ts",
        name: "computeSeverity",
        kind: "function",
        score: 0.9,
        snippet: "export function computeSeverity() {}",
      },
    ],
  },
  lineLookup: {
    resolve: async () =>
      new Map([
        ["sym_1", { filePath: "server/src/drift/severity.ts", startLine: 10, endLine: 42 }],
      ]),
  },
};

/**
 * A DOCUMENT knowledge base that always answers. `search_knowledge` is in the code
 * agent's tool set, so a code pass can rack up "successful retrievals" that never
 * touched code — the laundering path this fixture exists to drive.
 */
const knowledgeService = {
  search: async () => ({
    hits: [{ filename: "requirements.md", position: 1, score: 0.91, text: "The tenant quota…" }],
  }),
};

async function runPipeline(
  script: string[],
  opts: { withFusedSeed?: boolean; withKnowledge?: boolean } = {},
): Promise<void> {
  const orch = new AnalysisOrchestrator({
    provider: makeProvider(script) as never,
    retrieve: async () => [],
    knowledge: (opts.withKnowledge ? knowledgeService : {}) as never,
    ...(opts.withFusedSeed ? { fusedCode: fusedCodeDeps as never } : {}),
  });
  await (
    orch as unknown as {
      runPipeline: (
        analysisId: string,
        projectName: string,
        projectDescription: string,
        agentKeys: string[],
        opts: Record<string, unknown>,
      ) => Promise<void>;
    }
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", ["document", "code"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
  });
}

const codeFindings = (): AgentFindingPayload[] =>
  (
    (persistedAgentResults.find((r) => r.agentKey === "code")?.output ?? {}) as {
      findings?: AgentFindingPayload[];
    }
  ).findings ?? [];

const requirementVerdicts = (): unknown[] =>
  (persistedRequirements[0]?.verdicts as unknown[]) ?? [];

const capability = (): AnalysisCapability | undefined =>
  persistedCapabilities[persistedCapabilities.length - 1];

beforeEach(() => {
  vi.clearAllMocks();
  persistedAgentResults.length = 0;
  persistedRequirements.length = 0;
  persistedCapabilities.length = 0;
  persistedEnhancements.length = 0;
  state.documentRequirements = [...DEFAULT_REQUIREMENTS];
  state.synthesisRequirements = [...DEFAULT_SYNTHESIS];
  // Isolate the tool loop from the passive fused-code seed (#729) — a separate,
  // already-tested path that would otherwise supply citation provenance for free.
  // The false-positive scenario turns it back ON deliberately.
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AGENTIC_MAX_TURNS;
  delete process.env.ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT;
  __resetConfigSingleton();
});

describe("#773 — degraded retrieval can never produce a confirmed gap", () => {
  /**
   * The #773 incident, reproduced: every tool call fails, and the model — as it
   * did live — still emits a confident "No evidence found for X" gap finding.
   */
  const DEGRADED_SCRIPT = [
    DOC_ANSWER,
    JSON.stringify({ tool: "search_code_symbols", limit: 5 }), // no `query` → Error
    JSON.stringify({ tool: "read_file_slice", startLine: 1 }), // no `filePath` → Error
    GAP_ANSWER,
  ];

  it("emits ZERO gap-confirmed findings and marks them could-not-verify", async () => {
    await runPipeline(DEGRADED_SCRIPT);

    const findings = codeFindings();
    expect(findings).toHaveLength(1);
    // ON MAIN: the finding sails through as a gap (no verdict field at all, and
    // `verifyFinding` returns null for a citation-free absence claim).
    expect(findings.filter((f) => f.verdict === "gap-confirmed")).toHaveLength(0);
    expect(findings[0]?.verdict).toBe("could-not-verify");
    expect(findings[0]?.verificationStatus).toBe("could-not-verify");
  });

  it("never lets the finding TITLE assert an absence it did not establish", async () => {
    await runPipeline(DEGRADED_SCRIPT);

    const title = codeFindings()[0]?.title ?? "";
    expect(title).not.toMatch(/no evidence found/i);
    expect(title).toMatch(/^Could not verify:/);
    // Severity is dropped to info so an unverifiable claim cannot out-rank a real gap.
    expect(codeFindings()[0]?.severity).toBe("info");
  });

  it("flags the run with the code-retrieval-degraded capability reason", async () => {
    await runPipeline(DEGRADED_SCRIPT);

    // The incident run persisted `reasons: []` — a fully healthy-looking record.
    expect(capability()?.reasons).toContain("code-retrieval-degraded");
    expect(capability()?.codeRetrievalDegraded).toBe(true);
    // NOT a duplicate of #769/#770: the agent completed and answered in valid JSON.
    expect(capability()?.codeAgentFailed).toBe(false);
    expect(capability()?.codeAgentDegraded).toBe(false);
  });

  it("rolls the requirement up to could-not-verify, never a gap", async () => {
    await runPipeline(DEGRADED_SCRIPT);

    expect(requirementVerdicts()).toEqual(["could-not-verify", "could-not-verify"]);
  });

  it("persists the searched-scope provenance for the run", async () => {
    await runPipeline(DEGRADED_SCRIPT);

    const retrieval = persistedEnhancements.find((p) => p.retrieval)?.retrieval as {
      degraded: boolean;
      successfulSearches: number;
      searchedScope: Array<{ tool: string; hit: boolean }>;
    };
    expect(retrieval.degraded).toBe(true);
    expect(retrieval.successfulSearches).toBe(0);
    // #777 — the scope now carries ONE entry, not two. This fixture has no repo
    // connector, so `read_file_slice` was never in the pass's tool set; the model's
    // call to it earned the loop's "Unknown tool" repair error, which is a capability
    // limit, not a search. Only the `search_code_symbols` call was a real (errored)
    // code search, so only it is code-retrieval provenance. #773's actual claims are
    // untouched: the run is still degraded, still has zero successful searches, and
    // still confirms no gap (asserted above and in the sibling tests).
    expect(retrieval.searchedScope.map((s) => s.tool)).toEqual(["search_code_symbols"]);
    expect(retrieval.searchedScope.map((s) => s.hit)).toEqual([false]);
  });
});

describe("#773 — healthy retrieval still confirms a real gap (anti-regression)", () => {
  /**
   * The bar Fable set: a fix that marks everything `could-not-verify` is honest
   * and worthless. Here the agent's search WORKS (a real symbol comes back), and
   * the code genuinely lacks the feature — the gap must still confirm.
   */
  const HEALTHY_SCRIPT = [
    DOC_ANSWER,
    JSON.stringify({ tool: "search_code_graph", query: "drift severity" }), // hits
    GAP_ANSWER,
  ];

  it("keeps the gap-confirmed verdict on the finding and the requirement", async () => {
    await runPipeline(HEALTHY_SCRIPT);

    expect(codeFindings()[0]?.verdict).toBe("gap-confirmed");
    expect(codeFindings()[0]?.severity).toBe("high");
    expect(requirementVerdicts()[0]).toBe("gap-confirmed");
  });

  it("does not flag the run as retrieval-degraded", async () => {
    await runPipeline(HEALTHY_SCRIPT);

    expect(capability()?.reasons ?? []).not.toContain("code-retrieval-degraded");
  });

  it("still marks a requirement the agent never investigated as could-not-verify", async () => {
    await runPipeline(HEALTHY_SCRIPT);

    // Requirement 2 has NO linked code finding — the agent never produced one.
    // A healthy run does not license a gap for something it never looked at.
    expect(requirementVerdicts()[1]).toBe("could-not-verify");
  });
});

describe("#773 — a budget-exhausted investigation cannot confirm an UNCITED gap", () => {
  /**
   * `DEFAULT_AGENTIC_MAX_TURNS = 10` against ~20 requirements made several "no
   * evidence" outcomes structurally PREDETERMINED. Here the loop runs out of turns
   * after one search, and its gap finding cites nothing — so it never got far enough
   * to license the absence claim.
   *
   * #1236 — this used to assert `retrieval.starved`, because turn exhaustion was fed
   * into that field. It is now asserted on `exhausted`, and `starved` is asserted
   * FALSE: retrieval here worked perfectly (the search hit, nothing errored). The old
   * assertion encoded the conflation this issue removes; the OUTCOME is unchanged,
   * because `GAP_ANSWER` carries `citations: []`.
   */
  it("marks the finding could-not-verify even though the search itself succeeded", async () => {
    process.env.ANALYSIS_AGENTIC_MAX_TURNS = "1";
    // Disable the #773 turn scaling so the exhaustion is deterministic.
    process.env.ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT = "0";
    __resetConfigSingleton();

    await runPipeline([
      DOC_ANSWER,
      JSON.stringify({ tool: "search_code_graph", query: "drift severity" }), // hits, then turns run out
      GAP_ANSWER, // the loop's bounded final-answer retry (#769)
    ]);

    expect(codeFindings()[0]?.verdict).toBe("could-not-verify");
    expect(requirementVerdicts()[0]).toBe("could-not-verify");
    const retrieval = persistedEnhancements.find((p) => p.retrieval)?.retrieval as {
      starved: boolean;
      exhausted?: boolean;
      degraded: boolean;
      unverifiedRequirements?: number;
    };
    expect(retrieval.exhausted).toBe(true);
    // The pass is NOT starved — retrieval worked; it ran out of turns.
    expect(retrieval.starved).toBe(false);
    // #19 — but its one requirement shows `could-not-verify` on the page, so the
    // REPORT is degraded by the unverified share (report-side only: the verdict
    // above was set before this, by the per-claim rule).
    expect(retrieval.unverifiedRequirements).toBe(1);
    expect(retrieval.degraded).toBe(true);
  });
});

/**
 * #1236 — THE SAME EXHAUSTED LOOP, BUT THE REQUIREMENT WAS ACTUALLY REACHED.
 *
 * Identical budget to the suite above (one turn, then the answer): the ONLY difference
 * is that the finding carries a code citation that survives #734 grounding. Before the
 * fix this made no difference at all — turn exhaustion was fed into `starved`, which
 * short-circuits the run-level threshold, so the pass was condemned wholesale and a
 * finding naming an exact file and line range was still retitled "Could not verify".
 * On the measured run that flattened 13 of 22 findings.
 */
describe("#1236 — exhaustion does not downgrade a SEARCHED, CITED finding", () => {
  const CITED_GAP_ANSWER = JSON.stringify({
    summary: "investigated",
    findings: [
      {
        requirementId: "REQ-001",
        verdict: "gap-confirmed",
        category: "architecture",
        severity: "high",
        title: "computeSeverity has no commit-SHA baseline (REQ-001)",
        body: "computeSeverity classifies drift without reading any commit-SHA baseline.",
        tags: [],
        citations: [{ filePath: "server/src/drift/severity.ts", startLine: 10, endLine: 42 }],
      },
    ],
    notes: [],
  });

  async function runExhaustedButCited(): Promise<void> {
    process.env.ANALYSIS_AGENTIC_MAX_TURNS = "1";
    process.env.ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT = "0";
    // The passive #729 seed supplies the citation provenance, exactly as in the
    // false-positive suite below — this test is about the BUDGET, not about grounding.
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();

    await runPipeline(
      [
        DOC_ANSWER,
        JSON.stringify({ tool: "search_code_graph", query: "drift severity" }), // bears on REQ-001
        CITED_GAP_ANSWER,
      ],
      { withFusedSeed: true },
    );
  }

  it("keeps the verdict, the title and the severity of the cited finding", async () => {
    await runExhaustedButCited();

    const finding = codeFindings()[0];
    expect(finding?.citations?.length).toBeGreaterThan(0);
    expect(finding?.verdict).toBe("gap-confirmed");
    // The headline the model wrote survives — this is the retitling the issue reports.
    expect(finding?.title).not.toMatch(/^Could not verify:/);
    expect(finding?.severity).toBe("high");
    expect(requirementVerdicts()[0]).toBe("gap-confirmed");
  });

  it("still records that the investigation was cut short, without calling it starved", async () => {
    await runExhaustedButCited();

    const retrieval = persistedEnhancements.find((p) => p.retrieval)?.retrieval as {
      starved: boolean;
      exhausted?: boolean;
      degraded: boolean;
    };
    // The operator signal is preserved — it is the VERDICT that stops keying off it.
    expect(retrieval.exhausted).toBe(true);
    expect(retrieval.starved).toBe(false);
    expect(retrieval.degraded).toBe(false);
  });
});

/**
 * ANTI-REGRESSION AT PRODUCTION SCALE — the test the first cut of #773 did not have.
 *
 * The original threshold demanded `successfulSearches >= requirementCount` for the
 * whole pass. The turn cap bounds how many tool calls a pass can make, so at N≈20 it
 * needed ~2/3 of EVERY call to hit, and at N≥30 a `gap-confirmed` was MATHEMATICALLY
 * IMPOSSIBLE — above the cap the product silently degraded into "could-not-verify
 * everything", which is the useless-tool outcome this issue exists to prevent. The
 * only anti-regression test ran at N=1, the single easiest point in the threshold's
 * domain, and could not see any of it.
 *
 * This runs the REAL pipeline at N=20 and N=30 against a codebase that HAS two of the
 * requested features and genuinely LACKS the rest, with healthy retrieval throughout
 * (hits AND legitimately-empty searches, zero tool errors), and asserts the gaps STILL
 * CONFIRM.
 */
describe("#773 — healthy retrieval confirms real gaps AT SCALE (N=20, N=30)", () => {
  /** Features the codebase genuinely lacks — each gets one working, empty search. */
  const ABSENT = [
    { id: "REQ-002", term: "rate limiting", text: "The public API must apply rate limiting." },
    { id: "REQ-003", term: "webhook signing", text: "Outbound webhooks must be signed." },
    { id: "REQ-004", term: "tenant quota", text: "Each tenant must have an ingest quota." },
  ];

  /** Build an N-requirement pass: 2 present features, 3 absent ones, the rest untouched. */
  function scaleScenario(n: number): string[] {
    state.documentRequirements = [
      { id: "REQ-001", text: "Drift severity must be classified from a commit-SHA baseline." },
      ...ABSENT.map((a) => ({ id: a.id, text: a.text })),
      // Filler requirements the agent has no budget to look for. They must come back
      // `could-not-verify` — never gaps — which is the honest, scale-free outcome.
      ...Array.from({ length: n - 1 - ABSENT.length }, (_, i) => ({
        id: `REQ-${String(i + 5).padStart(3, "0")}`,
        text: `Filler requirement ${i + 5} about an unrelated subsystem.`,
      })),
    ];

    // The code agent's answer: REQ-001 is implemented (it found it), the three ABSENT
    // ones are confirmed gaps. Flat finding indexes are 0..3 (the doc agent emits none).
    const answer = JSON.stringify({
      summary: "investigated",
      findings: [
        {
          requirementId: "REQ-001",
          verdict: "implemented",
          category: "architecture",
          severity: "info",
          title: "Drift severity is computed in severity.ts",
          body: "computeSeverity classifies drift severity from the commit-SHA baseline.",
          tags: [],
          citations: [{ filePath: "server/src/drift/severity.ts", startLine: 10, endLine: 42 }],
        },
        ...ABSENT.map((a) => ({
          requirementId: a.id,
          verdict: "gap-confirmed",
          category: "architecture",
          severity: "high",
          title: `No ${a.term} in the codebase (${a.id})`,
          body: `I searched for ${a.term} and the codebase does not implement it.`,
          tags: [],
          citations: [],
        })),
      ],
      notes: [],
    });

    state.synthesisRequirements = [
      { title: "Drift severity", body: "b", priority: "high", evidenceFindingIndexes: [0] },
      ...ABSENT.map((a, i) => ({
        title: a.text,
        body: "b",
        priority: "high",
        evidenceFindingIndexes: [i + 1],
      })),
      // The requirement nobody searched for.
      { title: "Filler 5", body: "b", priority: "low", evidenceFindingIndexes: [] },
    ];

    return [
      DOC_ANSWER,
      // Two searches that HIT (the features that exist)…
      JSON.stringify({ tool: "search_code_graph", query: "drift severity" }),
      JSON.stringify({ tool: "search_code_graph", query: "commit sha baseline" }),
      // …and one working, EMPTY search per absent feature. These are what a CORRECT
      // absence investigation returns; they must not look like a broken run.
      ...ABSENT.map((a) => JSON.stringify({ tool: "search_code_graph", query: a.term })),
      answer,
    ];
  }

  it.each([20, 30])(
    "still confirms the gaps it searched for, with %i requirements in the pass",
    async (n) => {
      await runPipeline(scaleScenario(n));

      const findings = codeFindings();
      const gaps = findings.filter((f) => f.verdict === "gap-confirmed");
      // ALL THREE genuinely-absent features are still confirmed gaps. Under the old
      // pass-wide quota this was 0 at N=20 and provably impossible at N=30.
      expect(gaps).toHaveLength(3);
      expect(gaps.map((f) => f.title)).toEqual([
        "No rate limiting in the codebase (REQ-002)",
        "No webhook signing in the codebase (REQ-003)",
        "No tenant quota in the codebase (REQ-004)",
      ]);
      // Severity intact — a confirmed gap is not demoted to info.
      expect(gaps.every((f) => f.severity === "high")).toBe(true);
      // The requirement roll-up agrees: three gaps…
      expect(requirementVerdicts().slice(1, 4)).toEqual([
        "gap-confirmed",
        "gap-confirmed",
        "gap-confirmed",
      ]);
      // …the one it found is implemented…
      expect(requirementVerdicts()[0]).toBe("implemented");
      // …and the one nobody searched for is could-not-verify, NEVER a gap.
      expect(requirementVerdicts()[4]).toBe("could-not-verify");
    },
  );

  it("does not flag a gap-heavy (but working) run as retrieval-degraded", async () => {
    // #19 — five requirements, so the agent reported on four of them. At N=20 the 16
    // unreached fillers are `could-not-verify` on the page, and a run showing most of
    // its requirements unverified IS reported degraded now (see the #19 block below);
    // this test is about the gaps, which must never be what degrades a run.
    await runPipeline(scaleScenario(5));

    // 3 of 5 searches came back EMPTY — because the code genuinely is not there.
    // Counting empties as tool errors made a real-gap-heavy codebase look "degraded"
    // and downgraded its CORRECT gaps: the more gaps you had, the fewer we would report.
    const retrieval = persistedEnhancements.find((p) => p.retrieval)?.retrieval as {
      degraded: boolean;
      erroredCalls: number;
      failedSearches: number;
      successfulSearches: number;
    };
    expect(retrieval.erroredCalls).toBe(0);
    expect(retrieval.failedSearches).toBe(3); // the legitimate empties
    expect(retrieval.successfulSearches).toBe(2);
    expect(retrieval.degraded).toBe(false);
    expect(capability()?.reasons ?? []).not.toContain("code-retrieval-degraded");
  });
});

/**
 * THE FALSE-POSITIVE FLANK — the direction this whole issue MAKES more dangerous.
 *
 * Making the system reluctant to claim absence raises the relative cost of a
 * hallucinated "you already have this": it silently closes a real gap, and the user
 * never builds something they actually need. On the literal #773 run — every tool call
 * failing — the PASSIVE #729 fused-symbol seed still supplies citation provenance, so
 * a model claiming `implemented` sailed through a gate that checked ONLY for a
 * surviving citation. No downgrade happened, so no `code-retrieval-degraded` banner
 * fired either. Nothing anywhere told the user to look again.
 */
describe("#773 — a broken run cannot claim 'implemented' either (the false-positive flank)", () => {
  const IMPLEMENTED_ANSWER = JSON.stringify({
    summary: "investigated",
    findings: [
      {
        requirementId: "REQ-001",
        verdict: "implemented",
        category: "architecture",
        severity: "info",
        title: "Commit-SHA baselining already exists",
        body: "computeSeverity already classifies drift severity from a commit-SHA baseline.",
        tags: [],
        // Grounded ONLY by the passive fused seed — no search produced this.
        citations: [{ filePath: "server/src/drift/severity.ts", startLine: 10, endLine: 42 }],
      },
    ],
    notes: [],
  });

  /** The #773 run: every tool call errors, and the passive seed is ON. */
  const BROKEN_RUN = [
    DOC_ANSWER,
    JSON.stringify({ tool: "search_code_symbols", limit: 5 }), // no `query` → Error
    JSON.stringify({ tool: "read_file_slice", startLine: 1 }), // no `filePath` → Error
    IMPLEMENTED_ANSWER,
  ];

  async function runBrokenRun(): Promise<void> {
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
    await runPipeline(BROKEN_RUN, { withFusedSeed: true });
  }

  it("downgrades the passively-grounded 'implemented' claim to could-not-verify", async () => {
    await runBrokenRun();

    const finding = codeFindings()[0];
    // The citation DID survive #734 grounding (that is the point — the seed grounds it
    // without a single successful search), so the old citation-only gate kept it.
    expect(finding?.citations?.length).toBeGreaterThan(0);
    expect(finding?.verdict).not.toBe("implemented");
    expect(finding?.verdict).toBe("could-not-verify");
  });

  it("rolls the requirement up to could-not-verify — the gap is NOT silently closed", async () => {
    await runBrokenRun();

    expect(requirementVerdicts()[0]).toBe("could-not-verify");
  });

  it("RAISES code-retrieval-degraded even though the model claimed no absence", async () => {
    await runBrokenRun();

    // Previously the banner fired only when a claim had been DOWNGRADED, so an
    // `implemented` claim on a totally broken run produced no warning at all.
    // Degradation is a property of the RUN, and is now reported as one.
    expect(capability()?.reasons).toContain("code-retrieval-degraded");
    expect(capability()?.codeRetrievalDegraded).toBe(true);
  });
});

/**
 * #773 (review 2, N1) — A DOCUMENT SEARCH MUST NOT LAUNDER A CODE GAP.
 *
 * `search_knowledge` sits in the SAME tool set as the code tools, but it is document
 * RAG. Counting it as retrieval evidence let this exact run — four CODE searches that
 * all errored, five DOCUMENT searches that all hit — look healthy (error rate 4/9 =
 * 0.44, five "successful searches"), and a doc query lifted from the requirement text
 * shares every term with that requirement, so the per-claim rule passed too. Result:
 * `gap-confirmed` on a run where NOT ONE CODE SEARCH WORKED — #773's own inference,
 * arriving through a different tool.
 */
describe("#773 — document retrieval cannot license a code gap", () => {
  const LAUNDERING_RUN = [
    DOC_ANSWER,
    // 4 CODE searches — every one rejected (#774: an unfiltered graph search errors).
    ...Array.from({ length: 4 }, () => JSON.stringify({ tool: "search_code_graph", limit: 5 })),
    // 5 DOCUMENT searches — every one a hit, all quoting the requirement.
    ...Array.from({ length: 5 }, () =>
      JSON.stringify({
        tool: "search_knowledge",
        query: "Drift severity must be classified from a commit-SHA baseline.",
      }),
    ),
    GAP_ANSWER,
  ];

  async function runLaundering(): Promise<void> {
    // Enough turns for 9 tool calls + the answer, so the loop is NOT starved — the
    // degradation under test must come from the evidence rule, not the budget.
    process.env.ANALYSIS_AGENTIC_MAX_TURNS = "20";
    __resetConfigSingleton();
    await runPipeline(LAUNDERING_RUN, { withKnowledge: true });
  }

  it("emits ZERO gap-confirmed findings when every CODE search failed", async () => {
    await runLaundering();

    expect(codeFindings().filter((f) => f.verdict === "gap-confirmed")).toHaveLength(0);
    expect(codeFindings()[0]?.verdict).toBe("could-not-verify");
    expect(requirementVerdicts()[0]).toBe("could-not-verify");
  });

  it("raises code-retrieval-degraded — five doc hits do not make code retrieval healthy", async () => {
    await runLaundering();

    expect(capability()?.reasons).toContain("code-retrieval-degraded");
  });

  it("counts CODE calls only: the doc hits neither prove retrieval worked nor dilute the error rate", async () => {
    await runLaundering();

    const retrieval = persistedEnhancements.find((p) => p.retrieval)?.retrieval as {
      degraded: boolean;
      starved: boolean;
      totalCalls: number;
      erroredCalls: number;
      successfulSearches: number;
      searchedScope: Array<{ tool: string }>;
    };
    expect(retrieval.starved).toBe(false);
    expect(retrieval.totalCalls).toBe(4); // the 4 code calls, not all 9
    expect(retrieval.erroredCalls).toBe(4);
    expect(retrieval.successfulSearches).toBe(0);
    expect(retrieval.degraded).toBe(true);
    expect(retrieval.searchedScope.every((s) => s.tool !== "search_knowledge")).toBe(true);
  });
});

/**
 * #773 (review 2, N2) — THE GATE MUST SEE SEARCHES PAST THE PERSISTENCE CAP.
 *
 * The per-claim rule used to read the PERSISTED searched scope, which is truncated at
 * 40 entries for bounded storage. Once the turn cap rose to 60, a pass at N ≥ 21 could
 * make 41+ tool calls — so a search that ran as call #45 was invisible to the gate and
 * the gap it correctly established was silently demoted to `could-not-verify`. Here the
 * ONLY search bearing on REQ-004 is the 45th call.
 */
describe("#773 — a gap confirmed by the 45th tool call still confirms", () => {
  const LATE_SEARCH_RUN = () => {
    state.documentRequirements = [
      { id: "REQ-001", text: "Drift severity must be classified from a commit-SHA baseline." },
      { id: "REQ-004", text: "Each tenant must have an ingest quota." },
      ...Array.from({ length: 23 }, (_, i) => ({
        id: `REQ-${String(i + 10).padStart(3, "0")}`,
        text: `Filler requirement ${i + 10} about an unrelated subsystem.`,
      })),
    ];
    state.synthesisRequirements = [
      { title: "Drift severity", body: "b", priority: "high", evidenceFindingIndexes: [] },
      { title: "Tenant quota", body: "b", priority: "high", evidenceFindingIndexes: [0] },
    ];
    const answer = JSON.stringify({
      summary: "investigated",
      findings: [
        {
          requirementId: "REQ-004",
          verdict: "gap-confirmed",
          category: "architecture",
          severity: "high",
          title: "No tenant ingest quota in the codebase (REQ-004)",
          body: "I searched for a tenant ingest quota and the codebase does not implement it.",
          tags: [],
          citations: [],
        },
      ],
      notes: [],
    });
    return [
      DOC_ANSWER,
      // 44 working searches that bear on OTHER requirements…
      ...Array.from({ length: 44 }, () =>
        JSON.stringify({ tool: "search_code_graph", query: "drift severity" }),
      ),
      // …then, as tool call #45, the working (empty) search that establishes REQ-004's
      // gap. At N=25 the turn budget allows this; the 40-entry scope cap used to hide it.
      JSON.stringify({ tool: "search_code_graph", query: "tenant ingest quota" }),
      answer,
    ];
  };

  it("confirms the gap even though its search is past the searched-scope cap", async () => {
    await runPipeline(LATE_SEARCH_RUN());

    expect(codeFindings()[0]?.verdict).toBe("gap-confirmed");
    expect(codeFindings()[0]?.severity).toBe("high");
    expect(requirementVerdicts()[1]).toBe("gap-confirmed");
  });

  it("keeps the PERSISTED provenance bounded (display truncates; the gate does not)", async () => {
    await runPipeline(LATE_SEARCH_RUN());

    const retrieval = persistedEnhancements.find((p) => p.retrieval)?.retrieval as {
      starved: boolean;
      totalCalls: number;
      searchedScope: unknown[];
    };
    expect(retrieval.starved).toBe(false);
    expect(retrieval.totalCalls).toBe(45);
    expect(retrieval.searchedScope).toHaveLength(40);
  });
});

/**
 * #773 (review 2, M1) — THE MODEL MUST NOT BE ABLE TO LICENSE ITS OWN GAP.
 *
 * The per-claim matcher used to test the search queries against the requirement text
 * PLUS THE MODEL'S OWN FINDING TITLE. The model authors both operands, so it could
 * confirm a gap for a requirement nobody searched for simply by echoing an earlier
 * search's vocabulary in the headline. Here the agent searches only "drift severity"
 * (REQ-001) and never looks at tenant quota — then titles REQ-009's finding "No tenant
 * quota in the DRIFT SEVERITY layer". The claim side is now the requirement text alone.
 */
describe("#773 — a model-authored title cannot license a gap for an un-searched requirement", () => {
  const TITLE_INJECTION_RUN = () => {
    state.documentRequirements = [
      { id: "REQ-001", text: "Drift severity must be classified from a commit-SHA baseline." },
      { id: "REQ-009", text: "Each tenant must have an ingest quota enforced at write time." },
    ];
    state.synthesisRequirements = [
      { title: "Drift severity", body: "b", priority: "high", evidenceFindingIndexes: [] },
      { title: "Tenant quota", body: "b", priority: "high", evidenceFindingIndexes: [0] },
    ];
    const answer = JSON.stringify({
      summary: "investigated",
      findings: [
        {
          requirementId: "REQ-009",
          verdict: "gap-confirmed",
          category: "architecture",
          severity: "high",
          // Vocabulary borrowed from the ONE search the agent ran — for a DIFFERENT
          // requirement. Nothing here was investigated.
          title: "No tenant quota in the drift severity layer (REQ-009)",
          body: "The codebase does not enforce a per-tenant ingest quota.",
          tags: [],
          citations: [],
        },
      ],
      notes: [],
    });
    return [
      DOC_ANSWER,
      JSON.stringify({ tool: "search_code_graph", query: "drift severity" }), // hits — REQ-001
      answer,
    ];
  };

  it("downgrades the gap to could-not-verify (the run is healthy — nobody looked)", async () => {
    await runPipeline(TITLE_INJECTION_RUN());

    const retrieval = persistedEnhancements.find((p) => p.retrieval)?.retrieval as {
      starved: boolean;
      degraded: boolean;
      unverifiedRequirements?: number;
    };
    // The run's retrieval WORKED — this is not a starvation story. The requirement
    // simply was never investigated, and the title cannot stand in for having looked.
    expect(retrieval.starved).toBe(false);
    // #19 — both requirements show `could-not-verify` on the page (REQ-001 has no
    // finding at all), so the REPORT is degraded by the unverified share alone.
    expect(retrieval.unverifiedRequirements).toBe(2);
    expect(retrieval.degraded).toBe(true);
    expect(codeFindings()[0]?.verdict).toBe("could-not-verify");
    expect(codeFindings()[0]?.title).toMatch(/^Could not verify:/);
    expect(requirementVerdicts()[1]).toBe("could-not-verify");
  });
});

/**
 * #19 — THE HEALTH REPORT MUST NOT CALL A RUN THAT VERIFIED NOTHING HEALTHY.
 *
 * Reported run: the code agent made ONE tool call, then every one of its 16
 * requirements came back `could-not-verify` — and the persisted record read
 * `starved: false, degraded: false`, with no capability reason, so the analysis page
 * gave no hint that none of the requirements had been checked against the code. One
 * working search clears the #773 run-level threshold (which must stay scale-free for
 * the VERDICT), so the REPORT needs its own coverage check. Verdicts are unchanged.
 */
describe("#19 — a run that verified nothing is reported starved/degraded", () => {
  const SIXTEEN = Array.from({ length: 16 }, (_, i) => ({
    id: `REQ-${String(i + 1).padStart(3, "0")}`,
    text: `Requirement ${i + 1} about subsystem ${i + 1}.`,
  }));

  /** The agent's answer on the reported run: every requirement could-not-verify. */
  const NOTHING_VERIFIED = JSON.stringify({
    summary: "Investigation was cut short after a single call; nothing could be grounded.",
    findings: SIXTEEN.map((r) => ({
      requirementId: r.id,
      verdict: "could-not-verify",
      category: "other",
      severity: "info",
      title: `Could not verify ${r.id}`,
      body: "No code evidence was gathered for this requirement.",
      tags: [],
      citations: [],
    })),
    notes: [],
  });

  const retrieval = () =>
    persistedEnhancements.find((p) => p.retrieval)?.retrieval as {
      starved: boolean;
      degraded: boolean;
      totalCalls: number;
      successfulSearches: number;
      requirementCount: number;
      unverifiedRequirements?: number;
    };

  it("marks one search for 16 requirements as starved and degraded, and raises the banner", async () => {
    state.documentRequirements = [...SIXTEEN];
    await runPipeline([
      DOC_ANSWER,
      JSON.stringify({ tool: "search_code_graph", query: "drift severity" }), // one working hit
      NOTHING_VERIFIED,
    ]);

    // The reported run's exact counters…
    expect(retrieval().totalCalls).toBe(1);
    expect(retrieval().successfulSearches).toBe(1);
    expect(retrieval().requirementCount).toBe(16);
    // …which on main were reported `starved: false, degraded: false`.
    expect(retrieval().starved).toBe(true);
    expect(retrieval().degraded).toBe(true);
    expect(retrieval().unverifiedRequirements).toBe(16);
    expect(capability()?.codeRetrievalDegraded).toBe(true);
    expect(capability()?.reasons).toContain("code-retrieval-degraded");
  });

  it("degrades a run that searched enough but still verified most requirements as could-not-verify", async () => {
    state.documentRequirements = SIXTEEN.slice(0, 2);
    const answer = JSON.stringify({
      summary: "s",
      findings: SIXTEEN.slice(0, 2).map((r) => ({
        requirementId: r.id,
        verdict: "could-not-verify",
        category: "other",
        severity: "info",
        title: `Could not verify ${r.id}`,
        body: "b",
        tags: [],
        citations: [],
      })),
      notes: [],
    });
    await runPipeline([
      DOC_ANSWER,
      JSON.stringify({ tool: "search_code_graph", query: "drift severity" }),
      JSON.stringify({ tool: "search_code_graph", query: "commit sha baseline" }),
      answer,
    ]);

    expect(retrieval().starved).toBe(false);
    expect(retrieval().degraded).toBe(true);
    expect(retrieval().unverifiedRequirements).toBe(2);
    expect(capability()?.reasons).toContain("code-retrieval-degraded");
  });

  it("counts requirements the agent never reported on, as the page does (PR #37 review)", async () => {
    // Five searches for 16 requirements clears the starvation floor, and the three
    // findings are `implemented` — but the other 13 requirements have no finding, so
    // the page shows them `could-not-verify`. Counting only requirements that HAVE
    // a finding recorded this run as healthy.
    state.documentRequirements = [...SIXTEEN];
    const answer = JSON.stringify({
      summary: "s",
      findings: SIXTEEN.slice(0, 3).map((r) => ({
        requirementId: r.id,
        verdict: "implemented",
        category: "architecture",
        severity: "info",
        title: `Drift severity is computed in severity.ts (${r.id})`,
        body: "computeSeverity classifies drift severity from the commit-SHA baseline.",
        tags: [],
        citations: [{ filePath: "server/src/drift/severity.ts", startLine: 10, endLine: 42 }],
      })),
      notes: [],
    });
    await runPipeline([
      DOC_ANSWER,
      ...["drift severity", "commit sha baseline", "severity", "baseline", "drift"].map((query) =>
        JSON.stringify({ tool: "search_code_graph", query }),
      ),
      answer,
    ]);

    const verified = codeFindings().filter((f) => f.verdict !== "could-not-verify").length;
    expect(verified).toBe(3); // the three implemented claims stand
    expect(retrieval().totalCalls).toBe(5);
    expect(retrieval().starved).toBe(false);
    expect(retrieval().unverifiedRequirements).toBe(13);
    expect(retrieval().degraded).toBe(true);
    expect(capability()?.reasons).toContain("code-retrieval-degraded");
  });

  it("does not change a single verdict (the check is report-side only)", async () => {
    state.documentRequirements = [...SIXTEEN];
    await runPipeline([
      DOC_ANSWER,
      JSON.stringify({ tool: "search_code_graph", query: "drift severity" }),
      NOTHING_VERIFIED,
    ]);
    expect(codeFindings()).toHaveLength(16);
    expect(codeFindings().every((f) => f.verdict === "could-not-verify")).toBe(true);
  });
});
