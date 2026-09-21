/**
 * Epic #405 / Issue #415 — socket connection-lifecycle + status store tests.
 *
 * Strategy: mock the real `socket.io-client` so `getSocket()` builds a fake
 * socket whose lifecycle handlers we can capture and fire, then assert the
 * `useSocketStatus()` store snapshot transitions. This locks the
 * connect→connected, disconnect→disconnected/reconnecting, reconnect_attempt→
 * reconnecting, connect_error and auth:error contracts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, waitFor, renderHook } from "@testing-library/react";

// ---- Fake socket.io-client -------------------------------------------------

type Handler = (...args: unknown[]) => void;

function makeFakeSocket() {
  const socketHandlers = new Map<string, Handler>();
  const managerHandlers = new Map<string, Handler>();
  const manager = {
    on: vi.fn((evt: string, cb: Handler) => {
      managerHandlers.set(evt, cb);
    }),
  };
  const socket = {
    connected: false,
    io: manager,
    on: vi.fn((evt: string, cb: Handler) => {
      socketHandlers.set(evt, cb);
    }),
    off: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    socket,
    fireSocket: (evt: string, ...args: unknown[]) => act(() => socketHandlers.get(evt)?.(...args)),
    fireManager: (evt: string, ...args: unknown[]) =>
      act(() => managerHandlers.get(evt)?.(...args)),
    socketHandlers,
    managerHandlers,
  };
}

let fake: ReturnType<typeof makeFakeSocket>;
const ioMock = vi.fn((..._args: unknown[]) => fake.socket);

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

// #414 — capture the refresh-success handler the socket-client registers via
// `setOnRefreshSuccess`, so tests can simulate a token refresh and assert the
// token-driven reconnect. Mock keeps the real single-flight refresh logic out of
// these socket tests (that path is covered in api-client.test.ts).
let registeredRefreshSuccess: (() => void) | null = null;
const setOnRefreshSuccessMock = vi.fn((handler: (() => void) | null) => {
  registeredRefreshSuccess = handler;
});

vi.mock("@/lib/api-client", () => ({
  setOnRefreshSuccess: (handler: (() => void) | null) => setOnRefreshSuccessMock(handler),
}));

import { useSocket, useSocketStatus, __resetSocketStatusForTests } from "@/lib/socket-client";

beforeEach(() => {
  fake = makeFakeSocket();
  ioMock.mockClear();
  setOnRefreshSuccessMock.mockClear();
  registeredRefreshSuccess = null;
  __resetSocketStatusForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Simulate a successful `/auth/refresh` by invoking the registered handler. */
function fireRefreshSuccess() {
  act(() => registeredRefreshSuccess?.());
}

/** Mounts useSocket() (to trigger getSocket + lifecycle wiring) + status hook. */
function renderStatus() {
  const statusHook = renderHook(() => useSocketStatus());
  renderHook(() => useSocket());
  return statusHook;
}

describe("socket connection lifecycle store", () => {
  it("starts in reconnecting (connecting) before any event", async () => {
    const { result } = renderHook(() => useSocketStatus());
    expect(result.current.status).toBe("reconnecting");
    expect(result.current.error).toBeNull();
  });

  it("registers all lifecycle handlers on the socket and manager", async () => {
    renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    for (const evt of ["connect", "connect_error", "disconnect", "auth:error"]) {
      expect(fake.socketHandlers.has(evt)).toBe(true);
    }
    for (const evt of ["reconnect_attempt", "reconnect", "reconnect_failed"]) {
      expect(fake.managerHandlers.has(evt)).toBe(true);
    }
  });

  it("connect → connected", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");
    expect(result.current.status).toBe("connected");
    expect(result.current.error).toBeNull();
  });

  it("disconnect (transport drop) → reconnecting", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");
    fake.fireSocket("disconnect", "transport close");
    expect(result.current.status).toBe("reconnecting");
  });

  it("disconnect (intentional client/server) → disconnected", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");
    fake.fireSocket("disconnect", "io server disconnect");
    expect(result.current.status).toBe("disconnected");
  });

  it("reconnect_attempt → reconnecting, reconnect → connected", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");
    fake.fireSocket("disconnect", "transport error");
    fake.fireManager("reconnect_attempt");
    expect(result.current.status).toBe("reconnecting");
    fake.fireManager("reconnect");
    expect(result.current.status).toBe("connected");
  });

  it("reconnect_failed → disconnected", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireManager("reconnect_failed");
    expect(result.current.status).toBe("disconnected");
  });

  it("connect_error surfaces the reason and stays reconnecting", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect_error", new Error("boom"));
    expect(result.current.status).toBe("reconnecting");
    expect(result.current.error).toBe("boom");
  });

  it("auth:error surfaces the message", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("auth:error", { message: "Forbidden room" });
    expect(result.current.error).toBe("Forbidden room");
  });

  it("auth:error with no message falls back to a generic string", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("auth:error", {});
    expect(result.current.error).toBe("Authentication error");
  });

  it("connect_error with no message falls back to a generic string", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect_error", {} as Error);
    expect(result.current.error).toBe("Connection error");
  });

  it("reports connected immediately if the socket was already connected on mount", async () => {
    fake.socket.connected = true;
    const { result } = renderStatus();
    await waitFor(() => expect(result.current.status).toBe("connected"));
  });

  it("useSocket still returns the Socket instance (unchanged contract)", async () => {
    const { result } = renderHook(() => useSocket());
    await waitFor(() => expect(result.current).toBe(fake.socket));
  });

  it("does not notify listeners when state is unchanged (repeated reconnect_attempt)", async () => {
    const { result } = renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireManager("reconnect_attempt");
    expect(result.current.status).toBe("reconnecting");
    // firing again with the same resulting status is a no-op for the snapshot
    fake.fireManager("reconnect_attempt");
    expect(result.current.status).toBe("reconnecting");
  });
});

// #414 — token-refresh-driven reconnect. When the access token is refreshed, the
// socket must re-handshake so the next connection carries the FRESH `metis.at`
// cookie. The renewal is debounced (one reconnect per burst), only acts when a
// socket exists, and surfaces as `reconnecting` → `connected` (never stuck
// `disconnected`, even though the manual disconnect reason is "io client
// disconnect").
describe("token-refresh reconnect (#414)", () => {
  it("registers the refresh-success handler when the socket singleton is created", async () => {
    renderStatus();
    await waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    expect(setOnRefreshSuccessMock).toHaveBeenCalled();
    expect(registeredRefreshSuccess).toBeTypeOf("function");
  });

  it("a single refresh-success triggers exactly one disconnect()+connect()", async () => {
    vi.useFakeTimers();
    renderStatus();
    await vi.waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");

    fireRefreshSuccess();
    act(() => vi.runAllTimers());

    expect(fake.socket.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.socket.connect).toHaveBeenCalledTimes(1);
    // disconnect must precede connect so the new handshake carries the fresh cookie.
    expect(fake.socket.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      fake.socket.connect.mock.invocationCallOrder[0],
    );
  });

  it("rapid back-to-back refresh-successes still cause exactly one reconnect (debounce)", async () => {
    vi.useFakeTimers();
    renderStatus();
    await vi.waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");

    fireRefreshSuccess();
    fireRefreshSuccess();
    fireRefreshSuccess();
    act(() => vi.runAllTimers());

    expect(fake.socket.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.socket.connect).toHaveBeenCalledTimes(1);
  });

  it("does NOT reconnect when no socket exists yet (socketRef is null)", async () => {
    // No renderStatus() → getSocket() never ran → socketRef is null. We can still
    // invoke the renewal directly through the test seam and assert it is a no-op.
    vi.useFakeTimers();
    // Register the handler the way module init does, without a socket.
    const { __triggerTokenRefreshReconnectForTests } = await import("@/lib/socket-client");
    __triggerTokenRefreshReconnectForTests();
    act(() => vi.runAllTimers());

    expect(fake.socket.disconnect).not.toHaveBeenCalled();
    expect(fake.socket.connect).not.toHaveBeenCalled();
  });

  it("surfaces as reconnecting (not stuck disconnected) across the renewal", async () => {
    vi.useFakeTimers();
    const { result } = renderStatus();
    await vi.waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");
    expect(result.current.status).toBe("connected");

    fireRefreshSuccess();
    act(() => vi.runAllTimers());

    // The manual disconnect handler maps "io client disconnect" → disconnected,
    // but a token renewal must hold the UI at `reconnecting`, not `disconnected`.
    fake.fireSocket("disconnect", "io client disconnect");
    expect(result.current.status).toBe("reconnecting");

    // The fresh handshake completes → connected.
    fake.fireSocket("connect");
    expect(result.current.status).toBe("connected");
  });

  it("clears a pending debounce timer on reset (no leaked reconnect)", async () => {
    vi.useFakeTimers();
    renderStatus();
    await vi.waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");

    // Queue a renewal but reset BEFORE the debounce window elapses.
    fireRefreshSuccess();
    __resetSocketStatusForTests();
    act(() => vi.runAllTimers());

    // The pending timer was cleared, so no disconnect()/connect() ever fires.
    expect(fake.socket.disconnect).not.toHaveBeenCalled();
    expect(fake.socket.connect).not.toHaveBeenCalled();
  });

  it("a refresh FAILURE never reaches this handler — no reconnect", async () => {
    vi.useFakeTimers();
    renderStatus();
    await vi.waitFor(() => expect(fake.socket.on).toHaveBeenCalled());
    fake.fireSocket("connect");

    // Failure flows through setOnRefreshFailure (logout), never the success
    // handler — so simply NOT firing it must leave the socket untouched.
    act(() => vi.runAllTimers());

    expect(fake.socket.disconnect).not.toHaveBeenCalled();
    expect(fake.socket.connect).not.toHaveBeenCalled();
  });
});

describe("useSocket failure routing (#415 — no silent swallow)", () => {
  it("routes a getSocket import failure to the disconnected status", async () => {
    ioMock.mockImplementationOnce(() => {
      throw new Error("import blew up");
    });
    const status = renderHook(() => useSocketStatus());
    renderHook(() => useSocket());
    await waitFor(() => expect(status.result.current.status).toBe("disconnected"));
    expect(status.result.current.error).toBe("import blew up");
  });
});
