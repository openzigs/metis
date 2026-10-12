/**
 * #1063 — the #706 run-7 failure, driven through the REAL
 * `AnalysisOrchestrator.runPipeline`: the code agent's loop stops on its token
 * budget, and both recovery calls come back EMPTY at their output cap because
 * the model spent the cap reasoning. The run ended with 0 findings and said only
 * "0 finding(s) were recovered".
 *
 * Pinned here, by what crossed the provider boundary and what was persisted:
 *   - on a model that reasons by default, the final-answer retry and the
 *     evidence-only salvage both carry a reasoning bound, and no loop turn does;
 *   - on any other model nothing is added to either call;
 *   - `ANALYSIS_RECOVERY_REASONING` reaches both calls;
 *   - a total loss persists WHY, on the code agent's own output;
 *   - a run started from imported items hands them to synthesis.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOutput } from "@metis/shared";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import { DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS } from "./agent-loop.js";

const ANALYSIS_ID = "an_1063";
const PROJECT_ID = "pr_1063";
const CAP = DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS;

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      findMany: vi.fn(async () => [
        {
          id: "sym_1",
          name: "FlushAllSessions",
          qualifiedName: "internal/storage/web_session.go::FlushAllSessions",
          kind: "function",
          filePath: "internal/storage/web_session.go",
          startLine: 250,
          endLine: 262,
          language: "go",
        },
      ]),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    codeEdge: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) => {
        if (where.agentKey === "document") {
          return {
            output: JSON.stringify({
              requirements: [{ id: "REQ-001", text: "A user can terminate all sessions." }],
            }),
          };
        }
        return { status: "completed" };
      }),
    },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
  },
}));

const persistAgentResult = vi.fn(async (_input: { agentKey: string; output: unknown }) => ({
  id: "ar_1",
  findingIds: [],
}));
vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
  getStructuredRequirements: vi.fn(async () => null),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => undefined),
  markAnalysisFailed: vi.fn(async () => undefined),
  persistAgentResult: (input: { agentKey: string; output: unknown }) => persistAgentResult(input),
  persistAnalysisEnhancement: vi.fn(async () => undefined),
  persistAnalysisCapability: vi.fn(async () => undefined),
  persistAnalysisAffectedCode: vi.fn(async () => undefined),
  persistAnalysisDatabaseAware: vi.fn(async () => undefined),
  persistAnalysisEscalation: vi.fn(async () => undefined),
  persistRequirements: vi.fn(async () => []),
  persistCrossDocFindings: vi.fn(async () => undefined),
  // One finding, so synthesis is actually asked (it is skipped with none).
  readFlattenedFindings: vi.fn(async () => [
    {
      findingId: "f_1",
      agentKey: "document",
      category: "other",
      severity: "info",
      title: "Terminate all sessions has no defined scope",
      body: "b",
      tags: [],
      citations: [],
    },
  ]),
}));

vi.mock("./cost-cap.js", () => ({ assertCanStartAnalysis: vi.fn(async () => undefined) }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));
const runSynthesis = vi.fn(async (_provider: unknown, _input: Record<string, unknown>) => ({
  output: { summary: "s", requirements: [] },
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
}));
vi.mock("./synthesis.js", () => ({
  runSynthesis: (provider: unknown, input: Record<string, unknown>) =>
    runSynthesis(provider, input),
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
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

const AGENT_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });
const TOOL_CALL = JSON.stringify({
  tool: "search_code_graph",
  args: { query: "FlushAllSessions" },
});

type Recorded = { messages: ChatMessage[]; opts: ChatOptions };

/**
 * A model that calls a tool on every loop turn and, asked to stop and answer,
 * returns NO text having been billed its whole output cap.
 */
function makeProvider() {
  const recorded: Recorded[] = [];
  let turns = 0;
  const chat = vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
    recorded.push({ messages: [...messages], opts });
    const askedToStop = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
    );
    if (askedToStop) {
      return {
        content: "",
        finishReason: "max_tokens",
        usage: { promptTokens: 400, completionTokens: CAP, totalTokens: 400 + CAP },
        model: "m",
        provider: "anthropic" as const,
      };
    }
    turns += 1;
    return {
      // Call 1 is the single-shot document agent; everything after is the code loop.
      content: turns === 1 ? AGENT_ANSWER : TOOL_CALL,
      usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      model: "m",
      provider: "anthropic" as const,
    };
  });
  return { provider: { chat, key: "anthropic" } as never, recorded };
}

async function runPipeline(
  model: string,
  extra: Record<string, unknown> = {},
): Promise<Recorded[]> {
  const { provider, recorded } = makeProvider();
  const orch = new AnalysisOrchestrator({
    provider,
    retrieve: async () => [],
    knowledge: {} as never,
  });
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
  ).runPipeline(ANALYSIS_ID, "Miniflux", "A feed reader", ["document", "code"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model,
    ...extra,
  });
  return recorded;
}

const stopCalls = (recorded: Recorded[]) =>
  recorded.filter((c) =>
    c.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
    ),
  );
/** The final-answer retry: the stop call that re-sends the loop's transcript. */
const retryCall = (recorded: Recorded[]) =>
  stopCalls(recorded).find((c) => c.opts.callType === "agent-loop");
/** The evidence-only salvage: the stop call made without the transcript. */
const salvageCall = (recorded: Recorded[]) =>
  stopCalls(recorded).find((c) => c.opts.callType !== "agent-loop");
const loopTurns = (recorded: Recorded[]) =>
  recorded.filter((c) => c.opts.callType === "agent-loop" && !stopCalls(recorded).includes(c));

const persistedCodeOutput = (): AgentOutput =>
  persistAgentResult.mock.calls.map((c) => c[0]).find((i) => i.agentKey === "code")!
    .output as AgentOutput;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  // Each loop turn costs 200 tokens: two turns run their tool, the third stops.
  process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "500";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  delete process.env.ANALYSIS_RECOVERY_REASONING;
  __resetConfigSingleton();
});

describe("#1063 — recovery calls on a model that reasons by default", () => {
  it("makes both recovery calls, each with low reasoning effort", async () => {
    const recorded = await runPipeline("deepseek-flash");
    expect(retryCall(recorded), "the final-answer retry ran").toBeDefined();
    expect(salvageCall(recorded), "the evidence-only salvage ran").toBeDefined();
    expect(retryCall(recorded)!.opts.reasoningEffort).toBe("low");
    expect(salvageCall(recorded)!.opts.reasoningEffort).toBe("low");
    // Both keep their explicit output cap.
    expect(retryCall(recorded)!.opts.maxTokens).toBe(CAP);
    expect(salvageCall(recorded)!.opts.maxTokens).toBe(CAP);
  });

  it("leaves the loop's own turns alone", async () => {
    const recorded = await runPipeline("deepseek-flash");
    const turns = loopTurns(recorded);
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(t.opts.reasoningEffort).toBeUndefined();
      expect(t.opts.disableThinking).toBeUndefined();
    }
  });

  it("ANALYSIS_RECOVERY_REASONING=off turns thinking off for both calls", async () => {
    process.env.ANALYSIS_RECOVERY_REASONING = "off";
    __resetConfigSingleton();
    const recorded = await runPipeline("deepseek-flash");
    for (const call of [retryCall(recorded)!, salvageCall(recorded)!]) {
      expect(call.opts.disableThinking).toBe(true);
      expect(call.opts.reasoningEffort).toBeUndefined();
    }
  });

  it("ANALYSIS_RECOVERY_REASONING=provider-default sends neither option", async () => {
    process.env.ANALYSIS_RECOVERY_REASONING = "provider-default";
    __resetConfigSingleton();
    const recorded = await runPipeline("deepseek-flash");
    for (const call of [retryCall(recorded)!, salvageCall(recorded)!]) {
      expect(call.opts.reasoningEffort).toBeUndefined();
      expect(call.opts.disableThinking).toBeUndefined();
    }
  });
});

describe("#1063 — recovery calls on any other model", () => {
  it("adds nothing to either call", async () => {
    const recorded = await runPipeline("claude-sonnet-4-6");
    for (const call of [retryCall(recorded)!, salvageCall(recorded)!]) {
      expect(call.opts.reasoningEffort).toBeUndefined();
      expect(call.opts.disableThinking).toBeUndefined();
    }
  });
});

describe("#1063 — a total loss says why", () => {
  it("persists what each recovery call returned on the code agent's output", async () => {
    await runPipeline("deepseek-flash");
    const output = persistedCodeOutput();
    expect(output.findings).toEqual([]);
    expect(output.summary).toMatch(/exhausted its token budget/);
    const notes = output.notes.join("\n");
    expect(notes).toContain("Recovered 0 finding(s)");
    expect(notes).toContain(
      `The final-answer call returned no text: it stopped at its output limit (${CAP} of ${CAP} output tokens used).`,
    );
    expect(notes).toContain(
      `The evidence-only call returned no text: it stopped at its output limit (${CAP} of ${CAP} output tokens used).`,
    );
    expect(notes).toContain("ANALYSIS_RECOVERY_REASONING");
  });
});

describe("#1063 — a run started from imported items", () => {
  const sourceRequirements = [
    {
      candidateId: "NR-1",
      requirementId: "req-imported-1",
      title: "Add a button to terminate all sessions",
      externalSource: "github",
      externalId: "4074",
      externalUrl: "https://github.com/miniflux/v2/issues/4074",
    },
  ];

  it("hands the imported items to synthesis under their NR ids", async () => {
    await runPipeline("claude-sonnet-4-6", {
      extraInstructions: "- Add a button to terminate all sessions",
      sourceRequirements,
    });
    expect(runSynthesis).toHaveBeenCalledTimes(1);
    expect(runSynthesis.mock.calls[0]![1].sourceItems).toEqual([
      { id: "NR-1", title: "Add a button to terminate all sessions" },
    ]);
  });

  it("hands synthesis no imported items on any other run", async () => {
    await runPipeline("claude-sonnet-4-6");
    expect(runSynthesis).toHaveBeenCalledTimes(1);
    expect("sourceItems" in runSynthesis.mock.calls[0]![1]).toBe(false);
  });
});
