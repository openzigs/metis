/**
 * #1391 — one page load opened three Socket.IO connections.
 *
 * `getSocket()` checked the singleton before awaiting the dynamic
 * `import("socket.io-client")` and assigned it only after, so every
 * `useSocket()` that mounted during that await opened its own socket. These
 * specs pin the shared in-flight attempt, the retry after a failed one, and
 * `closeSocket()` (called on sign-out) resetting the singleton.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

type Handler = (...args: unknown[]) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Handler>();
  return {
    connected: false,
    io: { on: vi.fn() },
    on: vi.fn((evt: string, cb: Handler) => {
      handlers.set(evt, cb);
    }),
    off: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(() => handlers.get("disconnect")?.("io client disconnect")),
  };
}

const ioMock = vi.fn((..._args: unknown[]) => makeFakeSocket());

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

vi.mock("@/lib/api-client", () => ({
  setOnRefreshSuccess: vi.fn(),
}));

import {
  closeSocket,
  useSocket,
  useSocketStatus,
  __resetSocketStatusForTests,
} from "@/lib/socket-client";

beforeEach(() => {
  ioMock.mockClear();
  __resetSocketStatusForTests();
});

/** Mount several `useSocket()` hooks in the same commit, as a page does. */
function renderManySockets(count: number) {
  return renderHook(() => Array.from({ length: count }, () => useSocket()));
}

describe("getSocket singleton (#1391)", () => {
  it("several useSocket() hooks mounted at once open exactly one socket", async () => {
    const { result } = renderManySockets(3);
    await waitFor(() => expect(result.current.every((s) => s !== null)).toBe(true));
    expect(ioMock).toHaveBeenCalledTimes(1);
    const [first, ...rest] = result.current;
    for (const s of rest) expect(s).toBe(first);
  });

  it("separately rendered hooks that mount before the import resolves share the socket", async () => {
    const a = renderHook(() => useSocket());
    const b = renderHook(() => useSocket());
    await waitFor(() => expect(a.result.current).not.toBeNull());
    await waitFor(() => expect(b.result.current).not.toBeNull());
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(b.result.current).toBe(a.result.current);
  });

  it("a hook mounted after the socket exists reuses it", async () => {
    const a = renderHook(() => useSocket());
    await waitFor(() => expect(a.result.current).not.toBeNull());
    const b = renderHook(() => useSocket());
    await waitFor(() => expect(b.result.current).toBe(a.result.current));
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it("a failed attempt is not cached: the next caller retries", async () => {
    ioMock.mockImplementationOnce(() => {
      throw new Error("first attempt failed");
    });
    const status = renderHook(() => useSocketStatus());
    const failed = renderManySockets(2);
    await waitFor(() => expect(status.result.current.status).toBe("disconnected"));
    expect(failed.result.current).toEqual([null, null]);
    // Both concurrent callers shared the one failed attempt.
    expect(ioMock).toHaveBeenCalledTimes(1);

    const retry = renderHook(() => useSocket());
    await waitFor(() => expect(retry.result.current).not.toBeNull());
    expect(ioMock).toHaveBeenCalledTimes(2);
  });
});

describe("closeSocket (#1391)", () => {
  it("disconnects the socket and the next caller opens a new one", async () => {
    const a = renderHook(() => useSocket());
    await waitFor(() => expect(a.result.current).not.toBeNull());
    const first = a.result.current!;

    act(() => closeSocket());
    expect(first.disconnect).toHaveBeenCalledTimes(1);

    const b = renderHook(() => useSocket());
    await waitFor(() => expect(b.result.current).not.toBeNull());
    expect(b.result.current).not.toBe(first);
    expect(ioMock).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when no socket has been opened", () => {
    expect(() => closeSocket()).not.toThrow();
    expect(ioMock).not.toHaveBeenCalled();
  });

  it("an attempt still loading when closed opens nothing and reports no error", async () => {
    const status = renderHook(() => useSocketStatus());
    const stale = renderHook(() => useSocket());
    // Close before the dynamic import has resolved.
    closeSocket();
    // Let the stale import settle. (Vitest resolves the second of two dynamic
    // imports in flight at once to the REAL module, so the fresh attempt must
    // not overlap this one in a test; a browser has no such problem.)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ioMock).not.toHaveBeenCalled();
    expect(stale.result.current).toBeNull();

    const fresh = renderManySockets(2);
    await waitFor(() => expect(fresh.result.current.every((s) => s !== null)).toBe(true));
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(fresh.result.current[1]).toBe(fresh.result.current[0]);
    expect(stale.result.current).toBeNull();
    expect(status.result.current.error).toBeNull();
    expect(status.result.current.status).not.toBe("disconnected");
  });

  it("clears a pending token-renewal reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { setOnRefreshSuccess } = await import("@/lib/api-client");
      const a = renderHook(() => useSocket());
      await waitFor(() => expect(a.result.current).not.toBeNull());
      const socket = a.result.current!;
      const onRefresh = vi.mocked(setOnRefreshSuccess).mock.calls.at(-1)?.[0] as () => void;
      onRefresh();
      closeSocket();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(socket.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
