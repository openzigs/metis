/**
 * Epic #475 (Phase 2, #481) — discussion realtime emitter.
 *
 * Fans out discussion events to the per-thread room `thread:{id}` (joined via
 * the authz-gated `subscribe:thread` handler from #480, so only thread members
 * ever receive these). Two events:
 *   - `message:new`    — a message was posted (human now; AI in Phase 3).
 *   - `message:stream` — an incremental chunk of a streaming AI reply.
 *
 * Like the other module emitters (`rag/socket-emitter.ts`,
 * `publishing/socket-emitter.ts`, `socket/job-events.ts`), this resolves the
 * live IO server from the `getSocketServer()` registry on each call rather than
 * threading it through DI, and is a **silent no-op when no IO is registered**
 * (the test / pre-bootstrap case). Transport errors are swallowed so a socket
 * hiccup never breaks the REST request that triggered the emit.
 */
import type {
  DiscussionMessageNewEvent,
  DiscussionMessagePayload,
  DiscussionMessageStreamEvent,
} from "@metis/shared";
import { getSocketServer } from "../socket/registry.js";
import { threadRoom } from "../socket/discussion-rooms.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("discussion-emitter");

/** The shape of a persisted DiscussionMessage row as the route hands it over. */
export interface DiscussionMessageRow {
  id: string;
  threadId: string;
  authorKind: string;
  authorUserId?: string | null;
  aiProvider?: string | null;
  aiModel?: string | null;
  aiSessionId?: string | null;
  body: string;
  createdAt: Date | string;
  editedAt?: Date | string | null;
}

/** Normalize a Date|string|null into the wire ISO-string|null shape. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** Project a persisted message row onto the realtime wire payload. */
export function toMessagePayload(row: DiscussionMessageRow): DiscussionMessagePayload {
  return {
    id: row.id,
    threadId: row.threadId,
    authorKind: row.authorKind,
    authorUserId: row.authorUserId ?? null,
    aiProvider: row.aiProvider ?? null,
    aiModel: row.aiModel ?? null,
    aiSessionId: row.aiSessionId ?? null,
    body: row.body,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    editedAt: toIso(row.editedAt),
  };
}

/**
 * Emit `message:new` to `thread:{threadId}`. No-ops when IO is not registered;
 * never throws into the caller's path.
 */
export function emitMessageNew(threadId: string, message: DiscussionMessageRow): void {
  const io = getSocketServer();
  if (!io) return;
  try {
    const payload: DiscussionMessageNewEvent = {
      threadId,
      message: toMessagePayload(message),
      ts: Date.now(),
    };
    io.to(threadRoom(threadId)).emit("message:new", payload);
  } catch (err) {
    log.warn("emitMessageNew failed", { threadId, error: (err as Error).message });
  }
}

/**
 * Emit a `message:stream` chunk to `thread:{threadId}`. No-ops when IO is not
 * registered; never throws into the caller's path.
 */
export function emitMessageStream(
  threadId: string,
  chunk: { delta: string; messageId?: string; done?: boolean },
): void {
  const io = getSocketServer();
  if (!io) return;
  try {
    const payload: DiscussionMessageStreamEvent = {
      threadId,
      ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
      delta: chunk.delta,
      done: chunk.done ?? false,
      ts: Date.now(),
    };
    io.to(threadRoom(threadId)).emit("message:stream", payload);
  } catch (err) {
    log.warn("emitMessageStream failed", { threadId, error: (err as Error).message });
  }
}
