/**
 * #739 — a discussion reply's project-scoped excerpt retriever: chat's auto-RAG
 * (`buildAutoRagContext`) for one project, reporting how many excerpts it found.
 *
 * Used by the Teams AI participant (PR #850 review), which had no retrieval and
 * so answered ungrounded. `buildAutoRagContext` still lives in `routes/ai.ts`;
 * it is imported lazily so loading the Teams path does not pull in the whole
 * chat router until a reply actually needs excerpts.
 *
 * #2225 — retrieval runs for `requesterId`, the member whose message triggered
 * the reply, so a chunk whose ACL excludes them never grounds it.
 */
import type { RagContextCapture } from "../../routes/ai.js";
import type { RetrievedContext } from "./ai-responder.js";

export function projectRetriever(
  projectId: string,
  requesterId: string,
): (query: string) => Promise<RetrievedContext> {
  return async (query) => {
    const { buildAutoRagContext } = await import("../../routes/ai.js");
    const capture: RagContextCapture = { contexts: [], sources: 0 };
    const block = await buildAutoRagContext(
      projectId,
      [{ role: "user", content: query }],
      requesterId,
      undefined,
      capture,
    );
    return { block, sources: capture.sources };
  };
}
