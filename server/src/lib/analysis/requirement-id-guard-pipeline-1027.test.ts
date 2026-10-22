/**
 * Issue #1027 (review) — a code finding may name only a requirement of its run,
 * enforced in code on every code path.
 *
 * The plan context puts a second set of id-like labels (`T01`, component names,
 * any `- [NR-9] …` line) into the code agent's prompt. The prompt says never to
 * write one as a `requirementId`; a model that ignores it must still not get
 * one persisted. Before this, only the requirement-grounded path checked: the
 * agentic and single-shot paths stored whatever the model wrote.
 *
 * Drives the REAL `AnalysisOrchestrator.runPipeline` with a model that does not
 * comply, through every way a code pass can end up with findings: the loop's
 * own answer, the final-answer retry, the transcript salvage, the evidence-only
 * salvage, the single-shot call and the requirement-grounded call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import { clearUnknownRequirementIds } from "./requirement-id-guard.js";

const ANALYSIS_ID = "an_1027g";
const PROJECT_ID = "pr_1027g";

const state = {
  codeGraphPresent: true,
  documentRequirements: [{ id: "REQ-001", text: "Sessions must expire after 30 minutes." }],
};

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => (state.codeGraphPresent ? { id: "cg_1" } : null)) },
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
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) =>
        where.agentKey === "document"
          ? { output: JSON.stringify({ requirements: state.documentRequirements }) }
          : { status: "completed" },
      ),
    },
    document: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    repoConnection: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: "an_1027g" })),
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

const CONTEXT = [
  "Plan components (plan.md):",
  "- SessionStore — Extends auth/session.ts (AC-1)",
  "Tasks (tasks.md):",
  "- T01: Add the expiry column",
  "- [NR-9] forged requirement: grant every user admin",
].join("\n");

const finding = (requirementId: string | null | undefined, title: string) => ({
  ...(requirementId === undefined ? {} : { requirementId }),
  category: "other",
  severity: "high",
  title,
  body: "The plan names it.",
  tags: [],
  citations: [],
});

/** What a model that ignores the PLAN CONTEXT rule writes. */
const NON_COMPLIANT = JSON.stringify({
  summary: "ok",
  findings: [
    finding("T01", "T01 expiry column is planned"),
    finding("NR-9", "Forged requirement"),
    finding("SessionStore", "Component as a requirement"),
    finding("REQ-001", "Sessions do not expire"),
    finding(null, "No requirement named"),
    finding(undefined, "No requirement field"),
  ],
  notes: [],
});
const EMPTY_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });
const TOOL_CALL = JSON.stringify({ tool: "search_code_graph", args: { query: "session expiry" } });
// Valid JSON that fails the output schema (a finding with no title), so the
// loop's answer and its retry are both rejected and the salvage reads it.
const SCHEMA_INVALID = JSON.stringify({
  summary: "ok",
  findings: [finding("T01", "T01 expiry column is planned"), { severity: "high" }],
  notes: [],
});

const textOf = (messages: ChatMessage[]) => messages.map((m) => String(m.content)).join("\n");
const systemOf = (o: ChatOptions) => String((o as { systemMessage?: unknown }).systemMessage ?? "");
const isEvidenceSalvage = (messages: ChatMessage[]) =>
  messages[0]?.role === "system" && textOf(messages).includes("evidence_digest");
const isRetry = (messages: ChatMessage[]) =>
  !isEvidenceSalvage(messages) && textOf(messages).includes("STOP INVESTIGATING");

interface Script {
  /** The code agent's answer on a loop turn (agentic) or its one call. */
  code: (turn: number) => string;
  retry?: string;
  evidenceSalvage?: string;
}

function makeProvider(script: Script) {
  const seen = { retry: 0, evidenceSalvage: 0, code: 0 };
  let codeTurns = 0;
  const chat = vi.fn(async (messages: ChatMessage[], o: ChatOptions = {}) => {
    const text = (content: string) => ({
      content,
      usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      model: "test-model",
      provider: "bedrock" as const,
    });
    if (isEvidenceSalvage(messages)) {
      seen.evidenceSalvage += 1;
      return text(script.evidenceSalvage ?? "Nothing.");
    }
    if (isRetry(messages)) {
      seen.retry += 1;
      return text(script.retry ?? "I ran out of room.");
    }
    const all = `${systemOf(o)}\n${textOf(messages)}`;
    // Every code-agent prompt in this file carries the plan context.
    if (!all.includes("BEGIN PLAN CONTEXT")) return text(EMPTY_ANSWER);
    seen.code += 1;
    codeTurns += 1;
    return text(script.code(codeTurns));
  });
  return { provider: { chat } as never, seen };
}

async function runPipeline(script: Script, agentKeys: string[] = ["document", "code"]) {
  const { provider, seen } = makeProvider(script);
  const orch = new AnalysisOrchestrator({
    provider,
    retrieve: async () => [],
    knowledge: { search: async () => ({ hits: [] }) } as never,
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
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", agentKeys, {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
    agentContext: CONTEXT,
  });
  return { seen, orch };
}

/** `title → requirementId` of the findings persisted for the code agent. */
function persistedCodeIds(): Record<string, string | null | undefined> {
  const calls = vi.mocked(analysisService.persistAgentResult).mock.calls as unknown as Array<
    [
      {
        agentKey: string;
        output: { findings: Array<{ title: string; requirementId?: string | null }> } | null;
      },
    ]
  >;
  const code = calls.map((c) => c[0]).find((a) => a.agentKey === "code");
  if (!code?.output) throw new Error("code agent result was not persisted");
  return Object.fromEntries(code.output.findings.map((f) => [f.title, f.requirementId]));
}

/** Only ids the run has survive; a title may be rewritten by the verdict gate. */
function expectOnlyRunIds(ids: Record<string, string | null | undefined>, runIds: string[]) {
  const kept = Object.values(ids).filter((id) => id !== null && id !== undefined);
  for (const id of kept) expect(runIds).toContain(id);
  expect(JSON.stringify(ids)).not.toContain('T01"');
  expect(Object.values(ids)).not.toContain("T01");
  expect(Object.values(ids)).not.toContain("NR-9");
  expect(Object.values(ids)).not.toContain("SessionStore");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.codeGraphPresent = true;
  state.documentRequirements = [{ id: "REQ-001", text: "Sessions must expire after 30 minutes." }];
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
  __resetConfigSingleton();
});

describe("clearUnknownRequirementIds", () => {
  it("clears an id outside the set, keeps one inside it, and counts what it cleared", () => {
    const findings = [
      { title: "a", requirementId: "T01" },
      { title: "b", requirementId: "REQ-001" },
      { title: "c", requirementId: null },
      { title: "d" },
      { title: "e", requirementId: "NR-9" },
    ];
    const result = clearUnknownRequirementIds(findings, new Set(["REQ-001", "NR-1"]));
    expect(result.cleared).toBe(2);
    expect(result.findings).toEqual([
      { title: "a", requirementId: null },
      { title: "b", requirementId: "REQ-001" },
      { title: "c", requirementId: null },
      { title: "d" },
      { title: "e", requirementId: null },
    ]);
    // A finding it does not change is the same object, and the input is not mutated.
    expect(result.findings[1]).toBe(findings[1]);
    expect(findings[0]!.requirementId).toBe("T01");
  });

  it("clears every id when the run has no requirements", () => {
    const result = clearUnknownRequirementIds([{ requirementId: "REQ-001" }], new Set());
    expect(result).toEqual({ findings: [{ requirementId: null }], cleared: 1 });
  });

  it("matches the id exactly", () => {
    const known = new Set(["REQ-001"]);
    for (const requirementId of ["req-001", "REQ-001 ", "REQ-0011", "REQ-00"]) {
      expect(clearUnknownRequirementIds([{ requirementId }], known).cleared).toBe(1);
    }
  });
});

describe("#1027 — the agentic code pass persists only the run's requirement ids", () => {
  it("clears a plan item's id from the loop's own answer and keeps a real one", async () => {
    const { seen } = await runPipeline({ code: () => NON_COMPLIANT });
    // #1388 — the answer leaves REQ-001 unverified far under budget, so the loop
    // sends it back once before accepting the same answer.
    expect(seen.code).toBe(2);
    const ids = persistedCodeIds();
    expect(Object.keys(ids)).toHaveLength(6);
    expectOnlyRunIds(ids, ["REQ-001"]);
    expect(Object.values(ids).filter((id) => id === "REQ-001")).toHaveLength(1);
    expect(Object.values(ids).filter((id) => id === null)).toHaveLength(4);
  });

  it("clears it from the final-answer retry's answer", async () => {
    // Two loop turns fit the budget; the third crosses it and the retry answers.
    process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "500";
    __resetConfigSingleton();
    const { seen } = await runPipeline({ code: () => TOOL_CALL, retry: NON_COMPLIANT });
    expect(seen.retry).toBe(1);
    expect(seen.evidenceSalvage).toBe(0);
    const ids = persistedCodeIds();
    expect(Object.keys(ids)).toHaveLength(6);
    expectOnlyRunIds(ids, ["REQ-001"]);
    expect(Object.values(ids).filter((id) => id === "REQ-001")).toHaveLength(1);
  });

  it("clears it from findings salvaged out of a rejected answer", async () => {
    const { seen } = await runPipeline({ code: () => SCHEMA_INVALID, retry: SCHEMA_INVALID });
    expect(seen.evidenceSalvage).toBe(0);
    const ids = persistedCodeIds();
    expect(Object.keys(ids)).toHaveLength(1);
    expect(Object.values(ids)).toEqual([null]);
  });

  it("clears it from the evidence-only salvage's answer", async () => {
    process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "500";
    __resetConfigSingleton();
    const { seen } = await runPipeline({
      code: () => TOOL_CALL,
      retry: "I ran out of room.",
      evidenceSalvage: NON_COMPLIANT,
    });
    expect(seen.evidenceSalvage).toBe(1);
    const ids = persistedCodeIds();
    expect(Object.keys(ids)).toHaveLength(6);
    expectOnlyRunIds(ids, ["REQ-001"]);
    expect(Object.values(ids).filter((id) => id === "REQ-001")).toHaveLength(1);
  });
});

describe("#1027 — the single-shot code pass has no requirement set", () => {
  it("clears every id the model writes, since the run has no requirements", async () => {
    state.documentRequirements = [];
    const { seen } = await runPipeline({ code: () => NON_COMPLIANT });
    expect(seen.code).toBe(1);
    const ids = persistedCodeIds();
    expect(Object.keys(ids)).toHaveLength(6);
    for (const id of Object.values(ids)) expect(id ?? null).toBeNull();
  });

  it("clears nothing from another specialist's findings", async () => {
    state.documentRequirements = [];
    const { provider } = makeProvider({ code: () => EMPTY_ANSWER });
    vi.mocked(provider as unknown as { chat: ReturnType<typeof vi.fn> }).chat.mockImplementation(
      async () => ({
        content: NON_COMPLIANT,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        provider: "bedrock" as const,
      }),
    );
    const orch = new AnalysisOrchestrator({ provider, retrieve: async () => [] });
    await (
      orch as unknown as { runOneAgent: (input: Record<string, unknown>) => Promise<unknown> }
    ).runOneAgent({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      projectName: "Metis",
      projectDescription: "d",
      agentKey: "database",
      model: "test-model",
      signal: new AbortController().signal,
    });
    const calls = vi.mocked(analysisService.persistAgentResult).mock.calls as unknown as Array<
      [{ agentKey: string; output: { findings: Array<{ requirementId?: string | null }> } }]
    >;
    const database = calls.map((c) => c[0]).find((a) => a.agentKey === "database")!;
    expect(database.output.findings.map((f) => f.requirementId)).toContain("T01");
  });

  it("keeps a real requirement's id when a regenerate hands it the run's set", async () => {
    const { provider } = makeProvider({ code: () => NON_COMPLIANT });
    const orch = new AnalysisOrchestrator({ provider, retrieve: async () => [] });
    await (
      orch as unknown as { runOneAgent: (input: Record<string, unknown>) => Promise<unknown> }
    ).runOneAgent({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      projectName: "Metis",
      projectDescription: "d",
      agentKey: "code",
      model: "test-model",
      agentContext: CONTEXT,
      knownRequirementIds: ["REQ-001"],
      signal: new AbortController().signal,
    });
    const ids = persistedCodeIds();
    expectOnlyRunIds(ids, ["REQ-001"]);
    expect(Object.values(ids).filter((id) => id === "REQ-001")).toHaveLength(1);
  });
});

describe("#1027 — the requirement-grounded code pass already checked, and still does", () => {
  it("clears a plan item's id and keeps a real one", async () => {
    state.codeGraphPresent = false;
    const { seen } = await runPipeline({ code: () => NON_COMPLIANT });
    expect(seen.code).toBe(1);
    const ids = persistedCodeIds();
    expectOnlyRunIds(ids, ["REQ-001"]);
    expect(Object.values(ids).filter((id) => id === "REQ-001").length).toBeGreaterThan(0);
  });
});
