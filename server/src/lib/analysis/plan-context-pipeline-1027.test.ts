/**
 * Issue #1027 — a run's plan context (`agentContext`) through the REAL pipeline.
 *
 * Drives `AnalysisOrchestrator.runPipeline` with a fake provider, as the #768
 * suite does, and observes what each model call was sent. The context must
 * reach the code agent in each of its three modes, must reach no other call,
 * and must change nothing that counts or names requirements: the same `NR-*`
 * set, the same affected-code candidates, the same capability record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapability } from "@metis/shared";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { AffectedCodeDeps } from "./affected-code-context.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";

const ANALYSIS_ID = "an_1027";
const PROJECT_ID = "pr_1027";

const state = {
  codeGraphPresent: true,
  connectors: [] as Array<{ id: string; label: string }>,
};
const persisted = {
  capability: [] as AnalysisCapability[],
  affectedCode: [] as Array<{ candidates: Array<{ id: string; title: string }> }>,
};

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => (state.codeGraphPresent ? { id: "cg_1" } : null)) },
    project: {
      findFirst: vi.fn(async () => ({
        id: PROJECT_ID,
        name: "Metis",
        description: "A test project",
        status: "active",
      })),
    },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: { count: vi.fn(async () => 0) },
    codeEdge: { count: vi.fn(async () => 0) },
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) =>
        where.agentKey === "document"
          ? { output: JSON.stringify({ requirements: [] }) }
          : { status: "completed" },
      ),
    },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => state.connectors) },
  },
}));

const createAnalysis = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ id: "an_1027" })),
);
vi.mock("./analysis-service.js", () => ({
  createAnalysis,
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
  getStructuredRequirements: vi.fn(async () => null),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => undefined),
  markAnalysisFailed: vi.fn(async () => undefined),
  persistAgentResult: vi.fn(async () => undefined),
  persistAnalysisEnhancement: vi.fn(async () => undefined),
  persistAnalysisCapability: vi.fn(async (_id: string, capability: AnalysisCapability) => {
    persisted.capability.push(capability);
  }),
  persistAnalysisAffectedCode: vi.fn(
    async (_id: string, result: { candidates: Array<{ id: string; title: string }> }) => {
      persisted.affectedCode.push(result);
    },
  ),
  persistAnalysisDatabaseAware: vi.fn(async () => undefined),
  persistAnalysisEscalation: vi.fn(async () => undefined),
  persistRequirements: vi.fn(async () => []),
  persistCrossDocFindings: vi.fn(async () => undefined),
  readFlattenedFindings: vi.fn(async () => []),
}));

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
const runSynthesis = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    output: { summary: "s", requirements: [], risks: [], recommendations: [] },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })),
);
vi.mock("./synthesis.js", () => ({ runSynthesis }));
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

// Review of #1027 — what each specialist's model call was built from, so the
// isolation of the document agent is asserted where it is enforced.
const runAgentInputs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("./agent-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-runner.js")>();
  return {
    ...actual,
    runAgent: vi.fn((...args: Parameters<typeof actual.runAgent>) => {
      runAgentInputs.push(args[1] as unknown as Record<string, unknown>);
      return actual.runAgent(...args);
    }),
  };
});

const { AnalysisOrchestrator } = await import("./orchestrator.js");
const { agenticPassEffectiveBudget, buildAgenticPassPrompt, planContextSeed } =
  await import("./agentic-pass-context.js");

const AGENT_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });

/** One model call: everything the provider was handed, as one string. */
type CapturedCall = string;

function makeProvider(calls: CapturedCall[]) {
  return {
    chat: vi.fn(async (messages: unknown, opts?: unknown) => {
      calls.push(JSON.stringify({ messages, opts }));
      return {
        content: AGENT_ANSWER,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        provider: "bedrock" as const,
      };
    }),
  };
}

const mapEveryRequirement: AffectedCodeDeps["mapRequirement"] = async (req) => [
  {
    codeSymbolId: `sym-${req.body.slice(0, 8)}`,
    filePath: "src/api-handler.ts",
    qualifiedName: "Handlers.handle",
    startLine: 10,
    endLine: 20,
    confidence: 0.9,
  },
];
const emptyGraphSource: AffectedCodeDeps["dataSourceFor"] = () =>
  ({
    getSymbol: async () => null,
    getEdgesFrom: async () => [],
    getEdgesTo: async () => [],
    getSymbolsByFile: async () => [],
    getSymbolsByIds: async () => [],
  }) as unknown as CodeGraphDataSource;

async function runPipeline(
  opts: { extraInstructions?: string; agentContext?: string },
  agentKeys: string[] = ["document", "code", "database"],
) {
  const calls: CapturedCall[] = [];
  const orch = new AnalysisOrchestrator({
    provider: makeProvider(calls) as never,
    retrieve: async () => [],
    knowledge: { search: async () => ({ hits: [] }) } as never,
    affectedCode: { mapRequirement: mapEveryRequirement, dataSourceFor: emptyGraphSource },
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
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", agentKeys, {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
    ...opts,
  });
  const capability = persisted.capability.at(-1);
  if (!capability) throw new Error("capability was never persisted");
  return {
    calls,
    capability,
    affectedCode: persisted.affectedCode.at(-1),
    synthesis: JSON.stringify(runSynthesis.mock.calls),
  };
}

const REQUIREMENTS = [
  "AC-1: Given a feed URL the user already follows, when they add it again, then it is refused.",
  "AC-2: Given a refused feed, when the page reloads, then the message names the existing feed.",
].join("\n\n");

// Every line is written the way a requirement would be, so anything that split
// this text into requirements would produce NR-3 onward.
const CONTEXT = [
  "Plan components (plan.md):",
  "- ZebraFeedGuard — the system shall reject duplicates in storage/feed.go (AC-1)",
  "Tasks (tasks.md):",
  "- T01: The service must add a unique index on feeds (satisfies: AC-1)",
  "- T02: Users can see the ZebraNotice message (satisfies: AC-2)",
].join("\n");
const MARK = "ZebraFeedGuard";
const BEGIN = "BEGIN PLAN CONTEXT (BACKGROUND, NOT REQUIREMENTS)";

const holding = (calls: CapturedCall[], text: string) => calls.filter((c) => c.includes(text));

/**
 * Review of #1027 — the same pipeline with the REAL retrieval code and doubles
 * that RECORD what they are asked. `runPipeline` above cannot show that the
 * context is never a search query: its `retrieve` seam replaces the retrieval
 * call whole and ignores its argument, and fused retrieval is switched off, so
 * a build that joined the context into every query passed every test.
 */
async function runRecording(
  opts: { extraInstructions?: string; agentContext?: string },
  agentKeys: string[] = ["document", "code"],
) {
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "true";
  process.env.ANALYSIS_SCHEMA_CONTEXT = "false";
  __resetConfigSingleton();
  const calls: CapturedCall[] = [];
  /** Every query handed to a document or code search. */
  const queries: string[] = [];
  /** Every requirement handed to the affected-code mapper. */
  const mapped: string[] = [];
  const orch = new AnalysisOrchestrator({
    provider: makeProvider(calls) as never,
    knowledge: {
      search: async (_projectId: string, query: string) => {
        queries.push(query);
        return { hits: [] };
      },
    } as never,
    fusedCode: {
      searcher: {
        search: async (query: string) => {
          queries.push(query);
          return [];
        },
      },
      lineLookup: { resolve: async () => new Map() },
    },
    affectedCode: {
      mapRequirement: async (req, ...rest) => {
        mapped.push(JSON.stringify(req));
        return mapEveryRequirement!(req, ...rest);
      },
      dataSourceFor: emptyGraphSource,
    },
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
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", agentKeys, {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
    ...opts,
  });
  const capability = persisted.capability.at(-1);
  if (!capability) throw new Error("capability was never persisted");
  return { calls, queries, mapped, capability };
}

/** Words that occur only in CONTEXT, one from each of its lines. */
const CONTEXT_ONLY = [MARK, "Plan components", "storage/feed.go", "T01", "unique index", "T02"];
const expectNoContextIn = (texts: string[]) => {
  for (const text of texts) {
    for (const word of CONTEXT_ONLY) expect(text).not.toContain(word);
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  runAgentInputs.length = 0;
  state.codeGraphPresent = true;
  state.connectors = [];
  persisted.capability = [];
  persisted.affectedCode = [];
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_SCHEMA_CONTEXT;
  __resetConfigSingleton();
});

describe("#1027 — plan context through the pipeline", () => {
  it("reaches the agentic code agent, and only it", async () => {
    const run = await runPipeline({ extraInstructions: REQUIREMENTS, agentContext: CONTEXT });

    expect(run.capability.agentMode).toBe("agentic");
    const withContext = holding(run.calls, MARK);
    expect(withContext.length).toBeGreaterThan(0);
    for (const call of withContext) {
      expect(call).toContain("MODE: AGENTIC");
      expect(call).toContain(BEGIN);
    }
    // Every agentic call carries it; the document and database calls do not.
    expect(holding(run.calls, "MODE: AGENTIC")).toEqual(withContext);
    expect(run.calls.length).toBeGreaterThan(withContext.length);
    expect(run.synthesis).not.toContain(MARK);
  });

  it("adds no requirement: the same NR ids, candidates and capability as without it", async () => {
    const without = await runPipeline({ extraInstructions: REQUIREMENTS });
    const withContext = await runPipeline({
      extraInstructions: REQUIREMENTS,
      agentContext: CONTEXT,
    });

    expect(withContext.affectedCode?.candidates.map((c) => c.id)).toEqual(["NR-1", "NR-2"]);
    expect(withContext.affectedCode).toEqual(without.affectedCode);
    expect(withContext.capability).toEqual(without.capability);
    expect(holding(withContext.calls, "NR-3")).toEqual([]);
    // The calls that do not carry the context are the calls of the run without it.
    const untouched = withContext.calls.filter((c) => !c.includes(MARK));
    expect(untouched).toEqual(without.calls.filter((c) => !c.includes("MODE: AGENTIC")));
    expect(withContext.calls).toHaveLength(without.calls.length);
  });

  it("does not make a run agentic on its own: context is not a requirement", async () => {
    const run = await runPipeline({ agentContext: CONTEXT });

    expect(run.capability.agentMode).toBe("single-shot");
    expect(run.capability.newRequirementsProvided).not.toBe(true);
    expect(run.affectedCode?.candidates ?? []).toEqual([]);
    // The single-shot code call still reads it; the other specialists do not.
    const withContext = holding(run.calls, MARK);
    expect(withContext).toHaveLength(1);
    expect(withContext[0]).toContain(BEGIN);
    expect(run.calls.length).toBeGreaterThan(1);
  });

  it("reaches every repo's agentic pass on a multi-repo project", async () => {
    state.connectors = [
      { id: "c1", label: "api" },
      { id: "c2", label: "web" },
    ];
    const run = await runPipeline({ extraInstructions: REQUIREMENTS, agentContext: CONTEXT });

    const agenticCalls = holding(run.calls, "MODE: AGENTIC");
    expect(holding(agenticCalls, "[repo: api]").length).toBeGreaterThan(0);
    expect(holding(agenticCalls, "[repo: web]").length).toBeGreaterThan(0);
    expect(holding(run.calls, MARK)).toEqual(agenticCalls);
  });

  it("reaches a code-only run, which takes the path without a document agent", async () => {
    const run = await runPipeline({ agentContext: CONTEXT }, ["code", "database"]);

    expect(run.capability.agentMode).toBe("single-shot");
    const withContext = holding(run.calls, MARK);
    expect(withContext).toHaveLength(1);
    expect(withContext[0]).toContain(BEGIN);
    expect(run.calls).toHaveLength(2);
  });

  it("reaches the requirement-grounded code agent when there is no code graph", async () => {
    state.codeGraphPresent = false;
    const run = await runPipeline({ extraInstructions: REQUIREMENTS, agentContext: CONTEXT });

    expect(run.capability.agentMode).toBe("requirement-grounded");
    const withContext = holding(run.calls, MARK);
    expect(withContext).toHaveLength(1);
    expect(withContext[0]).toContain("MODE: REQUIREMENT-GROUNDED");
    expect(withContext[0]).toContain(BEGIN);
  });

  it("sends byte-identical calls when the field is absent, undefined or blank", async () => {
    const absent = await runPipeline({ extraInstructions: REQUIREMENTS });
    const undef = await runPipeline({ extraInstructions: REQUIREMENTS, agentContext: undefined });
    const blank = await runPipeline({ extraInstructions: REQUIREMENTS, agentContext: "" });
    const spaces = await runPipeline({ extraInstructions: REQUIREMENTS, agentContext: " \n " });

    expect(undef.calls).toEqual(absent.calls);
    expect(blank.calls).toEqual(absent.calls);
    expect(spaces.calls).toEqual(absent.calls);
    expect(holding(absent.calls, "PLAN CONTEXT")).toEqual([]);
  });
});

describe("#1027 — the plan context is never a retrieval query", () => {
  it("agentic: the code search is asked for the requirements, never the context", async () => {
    const without = await runRecording({ extraInstructions: REQUIREMENTS });
    const run = await runRecording({ extraInstructions: REQUIREMENTS, agentContext: CONTEXT });

    expect(run.capability.agentMode).toBe("agentic");
    // The recorder sees real queries: the requirements text is in them.
    expect(run.queries.length).toBeGreaterThan(0);
    expect(run.queries.some((q) => q.includes("feed URL the user already follows"))).toBe(true);
    expectNoContextIn(run.queries);
    expect(run.queries).toEqual(without.queries);
    // …and the context did reach the agent, so this is not a run without it.
    expect(holding(run.calls, MARK).length).toBeGreaterThan(0);
  });

  it("requirement-grounded: neither the per-requirement search nor the code search sees it", async () => {
    state.codeGraphPresent = false;
    const without = await runRecording({ extraInstructions: REQUIREMENTS });
    const run = await runRecording({ extraInstructions: REQUIREMENTS, agentContext: CONTEXT });

    expect(run.capability.agentMode).toBe("requirement-grounded");
    // One document search per requirement, and the fused code search.
    expect(run.queries.length).toBeGreaterThanOrEqual(3);
    expect(run.queries.some((q) => q.includes("feed URL the user already follows"))).toBe(true);
    expectNoContextIn(run.queries);
    expect(run.queries).toEqual(without.queries);
    expect(holding(run.calls, MARK)).toHaveLength(1);
  });

  it("single-shot: the document, code and fused searches are asked nothing from it", async () => {
    const without = await runRecording({});
    const run = await runRecording({ agentContext: CONTEXT });

    expect(run.capability.agentMode).toBe("single-shot");
    expect(run.queries.length).toBeGreaterThan(0);
    // The queries are derived from the project, as they are without a context.
    expect(run.queries.some((q) => q.includes("Metis"))).toBe(true);
    expectNoContextIn(run.queries);
    expect(run.queries).toEqual(without.queries);
    expect(holding(run.calls, MARK)).toHaveLength(1);
  });

  it("is not a requirement to the affected-code mapper, in any mode", async () => {
    for (const codeGraphPresent of [true, false]) {
      state.codeGraphPresent = codeGraphPresent;
      const without = await runRecording({ extraInstructions: REQUIREMENTS });
      const run = await runRecording({ extraInstructions: REQUIREMENTS, agentContext: CONTEXT });
      expect(run.mapped).toHaveLength(2);
      expectNoContextIn(run.mapped);
      expect(run.mapped).toEqual(without.mapped);
    }
    // Alone, it gives the mapper nothing to map.
    expect((await runRecording({ agentContext: CONTEXT })).mapped).toEqual([]);
  });
});

describe("#1027 — only the code agent's model call is built from the context", () => {
  const inputsFor = (agentKey: string) => runAgentInputs.filter((i) => i.agentKey === agentKey);

  it("hands it to the single-shot code agent and to no other specialist", async () => {
    await runPipeline({ agentContext: CONTEXT }, ["document", "code", "database"]);

    expect(inputsFor("code")).toHaveLength(1);
    expect(inputsFor("code")[0]!.agentContext).toBe(CONTEXT);
    expect(inputsFor("document")).toHaveLength(1);
    expect(inputsFor("database")).toHaveLength(1);
    for (const input of [...inputsFor("document"), ...inputsFor("database")]) {
      expect(input).not.toHaveProperty("agentContext");
    }
  });

  // Without a code agent the document agent is not run ahead of the others: it
  // goes through the same fan-out the code agent uses, which is handed the
  // run's context. `runOneAgent` is what keeps it from the document agent
  // there, and what it extracts as requirements is what the code pass reads.
  it("keeps it from the document agent on a run that fans every specialist out together", async () => {
    await runPipeline({ agentContext: CONTEXT }, ["document", "database"]);

    expect(inputsFor("document")).toHaveLength(1);
    expect(inputsFor("database")).toHaveLength(1);
    for (const input of runAgentInputs) expect(input).not.toHaveProperty("agentContext");
    expect(JSON.stringify(runAgentInputs)).not.toContain(MARK);
  });
});

describe("#1027 — start() stores the context and runs the pipeline with it", () => {
  async function start(opts: { agentContext?: string }) {
    const calls: CapturedCall[] = [];
    const orch = new AnalysisOrchestrator({
      provider: makeProvider(calls) as never,
      retrieve: async () => [],
      knowledge: { search: async () => ({ hits: [] }) } as never,
      affectedCode: { mapRequirement: mapEveryRequirement, dataSourceFor: emptyGraphSource },
    });
    await orch.start({
      projectId: PROJECT_ID,
      startedById: "u1",
      agentKeys: ["code"],
      extraInstructions: REQUIREMENTS,
      ...opts,
    });
    // The pipeline runs in the background; it is done once it has finalized.
    await vi.waitFor(() => expect(persisted.capability.length).toBeGreaterThan(0));
    return calls;
  }

  it("persists the context on the run and hands it to the code agent", async () => {
    const calls = await start({ agentContext: CONTEXT });
    expect(createAnalysis.mock.calls[0]![0]).toMatchObject({
      agentContext: CONTEXT,
      extraInstructions: REQUIREMENTS,
    });
    expect(holding(calls, MARK).length).toBeGreaterThan(0);
  });

  it("persists no context key on a run started without one", async () => {
    await start({});
    expect(createAnalysis.mock.calls[0]![0]).not.toHaveProperty("agentContext");
  });

  // Review of #1027 — a whitespace-only value used to be stored, fenced as an
  // empty block by two builders, trimmed away by the third and dropped on a
  // regenerate. It is no context, everywhere.
  it("treats a whitespace-only context as none: not stored, not sent", async () => {
    const calls = await start({ agentContext: "  \n\t " });
    expect(createAnalysis.mock.calls[0]![0]).not.toHaveProperty("agentContext");
    expect(holding(calls, "PLAN CONTEXT")).toEqual([]);
  });

  it("stores and sends the context trimmed", async () => {
    const calls = await start({ agentContext: `\n  ${CONTEXT}\n\n` });
    expect(createAnalysis.mock.calls[0]![0]).toMatchObject({ agentContext: CONTEXT });
    expect(
      holding(calls, `${BEGIN} ===METIS-DATA-BOUNDARY===\\n${CONTEXT.split("\n")[0]}`).length,
    ).toBeGreaterThan(0);
  });
});

describe("#1027 — the plan context is paid for out of the pass budget", () => {
  const seeds = {
    fused: { block: "", tokens: 1_000 },
    affectedCode: { block: "", tokens: 500 },
    affectedSchema: { block: "", tokens: 0 },
  };

  it("estimates the seed at characters / 4, and has none for a blank context", () => {
    expect(planContextSeed("x".repeat(4096))).toEqual({ block: "x".repeat(4096), tokens: 1024 });
    expect(planContextSeed(undefined)).toBeUndefined();
    expect(planContextSeed("  \n ")).toBeUndefined();
  });

  it("carves the context's tokens out of the loop's budget", () => {
    const planContext = planContextSeed("x".repeat(4096))!;
    expect(agenticPassEffectiveBudget(100_000, seeds)).toBe(98_500);
    expect(agenticPassEffectiveBudget(100_000, { ...seeds, planContext })).toBe(97_476);
  });

  it("keeps the half-budget floor however large the seeds are", () => {
    const planContext = { block: "x", tokens: 90_000 };
    expect(agenticPassEffectiveBudget(100_000, { ...seeds, planContext })).toBe(50_000);
  });

  it("builds the same pass prompt when there is no context seed", () => {
    const input = {
      projectName: "Metis",
      projectDescription: "d",
      requirements: [{ id: "NR-1", text: "t" }],
      fileToolsAvailable: true,
    };
    const without = buildAgenticPassPrompt({ ...input, seeds });
    const withSeed = buildAgenticPassPrompt({
      ...input,
      seeds: { ...seeds, planContext: planContextSeed(CONTEXT)! },
    });
    expect(without.userMessage).not.toContain("PLAN CONTEXT");
    expect(withSeed.userMessage).toContain(`${BEGIN} `);
    expect(withSeed.userMessage).toContain(MARK);
  });
});
