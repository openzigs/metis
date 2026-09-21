/**
 * Epic #475 (Phase 2, #480) — unit tests for the authz-gated
 * `subscribe:thread` / `unsubscribe:thread` Socket.IO handlers.
 *
 * The handlers are exercised against a FAKE socket (no real Socket.IO server)
 * with `canAccessThread` mocked, so we can assert every authz branch:
 *   - member → joins `thread:{id}`, no `auth:error`
 *   - non-member (forbidden) → `auth:error`, never joins
 *   - missing / soft-deleted (not_found) → `auth:error`, never joins
 *   - helper throw → `auth:error`, never joins (fail-closed)
 *   - unsubscribe → leaves the room
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";
import { threadRoom, wireThreadRoomHandlers, type ThreadRoomSocket } from "./discussion-rooms.js";

const canAccessThread = vi.fn();
vi.mock("../discussions/access.js", () => ({
  canAccessThread: (...a: unknown[]) => canAccessThread(...a),
}));

const USER: AuthPayload = {
  userId: "u1",
  username: "alice",
  role: "member",
  permissions: [],
};

/** A fake socket that records handlers and join/leave/emit calls. */
function makeFakeSocket(user: AuthPayload = USER) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const join = vi.fn().mockResolvedValue(undefined);
  const leave = vi.fn().mockResolvedValue(undefined);
  const emit = vi.fn();
  const socket = {
    id: "socket-1",
    data: { user },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    join,
    leave,
    emit,
  } as unknown as ThreadRoomSocket;
  return { socket, handlers, join, leave, emit };
}

/** Invoke a registered handler and flush the microtask queue (handlers are async). */
async function fire(
  handlers: Map<string, (...args: unknown[]) => void>,
  event: string,
  payload: unknown,
): Promise<void> {
  handlers.get(event)?.(payload);
  // Let the inner async IIFE (and its catch path) fully settle.
  await new Promise((r) => setTimeout(r, 0));
}

describe("threadRoom", () => {
  it("formats the room name as thread:{id}", () => {
    expect(threadRoom("abc")).toBe("thread:abc");
  });
});

describe("wireThreadRoomHandlers — subscribe:thread", () => {
  beforeEach(() => canAccessThread.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("registers both subscribe:thread and unsubscribe:thread handlers", () => {
    const { socket, handlers } = makeFakeSocket();
    wireThreadRoomHandlers(socket);
    expect(handlers.has("subscribe:thread")).toBe(true);
    expect(handlers.has("unsubscribe:thread")).toBe(true);
  });

  it("a member joins thread:{id} and receives no auth:error", async () => {
    canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
    const { socket, handlers, join, emit } = makeFakeSocket();
    wireThreadRoomHandlers(socket);

    await fire(handlers, "subscribe:thread", { threadId: "t1" });

    expect(canAccessThread).toHaveBeenCalledWith({ id: "u1", role: "member" }, "t1");
    expect(join).toHaveBeenCalledWith("thread:t1");
    expect(emit).not.toHaveBeenCalled();
  });

  it("a non-member (forbidden) is rejected with auth:error and never joins", async () => {
    canAccessThread.mockResolvedValue({ ok: false, reason: "forbidden" });
    const { socket, handlers, join, emit } = makeFakeSocket();
    wireThreadRoomHandlers(socket);

    await fire(handlers, "subscribe:thread", { threadId: "t1" });

    expect(join).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("auth:error", {
      message: "FORBIDDEN: no access to discussion thread",
    });
  });

  it("a missing / soft-deleted thread (not_found) yields auth:error and no join", async () => {
    canAccessThread.mockResolvedValue({ ok: false, reason: "not_found" });
    const { socket, handlers, join, emit } = makeFakeSocket();
    wireThreadRoomHandlers(socket);

    await fire(handlers, "subscribe:thread", { threadId: "gone" });

    expect(join).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("auth:error", {
      message: "NOT_FOUND: discussion thread not found",
    });
  });

  it("fails closed (auth:error) when joining the room rejects after authz passes", async () => {
    // Authz passes, but the transport `join` fails — the handler must swallow
    // the error and emit `auth:error` rather than letting it escape the socket
    // event loop (fail-closed).
    canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
    const { socket, handlers, emit } = makeFakeSocket();
    (socket.join as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("join failed"));
    wireThreadRoomHandlers(socket);

    await fire(handlers, "subscribe:thread", { threadId: "t1" });

    expect(emit).toHaveBeenCalledWith("auth:error", {
      message: "FORBIDDEN: no access to discussion thread",
    });
  });

  it("ignores a subscribe with a missing / non-string threadId (no authz call, no join)", async () => {
    const { socket, handlers, join, emit } = makeFakeSocket();
    wireThreadRoomHandlers(socket);

    await fire(handlers, "subscribe:thread", {});
    await fire(handlers, "subscribe:thread", { threadId: 42 });

    expect(canAccessThread).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("wireThreadRoomHandlers — unsubscribe:thread", () => {
  afterEach(() => vi.clearAllMocks());

  it("leaves the thread room", async () => {
    const { socket, handlers, leave } = makeFakeSocket();
    wireThreadRoomHandlers(socket);

    await fire(handlers, "unsubscribe:thread", { threadId: "t1" });

    expect(leave).toHaveBeenCalledWith("thread:t1");
  });

  it("ignores an unsubscribe with a missing / non-string threadId", async () => {
    const { socket, handlers, leave } = makeFakeSocket();
    wireThreadRoomHandlers(socket);

    await fire(handlers, "unsubscribe:thread", {});
    await fire(handlers, "unsubscribe:thread", { threadId: null });

    expect(leave).not.toHaveBeenCalled();
  });
});
