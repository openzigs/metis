/**
 * #739 / PR #850 review — the project-scoped retriever the Teams AI participant
 * uses: chat's auto-RAG for ONE project, with the excerpt count it found.
 */
import { describe, expect, it, vi } from "vitest";

const rag = vi.hoisted(() => ({
  buildAutoRagContext: vi.fn(
    async (
      _projectId: string | null,
      _messages: Array<{ role: string; content: string }>,
      _deps: unknown,
      capture?: { contexts: string[]; sources: number },
    ) => {
      if (capture) capture.sources = 2;
      return "## Retrieved Knowledge\n[1] internal/reader/handler.go:42";
    },
  ),
}));
vi.mock("../../routes/ai.js", () => rag);

const { projectRetriever } = await import("./project-retrieval.js");

describe("projectRetriever", () => {
  it("runs chat's auto-RAG for the given project with the question as the user turn", async () => {
    const out = await projectRetriever("proj-1")("where is the scheduler?");

    expect(rag.buildAutoRagContext).toHaveBeenCalledWith(
      "proj-1",
      [{ role: "user", content: "where is the scheduler?" }],
      undefined,
      expect.objectContaining({ sources: 2 }),
    );
    expect(out).toEqual({
      block: "## Retrieved Knowledge\n[1] internal/reader/handler.go:42",
      sources: 2,
    });
  });
});
