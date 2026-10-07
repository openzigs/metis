/**
 * #685 — the server refuses `subscribe:thread` and `presence:thread:join` with
 * the room-scoped `auth:error { message, room }` (`discussion-rooms.ts`,
 * `discussion-presence.ts`). A thread deleted, or access revoked, while it is
 * open is refused on the next reconnect's re-subscribe; that refusal belongs to
 * the thread view, so it must not become the app-wide connection error or a
 * global toast.
 *
 * The client cannot tell which of the two events a refusal answers, and the UI
 * never sends `presence:thread:join`, so the subscribe case covers both; the
 * server-side presence tests pin the presence payload.
 *
 * Wires the real socket client, `keepRoomSubscribed(threadFollow(...))` and
 * `<ConnectionStatus />` to one fake socket that keeps every listener.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";

type Handler = (...args: unknown[]) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    connected: false,
    io: { on: vi.fn() },
    on: vi.fn((evt: string, cb: Handler) => {
      if (!handlers.has(evt)) handlers.set(evt, new Set());
      handlers.get(evt)!.add(cb);
    }),
    off: vi.fn((evt: string, cb: Handler) => {
      handlers.get(evt)?.delete(cb);
    }),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const fire = (evt: string, ...args: unknown[]) =>
    act(() => {
      for (const cb of [...(handlers.get(evt) ?? [])]) cb(...args);
    });
  return { socket, fire };
}

let fake: ReturnType<typeof makeFakeSocket>;
vi.mock("socket.io-client", () => ({ io: () => fake.socket }));
vi.mock("@/lib/api-client", () => ({ setOnRefreshSuccess: vi.fn() }));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { useSocket, useSocketStatus, __resetSocketStatusForTests } from "@/lib/socket-client";
import { THREAD_DENIAL, threadRoom } from "@metis/shared";
import { keepRoomSubscribed } from "@/lib/socket-subscription";
import { threadFollow } from "@/lib/socket-rooms";
import { ConnectionStatus } from "@/components/realtime/connection-status";

async function mountApp() {
  render(<ConnectionStatus />);
  const status = renderHook(() => useSocketStatus());
  const hook = renderHook(() => useSocket());
  await waitFor(() => expect(hook.result.current).not.toBeNull());
  fake.socket.connected = true;
  fake.fire("connect");
  return status;
}

beforeEach(() => {
  fake = makeFakeSocket();
  toastError.mockClear();
  __resetSocketStatusForTests();
});

describe("a refused thread room (#685)", () => {
  it("a subscribe:thread refusal stores no global error and shows no toast", async () => {
    const status = await mountApp();
    keepRoomSubscribed(fake.socket as never, threadFollow(fake.socket as never, "t-gone"));
    expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:thread", { threadId: "t-gone" });

    fake.fire("auth:error", { message: THREAD_DENIAL, room: threadRoom("t-gone") });

    expect(status.result.current.error).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("the pre-#685 shape (no room) was shown globally — the bug this closes", async () => {
    const status = await mountApp();

    fake.fire("auth:error", { message: THREAD_DENIAL });

    expect(status.result.current.error).toBe(THREAD_DENIAL);
    expect(toastError).toHaveBeenCalledWith(THREAD_DENIAL);
  });
});
