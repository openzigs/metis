/**
 * #1131 — #706 run 8, wave B: a code pass that ran out of budget offered
 * "Continue with a larger budget" for three requirements that each already
 * carried a "Could not verify" finding. The agent had reached them; the code
 * did not settle them, and the rerun changed nothing.
 *
 * Driven through the REAL `AnalysisOrchestrator.runPipeline` with a scripted
 * model (no LLM spend): the model searches until the turn cap, and the
 * final-answer retry writes the findings. Pinned: a pass whose only gaps are
 * inconclusive raises `code-investigation-inconclusive` (no Continue), and one
 * that left requirements with no finding raises `code-investigation-cut-short`
 * with the two counts apart.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapability } from "@metis/shared";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_1131";
const PROJECT_ID = "pr_1131";
const REQUIREMENTS = [
  { id: "REQ-001", text: "The CLI accepts -flush-sessions to remove every session." },
  { id: "REQ-002", text: "The CLI accepts -refresh-feeds to refresh every feed." },
  { id: "REQ-003", text: "METRICS_COLLECTOR enables the Prometheus metrics endpoint." },
  { id: "REQ-004", text: "Publishing goes only to the openzigs/flux-v2 repository." },
];
vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      // The one search the model makes finds this, so a finding may cite it.
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
          return { output: JSON.stringify({ requirements: REQUIREMENTS }) };
        }
        return { status: "completed" };
      }),
    },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
  },
}));

const persistAnalysisCapability = vi.fn(async (_id: string, _c: unknown) => undefined);
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
  persistAnalysisCapability: (id: string, c: unknown) => persistAnalysisCapability(id, c),
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
    output: { summary: "s", requirements: [] },
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

const DOC_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });
const TOOL_CALL = JSON.stringify({ tool: "search_code_graph", args: { query: "sessions" } });

/**
 * The requirements the model's final answer writes a could-not-verify finding
 * for: `cited` ones cite the code it read (it looked, and the code did not
 * settle them); `placeholders` cite nothing, as the agentic prompt tells it to
 * write for a requirement it ran out of budget before reaching.
 */
let cited: string[] = [];
let placeholders: string[] = [];
const CITATION = { filePath: "internal/storage/web_session.go", startLine: 250, endLine: 262 };
const answer = () =>
  JSON.stringify({
    agentKey: "code",
    summary: "Some requirements could not be verified.",
    findings: [
      ...cited.map((id) => ({
        category: "other",
        severity: "info",
        title: `${id} could not be verified`,
        body: "The code read does not settle this.",
        tags: [],
        citations: [CITATION],
        requirementId: id,
        verdict: "could-not-verify",
      })),
      ...placeholders.map((id) => ({
        category: "other",
        severity: "info",
        title: `Could not verify: ${id}`,
        body: "Not reached: the investigation was cut short.",
        tags: [],
        citations: [],
        requirementId: id,
        verdict: "could-not-verify",
      })),
    ],
    notes: [],
  });

const lastUser = (messages: ChatMessage[]) =>
  String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");

/** Searches every loop turn until the cap; answers when told to stop. */
function makeProvider() {
  const chat = vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
    const out = (content: string) => ({
      content,
      usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1_000 },
      model: "m",
      provider: "anthropic" as const,
    });
    if (opts.callType !== "agent-loop") return out(DOC_ANSWER);
    if (lastUser(messages).includes("STOP INVESTIGATING")) return out(answer());
    return out(TOOL_CALL);
  });
  return { chat, key: "anthropic" } as never;
}

async function runPipeline(): Promise<AnalysisCapability> {
  const orch = new AnalysisOrchestrator({
    provider: makeProvider(),
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
  const calls = persistAnalysisCapability.mock.calls;
  return calls[calls.length - 1]![1] as AnalysisCapability;
}

beforeEach(() => {
  vi.clearAllMocks();
  cited = [];
  placeholders = [];
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "100000";
  // A small, unscaled turn cap the scripted model always runs into.
  process.env.ANALYSIS_AGENTIC_MAX_TURNS = "3";
  process.env.ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT = "0";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  delete process.env.ANALYSIS_AGENTIC_MAX_TURNS;
  delete process.env.ANALYSIS_AGENTIC_TURNS_PER_REQUIREMENT;
  __resetConfigSingleton();
});

describe("#1131 — a cut-short pass whose only gaps are inconclusive", () => {
  it("offers no Continue and names the requirements as inconclusive", async () => {
    cited = REQUIREMENTS.map((r) => r.id);
    const capability = await runPipeline();
    expect(capability.codeInvestigationCutShort).toBe(true);
    expect(capability.reasons).not.toContain("code-investigation-cut-short");
    expect(capability.reasons).toContain("code-investigation-inconclusive");
    expect(capability.codeInvestigationUnreached).toEqual({
      unreached: 0,
      inconclusive: 4,
      total: 4,
    });
  });
});

describe("#1131 — a cut-short pass that left requirements unreached", () => {
  it("offers Continue, and counts unreached and inconclusive apart", async () => {
    cited = ["REQ-004"];
    const capability = await runPipeline();
    expect(capability.reasons).toContain("code-investigation-cut-short");
    expect(capability.reasons).not.toContain("code-investigation-inconclusive");
    expect(capability.codeInvestigationUnreached).toEqual({
      unreached: 3,
      inconclusive: 1,
      total: 4,
    });
  });
});

/**
 * PR panel (#1131) — the agentic prompt tells the model to write an uncited
 * could-not-verify finding for every requirement it ran out of budget before
 * reaching (`VERDICT_RULE`, prompts.ts). Those are unreached, not inconclusive.
 */
describe("#1131 — the prompt's could-not-verify placeholders are unreached", () => {
  it("still offers Continue when the model wrote a placeholder for each requirement", async () => {
    placeholders = REQUIREMENTS.map((r) => r.id);
    const capability = await runPipeline();
    expect(capability.reasons).toContain("code-investigation-cut-short");
    expect(capability.reasons).not.toContain("code-investigation-inconclusive");
    expect(capability.codeInvestigationUnreached).toEqual({
      unreached: 4,
      inconclusive: 0,
      total: 4,
    });
  });
});
