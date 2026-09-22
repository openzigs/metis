/**
 * Issue #78 — drift realtime emitter (Epic #739).
 *
 * `reconcile-service.ts` has always accepted an `emitDrift` dependency and no
 * caller supplied one, so a `DriftEvent` row was written and nothing told a
 * connected client. The pending-drift badge (#78) needs that nudge to re-read
 * its count without a page reload.
 *
 * Fans out to the `project:{id}` room, which `subscribe:project` gates on
 * `actorCanAccessProject` (#255) — a client without access to the project never
 * joins the room, so this adds no new read path.
 *
 * The payload is deliberately an IDENTIFIER-ONLY notification: no issue title,
 * body or field diff. The badge re-reads `GET /sync/drift/count`, which is
 * permission-checked, so the socket never becomes a way to read drift content.
 *
 * Like the other module emitters (`discussions/socket-emitter.ts`,
 * `publishing/socket-emitter.ts`), it resolves the live IO server from the
 * `getSocketServer()` registry on each call, is a silent no-op when none is
 * registered (tests / pre-bootstrap), and swallows transport errors so a socket
 * hiccup never fails the webhook that triggered it.
 */
import type { DriftEventRow } from "@metis/shared";
import { getSocketServer } from "../socket/registry.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("sync-drift-emitter");

/** Build the `emitDrift` dependency `reconcileIssueChange` calls on a new drift. */
export function createSocketDriftEmitter(): (projectId: string, event: DriftEventRow) => void {
  return (projectId, event) => {
    const io = getSocketServer();
    if (!io) return;
    try {
      io.to(`project:${projectId}`).emit("drift:detected", {
        projectId,
        driftEventId: event.id,
        requirementId: event.requirementId,
        status: event.status,
        ts: Date.now(),
      });
    } catch (err) {
      log.warn("sync.drift.emit_failed", { projectId, error: (err as Error).message });
    }
  };
}
