/**
 * Epic #475 (Phase 2, #481) — unit tests for the discussion realtime emitter.
 *
 * Asserts: room targeting (`thread:{id}`), payload shape with full attribution
 * for both human and AI rows, Date→ISO serialization, graceful no-op when no IO
 * is registered (test mode), and transport-error swallowing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetisIOServer } from "../socket/server.js";
import {
  emitMessageNew,
  emitMessageStream,
  toMessagePayload,
  type DiscussionMessageRow,
} from "./socket-emitter.js";
import * as registry from "../socket/registry.js";

/** Minimal fake of the chainable `io.to(room).emit(name, payload)` surface. */
function makeFakeIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const io = { to } as unknown as MetisIOServer;
  return { io, to, emit };
}

const HUMAN_ROW: DiscussionMessageRow = {
  id: "m1",
  threadId: "t1",
  authorKind: "human",
  authorUserId: "u1",
  aiProvider: null,
  aiModel: null,
  aiSessionId: null,
  body: "hello team",
  createdAt: new Date("2026-06-28T00:00:00Z"),
  editedAt: null,
};

const AI_ROW: DiscussionMessageRow = {
  id: "m2",
  threadId: "t1",
  authorKind: "ai",
  authorUserId: null,
  aiProvider: "copilot",
  aiModel: "gpt-x",
  aiSessionId: "sess-1",
  body: "here is a summary",
  createdAt: new Date("2026-06-28T00:01:00Z"),
  editedAt: new Date("2026-06-28T00:02:00Z"),
};

afterEach(() => vi.restoreAllMocks());

describe("toMessagePayload", () => {
  it("projects a human row with attribution and ISO dates", () => {
    expect(toMessagePayload(HUMAN_ROW)).toEqual({
      id: "m1",
      threadId: "t1",
      authorKind: "human",
      authorUserId: "u1",
      aiProvider: null,
      aiModel: null,
      aiSessionId: null,
      body: "hello team",
      createdAt: "2026-06-28T00:00:00.000Z",
      editedAt: null,
    });
  });

  it("projects an AI row with provider/model/session attribution", () => {
    const p = toMessagePayload(AI_ROW);
    expect(p.authorKind).toBe("ai");
    expect(p.aiProvider).toBe("copilot");
    expect(p.aiModel).toBe("gpt-x");
    expect(p.aiSessionId).toBe("sess-1");
    expect(p.editedAt).toBe("2026-06-28T00:02:00.000Z");
  });

  it("passes through an already-ISO-string createdAt and defaults missing optionals to null", () => {
    const p = toMessagePayload({
      id: "m3",
      threadId: "t1",
      authorKind: "human",
      body: "x",
      createdAt: "2026-06-28T00:00:00.000Z",
    });
    expect(p.createdAt).toBe("2026-06-28T00:00:00.000Z");
    expect(p.authorUserId).toBeNull();
    expect(p.aiProvider).toBeNull();
    expect(p.editedAt).toBeNull();
  });
});

describe("emitMessageNew", () => {
  it("emits message:new to the thread room with the projected payload", () => {
    const { io, to, emit } = makeFakeIo();
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);
    vi.setSystemTime(new Date("2026-06-28T12:00:00Z"));

    emitMessageNew("t1", HUMAN_ROW);

    expect(to).toHaveBeenCalledWith("thread:t1");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("message:new", {
      threadId: "t1",
      message: toMessagePayload(HUMAN_ROW),
      ts: Date.parse("2026-06-28T12:00:00Z"),
    });
    vi.useRealTimers();
  });

  it("is a silent no-op when no IO server is registered (test mode)", () => {
    vi.spyOn(registry, "getSocketServer").mockReturnValue(null);
    expect(() => emitMessageNew("t1", HUMAN_ROW)).not.toThrow();
  });

  it("swallows transport errors instead of throwing into the request path", () => {
    const emit = vi.fn(() => {
      throw new Error("transport down");
    });
    const io = { to: vi.fn(() => ({ emit })) } as unknown as MetisIOServer;
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);
    expect(() => emitMessageNew("t1", HUMAN_ROW)).not.toThrow();
  });

  it("targets ONLY the message's own thread room (non-members are not in it)", () => {
    const { io, to } = makeFakeIo();
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);

    emitMessageNew("t1", HUMAN_ROW);

    // Only `thread:t1` is addressed — there is no broadcast to other rooms, so a
    // socket not joined to `thread:t1` (a non-member, per #480 authz) never
    // receives this event.
    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith("thread:t1");
    expect(to).not.toHaveBeenCalledWith("thread:other");
  });
});

describe("emitMessageStream", () => {
  it("emits message:stream with delta/done/messageId to the thread room", () => {
    const { io, to, emit } = makeFakeIo();
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);
    vi.setSystemTime(new Date("2026-06-28T12:00:00Z"));

    emitMessageStream("t1", { delta: "partial", messageId: "m9", done: false });

    expect(to).toHaveBeenCalledWith("thread:t1");
    expect(emit).toHaveBeenCalledWith("message:stream", {
      threadId: "t1",
      messageId: "m9",
      delta: "partial",
      done: false,
      ts: Date.parse("2026-06-28T12:00:00Z"),
    });
    vi.useRealTimers();
  });

  it("omits messageId when not provided and defaults done to false", () => {
    const { io, emit } = makeFakeIo();
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);

    emitMessageStream("t1", { delta: "chunk" });

    const payload = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("messageId");
    expect(payload.done).toBe(false);
    expect(payload.delta).toBe("chunk");
  });

  it("marks the terminal chunk with done=true", () => {
    const { io, emit } = makeFakeIo();
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);

    emitMessageStream("t1", { delta: "", messageId: "m9", done: true });

    const payload = emit.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.done).toBe(true);
  });

  it("is a silent no-op when no IO server is registered", () => {
    vi.spyOn(registry, "getSocketServer").mockReturnValue(null);
    expect(() => emitMessageStream("t1", { delta: "x" })).not.toThrow();
  });

  it("swallows transport errors", () => {
    const emit = vi.fn(() => {
      throw new Error("boom");
    });
    const io = { to: vi.fn(() => ({ emit })) } as unknown as MetisIOServer;
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);
    expect(() => emitMessageStream("t1", { delta: "x" })).not.toThrow();
  });
});
