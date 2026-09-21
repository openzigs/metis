/**
 * Epic #475 (Phase 2, #480) — authz-gated discussion-thread Socket.IO rooms.
 *
 * Wires the `subscribe:thread` / `unsubscribe:thread` handlers onto a connected
 * socket. The room name is `thread:{id}` (mirrors the existing `project:{id}`,
 * `session:{id}` conventions).
 *
 * Authorization mirrors the `subscribe:project` handler in `server.ts`: an
 * authenticated client MUST NOT be able to subscribe to a thread it has no
 * access to (OWASP A01 — broken access control). We delegate to the Phase 1
 * `canAccessThread` helper (`../discussions/access.ts`) — the single source of
 * truth for thread membership, which also writes an `AuditLog` row on a
 * not-found probe and on a project-access denial. Non-members (and probes
 * against missing / soft-deleted threads) receive `auth:error` and never join
 * the room, so no `message:*` / `presence:*` events ever leak to them.
 *
 * This is extracted from `attachHandlers` into its own function so the authz
 * branch is unit-testable against a fake socket without standing up a real
 * Socket.IO server.
 */
import type { Socket } from "socket.io";
import type {
  AuthPayload,
  ClientToServerEvents,
  ServerToClientEvents,
  RoleKey,
} from "@metis/shared";
import { canAccessThread } from "../discussions/access.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket:discussion");

/** The minimal socket surface the thread-room handlers depend on. */
export type ThreadRoomSocket = Pick<
  Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: AuthPayload }>,
  "id" | "on" | "join" | "leave" | "emit" | "data"
>;

/** The room name for a discussion thread's realtime fan-out. */
export function threadRoom(threadId: string): string {
  return `thread:${threadId}`;
}

/**
 * Attach `subscribe:thread` / `unsubscribe:thread` handlers to `socket`.
 *
 * - `subscribe:thread { threadId }` joins `thread:{threadId}` ONLY after
 *   `canAccessThread` passes. Missing / soft-deleted / forbidden → `auth:error`
 *   and no join.
 * - `unsubscribe:thread { threadId }` leaves the room (no authz needed — you
 *   can always stop listening).
 */
export function wireThreadRoomHandlers(socket: ThreadRoomSocket): void {
  const user = socket.data.user;

  socket.on("subscribe:thread", ({ threadId }) => {
    if (!threadId || typeof threadId !== "string") return;
    void (async () => {
      try {
        const access = await canAccessThread(
          { id: user.userId, role: user.role as RoleKey },
          threadId,
        );
        if (!access.ok) {
          log.warn("Socket subscribe:thread rejected", {
            socketId: socket.id,
            userId: user.userId,
            threadId,
            reason: access.reason,
          });
          socket.emit("auth:error", {
            message:
              access.reason === "not_found"
                ? "NOT_FOUND: discussion thread not found"
                : "FORBIDDEN: no access to discussion thread",
          });
          return;
        }
        await socket.join(threadRoom(threadId));
        log.debug("Socket joined thread room", {
          socketId: socket.id,
          userId: user.userId,
          room: threadRoom(threadId),
        });
      } catch (err) {
        log.warn("Socket subscribe:thread failed", {
          socketId: socket.id,
          threadId,
          error: (err as Error).message,
        });
        socket.emit("auth:error", { message: "FORBIDDEN: no access to discussion thread" });
      }
    })();
  });

  socket.on("unsubscribe:thread", ({ threadId }) => {
    if (!threadId || typeof threadId !== "string") return;
    void socket.leave(threadRoom(threadId));
  });
}
