/**
 * Issue #1098 — through the REAL `AnalysisOrchestrator.runPipeline`: a run
 * started from 5 imported items, whose document agent returns 23 unrelated
 * README features plus 5 restatements of the imported items (#706 run 7).
 * The code agent must be given the 5 imported items, first, once each.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import { DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS } from "./agent-loop.js";

const ANALYSIS_ID = "an_1098";
const PROJECT_ID = "pr_1098";
const CAP = DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS;

const docState = vi.hoisted(() => ({
  requirements: [] as Array<{ id: string; text: string }>,
}));

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
          return { output: JSON.stringify({ requirements: docState.requirements }) };
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
function makeProvider(key = "anthropic") {
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
  return { provider: { chat, key } as never, recorded };
}

async function runPipeline(
  model: string,
  extra: Record<string, unknown> = {},
  providerKey = "anthropic",
): Promise<Recorded[]> {
  const { provider, recorded } = makeProvider(providerKey);
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

const TITLES = [
  "Keyboard shortcut to mark all entries as read",
  "Per-feed refresh interval",
  "Export starred entries to JSON",
  "Hide read feeds in the sidebar",
  "Terminate all sessions button",
];
const sourceRequirements = TITLES.map((title, i) => ({
  candidateId: `NR-${i + 1}`,
  requirementId: `imp-${i + 1}`,
  title,
  externalSource: "github",
  externalId: String(4000 + i),
  externalUrl: null,
}));
const RESTATEMENTS = [
  "The system SHALL let a user mark all entries read with a keyboard shortcut.",
  "Users can set a refresh interval for each feed (per-feed).",
  "Starred entries can be exported as a JSON file.",
  "The sidebar hides feeds whose entries are all read.",
  "A button terminates all of the user's sessions.",
];
const UNRELATED = [
  "Import subscriptions from an OPML file",
  "Play YouTube videos inline",
  "Show favicons beside each feed",
  "Send a webhook on new entries",
  "Fever API compatibility",
  "Google Reader API compatibility",
  "Fetch original content with a scraper",
  "Rewrite rules per feed",
  "Block lists using regular expressions",
  "Keep lists using regular expressions",
  "Proxy media through the server",
  "Two-factor authentication with TOTP",
  "WebAuthn passkeys for login",
  "OAuth2 and OpenID Connect sign-in",
  "Integration with Pinboard",
  "Integration with Wallabag",
  "Integration with Pocket",
  "Telegram bot notifications",
  "Custom CSS for the reader",
  "Bookmarklet to subscribe to a site",
  "Translations into twenty languages",
  "PostgreSQL as the only database",
  "Single static binary deployment",
];

/** The requirement ids listed in the code agent's first loop turn, in order. */
function codeAgentRequirementIds(recorded: Recorded[]): string[] {
  const first = recorded.find((c) => c.opts.callType === "agent-loop");
  expect(first, "the agentic code loop ran").toBeDefined();
  const text = first!.messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  return [...text.matchAll(/^- \[([A-Z]+-\d+)\]/gm)].map((m) => m[1]!);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "500";
  __resetConfigSingleton();
  docState.requirements = [
    ...UNRELATED.map((text, i) => ({ id: `REQ-${String(i + 1).padStart(3, "0")}`, text })),
    ...RESTATEMENTS.map((text, i) => ({ id: `REQ-${String(i + 24).padStart(3, "0")}`, text })),
  ];
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  __resetConfigSingleton();
});

describe("#1098 — the code agent's requirement set on a run from imported items", () => {
  it("is the 5 imported items, first, with no duplicate and no unrelated feature", async () => {
    const recorded = await runPipeline("claude-sonnet-4-6", {
      extraInstructions: TITLES.map((t) => `- ${t}`).join("\n"),
      sourceRequirements,
    });
    expect(codeAgentRequirementIds(recorded)).toEqual(["NR-1", "NR-2", "NR-3", "NR-4", "NR-5"]);
  });

  it("investigates imported items past the candidate cap, and does not leave their restatements out", async () => {
    const titles = Array.from({ length: 10 }, (_, i) => `Gadget zone${i + 1} export option`);
    docState.requirements = [9, 10].map((n) => ({
      id: `REQ-${n}`,
      text: `The system SHALL provide a gadget zone${n} export option for users.`,
    }));
    const recorded = await runPipeline("claude-sonnet-4-6", {
      extraInstructions: titles.map((t) => `- ${t}`).join("\n"),
      sourceRequirements: titles.map((title, i) => ({
        candidateId: `NR-${i + 1}`,
        requirementId: `imp-${i + 1}`,
        title,
        externalSource: "github",
        externalId: String(5000 + i),
        externalUrl: null,
      })),
    });
    expect(codeAgentRequirementIds(recorded)).toEqual(
      Array.from({ length: 10 }, (_, i) => `NR-${i + 1}`),
    );
  });

  it("still gives the document requirements to the code agent on an ordinary run", async () => {
    docState.requirements = docState.requirements.slice(0, 3);
    const recorded = await runPipeline("claude-sonnet-4-6");
    expect(codeAgentRequirementIds(recorded)).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
  });
});
