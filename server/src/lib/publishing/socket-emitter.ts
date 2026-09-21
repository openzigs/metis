/**
 * Publishing Socket.IO emitter — Phase 9.
 *
 * Mirrors the connector emitter pattern: bridges PublishEmitter calls into
 * the `publish:{batchId}` room so the UI can render live progress.
 */
import type { MetisIOServer } from "../socket/server.js";
import type { PublishEmitter } from "./types.js";

export function createSocketPublishEmitter(io: MetisIOServer): PublishEmitter {
  return {
    status(event) {
      io.to(`publish:${event.batchId}`).emit("publish:status", { ...event, ts: Date.now() });
    },
    progress(event) {
      io.to(`publish:${event.batchId}`).emit("publish:progress", { ...event, ts: Date.now() });
    },
    completed(event) {
      io.to(`publish:${event.batchId}`).emit("publish:completed", { ...event, ts: Date.now() });
    },
  };
}
