/**
 * Connector Socket.IO emitter — Phase 8.
 *
 * Bridges connector lifecycle events (`status` / `progress`) into the
 * `connector:<id>` room so the UI can render live ingestion + test progress
 * without polling. Wired in `server.ts` immediately after `createSocketServer`.
 */
import type { ConnectorStatus } from "@metis/shared";
import type { MetisIOServer } from "../socket/server.js";
import type { ConnectorEmitter } from "./types.js";

export function createSocketConnectorEmitter(io: MetisIOServer): ConnectorEmitter {
  return {
    status(event) {
      io.to(`connector:${event.connectorId}`).emit("connector:status", {
        connectorId: event.connectorId,
        kind: event.kind,
        status: event.status as ConnectorStatus,
        message: event.message,
        errorMessage: event.errorMessage ?? null,
        ts: Date.now(),
      });
    },
    progress(event) {
      const payload = {
        connectorId: event.connectorId,
        projectId: event.projectId,
        kind: event.kind,
        phase: event.phase,
        step: event.step,
        current: event.current,
        total: event.total,
        status: event.status,
        errorMessage: event.errorMessage,
        ts: Date.now(),
      };
      // Emit to per-connector room (for targeted subscriptions)
      io.to(`connector:${event.connectorId}`).emit("connector:progress", payload);
      // Also emit to project room so project-level listeners receive progress
      if (event.projectId) {
        io.to(`project:${event.projectId}`).emit("connector:progress", payload);
      }
    },
    discovery(event) {
      io.to(`project:${event.projectId}`).emit("connector:discovery", {
        projectId: event.projectId,
        connectorId: event.connectorId,
        repoLabel: event.repoLabel,
        connectionsFound: event.connectionsFound,
        ts: Date.now(),
      });
    },
  };
}
