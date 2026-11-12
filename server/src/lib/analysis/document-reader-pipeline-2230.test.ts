/**
 * Issue #2230 — Requirements Analysis's document step through the document
 * reader, driven through the REAL pipeline (`runPipeline`) with a fake
 * provider. What is asserted is what a later step reads back: the document
 * agent's persisted output, read by `extractRequirementsFromDocAgent` the way
 * the code agent's requirement set is built, and the finalized capability the
 * results page renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisCapability } from "@metis/shared";
import { __resetConfigSingleton } from "../config/config-service.js";
import type { AffectedCodeDeps } from "./affected-code-context.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { ReaderDocumentLoader } from "./document-reader-agent.js";

const ANALYSIS_ID = "an_2230";
const PROJECT_ID = "pr_2230";

/** What the service layer was asked to persist, by agent. */
const persisted = {
  capability: [] as AnalysisCapability[],
  outputs: new Map<string, unknown>(),
};

vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findFirst: vi.fn(async () => ({ id: "cg_1" })) },
    databaseConnection: { count: vi.fn(async () => 0) },
    codeSymbol: { count: vi.fn(async () => 0) },
    codeEdge: { count: vi.fn(async () => 0) },
    agentResult: {
      // Reads back what `persistAgentResult` stored, as the real table would.
      findFirst: vi.fn(async ({ where }: { where: { agentKey: string } }) => {
        const output = persisted.outputs.get(where.agentKey);
        return output
          ? { output: JSON.stringify(output), status: "completed" }
          : { status: "completed" };
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
  persistAgentResult: vi.fn(async (input: { agentKey: string; output: unknown }) => {
    persisted.outputs.set(input.agentKey, input.output);
  }),
  persistAnalysisEnhancement: vi.fn(async () => undefined),
  persistAnalysisCapability: vi.fn(async (_id: string, capability: AnalysisCapability) => {
    persisted.capability.push(capability);
  }),
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
  // #2262 — the pipeline persists the phase's results; without it the phase threw and was logged.
  persistAgentPhaseResults: vi.fn(async () => undefined),
}));
vi.mock("../rag/acl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rag/acl.js")>()),
  resolveAclActor: vi.fn(async (userId: string) => ({ userId, role: "member" })),
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
const { prisma } = await import("../prisma.js");
const { resolveAclActor, InactiveAclActorError } = await import("../rag/acl.js");
const service = await import("./analysis-service.js");

const DOC_TEXT = [
  "# Booking FRD",
  "",
  "## 1 Access",
  "",
  "The portal shall lock an account after five failed attempts.",
  "",
  "## 2 Background",
  "",
  "The clinic opened its first site in 1998 and grew from there.",
  "",
].join("\n");

const AGENT_ANSWER = JSON.stringify({ summary: "ok", findings: [], notes: [] });
const READER_REPLY = JSON.stringify({
  statements: [
    {
      section: "S2",
      kind: "requirement",
      statement: "Lock an account after five failed logins.",
      quote: "The portal shall lock an account after five failed attempts.",
    },
    {
      section: "S3",
      kind: "background",
      statement: "The clinic dates from 1998.",
      quote: "The clinic opened its first site in 1998",
    },
  ],
});

interface CapturedCall {
  systemMessage?: string;
  userMessage: string;
}

/** `readsBeforeFailing`: the reader's statements calls answered before the provider fails them. */
function makeProvider(calls: CapturedCall[], readsBeforeFailing = Number.POSITIVE_INFINITY) {
  let reads = 0;
  return {
    key: "anthropic",
    model: "claude-sonnet-5-5",
    offline: false,
    chat: vi.fn(
      async (
        messages: Array<{ role: string; content: string }>,
        opts?: { systemMessage?: string },
      ) => {
        const systemMessage = opts?.systemMessage ?? "";
        calls.push({ systemMessage, userMessage: messages.map((m) => m.content).join("\n") });
        if (systemMessage.includes("from beginning to end") && ++reads > readsBeforeFailing) {
          throw new Error("upstream down");
        }
        const content = systemMessage.includes("from beginning to end")
          ? READER_REPLY
          : systemMessage.includes("combining the statements")
            ? JSON.stringify({ duplicates: [], crossReferences: [] })
            : AGENT_ANSWER;
        return {
          content,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "claude-sonnet-5-5",
          provider: "anthropic" as const,
        };
      },
    ),
  };
}

const mapEveryRequirement: AffectedCodeDeps["mapRequirement"] = async () => [];
const emptyGraphSource: AffectedCodeDeps["dataSourceFor"] = () =>
  ({
    getSymbol: async () => null,
    getEdgesFrom: async () => [],
    getEdgesTo: async () => [],
    getSymbolsByFile: async () => [],
    getSymbolsByIds: async () => [],
  }) as unknown as CodeGraphDataSource;

const loader = vi.fn<ReaderDocumentLoader>(async (_projectId, ids) =>
  ids.map((documentId) =>
    documentId === "doc_1" || documentId === "doc_2"
      ? {
          ok: true as const,
          document: {
            documentId,
            filename: "booking.docx",
            title: "Booking FRD",
            text: DOC_TEXT,
            chunks: [{ index: 0, text: DOC_TEXT }],
          },
        }
      : documentId === "doc_broken"
        ? {
            ok: false as const,
            documentId,
            filename: "broken.docx",
            reason: "Its stored file could not be read.",
          }
        : // #2297 — as the production loader reports a missing or not-ready id.
          {
            ok: false as const,
            documentId,
            filename: documentId,
            reason: "It is not ready.",
            unavailable: true as const,
          },
  ),
);

async function runPipeline(
  opts: Record<string, unknown> = {},
  readsBeforeFailing?: number,
): Promise<{
  calls: CapturedCall[];
  capability: AnalysisCapability;
  retrieve: ReturnType<typeof vi.fn>;
}> {
  const calls: CapturedCall[] = [];
  const retrieve = vi.fn(async () => []);
  const orch = new AnalysisOrchestrator({
    provider: makeProvider(calls, readsBeforeFailing) as never,
    retrieve,
    knowledge: {} as never,
    affectedCode: { mapRequirement: mapEveryRequirement, dataSourceFor: emptyGraphSource },
    readerDocuments: loader,
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
  ).runPipeline(ANALYSIS_ID, "Clinic", "", ["document", "code"], {
    projectId: PROJECT_ID,
    startedById: "u1",
    documentIds: ["doc_1", "doc_gone"],
    ...opts,
  });
  const capability = persisted.capability.at(-1);
  if (!capability) throw new Error("capability was never persisted");
  return { calls, capability, retrieve };
}

beforeEach(() => {
  vi.clearAllMocks();
  persisted.capability = [];
  persisted.outputs.clear();
  __resetConfigSingleton();
});

afterEach(() => {
  delete process.env.ANALYSIS_DOCUMENT_READER;
  __resetConfigSingleton();
});

describe("#2230 — the document agent through the document reader", () => {
  it("reads the selected documents in full instead of retrieving chunks for the document agent", async () => {
    process.env.ANALYSIS_DOCUMENT_READER = "true";
    const { calls, retrieve } = await runPipeline();
    expect(loader).toHaveBeenCalledWith(PROJECT_ID, ["doc_1", "doc_gone"], expect.anything());
    const reads = calls.filter((c) => c.systemMessage?.includes("from beginning to end"));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.userMessage).toContain("The clinic opened its first site in 1998");
    // Retrieval stays for the code agent, and the document agent no longer asks for it.
    const retrievedFor = retrieve.mock.calls.map(
      (c) => (c as unknown[])[0] as { agentKey: string },
    );
    expect(retrievedFor.map((r) => r.agentKey)).not.toContain("document");
  });

  it("hands the code agent the reader's requirements, read back from the persisted output", async () => {
    process.env.ANALYSIS_DOCUMENT_READER = "true";
    const { calls } = await runPipeline();
    const output = persisted.outputs.get("document") as {
      requirements: Array<{ id: string; text: string; source: unknown }>;
      findings: Array<{ requirementId: string; citations: Array<{ snippet: string }> }>;
    };
    // The background statement is not a requirement.
    expect(output.requirements).toEqual([
      {
        id: "REQ-001",
        text: "Lock an account after five failed logins.",
        // #2235 — with the verified paragraph its clarifying questions cite.
        source: {
          documentId: "doc_1",
          chunkIndex: 0,
          filename: "booking.docx",
          headingPath: ["Booking FRD", "1 Access"],
          quote: "The portal shall lock an account after five failed attempts.",
        },
      },
    ]);
    expect(output.findings[0]!.citations[0]!.snippet).toBe(
      "The portal shall lock an account after five failed attempts.",
    );
    const codePrompts = calls.filter((c) => c.userMessage.includes("REQ-001"));
    expect(codePrompts.length).toBeGreaterThan(0);
    expect(
      codePrompts.some((c) => c.userMessage.includes("Lock an account after five failed logins.")),
    ).toBe(true);
  });

  it("records the coverage report on the capability, the unread document with its reason", async () => {
    process.env.ANALYSIS_DOCUMENT_READER = "true";
    const { capability } = await runPipeline();
    expect(capability.documentReading?.documents).toEqual([
      expect.objectContaining({
        documentId: "doc_1",
        status: "read",
        mode: "whole",
        statements: 2,
        requirements: 1,
        sections: [
          { heading: "Booking FRD", status: "read", statements: 0, kinds: {} },
          {
            heading: "Booking FRD › 1 Access",
            status: "read",
            statements: 1,
            kinds: { requirement: 1 },
          },
          {
            heading: "Booking FRD › 2 Background",
            status: "read",
            statements: 1,
            kinds: { background: 1 },
          },
        ],
      }),
      expect.objectContaining({
        documentId: "doc_gone",
        status: "unread",
        reason: "It is not ready.",
      }),
    ]);
  });

  it("is off by default: the document agent retrieves as before and no coverage is recorded", async () => {
    const { calls, capability, retrieve } = await runPipeline();
    expect(loader).not.toHaveBeenCalled();
    expect(calls.some((c) => c.systemMessage?.includes("from beginning to end"))).toBe(false);
    const retrievedFor = retrieve.mock.calls.map(
      (c) => (c as unknown[])[0] as { agentKey: string },
    );
    expect(retrievedFor.map((r) => r.agentKey)).toContain("document");
    expect(capability.documentReading).toBeUndefined();
  });
});

/** The agent keys the pipeline retrieved chunks for. */
const retrievedAgents = (retrieve: ReturnType<typeof vi.fn>): string[] =>
  retrieve.mock.calls.map((c) => ((c as unknown[])[0] as { agentKey: string }).agentKey);

/** The document agent's persisted row, as `persistAgentResult` was asked to write it. */
function documentRow(): { status: string; usage: { totalTokens: number } } | undefined {
  const call = vi
    .mocked(service.persistAgentResult)
    .mock.calls.map((c) => c[0] as { agentKey: string; status: string })
    .find((input) => input.agentKey === "document");
  return call as never;
}

describe("#2262 — the document reader before the flag goes on", () => {
  beforeEach(() => {
    process.env.ANALYSIS_DOCUMENT_READER = "true";
  });
  afterEach(() => {
    vi.mocked(prisma.document.findMany).mockImplementation((async () => []) as never);
  });

  it("reads as the requester: their ACL actor reaches the loader", async () => {
    await runPipeline();
    expect(resolveAclActor).toHaveBeenCalledWith("u1");
    expect(loader).toHaveBeenCalledWith(PROJECT_ID, ["doc_1", "doc_gone"], {
      userId: "u1",
      role: "member",
    });
  });

  it("fails the document agent, reading and retrieving nothing, when the requester is no longer active", async () => {
    vi.mocked(resolveAclActor).mockRejectedValueOnce(new InactiveAclActorError());
    const { retrieve } = await runPipeline();
    expect(loader).not.toHaveBeenCalled();
    expect(retrievedAgents(retrieve)).not.toContain("document");
    expect(documentRow()?.status).toBe("failed");
  });

  it("does not fall back to retrieval for a document the requester's ACL withheld", async () => {
    loader.mockImplementationOnce(async (_p, ids) =>
      ids.map((documentId) => ({
        ok: false as const,
        documentId,
        filename: documentId,
        reason: "It is not available.",
        unavailable: true as const,
      })),
    );
    const { retrieve, capability } = await runPipeline({ documentIds: ["doc_secret"] });
    expect(retrievedAgents(retrieve)).not.toContain("document");
    expect(capability.documentReading?.documents).toEqual([
      expect.objectContaining({ documentId: "doc_secret", status: "unread" }),
    ]);
  });

  it("falls back to retrieval when no selected document's file could be loaded", async () => {
    const { retrieve, capability } = await runPipeline({ documentIds: ["doc_broken"] });
    expect(loader).toHaveBeenCalledWith(PROJECT_ID, ["doc_broken"], expect.anything());
    expect(retrievedAgents(retrieve)).toContain("document");
    expect(capability.documentReading).toBeUndefined();
  });

  it("#2297 — does not fall back for a missing id either, so it reads as a withheld one does", async () => {
    const { retrieve, capability } = await runPipeline({ documentIds: ["doc_gone"] });
    expect(retrievedAgents(retrieve)).not.toContain("document");
    expect(capability.documentReading?.documents).toEqual([
      expect.objectContaining({ documentId: "doc_gone", status: "unread" }),
    ]);
  });

  it("#2297 — a scheduled run reads as no requester, not as an inactive one", async () => {
    const { retrieve } = await runPipeline({ startedById: "system" });
    expect(resolveAclActor).not.toHaveBeenCalled();
    expect(loader).toHaveBeenCalledWith(PROJECT_ID, ["doc_1", "doc_gone"], {
      userId: "system",
      role: "shared-audience",
      sharedAudience: true,
    });
    expect(documentRow()?.status).toBe("completed");
    expect(retrievedAgents(retrieve)).not.toContain("document");
  });

  it("with no document selected, reads the newest ready uploads the requester may see", async () => {
    vi.mocked(prisma.document.findMany).mockImplementation((async (args: { orderBy?: unknown }) =>
      // Only the reader's implicit query orders by upload time.
      args.orderBy
        ? [
            { id: "doc_1", filename: "booking.docx", aclSubjects: "[]" },
            {
              id: "doc_secret",
              filename: "secret.docx",
              aclSubjects: JSON.stringify([{ kind: "user", value: "u2" }]),
            },
          ]
        : []) as never);
    const { retrieve, capability } = await runPipeline({ documentIds: undefined });
    expect(loader).toHaveBeenCalledWith(PROJECT_ID, ["doc_1"], expect.anything());
    expect(retrievedAgents(retrieve)).not.toContain("document");
    expect(capability.documentReading?.documents.map((d) => d.documentId)).toEqual(["doc_1"]);
  });

  it("with no document selected and none ready, retrieves as before", async () => {
    const { retrieve } = await runPipeline({ documentIds: undefined });
    expect(loader).not.toHaveBeenCalled();
    expect(retrievedAgents(retrieve)).toContain("document");
  });

  it("gives the operator's notes to the document reader", async () => {
    const { calls } = await runPipeline({
      extraInstructions: "Focus on account lockout for the audit.",
    });
    const reads = calls.filter((c) => c.systemMessage?.includes("from beginning to end"));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.userMessage).toContain("Focus on account lockout for the audit.");
  });

  it("counts the tokens a document read spent before it failed, on its row and the run's total", async () => {
    // doc_1 is read (a read and a merge, 2 tokens each); doc_2's read fails.
    const { calls } = await runPipeline({ documentIds: ["doc_1", "doc_2"] }, 1);
    const row = documentRow();
    expect(row?.status).toBe("failed");
    expect(row?.usage.totalTokens).toBe(4);
    // Every call that answered cost 2 tokens, and the run's total counts each one.
    const failed = 1;
    const totals = [
      ...vi.mocked(service.markAnalysisCompleted).mock.calls,
      ...vi.mocked(service.markAnalysisFailed).mock.calls,
    ].map((c) => c.at(-1) as { totalTokens: number });
    expect(totals).toHaveLength(1);
    expect(totals[0]!.totalTokens).toBe((calls.length - failed) * 2);
  });
});
