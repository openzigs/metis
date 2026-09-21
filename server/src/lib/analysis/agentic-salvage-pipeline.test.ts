/**
 * #1218 — the orchestrator half of the #1217 repair, driven through the REAL
 * `AnalysisOrchestrator.runPipeline` so the seams the unit tests cannot reach
 * are pinned by what actually crossed the provider boundary:
 *
 *   - the salvage source. Salvage MUST read `loopResult.salvageSource`, not the
 *     brace-free `finalResponse` prose that overwrote it. Reverting that line
 *     leaves every unit test green, so the proof has to be here: with prose as
 *     the source, `salvageWithRepair` classifies it `prose` and never spends a
 *     repair call at all. The repair call's existence IS the assertion.
 *   - the OUTPUT caps. The retry's cap must be the configured value, and the
 *     repair's must clear it — repair echoes the payload back, so inheriting the
 *     provider's 4096 default truncates it in turn (D3, one layer down).
 *   - configurability. A hardcoded 16384 is rejected outright with a 400 by a
 *     model whose output ceiling is 8192, so the knob must actually reach both
 *     calls.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import { DEFAULT_REPAIR_MAX_OUTPUT_TOKENS, repairMaxOutputTokens } from "./agent-runner.js";
import { DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS } from "./agent-loop.js";

const ANALYSIS_ID = "an_1218";
const PROJECT_ID = "pr_1218";

/** The system message `repairAgentJson` sends — how we spot a repair call. */
const REPAIR_SYSTEM = "You repair malformed JSON. You output JSON only.";

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      findMany: vi.fn(async () => [
        {
          qualifiedName: "server/src/auth/session.ts::createSession",
          kind: "function",
          filePath: "server/src/auth/session.ts",
          startLine: 10,
          endLine: 42,
          language: "typescript",
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
              requirements: [{ id: "REQ-001", text: "Sessions must expire after 30 minutes." }],
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

vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
  getStructuredRequirements: vi.fn(async () => null),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => undefined),
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
}));

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
vi.mock("../socket/job-events.js", () => ({
  jobEvents: { started: vi.fn(), completed: vi.fn(), failed: vi.fn() },
  genericFailureMessage: (kind: string) => `${kind} failed`,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

const AGENT_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });
const TOOL_CALL = JSON.stringify({ tool: "search_code_graph", args: { query: "session expiry" } });

/**
 * A retry answer cut off mid-`findings`, holding NO complete finding. Plain
 * salvage recovers nothing from it, so repair is the only route back — which is
 * what makes the repair call a reliable probe for which source was chosen.
 */
const TRUNCATED_RETRY =
  '{"agentKey":"code","summary":"code summary","findings":[{"category":"architecture","severity":"med';

const REPAIRED = JSON.stringify({
  agentKey: "code",
  summary: "code summary",
  findings: [
    {
      category: "architecture",
      severity: "medium",
      title: "Sessions never expire",
      body: "body",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

type Recorded = { messages: ChatMessage[]; opts: ChatOptions };

function makeProvider() {
  const recorded: Recorded[] = [];
  let turns = 0;
  const chat = vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
    recorded.push({ messages: [...messages], opts });
    const text = (content: string) => ({
      content,
      // Big enough that ONE turn blows the tiny budget set below, which is the
      // #1217 D1 sequence: a token-budget stop on a pending tool call.
      usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      model: "test-model",
      provider: "bedrock" as const,
    });
    if (opts.systemMessage === REPAIR_SYSTEM) return text(REPAIRED);
    const askedToStop = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
    );
    if (askedToStop) return text(TRUNCATED_RETRY);
    turns += 1;
    // Call 1 is the single-shot document agent; everything after is the code loop.
    return text(turns === 1 ? AGENT_ANSWER : TOOL_CALL);
  });
  return { provider: { chat } as never, recorded };
}

async function runPipeline(): Promise<Recorded[]> {
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
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", ["document", "code"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
  });
  return recorded;
}

const repairCalls = (recorded: Recorded[]) =>
  recorded.filter((c) => c.opts.systemMessage === REPAIR_SYSTEM);

const retryCalls = (recorded: Recorded[]) =>
  recorded.filter((c) =>
    c.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
    ),
  );

/**
 * The agentic loop's ordinary investigation turns, identified POSITIVELY by the
 * tool catalogue only they advertise.
 *
 * #1224 — "neither a repair nor a retry" used to be a sufficient definition,
 * because everything else on this pipeline was uncapped. It no longer is: the
 * single-shot `runAgent` call that opens the pipeline (the document specialist)
 * now carries its own explicit cap, and an exclusion filter would have swept it
 * in here and read a correct cap as a regression.
 */
const loopTurnCalls = (recorded: Recorded[]) =>
  recorded.filter((c) => (c.opts.systemMessage ?? "").includes("search_code_graph"));

/** The single-shot `runAgent` calls — no tools, no repair, no retry. */
const singleShotCalls = (recorded: Recorded[]) =>
  recorded.filter(
    (c) =>
      !loopTurnCalls(recorded).includes(c) &&
      !repairCalls(recorded).includes(c) &&
      !retryCalls(recorded).includes(c),
  );

beforeEach(() => {
  vi.clearAllMocks();
  // Isolate the loop: the passive fused-code seed (#729) is a separate path.
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  // One turn of the loop costs 200 tokens, so the pass stops on budget.
  process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "100";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  delete process.env.ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS;
  __resetConfigSingleton();
});

describe("#1218 — the orchestrator salvages from the PRESERVED source", () => {
  it("spends a repair call, which only the truncated source can trigger", async () => {
    const recorded = await runPipeline();

    // The retry ran and came back truncated...
    expect(retryCalls(recorded).length).toBeGreaterThan(0);
    // ...and repair was reached. Reading `finalResponse` instead hands salvage
    // the brace-free prose, which classifies as `prose` and is never repaired —
    // so this expectation is what fails if the seam regresses to D1.
    expect(repairCalls(recorded).length).toBeGreaterThan(0);
    // The repair was handed the model's own truncated words, verbatim.
    const body = repairCalls(recorded)[0]!
      .messages.map((m) => String(m.content))
      .join("\n");
    expect(body).toContain(TRUNCATED_RETRY);
  });
});

describe("#1218 — both bounded calls carry an explicit, configurable OUTPUT cap", () => {
  it("defaults the retry to 16384 and the repair to that plus headroom", async () => {
    const recorded = await runPipeline();

    expect(retryCalls(recorded)[0]!.opts.maxTokens).toBe(DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS);
    expect(repairCalls(recorded)[0]!.opts.maxTokens).toBe(DEFAULT_REPAIR_MAX_OUTPUT_TOKENS);
    // Neither may fall back to the provider's 4096 default: the retry truncates
    // its findings payload, and the repair truncates its echo of one.
    for (const call of [...retryCalls(recorded), ...repairCalls(recorded)]) {
      expect(call.opts.maxTokens!).toBeGreaterThan(4096);
    }
  });

  it("lets an operator lower both for a model whose output ceiling is 8192", async () => {
    process.env.ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS = "8192";
    __resetConfigSingleton();

    const recorded = await runPipeline();

    // A hardcoded 16384 is rejected with a 400 by such a model, turning a
    // working retry into a hard failure — hence the knob.
    expect(retryCalls(recorded)[0]!.opts.maxTokens).toBe(8192);
    expect(repairCalls(recorded)[0]!.opts.maxTokens).toBe(repairMaxOutputTokens(8192));
    // The repair still clears the cap on the text it has to echo back.
    expect(repairCalls(recorded)[0]!.opts.maxTokens!).toBeGreaterThan(8192);
  });

  it("leaves the ordinary investigation turns uncapped", async () => {
    const recorded = await runPipeline();

    const loopTurns = loopTurnCalls(recorded);
    expect(loopTurns.length).toBeGreaterThan(0);
    expect(loopTurns.every((c) => c.opts.maxTokens === undefined)).toBe(true);
  });

  it("caps the single-shot runAgent call too (#1224)", async () => {
    // The other half of the exclusion above: narrowing `loopTurns` must not be
    // a way to stop noticing an uncapped call. Every call this pipeline makes
    // is now accounted for — capped on purpose, or uncapped on purpose.
    const recorded = await runPipeline();

    const singleShot = singleShotCalls(recorded);
    expect(singleShot.length).toBeGreaterThan(0);
    for (const call of singleShot) {
      expect(call.opts.maxTokens).toBe(DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS);
    }
    expect(recorded.length, "every recorded call must fall into exactly one bucket").toBe(
      loopTurnCalls(recorded).length +
        retryCalls(recorded).length +
        repairCalls(recorded).length +
        singleShot.length,
    );
  });
});
