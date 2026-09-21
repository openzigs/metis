/**
 * Issue #768 — "Evaluate new requirements" (`extraInstructions`) must trigger
 * deep code analysis.
 *
 * These tests drive the REAL pipeline (`AnalysisOrchestrator.runPipeline`) end to
 * end with a fake AI provider and an injected affected-code seam. NOTHING private
 * is stubbed: the mode, the requirement set, the prompt and the persisted
 * capability are all observed from the outside (what the provider was asked, what
 * the service layer was told to persist). That matters — the bug survived review
 * precisely because the existing tests handed requirements straight to the code
 * agent, forcing agentic mode and hiding the fact that nothing derived a
 * requirement from the operator's free-text box.
 *
 * Scenario under test (the live repro): a project with a code graph, documents
 * that carry NO requirements, and a non-empty `extraInstructions`. Before #768
 * this produced `agentMode: "single-shot"`, `agentic-unavailable-no-requirements`
 * and an empty `affectedCode`.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapability } from "@metis/shared";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { AffectedCodeDeps } from "./affected-code-context.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";

const ANALYSIS_ID = "an_768";
const PROJECT_ID = "pr_768";

/** Mutable per-test fixture state read by the module mocks below. */
const state = {
  /** Whether the project has a built code graph. */
  codeGraphPresent: true,
  /** `requirements` the document agent persisted (the live repro: none). */
  documentRequirements: [] as Array<{ id: string; text: string }>,
};

/** Everything the service layer was asked to persist during a run. */
const persisted = {
  capability: [] as AnalysisCapability[],
  affectedCode: [] as Array<{ candidates: Array<{ id: string; title: string }> }>,
};

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: {
      findFirst: vi.fn(async () => (state.codeGraphPresent ? { id: "cg_1" } : null)),
    },
    // #855 — back `hasSchemaData` (#854), the database-aware resolver's
    // schema-data probe. This suite never sets a per-project override, so the
    // resolved setting defaults to `auto`; 0 counts resolve to "no schema data"
    // (schema mapping stays a no-op, matching pre-#855 default-off behaviour).
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: { count: vi.fn(async () => 0) },
    codeEdge: { count: vi.fn(async () => 0) },
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) => {
        if (where.agentKey === "document") {
          return { output: JSON.stringify({ requirements: state.documentRequirements }) };
        }
        // #770 capability read for the code agent's persisted outcome.
        return { status: "completed" };
      }),
    },
    document: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
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

const { AnalysisOrchestrator } = await import("./orchestrator.js");

/** A code-agent answer the runner/loop can parse (JSON, schema-valid). */
const AGENT_ANSWER = JSON.stringify({
  summary: "ok",
  findings: [],
  notes: [],
});

/** Records every prompt the pipeline sent to the model. */
interface CapturedCall {
  systemMessage?: string;
  userMessage: string;
}

function makeProvider(calls: CapturedCall[]) {
  return {
    chat: vi.fn(
      async (
        messages: Array<{ role: string; content: string }>,
        opts?: { systemMessage?: string },
      ) => {
        calls.push({
          systemMessage: opts?.systemMessage,
          userMessage: messages.map((m) => m.content).join("\n"),
        });
        return {
          content: AGENT_ANSWER,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "test-model",
          provider: "bedrock" as const,
        };
      },
    ),
  };
}

/**
 * Maps every requirement to one symbol — the deterministic #735 seam (no BM25/DB).
 * Note the impact engine hands the mapper the CHANGE (whose `requirementId` is
 * null for free-text candidates), so key off the body, never the id.
 */
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

/** No edges ⇒ blast radius adds nothing beyond the direct mapper hits. */
const emptyGraphSource: AffectedCodeDeps["dataSourceFor"] = () =>
  ({
    getSymbol: async () => null,
    getEdgesFrom: async () => [],
    getEdgesTo: async () => [],
    getSymbolsByFile: async () => [],
    getSymbolsByIds: async () => [],
  }) as unknown as CodeGraphDataSource;

/**
 * Run the real pipeline for `["document","code"]` and return the observable
 * outcome: every model prompt + the finalized capability record.
 */
async function runPipeline(opts: { extraInstructions?: string }): Promise<{
  calls: CapturedCall[];
  capability: AnalysisCapability;
}> {
  const calls: CapturedCall[] = [];
  const provider = makeProvider(calls);
  const orch = new AnalysisOrchestrator({
    provider: provider as never,
    // Retrieval is not what's under test — return no chunks so the document +
    // single-shot paths stay deterministic and DB-free.
    retrieve: async () => [],
    knowledge: {} as never,
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
  ).runPipeline(ANALYSIS_ID, "Metis", "A test project", ["document", "code"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    model: "test-model",
    extraInstructions: opts.extraInstructions,
  });

  const capability = persisted.capability.at(-1);
  if (!capability) throw new Error("capability was never persisted");
  return { calls, capability };
}

/** The prompt the CODE agent saw (the last chat call — code runs after document). */
function codePrompt(calls: CapturedCall[]): string {
  return calls.at(-1)?.userMessage ?? "";
}

/**
 * The REQUIREMENTS block of the code agent's prompt — i.e. exactly the set the
 * agent is told to investigate (as opposed to the AFFECTED CODE data block).
 */
function requirementsBlock(calls: CapturedCall[]): string {
  const prompt = codePrompt(calls);
  const start = prompt.indexOf("BEGIN REQUIREMENTS");
  const end = prompt.indexOf("END REQUIREMENTS");
  return start >= 0 && end > start ? prompt.slice(start, end) : "";
}

/**
 * CASUAL phrasing — the shape that actually broke. `extraInstructions` are also
 * rendered into the document agent's prompt as operator notes, and #750's
 * extraction prompt CAN lift spec-voice text ("REQ-1: … SHALL …") into
 * `requirements[]`, which then reached `detectAgentMode` by luck. A plain English
 * sentence does not get lifted (the doc agent extracts zero, as the fixture
 * asserts), and pre-#768 that user silently got NO code analysis at all. The
 * quality cliff between "writes like a spec" and "writes like a person" is the
 * bug; these tests pin the casual side of it.
 */
const NEW_REQUIREMENTS = [
  "- Add rate limiting to the AI chat endpoint so one user can't exceed 20 requests per minute.",
  "- Show a friendly message when someone hits that limit instead of a raw 429.",
].join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  state.codeGraphPresent = true;
  state.documentRequirements = [];
  persisted.capability = [];
  persisted.affectedCode = [];
  // The fused code-graph seed (#729) is a separate, already-tested path; turn it
  // off so this test observes ONLY the #768 requirement/affected-code wiring.
  process.env.ANALYSIS_FUSED_CODE_RETRIEVAL = "false";
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

describe("#768 — extraInstructions drive deep code analysis", () => {
  it("enters AGENTIC mode from CASUALLY-phrased extraInstructions when the documents carry no requirements", async () => {
    // The live repro: code graph present, document agent extracted ZERO
    // requirements (plain English does not trip #750's extraction prompt), and the
    // operator pasted two new requirements. Pre-#768 this was `single-shot` with
    // `agentic-unavailable-no-requirements` and zero code citations — while the
    // SAME requirements written as "REQ-1: … SHALL …" got the full deep pipeline.
    const { calls, capability } = await runPipeline({ extraInstructions: NEW_REQUIREMENTS });

    expect(state.documentRequirements).toEqual([]); // guard: the fixture really has no doc reqs
    expect(capability.agentMode).toBe("agentic");

    // The code agent's prompt carries the parsed new requirements AND the
    // deterministically-mapped affected code for them.
    const prompt = codePrompt(calls);
    expect(requirementsBlock(calls)).toContain("NR-1");
    expect(requirementsBlock(calls)).toContain("NR-2");
    expect(prompt).toContain("rate limiting to the AI chat endpoint");
    // …and the deterministic requirement→code mapping (#735) rides the same prompt.
    expect(prompt).toContain("AFFECTED CODE");
    expect(prompt).toContain("src/api-handler.ts");
  });

  it("populates affectedCode (#735) from extraInstructions in that scenario", async () => {
    await runPipeline({ extraInstructions: NEW_REQUIREMENTS });

    const affected = persisted.affectedCode.at(-1);
    expect(affected?.candidates.map((c) => c.id)).toEqual(["NR-1", "NR-2"]);
  });

  it("does NOT report agentic-unavailable-no-requirements for an extraInstructions-driven run", async () => {
    const { capability } = await runPipeline({ extraInstructions: NEW_REQUIREMENTS });

    expect(capability.reasons).not.toContain("agentic-unavailable-no-requirements");
    expect(capability.reasons).not.toContain("new-requirements-not-analyzed");
    expect(capability.newRequirementsProvided).toBe(true);
    expect(capability.newRequirementsAnalyzed).toBe(true);
  });

  it("falls back to REQUIREMENT-GROUNDED (not single-shot) when there is no code graph", async () => {
    state.codeGraphPresent = false;

    const { capability } = await runPipeline({ extraInstructions: NEW_REQUIREMENTS });

    expect(capability.agentMode).toBe("requirement-grounded");
    expect(capability.reasons).toContain("no-code-graph");
    expect(capability.reasons).not.toContain("agentic-unavailable-no-requirements");
    expect(capability.newRequirementsAnalyzed).toBe(true);
    // The deterministic mapping is NOT gated on `agentic`: it runs (and persists)
    // in this mode too, driven only by the operator's free text.
    expect(persisted.affectedCode.at(-1)?.candidates.map((c) => c.id)).toEqual(["NR-1", "NR-2"]);
  });

  it("stays SINGLE-SHOT with the untouched reason when no requirements exist anywhere", async () => {
    const { capability } = await runPipeline({});

    expect(capability.agentMode).toBe("single-shot");
    expect(capability.reasons).toContain("agentic-unavailable-no-requirements");
    expect(capability.newRequirementsProvided).toBe(false);
    expect(capability.newRequirementsAnalyzed).toBe(false);
    expect(persisted.affectedCode).toEqual([]);
  });

  it("reports new-requirements-not-analyzed when the operator's text yields no candidates", async () => {
    // The operator DID supply text, but no candidate survives (here: an operator
    // capped the extractor at zero). The run degrades to single-shot — and the
    // banner must say why, instead of claiming "no requirements were found".
    process.env.ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES = "0";
    __resetConfigSingleton();

    const { capability } = await runPipeline({ extraInstructions: NEW_REQUIREMENTS });
    delete process.env.ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES;

    expect(capability.agentMode).toBe("single-shot");
    expect(capability.newRequirementsProvided).toBe(true);
    expect(capability.newRequirementsAnalyzed).toBe(false);
    expect(capability.reasons).toContain("new-requirements-not-analyzed");
    // The honest reason replaces the one that would now be a lie.
    expect(capability.reasons).not.toContain("agentic-unavailable-no-requirements");
  });

  it("does not regress the document-extracted-requirements path", async () => {
    state.documentRequirements = [{ id: "REQ-001", text: "The system must log every login." }];

    const { calls, capability } = await runPipeline({});

    expect(capability.agentMode).toBe("agentic");
    expect(capability.reasons).not.toContain("agentic-unavailable-no-requirements");
    expect(codePrompt(calls)).toContain("REQ-001");
    expect(codePrompt(calls)).not.toContain("NR-1");
    // No new requirements ⇒ no affected-code mapping (byte-identical to pre-#768).
    expect(persisted.affectedCode).toEqual([]);
  });

  it("keeps FORMALLY-phrased extraInstructions working, without double-counting the doc agent's echo", async () => {
    // The formal side of the quality cliff: spec-voice text pasted into the box is
    // ALSO shown to the document agent as operator notes, and #750's extraction
    // prompt lifts it into `requirements[]` — verbatim or rephrased. This already
    // reached agentic mode by luck pre-#768; it must still work, and the same
    // requirement must NOT be investigated twice now that we parse the box too.
    state.documentRequirements = [
      // What the doc agent echoed back (rephrased into spec voice, as it does).
      {
        id: "REQ-001",
        text: "The system SHALL rate limit the AI chat endpoint to 20 requests per minute per user.",
      },
    ];

    const { calls, capability } = await runPipeline({
      // Blank-line separated, as a pasted spec is: the deterministic splitter
      // yields one candidate per paragraph (consecutive lines are ONE requirement).
      extraInstructions: [
        "REQ-1: The AI chat endpoint SHALL rate limit each user to 20 requests per minute.",
        "REQ-2: Publishing a document SHALL record an audit event.",
      ].join("\n\n"),
    });

    expect(capability.agentMode).toBe("agentic");

    // The investigated set carries the rate-limit requirement ONCE (the candidate
    // collapses into the doc agent's echo of it) plus the genuinely-new one, which
    // keeps its extractor-assigned id so it still lines up with its #735 entry.
    const requirements = requirementsBlock(calls);
    expect(requirements).toContain("REQ-001");
    expect(requirements).toContain("NR-2");
    expect(requirements).not.toContain("NR-1");
    expect(requirements).toContain("Publishing a document SHALL record an audit event");

    // The AFFECTED CODE data block maps what the operator PASTED, so it still shows
    // both pasted items. That is evidence, not an investigation list — the agent's
    // requirement set (asserted above) is what drives the investigation, so no
    // requirement is investigated twice.
    expect(persisted.affectedCode.at(-1)?.candidates.map((c) => c.id)).toEqual(["NR-1", "NR-2"]);
  });

  it("drops a verbatim restatement of a document requirement", async () => {
    state.documentRequirements = [
      { id: "REQ-001", text: "The API must expose a health-check endpoint at /api/status." },
    ];

    const { calls } = await runPipeline({
      // Same requirement, re-punctuated — plus a genuinely new one.
      extraInstructions: [
        "- The API must expose a health-check endpoint at /api/status",
        "- Every analysis run must emit an audit event when it completes.",
      ].join("\n"),
    });

    const requirements = requirementsBlock(calls);
    expect(requirements).toContain("REQ-001");
    expect(requirements).not.toContain("NR-1");
    expect(requirements).toContain("NR-2");
  });
});

/**
 * Issue #1112 (Epic #1107) — the same REAL pipeline, now asserting the INPUT-side
 * account reaches the persisted capability record. #1101's whole problem was that
 * the loss was unobservable from outside; these assertions are deliberately made
 * against the persisted record the results page reads, not against an internal.
 */
describe("#1112 — input-side coverage reaches the persisted capability", () => {
  /**
   * The #1101 paste: seven numbered requirements, each with its own
   * acceptance-criteria bullets.
   *
   * Before #1136 the block splitter counted every bullet, so this overflowed the
   * default cap of 8 and the TAIL fell off — R7. The bullets are now attributed to
   * the requirement above them, so all seven reach the agents.
   */
  const SEVEN_REQUIREMENTS = Array.from({ length: 7 }, (_, i) => {
    const n = i + 1;
    return [
      `R${n}: The system must support capability number ${n}.`,
      "",
      `- Acceptance criteria ${n}a.`,
      `- Acceptance criteria ${n}b.`,
    ].join("\n");
  }).join("\n\n");

  /** A paste that genuinely holds more requirements than the (untouched) cap. */
  const TWELVE_REQUIREMENTS = Array.from(
    { length: 12 },
    (_, i) => `- The system must support capability number ${i + 1}.`,
  ).join("\n");

  it("investigates R7 rather than dropping it in silence (the #1101 repro, fixed by #1136)", async () => {
    const { calls, capability } = await runPipeline({ extraInstructions: SEVEN_REQUIREMENTS });
    const account = capability.requirementInputAccount;

    expect(account).toBeDefined();
    // #1136: the unit being counted is the requirement, not its criteria.
    expect(account!.parsedCount).toBe(7);
    expect(account!.dropped).toEqual([]);
    expect(account!.analyzedIds.length + account!.merged.length + account!.dropped.length).toBe(
      account!.parsedCount,
    );

    // R7's text is either investigated or named in the account — never absent.
    const reported = account!.dropped.some((d) => d.excerpt.includes("capability number 7"));
    const investigated = requirementsBlock(calls).includes("capability number 7");
    expect(reported || investigated).toBe(true);
    expect(investigated).toBe(true);
  });

  it("does not report unqualified success for a run that discarded input", async () => {
    const { capability } = await runPipeline({ extraInstructions: TWELVE_REQUIREMENTS });

    expect(capability.requirementInputAccount!.dropped.length).toBeGreaterThan(0);
    expect(capability.reasons).toContain("requirement-inputs-dropped");
  });

  it("reports NO dropped-input reason once the criteria stop inflating the count (#1136)", async () => {
    const { capability } = await runPipeline({ extraInstructions: SEVEN_REQUIREMENTS });

    expect(capability.reasons).not.toContain("requirement-inputs-dropped");
  });

  it("reports a de-duplicated candidate as MERGED, naming the survivor", async () => {
    state.documentRequirements = [
      { id: "REQ-001", text: "The API must expose a health-check endpoint at /api/status." },
    ];

    const { capability } = await runPipeline({
      extraInstructions: [
        "- The API must expose a health-check endpoint at /api/status",
        "- Every analysis run must emit an audit event when it completes.",
      ].join("\n"),
    });

    const account = capability.requirementInputAccount;
    expect(account?.merged).toEqual([
      expect.objectContaining({ id: "NR-1", mergedIntoId: "REQ-001" }),
    ]);
    expect(account?.dropped).toEqual([]);
    // A merge is accounted for, so it is NOT a degradation.
    expect(capability.reasons).not.toContain("requirement-inputs-dropped");
  });

  it("carries no account at all for a run with no free-text requirements", async () => {
    const { capability } = await runPipeline({});
    expect(capability.requirementInputAccount).toBeUndefined();
  });
});
