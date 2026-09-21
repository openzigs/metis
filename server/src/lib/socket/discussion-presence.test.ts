/**
 * Epic #475 (Phase 2, #482) — unit tests for per-thread presence + typing.
 *
 * Exercised against a FAKE socket (no live Socket.IO server) with an injected
 * access checker, asserting every AC:
 *   - join (member) → joins room, adds to presence set, broadcasts member list
 *   - join (non-member) → auth:error, NOT added to presence
 *   - leave / disconnect → removed, rebroadcast, empty room cleaned up
 *   - typing:start/stop → broadcast to OTHER members only (socket.to, not echo)
 *   - typing is ignored for a thread the socket has not joined (authz)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";
import {
  clearThreadPresence,
  getThreadPresence,
  wireDiscussionPresenceHandlers,
  type PresenceSocket,
} from "./discussion-presence.js";

const USER: AuthPayload = {
  userId: "u1",
  username: "alice",
  role: "member",
  permissions: [],
};

/** Fake socket recording handlers + join/leave/emit and the `to(room).emit` chain. */
function makeFakeSocket(user: AuthPayload = USER, id = "socket-1") {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const join = vi.fn().mockResolvedValue(undefined);
  const leave = vi.fn().mockResolvedValue(undefined);
  const emit = vi.fn();
  /** Records `socket.to(room).emit(name, payload)` calls. */
  const toEmit = vi.fn();
  const to = vi.fn(() => ({ emit: toEmit }));
  const socket = {
    id,
    data: { user },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    join,
    leave,
    emit,
    to,
  } as unknown as PresenceSocket;
  return { socket, handlers, join, leave, emit, to, toEmit };
}

async function fire(
  handlers: Map<string, (...args: unknown[]) => void>,
  event: string,
  payload?: unknown,
): Promise<void> {
  handlers.get(event)?.(payload);
  await new Promise((r) => setTimeout(r, 0));
}

const allow = () => Promise.resolve({ ok: true });
const deny = () => Promise.resolve({ ok: false });

beforeEach(() => clearThreadPresence());
afterEach(() => vi.clearAllMocks());

describe("presence:thread:join", () => {
  it("a member joins the room, is tracked, and a presence:update is broadcast", async () => {
    const { socket, handlers, join, emit, toEmit } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });

    await fire(handlers, "presence:thread:join", { threadId: "t1" });

    expect(join).toHaveBeenCalledWith("thread:t1");
    const set = getThreadPresence().get("thread:t1")!;
    expect(set.get("socket-1")).toEqual({ userId: "u1", username: "alice", displayName: "alice" });
    // Broadcast to others (socket.to) AND to self (socket.emit) so the joiner
    // sees themselves.
    expect(toEmit).toHaveBeenCalledWith(
      "presence:update",
      expect.objectContaining({
        room: "thread:t1",
        users: [expect.objectContaining({ userId: "u1" })],
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      "presence:update",
      expect.objectContaining({ room: "thread:t1" }),
    );
  });

  it("a non-member is rejected with auth:error and never tracked", async () => {
    const { socket, handlers, join, emit } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: deny });

    await fire(handlers, "presence:thread:join", { threadId: "t1" });

    expect(join).not.toHaveBeenCalled();
    expect(getThreadPresence().has("thread:t1")).toBe(false);
    expect(emit).toHaveBeenCalledWith("auth:error", {
      message: "FORBIDDEN: no access to discussion thread",
    });
  });

  it("the member list aggregates multiple sockets in the same thread", async () => {
    const a = makeFakeSocket(USER, "sock-a");
    const b = makeFakeSocket({ ...USER, userId: "u2", username: "bob" }, "sock-b");
    wireDiscussionPresenceHandlers(a.socket, { canAccessThread: allow });
    wireDiscussionPresenceHandlers(b.socket, { canAccessThread: allow });

    await fire(a.handlers, "presence:thread:join", { threadId: "t1" });
    await fire(b.handlers, "presence:thread:join", { threadId: "t1" });

    const users = getThreadPresence().get("thread:t1")!;
    expect(users.size).toBe(2);
    // The second joiner's broadcast carries both members.
    const lastBroadcast = b.toEmit.mock.calls.at(-1)![1] as { users: Array<{ userId: string }> };
    expect(lastBroadcast.users.map((u) => u.userId).sort()).toEqual(["u1", "u2"]);
  });

  it("ignores a join with a missing / non-string threadId", async () => {
    const { socket, handlers, join } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });
    await fire(handlers, "presence:thread:join", {});
    await fire(handlers, "presence:thread:join", { threadId: 1 });
    expect(join).not.toHaveBeenCalled();
  });

  it("fails closed (auth:error, not tracked) when the access checker throws", async () => {
    const throwing = () => Promise.reject(new Error("db down"));
    const { socket, handlers, emit, join } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: throwing });

    await fire(handlers, "presence:thread:join", { threadId: "t1" });

    expect(join).not.toHaveBeenCalled();
    expect(getThreadPresence().has("thread:t1")).toBe(false);
    expect(emit).toHaveBeenCalledWith("auth:error", {
      message: "FORBIDDEN: no access to discussion thread",
    });
  });
});

describe("presence:thread:leave + disconnect", () => {
  it("leaving removes the member, rebroadcasts, and cleans up the empty room", async () => {
    const { socket, handlers, leave } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });

    await fire(handlers, "presence:thread:join", { threadId: "t1" });
    await fire(handlers, "presence:thread:leave", { threadId: "t1" });

    expect(leave).toHaveBeenCalledWith("thread:t1");
    expect(getThreadPresence().has("thread:t1")).toBe(false); // cleaned up
  });

  it("disconnect removes the socket from every thread it was present in", async () => {
    const { socket, handlers } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });

    await fire(handlers, "presence:thread:join", { threadId: "t1" });
    await fire(handlers, "presence:thread:join", { threadId: "t2" });
    expect(getThreadPresence().size).toBe(2);

    await fire(handlers, "disconnect");

    expect(getThreadPresence().size).toBe(0);
  });

  it("leaving a thread the socket never joined is a harmless no-op", async () => {
    const { socket, handlers, leave } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });
    await fire(handlers, "presence:thread:leave", { threadId: "ghost" });
    expect(leave).toHaveBeenCalledWith("thread:ghost");
    expect(getThreadPresence().has("thread:ghost")).toBe(false);
  });

  it("ignores a leave with a missing / non-string threadId", async () => {
    const { socket, handlers, leave } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });
    await fire(handlers, "presence:thread:leave", {});
    expect(leave).not.toHaveBeenCalled();
  });
});

describe("typing:start / typing:stop", () => {
  it("broadcasts typing:update isTyping=true to OTHER members only (not echoed)", async () => {
    const { socket, handlers, toEmit, emit } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });
    await fire(handlers, "presence:thread:join", { threadId: "t1" });
    emit.mockClear();
    toEmit.mockClear();

    await fire(handlers, "typing:start", { threadId: "t1" });

    expect(toEmit).toHaveBeenCalledWith("typing:update", {
      threadId: "t1",
      userId: "u1",
      username: "alice",
      isTyping: true,
      ts: expect.any(Number),
    });
    // Never echoed to the sender.
    expect(emit).not.toHaveBeenCalledWith("typing:update", expect.anything());
  });

  it("typing:stop broadcasts isTyping=false", async () => {
    const { socket, handlers, toEmit } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });
    await fire(handlers, "presence:thread:join", { threadId: "t1" });
    toEmit.mockClear();

    await fire(handlers, "typing:stop", { threadId: "t1" });

    expect(toEmit).toHaveBeenCalledWith(
      "typing:update",
      expect.objectContaining({ isTyping: false }),
    );
  });

  it("ignores typing for a thread the socket has NOT joined (authz scoping)", async () => {
    const { socket, handlers, toEmit } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });

    // No join first.
    await fire(handlers, "typing:start", { threadId: "t1" });

    expect(toEmit).not.toHaveBeenCalled();
  });

  it("ignores typing with a missing / non-string threadId", async () => {
    const { socket, handlers, toEmit } = makeFakeSocket();
    wireDiscussionPresenceHandlers(socket, { canAccessThread: allow });
    await fire(handlers, "presence:thread:join", { threadId: "t1" });
    toEmit.mockClear();
    await fire(handlers, "typing:start", {});
    await fire(handlers, "typing:start", { threadId: 5 });
    expect(toEmit).not.toHaveBeenCalled();
  });
});
