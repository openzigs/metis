/**
 * Issue #777 — a repo that is INDEXED but has NO CLONE ON DISK must still analyse.
 *
 * The defect: the agentic code agent was offered `read_file_slice` / `list_files`
 * whenever a CONNECTOR ROW existed, gated on the truthiness of an unconditionally
 * built path STRING — never on whether that directory is actually there. On a
 * fully-indexed project with no clone (clone reaped after ingest, ephemeral worker
 * disk, redeployed instance, ingest-only pipeline) BOTH tools then failed on EVERY
 * call: live telemetry (#774) showed 69–71% of all tool calls erroring, which blew
 * past #773's `MAX_TOOL_ERROR_RATE`, so the run was branded `code-retrieval-degraded`
 * and every requirement rolled up `could-not-verify`. The agent could query the graph
 * but never read source, and the product produced nothing usable.
 *
 * Driven end-to-end through the REAL pipeline (`AnalysisOrchestrator.runPipeline`)
 * against a REAL temp directory (no `fs` mock): the fake MODEL is scripted at the
 * provider boundary and every assertion is made on what crossed a real boundary —
 * the prompt the model was handed, the tool telemetry persisted for the run, the
 * findings, the requirement verdicts, and the capability record. Stubbing the agentic
 * pass is the anti-pattern that hid #750, #769 and #774.
 *
 * THE ACCEPTANCE BAR is `#777 — a clone-less INDEXED project still reaches real
 * verdicts`: a fix that merely stops the errors while still marking everything
 * `could-not-verify` is honest and worthless.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { AgentFindingPayload, AnalysisCapability } from "@metis/shared";

const ANALYSIS_ID = "an_777";
const PROJECT_ID = "pr_777";
const CONNECTOR_ID = "conn_777";

interface SynthRequirement {
  title: string;
  body: string;
  priority: string;
  evidenceFindingIndexes: number[];
}

const state: {
  documentRequirements: Array<{ id: string; text: string }>;
  synthesisRequirements: SynthRequirement[];
} = { documentRequirements: [], synthesisRequirements: [] };

/**
 * The project IS indexed — 2 symbols in the code graph, exactly like the live
 * `metis` project (14,973 symbols) that had no clone. `search_code_graph` filters
 * `qualifiedName: { contains: … }`, so a query for something the codebase HAS comes
 * back a hit and a query for something it LACKS comes back a well-formed empty
 * result. Both are working retrieval; neither needs a working tree.
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
/**
 * Every SYSTEM prompt the run handed the model. The tool SCHEMAS are rendered into
 * it (`buildCachedSystemPrompt` → `formatToolSchemas`) and it reaches the provider as
 * `chat`'s second argument (`options.systemMessage`) — NOT as a message. So this, and
 * not the message list, is the honest answer to "which tools was the model offered?":
 * the message list also carries the model's OWN tool-call JSON echoed back, which
 * would read as an offer even when the tool was never in the set.
 */
const chatSystemPrompts: string[] = [];

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    // #855 — back `hasSchemaData` (#854), the database-aware resolver's
    // schema-data probe. This suite never sets a per-project override, so the
    // resolved setting defaults to `auto`; 0 counts resolve to "no schema data"
    // (schema mapping stays a no-op, matching pre-#855 default-off behaviour).
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
    // The repo's SOURCE was ingested as knowledge — the project is fully indexed.
    document: {
      findFirst: vi.fn(async () => ({ id: "doc_1" })),
      findMany: vi.fn(async () => []),
    },
    // THE CONNECTOR EXISTS. On main this alone is enough to offer the file tools.
    repoConnection: {
      findMany: vi.fn(async () => [{ id: CONNECTOR_ID, label: "metis" }]),
    },
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

/**
 * The codebase HAS drift severity (REQ-001) and genuinely LACKS a tenant quota
 * (REQ-002). A clone-less run must be able to reach BOTH verdicts from graph search
 * alone — `implemented` for the one it found, `gap-confirmed` for the one it did not.
 */
const REQUIREMENTS = [
  { id: "REQ-001", text: "Drift severity must be classified from a commit-SHA baseline." },
  { id: "REQ-002", text: "Each tenant must have an ingest quota enforced at write time." },
];
const SYNTHESIS: SynthRequirement[] = [
  { title: "Drift severity", body: "b", priority: "high", evidenceFindingIndexes: [0] },
  { title: "Tenant quota", body: "b", priority: "high", evidenceFindingIndexes: [1] },
];

/** Winston's final answer: one `implemented`, one `gap-confirmed`. */
const VERDICT_ANSWER = JSON.stringify({
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
    {
      requirementId: "REQ-002",
      verdict: "gap-confirmed",
      category: "architecture",
      severity: "high",
      title: "No tenant ingest quota in the codebase (REQ-002)",
      body: "I searched the code graph for a tenant ingest quota; the codebase does not implement it.",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

/** Two working graph searches: one HITS (REQ-001), one is legitimately EMPTY (REQ-002). */
const GRAPH_ONLY_SCRIPT = [
  DOC_ANSWER,
  JSON.stringify({ tool: "search_code_graph", query: "drift severity" }),
  JSON.stringify({ tool: "search_code_graph", query: "tenant ingest quota" }),
  VERDICT_ANSWER,
];

function makeProvider(script: string[]) {
  let n = 0;
  return {
    chat: vi.fn(async (_messages: unknown, opts?: { systemMessage?: string }) => {
      if (opts?.systemMessage) chatSystemPrompts.push(opts.systemMessage);
      const content = script[Math.min(n, script.length - 1)] ?? VERDICT_ANSWER;
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

let cloneRoot: string;

async function runPipeline(script: string[]): Promise<void> {
  const orch = new AnalysisOrchestrator({
    provider: makeProvider(script) as never,
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

const toolTelemetry = (): {
  totalCalls: number;
  errorCalls: number;
  byTool: Array<{ tool: string; calls: number; errors: number }>;
} => persistedAgentResults.find((r) => r.agentKey === "code")?.toolTelemetry as never;

const retrieval = (): {
  degraded: boolean;
  starved: boolean;
  totalCalls: number;
  erroredCalls: number;
  successfulSearches: number;
} => persistedEnhancements.find((p) => p.retrieval)?.retrieval as never;

/** Did the MODEL ever see the file tools? Their schemas render into the system prompt. */
const promptOffersFileTools = (): boolean =>
  chatSystemPrompts.some((p) => p.includes("read_file_slice") || p.includes("list_files"));

/** The agentic code agent's system prompt (the only one carrying `MODE: AGENTIC`). */
const agenticSystemPrompt = (): string =>
  chatSystemPrompts.find((p) => p.includes("MODE: AGENTIC")) ?? "";

beforeEach(async () => {
  vi.clearAllMocks();
  persistedAgentResults.length = 0;
  persistedRequirements.length = 0;
  persistedCapabilities.length = 0;
  persistedEnhancements.length = 0;
  chatSystemPrompts.length = 0;
  state.documentRequirements = REQUIREMENTS.map((r) => ({ ...r }));
  state.synthesisRequirements = SYNTHESIS.map((r) => ({ ...r }));
  // A REAL directory tree — the bug is about the filesystem, so no `fs` mock.
  // `cloneRoot` exists; `cloneRoot/<connectorId>` does NOT, unless a test creates it.
  cloneRoot = await mkdtemp(path.join(tmpdir(), "metis-777-"));
  process.env.REPO_CLONE_DIR = cloneRoot;
  // Isolate the tool loop from the #729 passive fused seed: it would supply citation
  // provenance (and `seedGrounded`) for free, masking what graph SEARCH alone can do.
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(async () => {
  delete process.env.REPO_CLONE_DIR;
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
  await rm(cloneRoot, { recursive: true, force: true });
});

describe("#777 — connector present, clone dir ABSENT: the file tools are never offered", () => {
  it("keeps read_file_slice and list_files out of the model-facing tool set", async () => {
    await runPipeline(GRAPH_ONLY_SCRIPT);

    // ON MAIN: the connector row alone puts both schemas in the system prompt.
    expect(promptOffersFileTools()).toBe(false);
    // The graph tools ARE offered — the agent is not left toolless.
    expect(agenticSystemPrompt()).toContain("search_code_graph");
  });

  it("attempts ZERO calls to the file tools", async () => {
    await runPipeline(GRAPH_ONLY_SCRIPT);

    const tools = toolTelemetry().byTool.map((t) => t.tool);
    expect(tools).not.toContain("read_file_slice");
    expect(tools).not.toContain("list_files");
    // Every call the run DID make worked — the 69–71% error rate is gone.
    expect(toolTelemetry().errorCalls).toBe(0);
    expect(toolTelemetry().totalCalls).toBe(2);
  });

  it("raises repo-clone-unavailable — its own reason, NOT code-retrieval-degraded", async () => {
    await runPipeline(GRAPH_ONLY_SCRIPT);

    expect(capability()?.reasons).toContain("repo-clone-unavailable");
    expect(capability()?.repoCloneUnavailable).toBe(true);
    // The absent clone is a KNOWN CAPABILITY LIMIT, not evidence that search broke.
    // Misattributing it to search quality is what told the user to distrust verdicts
    // that were, in fact, perfectly well grounded in the graph.
    expect(capability()?.reasons).not.toContain("code-retrieval-degraded");
    expect(capability()?.codeRetrievalDegraded).toBe(false);
  });

  it("does not poison the #773 retrieval-health signal", async () => {
    await runPipeline(GRAPH_ONLY_SCRIPT);

    expect(retrieval().degraded).toBe(false);
    expect(retrieval().erroredCalls).toBe(0);
    expect(retrieval().successfulSearches).toBe(1); // the hit; the empty one is a valid miss
    expect(retrieval().starved).toBe(false);
  });
});

/**
 * THE ACCEPTANCE BAR (#777). Stopping the errors is not the point — the point is that
 * a clone-less, fully-indexed project produces USABLE VERDICTS from graph search alone.
 * Post-#773 every requirement on such a run came back `could-not-verify`; here a
 * genuinely-absent feature must still reach `gap-confirmed` and an existing one
 * `implemented`.
 */
describe("#777 — a clone-less INDEXED project still reaches real verdicts", () => {
  it("confirms a real gap and a real implementation from graph search alone", async () => {
    await runPipeline(GRAPH_ONLY_SCRIPT);

    const findings = codeFindings();
    expect(findings.map((f) => f.verdict)).toEqual(["implemented", "gap-confirmed"]);
    // NOT a blanket could-not-verify — the whole product outcome this issue is about.
    expect(findings.filter((f) => f.verdict === "could-not-verify")).toHaveLength(0);
    // Severity survives: a confirmed gap is not demoted to `info`.
    expect(findings[1]?.severity).toBe("high");
    expect(findings[1]?.title).toBe("No tenant ingest quota in the codebase (REQ-002)");

    // …and the requirement roll-up agrees.
    expect(requirementVerdicts()).toEqual(["implemented", "gap-confirmed"]);
  });

  it("tells the agent it has no working tree so it does not plan around reading files", async () => {
    await runPipeline(GRAPH_ONLY_SCRIPT);

    const codePrompt = agenticSystemPrompt();
    expect(codePrompt).toMatch(/no working tree is available/i);
    expect(codePrompt).toMatch(/do not attempt to read files/i);
  });
});

/**
 * NO REGRESSION. When the clone IS there, both tools are offered and work exactly as
 * they do today — the gate is existence, not a blanket removal of file access.
 */
describe("#777 — connector present, clone dir EXISTS: the file tools work as today", () => {
  const READ_SCRIPT = [
    DOC_ANSWER,
    JSON.stringify({ tool: "search_code_graph", query: "drift severity" }),
    // The agent OPENS the file it found — the capability an existing clone buys.
    JSON.stringify({
      tool: "read_file_slice",
      filePath: "server/src/drift/severity.ts",
      startLine: 1,
      endLine: 3,
    }),
    // …and still runs the working (empty) search that licenses REQ-002's gap. Without
    // a search bearing on REQ-002, #773's per-claim rule correctly refuses the gap —
    // having a clone does not exempt a claim from needing a search behind it.
    JSON.stringify({ tool: "search_code_graph", query: "tenant ingest quota" }),
    VERDICT_ANSWER,
  ];

  beforeEach(async () => {
    const dir = path.join(cloneRoot, CONNECTOR_ID, "server/src/drift");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "severity.ts"),
      "export function computeSeverity() {\n  return 'high';\n}\n",
      "utf8",
    );
  });

  it("offers both file tools and executes read_file_slice against the clone", async () => {
    await runPipeline(READ_SCRIPT);

    expect(promptOffersFileTools()).toBe(true);
    const read = toolTelemetry().byTool.find((t) => t.tool === "read_file_slice");
    expect(read).toEqual({ tool: "read_file_slice", calls: 1, errors: 0 });
    expect(toolTelemetry().errorCalls).toBe(0);
  });

  it("does not raise repo-clone-unavailable, and still reaches real verdicts", async () => {
    await runPipeline(READ_SCRIPT);

    expect(capability()?.reasons ?? []).not.toContain("repo-clone-unavailable");
    expect(capability()?.repoCloneUnavailable).toBe(false);
    expect(requirementVerdicts()).toEqual(["implemented", "gap-confirmed"]);
  });
});

/**
 * THE LIVE INCIDENT, REPRODUCED — and the sharpest proof of the fix.
 *
 * This is the script the real agent ran: offered the file tools, it USED them. Three
 * file-tool calls, two graph searches.
 *
 *   ON MAIN: the three file calls all fail (there is no clone), giving 3 errors out of
 *   5 code calls — an 0.6 error rate, past `MAX_TOOL_ERROR_RATE` (0.5). #773 brands the
 *   run `code-retrieval-degraded` and BOTH verdicts collapse to `could-not-verify`
 *   (asserted below as `["implemented", "gap-confirmed"]`, which main cannot produce).
 *
 *   WITH THE FIX: the tools are never offered, so those calls are the loop's "Unknown
 *   tool" repair errors — a model flailing against a KNOWN CAPABILITY LIMIT, which is
 *   not evidence that retrieval failed. They are excluded from the health counters, the
 *   two graph searches stand on their own, and the real verdicts survive.
 *
 * The exclusion is defence in depth: item 1 (never offer the tools) means a well-behaved
 * agent makes zero such calls. This guarantees that even a model that ignores the prompt
 * cannot resurrect the blanket-`could-not-verify` outcome through a different door.
 */
describe("#777 — a call to a withheld file tool cannot degrade the run", () => {
  const HALLUCINATION_SCRIPT = [
    DOC_ANSWER,
    JSON.stringify({ tool: "search_code_graph", query: "drift severity" }), // hits
    JSON.stringify({ tool: "read_file_slice", filePath: "server/src/drift/severity.ts" }), // withheld
    JSON.stringify({ tool: "list_files", pattern: "**/*.ts" }), // withheld
    JSON.stringify({ tool: "read_file_slice", filePath: "server/src/drift/baseline.ts" }), // withheld
    JSON.stringify({ tool: "search_code_graph", query: "tenant ingest quota" }), // empty, valid
    VERDICT_ANSWER,
  ];

  it("excludes the withheld tools from retrieval health and keeps the verdicts", async () => {
    await runPipeline(HALLUCINATION_SCRIPT);

    // The health counters see the two CODE SEARCHES only — the three unknown-tool
    // errors are a capability limit, and are not evidence about retrieval either way.
    expect(retrieval().totalCalls).toBe(2);
    expect(retrieval().erroredCalls).toBe(0);
    expect(retrieval().successfulSearches).toBe(1);
    expect(retrieval().degraded).toBe(false);

    expect(capability()?.reasons).not.toContain("code-retrieval-degraded");
    expect(capability()?.reasons).toContain("repo-clone-unavailable");
    expect(requirementVerdicts()).toEqual(["implemented", "gap-confirmed"]);
  });

  it("still reports the hallucinated calls in the #774 tool telemetry (operator triage)", async () => {
    await runPipeline(HALLUCINATION_SCRIPT);

    // Excluded from the VERDICT signal, never hidden from the operator: the telemetry
    // is how you find out a model is flailing against a tool it does not have.
    expect(toolTelemetry().errorCalls).toBe(3);
    expect(toolTelemetry().byTool.find((t) => t.tool === "read_file_slice")?.errors).toBe(2);
    expect(toolTelemetry().byTool.find((t) => t.tool === "list_files")?.errors).toBe(1);
  });
});
