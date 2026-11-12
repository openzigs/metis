/**
 * #2293 — the Requirements Analysis document agent hands "Read the documents
 * again" on to the reader. Before this test, removing the forwarding in
 * `readSelectedDocuments` left every suite green: the run asked for a fresh
 * reading and silently reused the saved one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runDocumentReaderAgent } = vi.hoisted(() => ({
  runDocumentReaderAgent: vi.fn(async (_input: Record<string, unknown>) => null),
}));

vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("./document-reader-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./document-reader-agent.js")>()),
  runDocumentReaderAgent,
}));

const { AnalysisOrchestrator } = await import("./orchestrator.js");

type WithReader = {
  readSelectedDocuments: (input: Record<string, unknown>) => Promise<unknown>;
};

function orchestrator(): WithReader {
  return new AnalysisOrchestrator({
    provider: { chat: vi.fn(), model: "m" } as never,
    retrieve: async () => [],
  }) as unknown as WithReader;
}

const INPUT = {
  analysisId: "an_2293",
  projectId: "pr_2293",
  projectName: "P",
  projectDescription: "D",
  agentKey: "document",
  documentIds: ["doc-1"],
};

beforeEach(() => {
  runDocumentReaderAgent.mockClear();
});

describe("#2293 — the document agent forwards 'Read the documents again' to the reader", () => {
  it("asks the reader to read again when the run asked for it", async () => {
    await orchestrator().readSelectedDocuments({ ...INPUT, rereadDocuments: true });
    expect(runDocumentReaderAgent).toHaveBeenCalledTimes(1);
    expect(runDocumentReaderAgent.mock.calls[0]![0]).toMatchObject({
      projectId: "pr_2293",
      documentIds: ["doc-1"],
      reread: true,
    });
  });

  it("lets the reader reuse a saved reading otherwise", async () => {
    await orchestrator().readSelectedDocuments(INPUT);
    expect(runDocumentReaderAgent).toHaveBeenCalledTimes(1);
    expect(runDocumentReaderAgent.mock.calls[0]![0]).not.toHaveProperty("reread");
  });
});
