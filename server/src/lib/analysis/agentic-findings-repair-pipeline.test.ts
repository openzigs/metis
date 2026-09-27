/**
 * #298 — one over-long field must not invalidate a whole agentic findings
 * answer. Driven through the REAL `AnalysisOrchestrator.runPipeline`, so what
 * is asserted is what `persistAgentResult` was handed — the write the analysis
 * page reads back — not what a helper returned.
 *
 * The answer shapes are the ones #214 measured on DeepSeek-flash: a citation
 * `documentId` that is really a path (> 64 chars, the id limit) and a `notes`
 * entry over 512 characters. Before #298 each made `agentOutputSchema.parse`
 * throw, the pass degraded, and salvage — which applies the same per-finding
 * schema — lost the finding carrying the bad citation too.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";

const ANALYSIS_ID = "an_298";
const PROJECT_ID = "pr_298";
const KNOWN_DOC_ID = "doc_loanterms_0001";

const { documentFindMany } = vi.hoisted(() => ({
  documentFindMany: vi.fn(async () => [
    { id: "doc_loanterms_0001", filename: "Loan Terms and Conditions.md" },
    { id: "doc_other_000000001", filename: "Other.md" },
  ]),
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    codeEdge: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) => {
        if (where.agentKey === "document") {
          return {
            output: JSON.stringify({
              requirements: [{ id: "REQ-001", text: "Loan terms must be configurable." }],
            }),
          };
        }
        return { status: "completed" };
      }),
    },
    document: { findFirst: vi.fn(async () => null), findMany: documentFindMany },
    repoConnection: { findMany: vi.fn(async () => []) },
  },
}));

const { persistAgentResult } = vi.hoisted(() => ({
  persistAgentResult: vi.fn(async (_input: unknown) => ({ id: "ar_1", findingIds: [] })),
}));

vi.mock("./analysis-service.js", () => ({
  createAnalysis: vi.fn(async () => ({ id: ANALYSIS_ID })),
  finalizeAnalysisDelta: vi.fn(async () => undefined),
  getAnalysisCapability: vi.fn(async () => null),
  getStructuredRequirements: vi.fn(async () => null),
  markAnalysisCancelled: vi.fn(async () => undefined),
  markAnalysisCompleted: vi.fn(async () => undefined),
  markAnalysisFailed: vi.fn(async () => undefined),
  persistAgentResult,
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
const { isSchemaValidFinalAnswer } = await import("./agentic-degradation.js");

const DOC_AGENT_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });

/** A path where an id belongs: longer than the 64-char id limit, names a known document. */
const PATH_AS_ID = "docs/requirements/product/lending/Loan Terms and Conditions.md#chunk2";
/** Quoted text where an id belongs: names no document, and over the 256 the issue measured. */
const SNIPPET_AS_ID = "The loan term is fixed at origination and cannot be changed. ".repeat(5);
const LONG_NOTE = "Investigated the loan-term configuration across the service layer. ".repeat(9);

function finding(citations: unknown[], extra: Record<string, unknown> = {}) {
  return {
    category: "architecture",
    severity: "medium",
    title: "Loan term is hard-coded",
    body: "The term is fixed at origination.",
    tags: [],
    requirementId: "REQ-001",
    citations,
    ...extra,
  };
}

/** The #214 shape: one path-as-id, one snippet-as-id, one over-long note. */
const ANSWER_298 = JSON.stringify({
  summary: "One gap found.",
  findings: [
    finding([
      { documentId: PATH_AS_ID, chunkIndex: 2 },
      { documentId: SNIPPET_AS_ID, chunkIndex: 0 },
    ]),
  ],
  notes: [LONG_NOTE],
});

/** Genuinely malformed: the only finding has no title and a numeric severity. */
const MALFORMED = JSON.stringify({
  summary: "One gap found.",
  findings: [
    { ...finding([{ documentId: PATH_AS_ID, chunkIndex: 2 }]), title: undefined, severity: 3 },
  ],
  notes: [],
});

type Recorded = { messages: ChatMessage[]; opts: ChatOptions };

function makeProvider(codeAnswer: string) {
  const recorded: Recorded[] = [];
  let turns = 0;
  const chat = vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
    recorded.push({ messages: [...messages], opts });
    turns += 1;
    return {
      // Call 1 is the single-shot document agent; every later call is the
      // code pass (its turn, and the #769 retry when the gate rejects).
      content: turns === 1 ? DOC_AGENT_ANSWER : codeAnswer,
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      model: "test-model",
      provider: "bedrock" as const,
    };
  });
  return { provider: { chat } as never, recorded };
}

async function runPipeline(codeAnswer: string): Promise<Recorded[]> {
  const { provider, recorded } = makeProvider(codeAnswer);
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

interface PersistedOutput {
  summary: string;
  findings: Array<{ title: string; citations: Array<Record<string, unknown>> }>;
  notes: string[];
}

function persistedCodeOutput(): PersistedOutput {
  const call = persistAgentResult.mock.calls
    .map(([input]) => input as { agentKey: string; status: string; output: PersistedOutput })
    .find((i) => i.agentKey === "code" && i.status === "completed");
  expect(call, "the code pass persisted a completed result").toBeDefined();
  return call!.output;
}

const retryCalls = (recorded: Recorded[]) =>
  recorded.filter((c) =>
    c.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("STOP INVESTIGATING"),
    ),
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

describe("#298 — an over-long documentId and note are repaired, not fatal", () => {
  it("persists the finding, resolves the path to the real id, drops the snippet, truncates the note", async () => {
    const recorded = await runPipeline(ANSWER_298);

    const output = persistedCodeOutput();
    // The answer was accepted as it stood: no #769 retry, no degradation.
    expect(retryCalls(recorded)).toHaveLength(0);
    expect(output.summary).toBe("One gap found.");
    expect(output.findings).toHaveLength(1);
    // The path named a known document → its real id. The snippet named none →
    // that citation (which had no other identity) is gone; the finding is not.
    expect(output.findings[0]!.citations).toHaveLength(1);
    expect(output.findings[0]!.citations[0]).toMatchObject({
      documentId: KNOWN_DOC_ID,
      chunkIndex: 2,
    });
    // The stored limit is kept: truncated to exactly 512, with an ellipsis.
    expect(output.notes[0]).toHaveLength(512);
    expect(output.notes[0]!.endsWith("…")).toBe(true);
    expect(output.notes[0]!.slice(0, 100)).toBe(LONG_NOTE.slice(0, 100));
    // Every repair is recorded on the persisted output.
    const repairNote = output.notes.find((n) => n.startsWith("REPAIRED:"));
    expect(repairNote).toContain("1 document-id-resolved");
    expect(repairNote).toContain("1 citation-dropped");
    expect(repairNote).toContain("1 note-truncated");
  });

  it("looks the documents up scoped to the run's project", async () => {
    await runPipeline(ANSWER_298);

    const lookups = documentFindMany.mock.calls as unknown as Array<
      [{ where: Record<string, unknown>; select: Record<string, unknown> }]
    >;
    const repairLookup = lookups.find(([arg]) => arg.select.filename === true);
    expect(repairLookup).toBeDefined();
    expect(repairLookup![0].where).toEqual({ projectId: PROJECT_ID, deletedAt: null });
  });

  it("salvage repairs too: a finding with a path-as-id survives an otherwise-invalid answer", async () => {
    // `summary` missing ⇒ the answer fails the schema whatever is repaired, so
    // the pass degrades and salvage runs per finding.
    const noSummary = JSON.stringify({ ...JSON.parse(ANSWER_298), summary: undefined });

    await runPipeline(noSummary);

    const output = persistedCodeOutput();
    expect(output.summary).toMatch(/^Code analysis degraded/);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]!.citations).toEqual([
      expect.objectContaining({ documentId: KNOWN_DOC_ID, chunkIndex: 2 }),
    ]);
    expect(output.notes.some((n) => n.startsWith("REPAIRED:"))).toBe(true);
  });

  // PR #300 review — a resolvable id on a citation with NO chunkIndex. The
  // gate (no documents) dropped it and said "valid"; the orchestrator
  // (documents) resolved it into an incomplete document citation and the
  // parse threw, so the pass degraded with no retry and salvage lost the
  // finding. Gate and orchestrator must reach the same verdict.
  const NO_CHUNK = JSON.stringify({
    summary: "One gap found.",
    findings: [
      finding([
        { documentId: "docs/requirements/product/lending/final/Loan Terms and Conditions.md" },
      ]),
    ],
    notes: [LONG_NOTE],
  });

  it("gate and orchestrator agree on a resolvable id with no chunkIndex: accepted, finding kept", async () => {
    expect(isSchemaValidFinalAnswer(NO_CHUNK)).toBe(true);

    const recorded = await runPipeline(NO_CHUNK);

    const output = persistedCodeOutput();
    expect(retryCalls(recorded)).toHaveLength(0);
    expect(output.summary).toBe("One gap found.");
    expect(output.findings).toHaveLength(1);
    // Incomplete as a document citation even once resolved ⇒ dropped, recorded.
    expect(output.findings[0]!.citations).toEqual([]);
    const repairNote = output.notes.find((n) => n.startsWith("REPAIRED:"));
    expect(repairNote).toContain("1 citation-dropped");
    expect(repairNote).toContain("1 note-truncated");
  });

  it("salvage keeps the finding with a resolvable id and no chunkIndex, and records the repair", async () => {
    const noSummary = JSON.stringify({ ...JSON.parse(NO_CHUNK), summary: undefined });

    await runPipeline(noSummary);

    const output = persistedCodeOutput();
    expect(output.summary).toMatch(/^Code analysis degraded/);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]!.citations).toEqual([]);
    expect(output.notes.find((n) => n.startsWith("REPAIRED:"))).toContain("1 citation-dropped");
  });

  it("a failing document lookup drops the id instead of failing the pass", async () => {
    documentFindMany.mockRejectedValueOnce(new Error("db down"));

    const recorded = await runPipeline(ANSWER_298);

    const output = persistedCodeOutput();
    expect(retryCalls(recorded)).toHaveLength(0);
    expect(output.summary).toBe("One gap found.");
    expect(output.findings).toHaveLength(1);
    // Nothing to resolve against: both invalid-id citations are dropped.
    expect(output.findings[0]!.citations).toEqual([]);
    expect(output.notes.find((n) => n.startsWith("REPAIRED:"))).toContain("2 citation-dropped");
  });

  it("a genuinely malformed answer is still rejected — nothing is invented", async () => {
    const recorded = await runPipeline(MALFORMED);

    const output = persistedCodeOutput();
    // The gate rejected it, so the one bounded retry fired…
    expect(retryCalls(recorded).length).toBeGreaterThan(0);
    // …and the pass degraded with no finding: the repair did not make a
    // title-less, numeric-severity finding valid.
    expect(output.summary).toMatch(/^Code analysis degraded/);
    expect(output.findings).toHaveLength(0);
  });

  it("an answer with nothing to repair loads no documents and carries no repair note", async () => {
    await runPipeline(
      JSON.stringify({
        summary: "One gap found.",
        findings: [finding([{ documentId: KNOWN_DOC_ID, chunkIndex: 2 }])],
        notes: ["short"],
      }),
    );

    const output = persistedCodeOutput();
    expect(output.notes).toEqual(["short"]);
    const lookups = documentFindMany.mock.calls as unknown as Array<
      [{ select?: Record<string, unknown> }]
    >;
    expect(lookups.some(([arg]) => arg.select?.filename === true)).toBe(false);
  });
});
