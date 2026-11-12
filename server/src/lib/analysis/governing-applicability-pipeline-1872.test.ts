/**
 * #1872 (epic #1866) — the applicability hook in the REAL analysis pipeline.
 *
 * Drives `AnalysisOrchestrator.runPipeline` down the requirement-grounded code
 * path (no code graph), where `retrievePerRequirement` runs and the hook sits
 * beside it. With `GOVERNING_DOCS_ENABLED` off, every model call and the
 * persisted code result must be byte-identical to the snapshot taken before
 * the hook existed, and the database is never asked for a project's workspace
 * or its rules. With it on, the hook screens the workspace's rules — and still
 * changes nothing the code agent is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import {
  MAX_REQUIREMENTS_FOR_RETRIEVAL,
  REQUIREMENT_RETRIEVAL_CONCURRENCY,
  type AnalysisCapability,
} from "@metis/shared";
import { __resetConfigSingleton } from "../config/config-service.js";
import { MAX_REQUIREMENT_QUERY_CHARS } from "./requirement-query.js";

const ANALYSIS_ID = "an_1872";
const PROJECT_ID = "pr_1872";

const state = vi.hoisted(() => ({
  workspaceId: null as string | null,
  rules: [] as Array<Record<string, unknown>>,
  /** #1997 — governing replies finished when the analysis was marked completed. */
  governingDoneAtCompletion: -1,
  /** #2022 — the document agent's requirements; two unless a test sets more. */
  requirements: null as Array<{ id: string; text: string }> | null,
  /** #2233 — how many findings the non-code specialists write. */
  otherFindings: 0,
  /** #2233 — every query the knowledge search was given. */
  searchQueries: [] as string[],
  /** #2233 — what the custom-agent phase returns. */
  customResults: [] as Array<Record<string, unknown>>,
}));
/** #2022 — every requirement the applicability hook was asked to decide. */
const decided = vi.hoisted(() => ({ ids: [] as string[] }));
/** #1997 — how many governing replies have been returned so far. */
const progress = vi.hoisted(() => ({ governingDone: 0 }));

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => null) },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    codeEdge: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) =>
        where.agentKey === "document"
          ? {
              output: JSON.stringify({
                requirements: state.requirements ?? [
                  { id: "REQ-001", text: "Export every customer's order history as a CSV." },
                  { id: "REQ-002", text: "Remove the legacy coupon screen." },
                ],
              }),
            }
          : { status: "completed" },
      ),
    },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
    project: {
      findFirst: vi.fn(async () => ({ workspaceId: state.workspaceId })),
    },
    governingRule: { findMany: vi.fn(async () => state.rules) },
    // The governing index's own reads: a live workspace with no embedded revision.
    workspace: { findFirst: vi.fn(async () => ({ id: state.workspaceId })) },
    governingDocument: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
  getStructuredRequirements: vi.fn(async () => null),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => {
    state.governingDoneAtCompletion = progress.governingDone;
  }),
  markAnalysisFailed: vi.fn(async () => undefined),
  persistAgentResult: vi.fn(async () => ({ id: "ar_1", findingIds: [] })),
  persistAnalysisEnhancement: vi.fn(async () => undefined),
  persistAnalysisCapability: vi.fn(async () => undefined),
  persistAnalysisAffectedCode: vi.fn(async () => undefined),
  persistAnalysisDatabaseAware: vi.fn(async () => undefined),
  persistAnalysisEscalation: vi.fn(async () => undefined),
  persistRequirements: vi.fn(async () => []),
  persistCrossDocFindings: vi.fn(async () => undefined),
  readFlattenedFindings: vi.fn(async () => []),
  // #1873 — the join stores the applicability on the analysis.
  updateGoverningApplicabilityMetadata: vi.fn(async () => undefined),
  readGoverningApplicabilityMetadata: vi.fn(async () => undefined),
}));

// #2022 — the real hook, with every `decide` call recorded.
vi.mock("../governing/applicability.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../governing/applicability.js")>();
  return {
    ...real,
    governingApplicabilityHookFor: async (
      input: Parameters<typeof real.governingApplicabilityHookFor>[0],
    ) => {
      const hook = await real.governingApplicabilityHookFor(input);
      return (
        hook && {
          ...hook,
          decide: (requirement: { id: string; text: string }) => {
            decided.ids.push(requirement.id);
            return hook.decide(requirement);
          },
        }
      );
    },
  };
});

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
// #1874 — the findings the join produces from the stored applicability.
vi.mock("../governing/findings-store.js", () => ({
  produceGoverningFindingsForAnalysis: vi.fn(async () => ({
    requirements: 0,
    written: 0,
    removed: 0,
    unverifiedCitations: 0,
    noEvidenceDemoted: 0,
    failed: 0,
  })),
}));
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
    results: state.customResults,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  })),
  // #1997 — the orchestrator persists the phase's results; without this every
  // run logged a failed custom-agent phase.
  persistAgentPhaseResults: vi.fn(async () => undefined),
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
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");
const analysisService = await import("./analysis-service.js");
const { prisma } = await import("../prisma.js");
const findingsStore = await import("../governing/findings-store.js");
const { GOVERNING_RULES_UNAVAILABLE } = await import("../governing/applicability.js");
/** #2010 — the orchestrator of the run in progress, for a test that cancels it. */
const orchestrator: { current?: InstanceType<typeof AnalysisOrchestrator> } = {};

const CODE_ANSWER = JSON.stringify({
  summary: "ok",
  findings: [
    {
      requirementId: "REQ-001",
      category: "other",
      severity: "medium",
      title: "The export has no row cap",
      body: "The order history can be large.",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

interface Call {
  system: string;
  messages: Array<{ role: string; content: string }>;
}

function userOf(c: Call): string {
  return c.messages.map((m) => m.content).join("\n");
}

const isGoverning = (c: Call) => userOf(c).includes("governing_rule");

/**
 * #1997 — every governing call waits for the code agent's call to have been
 * made (giving up after `GATE_MS`, which `timeline.waitedOut` records): when
 * applicability runs ahead of the code agent instead of beside it, the gate
 * can never open. Each governing reply is also a little slow, so a run that
 * did not join the work would be marked completed before it finished.
 */
const GATE_MS = 1_500;
function makeProvider() {
  const calls: Call[] = [];
  const timeline = { waitedOut: false };
  let openGate!: () => void;
  const codeCalled = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const chat = vi.fn(async (messages: ChatMessage[], o: ChatOptions = {}) => {
    const call: Call = {
      system: String((o as { systemMessage?: unknown }).systemMessage ?? ""),
      messages: messages.map((m) => ({ role: m.role, content: String(m.content) })),
    };
    calls.push(call);
    if (isGoverning(call)) {
      await Promise.race([
        codeCalled,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            timeline.waitedOut = true;
            resolve();
          }, GATE_MS),
        ),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      progress.governingDone++;
    } else if (call.system.includes("requirementId")) {
      openGate();
    }
    const text = (content: string) => ({
      content,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      model: "test-model",
      provider: "bedrock" as const,
    });
    const user = call.messages.map((m) => m.content).join("\n");
    if (user.includes("governing_rule_summaries")) return text('{"rules":["R1"]}');
    if (user.includes("governing_rules")) {
      return text(
        '{"decisions":[{"rule":"R1","verdict":"applies","reason":"The export reads customer records."}]}',
      );
    }
    if (call.system.includes("requirementId")) return text(CODE_ANSWER);
    // #2233 — the other specialists answer with `otherFindings` findings.
    return text(
      JSON.stringify({
        summary: "ok",
        findings: Array.from({ length: state.otherFindings }, (_, i) => ({
          category: "other",
          severity: "low",
          title: `Document finding ${i + 1}`,
          body: "b",
          tags: [],
          citations: [],
        })),
        notes: [],
      }),
    );
  });
  return { provider: { key: "bedrock", model: "test-model", chat } as never, calls, timeline };
}

/** #2233 — the embeddings sidecar's input limit (`embeddings-svc/src/app.ts`). */
const SIDECAR_MAX_INPUT_CHARS = 32_768;

async function runPipeline(
  made: ReturnType<typeof makeProvider> = makeProvider(),
  extra: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
) {
  const { provider, calls, timeline } = made;
  const orch = new AnalysisOrchestrator({
    ...deps,
    provider,
    retrieve: async () => [],
    knowledge: {
      search: async (_projectId: string, query: string) => {
        state.searchQueries.push(query);
        // #2233 — as the sidecar embedder does: a non-retryable 400 past its limit.
        if (query.length > SIDECAR_MAX_INPUT_CHARS) {
          throw new Error(
            `embeddings sidecar 400: input over ${SIDECAR_MAX_INPUT_CHARS} characters`,
          );
        }
        return {
          hits: [
            {
              chunkId: "doc_1#0",
              documentId: "doc_1",
              filename: "brief.md",
              position: 0,
              text: `Brief: ${query.slice(0, 40)}`,
              score: 1,
              embeddingModel: "test",
              source: "upload",
            },
          ],
        };
      },
    } as never,
  });
  orchestrator.current = orch;
  await (
    orch as unknown as {
      runPipeline: (
        a: string,
        b: string,
        c: string,
        d: string[],
        e: Record<string, unknown>,
      ) => Promise<void>;
    }
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", ["document", "code"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
    ...extra,
  });
  const persisted = (
    vi.mocked(analysisService.persistAgentResult).mock.calls as unknown as Array<
      [{ agentKey: string; output: unknown }]
    >
  )
    .map((c) => c[0])
    .filter((a) => a.agentKey === "code")
    .map((a) => a.output);
  return { calls, persisted, timeline };
}

/** #2233 — the capability record the run persisted last. */
function persistedCapability(): AnalysisCapability {
  const calls = vi.mocked(analysisService.persistAnalysisCapability).mock.calls as unknown as Array<
    [string, AnalysisCapability]
  >;
  expect(calls.length, "the run persisted its capability").toBeGreaterThan(0);
  return calls.at(-1)![1];
}

/** What the analysis produced: every model call and the persisted code result. */
function analysisOutput(run: Awaited<ReturnType<typeof runPipeline>>, governing = false): string {
  return JSON.stringify(
    { calls: run.calls.filter((c) => isGoverning(c) === governing), persisted: run.persisted },
    null,
    2,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.workspaceId = null;
  state.rules = [];
  state.governingDoneAtCompletion = -1;
  state.requirements = null;
  state.otherFindings = 0;
  state.searchQueries = [];
  state.customResults = [];
  decided.ids = [];
  progress.governingDone = 0;
  process.env.GOVERNING_DOCS_ENABLED = "0";
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.GOVERNING_DOCS_ENABLED;
  __resetConfigSingleton();
});

describe("#1872 — governing applicability in the analysis pipeline", () => {
  it("flag off: the analysis output is byte-identical to the pre-#1872 snapshot, and no workspace or rule is read", async () => {
    const run = await runPipeline();
    expect(run.persisted).toHaveLength(1);
    expect(analysisOutput(run)).toMatchSnapshot();
    expect(run.calls.some(isGoverning)).toBe(false);
    expect(vi.mocked(prisma.project.findFirst)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.governingRule.findMany)).not.toHaveBeenCalled();
    // #1873 — nothing decided, nothing stored on the analysis.
    expect(vi.mocked(analysisService.updateGoverningApplicabilityMetadata)).not.toHaveBeenCalled();
    expect(vi.mocked(findingsStore.produceGoverningFindingsForAnalysis)).not.toHaveBeenCalled();
  });

  it("flag on, project with no workspace: skipped, the output is the flag-off output", async () => {
    const off = analysisOutput(await runPipeline());
    vi.clearAllMocks();
    process.env.GOVERNING_DOCS_ENABLED = "1";
    const on = await runPipeline();
    expect(analysisOutput(on)).toBe(off);
    expect(on.calls.some(isGoverning)).toBe(false);
    expect(vi.mocked(prisma.project.findFirst)).toHaveBeenCalled();
    expect(vi.mocked(prisma.governingRule.findMany)).not.toHaveBeenCalled();
  });

  it("flag on, workspace with current rules: every requirement is screened and judged; the code agent is sent the same prompt", async () => {
    const off = analysisOutput(await runPipeline());
    vi.clearAllMocks();
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [
      {
        id: "rule_audit",
        revisionId: "rev_1",
        controlId: "LG-03",
        summary: "Log every read of customer records to the audit log.",
        clauseRef: "§3",
        clauseExcerpt: "Every read of customer records is written to the audit log.",
        revision: { revisionLabel: "v1", document: { title: "Info Policy" } },
      },
    ];
    const on = await runPipeline();
    const governing = on.calls.filter(isGoverning);
    // Per requirement: one screen batch, one judging call.
    expect(governing).toHaveLength(4);
    expect(governing.every((c) => userOf(c).includes("LG-03"))).toBe(true);
    expect(governing.some((c) => userOf(c).includes("Export every customer's order history"))).toBe(
      true,
    );
    expect(analysisOutput(on)).toBe(off);
    // #1997 — beside the code agent, not ahead of it: no governing call had to
    // give up waiting for the code agent's call…
    expect(on.timeline.waitedOut).toBe(false);
    // …and joined before the run was recorded: every governing reply was in
    // when the analysis was marked completed.
    expect(state.governingDoneAtCompletion).toBe(4);
    // #1873 — and stored on the analysis: both requirements, the rule applying.
    const store = vi.mocked(analysisService.updateGoverningApplicabilityMetadata);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0]![0]).toBe(ANALYSIS_ID);
    const stored = (store.mock.calls[0]![1] as (c: unknown) => unknown)(undefined) as {
      requirements: Array<{ requirementId: string; decisions: Array<Record<string, unknown>> }>;
    };
    expect(stored.requirements.map((r) => r.requirementId)).toEqual(["REQ-001", "REQ-002"]);
    expect(stored.requirements[0]!.decisions).toEqual([
      expect.objectContaining({ ruleId: "rule_audit", controlId: "LG-03", verdict: "applies" }),
    ]);
    // #1874 — and the cited findings are produced from exactly that applicability.
    const produce = vi.mocked(findingsStore.produceGoverningFindingsForAnalysis);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(produce.mock.calls[0]![0]).toMatchObject({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      applicability: stored,
    });
    expect(vi.mocked(analysisService.markAnalysisCompleted)).toHaveBeenCalledTimes(1);
    const where = vi.mocked(prisma.governingRule.findMany).mock.calls[0]![0] as {
      where: { revision: { currentOf: { is: { workspaceId: string } } } };
    };
    expect(where.where.revision.currentOf.is.workspaceId).toBe("ws_1872");
  });

  it("#1997 — flag on, the rules cannot be loaded: the analysis completes unchanged and asks no governing question", async () => {
    const off = analysisOutput(await runPipeline());
    vi.clearAllMocks();
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    vi.mocked(prisma.governingRule.findMany).mockRejectedValueOnce(new Error("database is locked"));
    const on = await runPipeline();
    expect(analysisOutput(on)).toBe(off);
    expect(on.calls.some(isGoverning)).toBe(false);
    expect(vi.mocked(prisma.governingRule.findMany)).toHaveBeenCalled();
    expect(vi.mocked(analysisService.markAnalysisCompleted)).toHaveBeenCalledTimes(1);
    // #2008 — and the joined evidence says why: every requirement is undecided
    // with the error, not the flag-off "nothing to check" (which stores nothing).
    const store = vi.mocked(analysisService.updateGoverningApplicabilityMetadata);
    expect(store).toHaveBeenCalledTimes(1);
    const stored = (store.mock.calls[0]![1] as (c: unknown) => unknown)(undefined) as {
      requirements: Array<{ requirementId: string; decisions: unknown[]; error?: string }>;
    };
    expect(stored.requirements).toEqual([
      // #2016 — the load-failure constant itself, not any string.
      expect.objectContaining({
        requirementId: "REQ-001",
        decisions: [],
        error: GOVERNING_RULES_UNAVAILABLE,
      }),
      expect.objectContaining({
        requirementId: "REQ-002",
        decisions: [],
        error: GOVERNING_RULES_UNAVAILABLE,
      }),
    ]);
  });

  it("#2008 — a run that fails before the join ends with the unjoined applicability work aborted", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [
      {
        id: "rule_audit",
        revisionId: "rev_1",
        controlId: "LG-03",
        summary: "Log every read of customer records to the audit log.",
        clauseRef: "§3",
        clauseExcerpt: "Every read of customer records is written to the audit log.",
        revision: { revisionLabel: "v1", document: { title: "Info Policy" } },
      },
    ];
    const signals: AbortSignal[] = [];
    let returned = false;
    /** Governing calls started after the run returned, with a signal not aborted. */
    let liveAfterReturn = 0;
    const made = makeProvider();
    const chat = vi.mocked(
      (made.provider as unknown as { chat: (m: ChatMessage[], o?: ChatOptions) => unknown }).chat,
    );
    const specialists = chat.getMockImplementation()!;
    chat.mockImplementation(async (messages: ChatMessage[], o: ChatOptions = {}) => {
      const user = messages.map((m) => String(m.content)).join("\n");
      if (!user.includes("governing_rule")) return specialists(messages, o);
      const signal = o.signal!;
      signals.push(signal);
      if (returned && !signal.aborted) liveAfterReturn++;
      // Slow enough that the work is still running when the run is marked failed.
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return {
        content: user.includes("governing_rule_summaries")
          ? '{"rules":["R1"]}'
          : '{"decisions":[{"rule":"R1","verdict":"applies","reason":"Reads records."}]}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        provider: "bedrock" as const,
      };
    });
    // Synthesis throws: the generic-catch exit, which skips the join.
    vi.mocked(analysisService.readFlattenedFindings).mockRejectedValueOnce(
      new Error("database is locked"),
    );
    await runPipeline(made);
    returned = true;
    expect(vi.mocked(analysisService.markAnalysisFailed)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analysisService.markAnalysisCompleted)).not.toHaveBeenCalled();
    // The work outlives the run: let what it still does reach the model…
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(signals.length).toBeGreaterThan(0);
    // …and every call it made after the run returned carried an aborted signal.
    expect(liveAfterReturn).toBe(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
    // It was never joined: nothing was stored or produced from it.
    expect(vi.mocked(analysisService.updateGoverningApplicabilityMetadata)).not.toHaveBeenCalled();
  });

  it("#1997 — the custom-agent phase's results are persisted (the mock carries persistAgentPhaseResults)", async () => {
    const phase = await import("./custom-agent-phase.js");
    await runPipeline();
    expect(vi.mocked(phase.persistAgentPhaseResults)).toHaveBeenCalledWith(ANALYSIS_ID, []);
  });
});

const AUDIT_RULE = {
  id: "rule_audit",
  revisionId: "rev_1",
  controlId: "LG-03",
  summary: "Log every read of customer records to the audit log.",
  clauseRef: "§3",
  clauseExcerpt: "Every read of customer records is written to the audit log.",
  revision: { revisionLabel: "v1", document: { title: "Info Policy" } },
};

/** #2022 — a governing model call that waits for its signal to abort, then fails with it. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail, { once: true });
  });
}

describe("#2010 — a cancel during synthesis", () => {
  it("ends the run cancelled before the join: no findings are produced or stored", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [AUDIT_RULE];
    // #2022 — more requirements than run at once, every governing call held
    // until the cancel: the requirements no worker reached are never decided.
    state.requirements = Array.from({ length: REQUIREMENT_RETRIEVAL_CONCURRENCY + 2 }, (_, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      text: `Export customer report number ${i + 1} as a CSV.`,
    }));
    const made = makeProvider();
    const chat = vi.mocked(
      (made.provider as unknown as { chat: (m: ChatMessage[], o?: ChatOptions) => unknown }).chat,
    );
    const specialists = chat.getMockImplementation()!;
    chat.mockImplementation(async (messages: ChatMessage[], o: ChatOptions = {}) => {
      const user = messages.map((m) => String(m.content)).join("\n");
      if (!user.includes("governing_rule")) return specialists(messages, o);
      return untilAborted(o.signal!);
    });
    const synthesis = await import("./synthesis.js");
    vi.mocked(synthesis.runSynthesis).mockImplementationOnce(async () => {
      // The user presses Cancel while synthesis runs; its fallback never throws.
      expect(await orchestrator.current!.cancel(ANALYSIS_ID, "u1")).toBe(true);
      return {
        output: { summary: "s", requirements: [], risks: [], recommendations: [] },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      } as never;
    });
    await runPipeline(made);
    expect(vi.mocked(synthesis.runSynthesis)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analysisService.markAnalysisCancelled)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analysisService.markAnalysisCompleted)).not.toHaveBeenCalled();
    expect(vi.mocked(findingsStore.produceGoverningFindingsForAnalysis)).not.toHaveBeenCalled();
    expect(vi.mocked(analysisService.updateGoverningApplicabilityMetadata)).not.toHaveBeenCalled();
    // #2022 — the orchestrator hands the loop its signal: after the cancel no
    // worker takes another requirement, so only those already in flight were
    // ever decided. The work outlives the run, so give it time to go on.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(decided.ids).toEqual(
      state.requirements.slice(0, REQUIREMENT_RETRIEVAL_CONCURRENCY).map((r) => r.id),
    );
  });
});

describe("#2022 — a cancel during the governing join", () => {
  it("stores no partial applicability and produces no findings: the run ends cancelled", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [AUDIT_RULE];
    const made = makeProvider();
    const chat = vi.mocked(
      (made.provider as unknown as { chat: (m: ChatMessage[], o?: ChatOptions) => unknown }).chat,
    );
    const specialists = chat.getMockImplementation()!;
    const active = () =>
      (
        orchestrator.current as unknown as {
          active: Map<string, { controllers: Map<string, AbortController> }>;
        }
      ).active.get(ANALYSIS_ID);
    chat.mockImplementation(async (messages: ChatMessage[], o: ChatOptions = {}) => {
      const user = messages.map((m) => String(m.content)).join("\n");
      // REQ-001 is decided at once; REQ-002 is still being decided at the join.
      if (!user.includes("governing_rule") || !user.includes("legacy coupon")) {
        return specialists(messages, o);
      }
      // The user presses Cancel once the run is waiting for this work in the join.
      await vi.waitFor(() => expect(active()?.controllers.has("governing")).toBe(true), {
        timeout: 5_000,
      });
      expect(await orchestrator.current!.cancel(ANALYSIS_ID, "u1")).toBe(true);
      return untilAborted(o.signal!);
    });
    await runPipeline(made);
    expect(decided.ids).toEqual(["REQ-001", "REQ-002"]);
    expect(vi.mocked(analysisService.markAnalysisCancelled)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analysisService.markAnalysisCompleted)).not.toHaveBeenCalled();
    // REQ-002 was never decided: storing the set would drop it silently.
    expect(vi.mocked(analysisService.updateGoverningApplicabilityMetadata)).not.toHaveBeenCalled();
    expect(vi.mocked(findingsStore.produceGoverningFindingsForAnalysis)).not.toHaveBeenCalled();
  });

  it("#2029 — the guard reads the run's cancel, not the findings' signal: a join given no findings stores nothing either", async () => {
    const orch = new AnalysisOrchestrator({
      provider: makeProvider().provider,
      retrieve: async () => [],
    } as never);
    const join = (
      orch as unknown as {
        joinGoverningApplicability: (
          analysisId: string,
          work: Promise<unknown[]>,
          cancelled: () => boolean,
        ) => Promise<unknown>;
      }
    ).joinGoverningApplicability.bind(orch);
    const store = vi.mocked(analysisService.updateGoverningApplicabilityMetadata);
    await expect(join(ANALYSIS_ID, Promise.resolve([]), () => true)).resolves.toBeUndefined();
    expect(store).not.toHaveBeenCalled();
    // The same join of a run still going stores the set.
    await expect(join(ANALYSIS_ID, Promise.resolve([]), () => false)).resolves.toEqual([]);
    expect(store).toHaveBeenCalledTimes(1);
    expect(vi.mocked(findingsStore.produceGoverningFindingsForAnalysis)).not.toHaveBeenCalled();
  });
});

describe("#2113 — the agentic path (a project with ingested code)", () => {
  type AgenticInput = { requirements: Array<{ id: string }> };
  type ChatFn = (m: ChatMessage[], o?: ChatOptions) => Promise<unknown>;

  /**
   * The project has a code graph, so the code agent runs agentic. Its tool
   * loop needs a real graph, so it is stubbed; the stub makes the code agent's
   * model call, and a governing call waiting on it (`makeProvider`'s gate)
   * shows the work ran beside the code agent rather than ahead of it.
   */
  async function runAgentic(made: ReturnType<typeof makeProvider> = makeProvider()) {
    const seen: AgenticInput[] = [];
    vi.mocked(prisma.codeGraph.findFirst).mockImplementation((async () => ({
      id: "cg_2113",
    })) as never);
    const spy = vi
      .spyOn(
        AnalysisOrchestrator.prototype as unknown as {
          runAgenticCodeAgent: (input: AgenticInput) => Promise<unknown>;
        },
        "runAgenticCodeAgent",
      )
      .mockImplementation(async (input) => {
        seen.push(input);
        await (made.provider as unknown as { chat: ChatFn }).chat(
          [{ role: "user", content: "investigate" }],
          { systemMessage: "Answer with a requirementId on every finding." },
        );
        return {
          agentKey: "code",
          output: { summary: "ok", findings: [], notes: [] },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          durationMs: 1,
        };
      });
    try {
      return { ...(await runPipeline(made)), seen };
    } finally {
      spy.mockRestore();
      vi.mocked(prisma.codeGraph.findFirst).mockImplementation((async () => null) as never);
    }
  }

  it("flag on, workspace with current rules: every requirement is checked beside the code agent, joined, stored and its findings produced", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [AUDIT_RULE];
    const run = await runAgentic();
    // It did take the agentic path, with the document agent's requirements.
    expect(run.seen.map((i) => i.requirements.map((r) => r.id))).toEqual([["REQ-001", "REQ-002"]]);
    // Per requirement: one screen batch, one judging call.
    expect(run.calls.filter(isGoverning)).toHaveLength(4);
    expect([...decided.ids].sort()).toEqual(["REQ-001", "REQ-002"]);
    // Beside the code agent, and joined before the run was recorded.
    expect(run.timeline.waitedOut).toBe(false);
    expect(state.governingDoneAtCompletion).toBe(4);
    const store = vi.mocked(analysisService.updateGoverningApplicabilityMetadata);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0]![0]).toBe(ANALYSIS_ID);
    const stored = (store.mock.calls[0]![1] as (c: unknown) => unknown)(undefined) as {
      requirements: Array<{ requirementId: string; decisions: Array<Record<string, unknown>> }>;
    };
    expect(stored.requirements.map((r) => r.requirementId)).toEqual(["REQ-001", "REQ-002"]);
    expect(stored.requirements[0]!.decisions).toEqual([
      expect.objectContaining({ ruleId: "rule_audit", controlId: "LG-03", verdict: "applies" }),
    ]);
    const produce = vi.mocked(findingsStore.produceGoverningFindingsForAnalysis);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(produce.mock.calls[0]![0]).toMatchObject({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      applicability: stored,
    });
    expect(vi.mocked(analysisService.markAnalysisCompleted)).toHaveBeenCalledTimes(1);
  });

  it("two repositories: the governing check still runs once per run, not once per repository", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [AUDIT_RULE];
    vi.mocked(prisma.repoConnection.findMany).mockImplementation((async () => [
      { id: "rc_a", label: "a", isPrimary: true, createdAt: new Date(1) },
      { id: "rc_b", label: "b", isPrimary: false, createdAt: new Date(2) },
    ]) as never);
    try {
      const run = await runAgentic();
      // The code agent ran once per repository, governing did not.
      expect(run.seen).toHaveLength(2);
      expect(run.calls.filter(isGoverning)).toHaveLength(4);
      expect([...decided.ids].sort()).toEqual(["REQ-001", "REQ-002"]);
      expect(vi.mocked(analysisService.updateGoverningApplicabilityMetadata)).toHaveBeenCalledTimes(
        1,
      );
    } finally {
      vi.mocked(prisma.repoConnection.findMany).mockImplementation((async () => []) as never);
    }
  });

  it("blank requirement text is not decided, and no more than the retrieval cap is", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [AUDIT_RULE];
    state.requirements = [
      { id: "REQ-BLANK", text: "   " },
      ...Array.from({ length: MAX_REQUIREMENTS_FOR_RETRIEVAL + 3 }, (_, i) => ({
        id: `REQ-${String(i + 1).padStart(3, "0")}`,
        text: `Export dataset ${i + 1} as a CSV.`,
      })),
    ];
    await runAgentic();
    expect(decided.ids).not.toContain("REQ-BLANK");
    expect(decided.ids).toHaveLength(MAX_REQUIREMENTS_FOR_RETRIEVAL);
    // #2233 — and the run names the three it did not decide.
    expect(persistedCapability().requirementsLeftOut).toEqual([
      expect.objectContaining({
        stage: "governing-applicability",
        analysedCount: MAX_REQUIREMENTS_FOR_RETRIEVAL,
        totalCount: MAX_REQUIREMENTS_FOR_RETRIEVAL + 3,
        leftOut: ["REQ-025", "REQ-026", "REQ-027"].map((id) => expect.objectContaining({ id })),
      }),
    ]);
    expect(persistedCapability().reasons).toContain("requirements-left-out");
  });

  it("flag off: the agentic path reads no workspace or rule, and stores nothing", async () => {
    const run = await runAgentic();
    expect(run.seen).toHaveLength(1);
    expect(run.calls.some(isGoverning)).toBe(false);
    expect(vi.mocked(prisma.project.findFirst)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.governingRule.findMany)).not.toHaveBeenCalled();
    expect(vi.mocked(analysisService.updateGoverningApplicabilityMetadata)).not.toHaveBeenCalled();
    expect(vi.mocked(findingsStore.produceGoverningFindingsForAnalysis)).not.toHaveBeenCalled();
    expect(vi.mocked(analysisService.markAnalysisCompleted)).toHaveBeenCalledTimes(1);
  });

  it("a run that fails before the join ends with the agentic path's unjoined work aborted", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [AUDIT_RULE];
    const signals: AbortSignal[] = [];
    const made = makeProvider();
    const chat = vi.mocked((made.provider as unknown as { chat: ChatFn }).chat);
    const specialists = chat.getMockImplementation()!;
    chat.mockImplementation(async (messages: ChatMessage[], o: ChatOptions = {}) => {
      const user = messages.map((m) => String(m.content)).join("\n");
      if (!user.includes("governing_rule")) return specialists(messages, o);
      signals.push(o.signal!);
      return untilAborted(o.signal!);
    });
    vi.mocked(analysisService.readFlattenedFindings).mockRejectedValueOnce(
      new Error("database is locked"),
    );
    await runAgentic(made);
    expect(vi.mocked(analysisService.markAnalysisFailed)).toHaveBeenCalledTimes(1);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(vi.mocked(analysisService.updateGoverningApplicabilityMetadata)).not.toHaveBeenCalled();
  });
});

/**
 * #2233 — the limits on the requirement-grounded path (no code graph). These
 * use `runPipeline` directly, so they sit apart from the agentic path above.
 */
describe("#2233 — analysis limits on the requirement-grounded path", () => {
  it("#2233 — no code graph: the run names the requirements past the limit for code retrieval and governing rules", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    state.workspaceId = "ws_1872";
    state.rules = [AUDIT_RULE];
    state.requirements = Array.from({ length: MAX_REQUIREMENTS_FOR_RETRIEVAL + 2 }, (_, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      text: `Export dataset ${i + 1} as a CSV.`,
    }));
    await runPipeline();
    const notices = persistedCapability().requirementsLeftOut ?? [];
    expect(notices.map((n) => [n.stage, n.leftOut.map((r) => r.id)])).toEqual([
      ["requirement-grounded-code", ["REQ-025", "REQ-026"]],
      ["governing-applicability", ["REQ-025", "REQ-026"]],
    ]);
    expect(notices[0]!.leftOut[0]!.excerpt).toBe("Export dataset 25 as a CSV.");
  });

  it("#2233 — a specialist that writes more than 50 findings: the run names the ones not saved", async () => {
    state.otherFindings = 52;
    await runPipeline();
    expect(persistedCapability().findingsLeftOut).toEqual([
      {
        agentKey: "document",
        producedCount: 52,
        keptCount: 50,
        leftOutTitles: ["Document finding 51", "Document finding 52"],
      },
    ]);
    expect(persistedCapability().reasons).toContain("findings-left-out");
  });

  it("#2233 — flag off: only the code-retrieval limit is reported, and a run under it reports none", async () => {
    state.requirements = Array.from({ length: MAX_REQUIREMENTS_FOR_RETRIEVAL + 1 }, (_, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      text: `Export dataset ${i + 1} as a CSV.`,
    }));
    await runPipeline();
    expect(persistedCapability().requirementsLeftOut?.map((n) => n.stage)).toEqual([
      "requirement-grounded-code",
    ]);

    vi.clearAllMocks();
    state.requirements = null;
    await runPipeline();
    expect(persistedCapability()).not.toHaveProperty("requirementsLeftOut");
    expect(persistedCapability().reasons).not.toContain("requirements-left-out");
  });

  it("#2276 — fused retrieval on, requirements past the embedder's limit: the run names them for the code search's vector half", async () => {
    process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
    // 12 requirements at the 4,000-character query bound: about 48k characters.
    state.requirements = Array.from({ length: 12 }, (_, i) => ({
      id: `REQ-${String(i + 1).padStart(3, "0")}`,
      text: `Export dataset ${i + 1} as a CSV. ${"Every column goes into the file. ".repeat(130)}`.slice(
        0,
        MAX_REQUIREMENT_QUERY_CHARS,
      ),
    }));
    const queries: string[] = [];
    await runPipeline(
      makeProvider(),
      {},
      {
        fusedCode: {
          searcher: {
            search: async (q: string) => {
              queries.push(q);
              return [];
            },
          },
          lineLookup: { resolve: async () => new Map() },
        },
      },
    );
    // The symbol search was given every requirement (BM25 reads the whole query)...
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("Export dataset 12 as a CSV.");
    // ...and the run names the ones the vector half could not embed.
    const notices = persistedCapability().requirementsLeftOut ?? [];
    expect(notices.map((n) => [n.stage, n.leftOut.map((r) => r.id)])).toEqual([
      ["fused-code-semantic", ["REQ-009", "REQ-010", "REQ-011", "REQ-012"]],
    ]);
    expect(persistedCapability().reasons).toContain("requirements-left-out");
  });

  it("#2233 — an imported item whose body is over 32,768 characters: the search query is bounded and the code agent still runs", async () => {
    const title = "Export the order history as a CSV";
    const body = "Every column of every order goes into the file. ".repeat(800);
    expect(body.length).toBeGreaterThan(SIDECAR_MAX_INPUT_CHARS);
    const run = await runPipeline(makeProvider(), {
      extraInstructions: `- ${title}`,
      sourceRequirements: [
        {
          candidateId: "NR-1",
          requirementId: "imp-1",
          title,
          externalSource: "github",
          externalId: "4100",
          externalUrl: null,
          detail: body,
        },
      ],
    });
    expect(state.searchQueries.length).toBeGreaterThan(0);
    for (const q of state.searchQueries) {
      expect(q.length).toBeLessThanOrEqual(MAX_REQUIREMENT_QUERY_CHARS);
    }
    expect(state.searchQueries).toContainEqual(expect.stringMatching(new RegExp(`^${title}\\n`)));
    // The code agent ran, read the whole body, and its result was persisted.
    const code = run.calls.find((c) => c.system.includes("requirementId"));
    expect(code, "the requirement-grounded code agent ran").toBeDefined();
    expect(userOf(code!)).toContain(body.trim());
    expect(run.persisted.length).toBeGreaterThan(0);
    expect(run.persisted.every((o) => o !== null)).toBe(true);
  });

  it("#2233 — the custom-agent phase: findings an agent lost at the 50-finding cap are named on the persisted capability", async () => {
    const leftOut = {
      agentKey: "custom:ag_1",
      producedCount: 52,
      keptCount: 50,
      leftOutTitles: ["Finding 51", "Finding 52"],
    };
    state.customResults = [
      {
        agentId: "ag_1",
        agentRef: "custom:ag_1",
        agentName: "Verbose",
        content: "{}",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        findingsLeftOut: leftOut,
      },
    ];
    await runPipeline();
    expect(persistedCapability().findingsLeftOut).toEqual([leftOut]);
    expect(persistedCapability().reasons).toContain("findings-left-out");
  });
});
