/**
 * #1388 — the measured early stop, driven through the REAL
 * `AnalysisOrchestrator.runPipeline` with a scripted model (no LLM spend).
 *
 * Run `cmvivqzri008jj39km1bzzjk8` (DeepSeek, clarification and web research off):
 * the code loop made two tool turns, then a short reply that was neither a tool
 * call nor the findings JSON. The loop took it as the final answer and stopped at
 * 3 turns and ~6k of ~100k tokens; the final-answer retry told the model it had no
 * tools left and it wrote most requirements up as could-not-verify. That retry
 * succeeded, so `codeAgentDegraded` stayed false and the card read `completed`.
 *
 * Pinned here: the loop asks the model to continue instead of stopping, and a
 * pass that still ends with most requirements unverified is marked degraded —
 * on the capability record, in its reasons, and by the note behind the badge.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_DEGRADED_NOTE_PREFIX, type AgentOutput } from "@metis/shared";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_1388";
const PROJECT_ID = "pr_1388";
const REQUIREMENTS = [
  {
    id: "REQ-001",
    text: "The CLI accepts -flush-sessions to remove every session.",
  },
  {
    id: "REQ-002",
    text: "The CLI accepts -refresh-feeds to refresh every feed.",
  },
  {
    id: "REQ-003",
    text: "METRICS_COLLECTOR enables the Prometheus metrics endpoint.",
  },
  { id: "REQ-004", text: "OAUTH2_PROVIDER selects the OAuth2 provider." },
];
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
              requirements: REQUIREMENTS,
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

const persistAnalysisCapability = vi.fn(async (_id: string, _c: unknown) => undefined);
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
  persistAnalysisCapability: (id: string, c: unknown) => persistAnalysisCapability(id, c),
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

const DOC_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });
const TOOL_CALL = JSON.stringify({
  tool: "search_code_graph",
  args: { query: "flush sessions" },
});
const PROSE = "Investigation covered main.go; the remaining flags are registered further down.";
/** Notes the model writes on its thin answer (a test may set them). */
let thinNotes: string[] = [];
const thinAnswer = () =>
  JSON.stringify({
    agentKey: "code",
    summary: "Most requirements could not be verified.",
    findings: REQUIREMENTS.map((r) => ({
      category: "other",
      severity: "info",
      title: `${r.id} could not be verified`,
      body: "Not reached.",
      tags: [],
      citations: [],
      requirementId: r.id,
      verdict: "could-not-verify",
    })),
    notes: thinNotes,
  });

type Recorded = { messages: ChatMessage[]; opts: ChatOptions };
const lastUser = (messages: ChatMessage[]) =>
  String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");

/**
 * `incident`: the measured model. Two tool turns, then prose. Asked to continue
 * it makes one more call and then answers thinly; asked for coverage, or to
 * STOP, it answers thinly too.
 *
 * `answer-then-search`: answers thinly on its FIRST turn. Sent back for
 * coverage, it searches until the turn cap, and asked to STOP it answers thinly
 * again — a pass METIS's own nudge pushed into the cap.
 */
type Shape = "incident" | "answer-then-search";

function makeProvider(shape: Shape) {
  const recorded: Recorded[] = [];
  let loopTurns = 0;
  let calledAfterNudge = false;
  const chat = vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
    recorded.push({ messages: [...messages], opts });
    const usage = {
      promptTokens: 900,
      completionTokens: 100,
      totalTokens: 1_000,
    };
    const out = (content: string) => ({
      content,
      usage,
      model: "m",
      provider: "anthropic" as const,
    });
    if (opts.callType !== "agent-loop") return out(DOC_ANSWER);
    const last = lastUser(messages);
    if (last.includes("STOP INVESTIGATING")) return out(thinAnswer());
    if (shape === "answer-then-search") {
      loopTurns += 1;
      return out(loopTurns === 1 ? thinAnswer() : TOOL_CALL);
    }
    if (last.includes("Do not answer yet")) return out(thinAnswer());
    if (calledAfterNudge) return out(thinAnswer());
    if (last.includes("neither a tool call nor the final JSON answer")) {
      calledAfterNudge = true;
      return out(TOOL_CALL);
    }
    loopTurns += 1;
    return out(loopTurns <= 2 ? TOOL_CALL : PROSE);
  });
  return { provider: { chat, key: "anthropic" } as never, recorded };
}

async function runPipeline(shape: Shape = "incident"): Promise<Recorded[]> {
  const { provider, recorded } = makeProvider(shape);
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
    model: "deepseek-flash",
  });
  return recorded;
}

const loopCalls = (recorded: Recorded[]) =>
  recorded.filter((c) => c.opts.callType === "agent-loop");
const persistedCodeOutput = (): AgentOutput =>
  persistAgentResult.mock.calls.map((c) => c[0]).find((i) => i.agentKey === "code")!
    .output as AgentOutput;
const finalCapability = () =>
  persistAnalysisCapability.mock.calls[persistAnalysisCapability.mock.calls.length - 1]![1] as {
    codeAgentDegraded?: boolean;
    codeInvestigationCutShort?: boolean;
    reasons: string[];
  };

beforeEach(() => {
  vi.clearAllMocks();
  thinNotes = [];
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "100000";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  delete process.env.ANALYSIS_AGENTIC_MAX_TURNS;
  delete process.env.ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT;
  __resetConfigSingleton();
});

describe("#1388 — a tool-less reply no longer ends the code investigation", () => {
  it("asks the model to continue, and it investigates past the third turn", async () => {
    const recorded = await runPipeline();
    const loop = loopCalls(recorded);
    const continued = loop.filter((c) =>
      lastUser(c.messages).includes("neither a tool call nor the final JSON answer"),
    );
    expect(continued.length).toBeGreaterThan(0);
    expect(loop.length).toBeGreaterThan(3);
    // It answered inside the loop, so the tool-free retry was never needed.
    expect(loop.some((c) => lastUser(c.messages).includes("STOP INVESTIGATING"))).toBe(false);
  });
});

describe("#1388 — a pass that still ends shallow is reported degraded", () => {
  it("sets codeAgentDegraded and its one reason on the run's capability", async () => {
    await runPipeline();
    const capability = finalCapability();
    expect(capability.codeAgentDegraded).toBe(true);
    expect(capability.reasons).toContain("code-agent-degraded");
    // #19's coverage reason describes the same early stop: not shown twice.
    expect(capability.reasons).not.toContain("code-retrieval-degraded");
  });

  it("puts the plain reason behind the degraded badge on the code agent's output", async () => {
    await runPipeline();
    const notes = persistedCodeOutput().notes;
    const degraded = notes.filter((n) => n.startsWith(AGENT_DEGRADED_NOTE_PREFIX));
    expect(degraded).toHaveLength(1);
    // The one search ("flush sessions") bore on REQ-001, so it counts as checked.
    expect(degraded[0]).toContain("did not check 3 of 4 requirements against the code");
    expect(degraded[0]).toMatch(/using about \d+% of its token budget/);
  });
});

describe("#1388 review — the shallow note is METIS's, whatever the model writes", () => {
  it("is added even when the model's own note starts with the degraded prefix", async () => {
    thinNotes = [`${AGENT_DEGRADED_NOTE_PREFIX} self-reported by the model`];
    await runPipeline();
    const notes = persistedCodeOutput().notes;
    expect(notes[0]).toContain("did not check 3 of 4 requirements against the code");
    expect(notes).toContain(`${AGENT_DEGRADED_NOTE_PREFIX} self-reported by the model`);
    expect(finalCapability().reasons).toContain("code-agent-degraded");
  });
});

describe("#1388 review — a pass METIS's nudge pushed into the turn cap", () => {
  beforeEach(() => {
    // Four turns, unscaled: the answer on turn 1 leaves three, enough to nudge.
    process.env.ANALYSIS_AGENTIC_MAX_TURNS = "4";
    process.env.ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT = "0";
    __resetConfigSingleton();
  });

  it("is not reported cut short, and offers no Continue", async () => {
    const recorded = await runPipeline("answer-then-search");
    const loop = loopCalls(recorded);
    // The thin answer was sent back, and the model searched to the cap.
    expect(loop.some((c) => lastUser(c.messages).includes("Do not answer yet"))).toBe(true);
    expect(loop.some((c) => lastUser(c.messages).includes("STOP INVESTIGATING"))).toBe(true);
    const capability = finalCapability();
    expect(capability.codeInvestigationCutShort).toBe(false);
    expect(capability.reasons).not.toContain("code-investigation-cut-short");
    // It is judged as the shallow pass it was instead.
    expect(capability.reasons).toContain("code-agent-degraded");
  });
});
