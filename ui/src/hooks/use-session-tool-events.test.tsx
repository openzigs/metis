/** #143 — the session room's tool events reach the chat page, filtered to its session. */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const handlers = new Map<string, (data: unknown) => void>();
const socket = {
  emit: vi.fn(),
  on: vi.fn((name: string, fn: (data: unknown) => void) => handlers.set(name, fn)),
  off: vi.fn((name: string) => handlers.delete(name)),
};
vi.mock("@/lib/socket-client", () => ({ useSocket: () => socket }));

const { useSessionToolEvents } = await import("./use-session-tool-events");

const EVENT = {
  type: "tool_event",
  phase: "started",
  sessionId: "s1",
  callId: "c1",
  name: "t",
  risk: "low",
  source: "metis",
  ts: 1,
};

describe("useSessionToolEvents", () => {
  it("joins the room, delivers this session's well-formed events, and leaves on unmount", () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() => useSessionToolEvents("s1", onEvent));
    expect(socket.emit).toHaveBeenCalledWith("subscribe:session", { sessionId: "s1" });
    const deliver = handlers.get("ai:tool:event")!;
    deliver(EVENT);
    deliver({ ...EVENT, sessionId: "s-other" });
    deliver({ nonsense: true });
    expect(onEvent).toHaveBeenCalledTimes(1);
    unmount();
    expect(socket.emit).toHaveBeenCalledWith("unsubscribe:session", { sessionId: "s1" });
    expect(handlers.has("ai:tool:event")).toBe(false);
  });

  it("does nothing without a session", () => {
    socket.emit.mockClear();
    renderHook(() => useSessionToolEvents(null, vi.fn()));
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
