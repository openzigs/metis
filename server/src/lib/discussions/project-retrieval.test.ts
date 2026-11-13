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
      _requester: unknown,
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
    const out = await projectRetriever("proj-1", "u-7")("where is the scheduler?");

    expect(rag.buildAutoRagContext).toHaveBeenCalledWith(
      "proj-1",
      [{ role: "user", content: "where is the scheduler?" }],
      // #2248 — a shared audience, not the trigger's own ACLs.
      { userId: "u-7", role: "shared-audience", sharedAudience: true },
      undefined,
      expect.objectContaining({ sources: 2 }),
    );
    expect(out).toEqual({
      block: "## Retrieved Knowledge\n[1] internal/reader/handler.go:42",
      sources: 2,
    });
  });

  it("#2326 — passes the index status line on, so a reply with no excerpt still gets it", async () => {
    rag.buildAutoRagContext.mockImplementationOnce(async (_p, _m, _r, _d, capture) => {
      Object.assign(capture!, { sources: 0, indexStatusLine: "## Index status\nfailed" });
      return "## Index status\nfailed";
    });
    const out = await projectRetriever("proj-1", "u-7")("q");
    expect(out).toEqual({
      block: "## Index status\nfailed",
      sources: 0,
      indexStatus: "## Index status\nfailed",
    });
  });
});
