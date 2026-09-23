/**
 * #98 — the `document:status` socket payload used to carry the ingest
 * pipeline's raw exception text (`ingest-queue.ts` sends `lastError.message` on
 * every retry and on the final failure) straight to the browser.
 */
import { describe, expect, it, vi } from "vitest";
import { createSocketDocumentEmitter } from "./socket-emitter.js";
import {
  INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE,
  INDEXING_PROVIDER_UNREACHABLE_MESSAGE,
} from "./indexing-failure-message.js";
import type { MetisIOServer } from "../socket/server.js";

function makeIo() {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  return { io: { to } as unknown as MetisIOServer, to, emit };
}

const RAW =
  'embedding failed: embeddings returned 500: {"key":"sk-live-4f9a8b7c6d5e"} ' +
  "at /srv/metis/server/src/lib/ai/providers/x.ts:12:7";

describe("createSocketDocumentEmitter", () => {
  it("emits the document status to the project room", () => {
    const { io, to, emit } = makeIo();
    createSocketDocumentEmitter(io)({
      type: "document:status",
      projectId: "p-1",
      documentId: "d-1",
      status: "ready",
      chunkCount: 4,
    });
    expect(to).toHaveBeenCalledWith("project:p-1");
    expect(emit).toHaveBeenCalledWith("document:status", {
      projectId: "p-1",
      documentId: "d-1",
      status: "ready",
      chunkCount: 4,
      errorMessage: null,
      attempt: undefined,
    });
  });

  it("never sends the raw ingest error to the browser", () => {
    const { io, emit } = makeIo();
    createSocketDocumentEmitter(io)({
      type: "document:status",
      projectId: "p-1",
      documentId: "d-1",
      status: "failed",
      attempt: 3,
      errorMessage: RAW,
    });
    const payload = emit.mock.calls[0][1] as { errorMessage: string };
    expect(payload.errorMessage).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
    expect(JSON.stringify(payload)).not.toMatch(/sk-live|\/srv/);
  });

  it("names an unreachable embedding host on a retry event", () => {
    const { io, emit } = makeIo();
    createSocketDocumentEmitter(io)({
      type: "document:status",
      projectId: "p-1",
      documentId: "d-1",
      status: "queued",
      attempt: 1,
      errorMessage: "fetch failed",
    });
    expect(emit.mock.calls[0][1]).toMatchObject({
      errorMessage: INDEXING_PROVIDER_UNREACHABLE_MESSAGE,
    });
  });

  it("ignores events that are not document status", () => {
    const { io, emit } = makeIo();
    createSocketDocumentEmitter(io)({ type: "other" } as never);
    expect(emit).not.toHaveBeenCalled();
  });
});
