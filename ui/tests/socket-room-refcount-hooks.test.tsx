/**
 * #647 — two still-mounted followers of one non-job room on the shared socket.
 * Unmounting one must keep the room joined (no `unsubscribe:*`, the survivor
 * keeps receiving and re-joining); unmounting both leaves it. Before the fix
 * the first unmount sent the unsubscribe and silenced the survivor — the #430
 * shape that `job-rooms.ts` fixes for job rooms.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({ useSocket: () => socket }));

import { useSessionToolEvents } from "@/hooks/use-session-tool-events";
import { useTaskProgress } from "@/hooks/use-task-progress";

beforeEach(() => {
  socket = createFakeSocket();
});

describe("non-job rooms are reference-counted across hooks", () => {
  it("useSessionToolEvents: one unmount keeps the session room; both leave it", () => {
    const room = { sessionId: "s1" };
    const first = renderHook(() => useSessionToolEvents("s1", vi.fn()));
    const onEvent = vi.fn();
    const second = renderHook(() => useSessionToolEvents("s1", onEvent));

    first.unmount();
    expect(socket.emitted("unsubscribe:session", room)).toBe(0);
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:session", room)).toBe(3);
    act(() =>
      socket.fire("ai:tool:event", {
        type: "tool_event",
        phase: "started",
        callId: "c1",
        name: "x",
        sessionId: "s1",
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);

    second.unmount();
    expect(socket.emitted("unsubscribe:session", room)).toBe(1);
  });

  it("useTaskProgress: one unmount keeps the task room; both leave it", () => {
    const room = { taskId: "t1" };
    const first = renderHook(() => useTaskProgress("t1"));
    const second = renderHook(() => useTaskProgress("t1"));

    first.unmount();
    expect(socket.emitted("unsubscribe:task", room)).toBe(0);
    act(() => socket.fire("task:status", { taskId: "t1", status: "running" }));
    expect(second.result.current.status?.status).toBe("running");

    second.unmount();
    expect(socket.emitted("unsubscribe:task", room)).toBe(1);
  });

  it("followers of different rooms do not hold each other's room", () => {
    const first = renderHook(() => useTaskProgress("t1"));
    renderHook(() => useTaskProgress("t2"));
    first.unmount();
    expect(socket.emitted("unsubscribe:task", { taskId: "t1" })).toBe(1);
    expect(socket.emitted("unsubscribe:task", { taskId: "t2" })).toBe(0);
  });
});
