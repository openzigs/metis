/**
 * #766 / #726 — the orchestrator half of the evidence fixes, driven through the
 * REAL `AnalysisOrchestrator.runPipeline`:
 *
 *   - #726: the final-answer retry carries the untruncated evidence the loop
 *     retrieved, as a fenced `evidence_digest` block;
 *   - #766: when the transcript path recovers nothing (here the retry call
 *     itself fails, so salvage has only the last tool-call reply), ONE
 *     evidence-only call recovers the findings instead of persisting zero.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_766";
const PROJECT_ID = "pr_766";

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
const analysisService = await import("./analysis-service.js");

const AGENT_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });
const TOOL_CALL = JSON.stringify({ tool: "search_code_graph", args: { query: "session expiry" } });

const RECOVERED = JSON.stringify({
  agentKey: "code",
  summary: "recovered from evidence",
  findings: [
    {
      category: "architecture",
      severity: "medium",
      title: "Sessions are created without an expiry",
      body: "createSession sets no TTL.",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

type Recorded = { messages: ChatMessage[]; opts: ChatOptions };

const textOf = (messages: ChatMessage[]) => messages.map((m) => String(m.content)).join("\n");
const isEvidenceSalvage = (messages: ChatMessage[]) =>
  messages[0]?.role === "system" && textOf(messages).includes("evidence_digest");
const isRetry = (messages: ChatMessage[]) =>
  !isEvidenceSalvage(messages) && textOf(messages).includes("STOP INVESTIGATING");

function makeProvider(opts: { retry: "throws" | "prose"; salvage: string }) {
  const recorded: Recorded[] = [];
  let turns = 0;
  const chat = vi.fn(async (messages: ChatMessage[], o: ChatOptions = {}) => {
    recorded.push({ messages: [...messages], opts: o });
    const text = (content: string) => ({
      content,
      usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      model: "test-model",
      provider: "bedrock" as const,
    });
    if (isEvidenceSalvage(messages)) return text(opts.salvage);
    if (isRetry(messages)) {
      if (opts.retry === "throws") throw new Error("upstream closed the connection");
      return text("I ran out of room.");
    }
    turns += 1;
    return text(turns === 1 ? AGENT_ANSWER : TOOL_CALL);
  });
  return { provider: { chat } as never, recorded };
}

async function runPipeline(opts: { retry: "throws" | "prose"; salvage: string }) {
  const { provider, recorded } = makeProvider(opts);
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

/** The output persisted for the code agent. */
function persistedCodeOutput(): {
  summary: string;
  findings: Array<{ title: string }>;
  notes: string[];
} {
  const calls = vi.mocked(analysisService.persistAgentResult).mock.calls as unknown as Array<
    [
      {
        agentKey: string;
        output: { summary: string; findings: Array<{ title: string }>; notes: string[] };
      },
    ]
  >;
  const code = calls.map((c) => c[0]).find((a) => a.agentKey === "code");
  if (!code) throw new Error("code agent result was not persisted");
  return code.output;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  // Two loop turns fit; the third crosses the budget, so the pass stops on it.
  process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "500";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  __resetConfigSingleton();
});

describe("#726 — the final-answer retry is given the untruncated evidence", () => {
  it("puts an evidence_digest block holding the search result ahead of the instruction", async () => {
    const recorded = await runPipeline({ retry: "prose", salvage: RECOVERED });
    const retry = recorded.find((c) => isRetry(c.messages));
    expect(retry).toBeDefined();
    const last = String(retry!.messages[retry!.messages.length - 1].content);
    expect(last).toContain("Tool result for evidence_digest:");
    expect(last).toContain("server/src/auth/session.ts");
    expect(last.indexOf("evidence_digest")).toBeLessThan(last.indexOf("STOP INVESTIGATING"));
  });
});

describe("#766 — a degraded pass with nothing to salvage falls back to the evidence", () => {
  it("recovers findings when the retry call itself fails", async () => {
    const recorded = await runPipeline({ retry: "throws", salvage: RECOVERED });
    const salvage = recorded.filter((c) => isEvidenceSalvage(c.messages));
    expect(salvage).toHaveLength(1);
    // The task and the evidence, without the transcript or a tool manifest.
    const body = textOf(salvage[0].messages);
    expect(body).toContain("REQ-001");
    expect(body).toContain("server/src/auth/session.ts");
    expect(salvage[0].opts.tools).toBeUndefined();
    expect(salvage[0].messages.some((m) => m.role === "assistant")).toBe(false);

    const output = persistedCodeOutput();
    expect(output.findings.map((f) => f.title)).toEqual(["Sessions are created without an expiry"]);
    // Still honest: the pass degraded, and the note says how much came back.
    expect(output.summary).toContain("1 finding(s) were recovered");
  });

  it("also recovers when the retry answered in prose", async () => {
    await runPipeline({ retry: "prose", salvage: RECOVERED });
    expect(persistedCodeOutput().findings).toHaveLength(1);
  });

  it("persists zero findings, not a failure, when the evidence call recovers nothing too", async () => {
    await runPipeline({ retry: "throws", salvage: "Still nothing to say." });
    const output = persistedCodeOutput();
    expect(output.findings).toEqual([]);
    expect(output.summary).toContain("0 finding(s) were recovered");
  });
});
