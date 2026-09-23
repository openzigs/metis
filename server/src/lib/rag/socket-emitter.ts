/**
 * Document realtime emitter — issue #133.
 *
 * Bridges KnowledgeService + IngestQueue `document:status` events into the
 * `project:{projectId}` Socket.IO room so the workbench can react to ingest
 * lifecycle without polling. Wired in `server.ts` once the live io is ready.
 */
import type { MetisIOServer } from "../socket/server.js";
import type { KnowledgeEvent } from "../rag/knowledge-service.js";
import { publicIndexingErrorMessage } from "./indexing-failure-message.js";

export function createSocketDocumentEmitter(io: MetisIOServer) {
  return (event: KnowledgeEvent): void => {
    if (event.type !== "document:status") return;
    io.to(`project:${event.projectId}`).emit("document:status", {
      projectId: event.projectId,
      documentId: event.documentId,
      status: event.status,
      chunkCount: event.chunkCount,
      // #98 — the ingest queue and KnowledgeService put the raw exception
      // text here; only the fixed indexing vocabulary reaches the browser.
      errorMessage: publicIndexingErrorMessage(event.errorMessage),
      attempt: event.attempt,
    });
  };
}
