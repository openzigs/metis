/**
 * #739 — a discussion reply's project-scoped excerpt retriever: chat's auto-RAG
 * (`buildAutoRagContext`) for one project, reporting how many excerpts it found.
 *
 * Used by the Teams AI participant (PR #850 review), which had no retrieval and
 * so answered ungrounded. `buildAutoRagContext` still lives in `routes/ai.ts`;
 * it is imported lazily so loading the Teams path does not pull in the whole
 * chat router until a reply actually needs excerpts.
 *
 * #2248 — a discussion reply is read by the whole thread (and a Teams reply by
 * the whole channel), so retrieval runs for a shared audience: only
 * unrestricted chunks, never one restricted to the member who triggered it.
 * `triggeredBy` attributes the ACL-denial audit row and grants nothing.
 */
import type { RagContextCapture } from "../../routes/ai.js";
import { sharedAudienceActor } from "../rag/acl.js";
import type { RetrievedContext } from "./ai-responder.js";

export function projectRetriever(
  projectId: string,
  triggeredBy: string,
): (query: string) => Promise<RetrievedContext> {
  return async (query) => {
    const { buildAutoRagContext } = await import("../../routes/ai.js");
    const capture: RagContextCapture = { contexts: [], sources: 0 };
    const block = await buildAutoRagContext(
      projectId,
      [{ role: "user", content: query }],
      sharedAudienceActor(triggeredBy),
      undefined,
      capture,
    );
    return {
      block,
      sources: capture.sources,
      ...(capture.indexStatusLine ? { indexStatus: capture.indexStatusLine } : {}),
    };
  };
}
