/**
 * #655 — the server refuses a `job:{id}` join it cannot scope, and some jobs
 * (repo ingest, spec-kit, overview, reindex, PR review) have no row to scope
 * from after a restart. The UI re-subscribes to every followed job on each
 * reconnect, so that refusal is routine: it must not reach the user as an
 * error, and the refused room must not be re-subscribed again. A connection
 * level `auth:error` (no `room`) is still shown.
 *
 * Wires the real socket client, `joinJobRoom`, `useFollowJobs` and
 * `<ConnectionStatus />` to one fake socket that keeps every listener.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";

type Handler = (...args: unknown[]) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const managerHandlers = new Map<string, Handler>();
  const socket = {
    connected: false,
    io: {
      on: vi.fn((evt: string, cb: Handler) => {
        managerHandlers.set(evt, cb);
      }),
    },
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
  return {
    socket,
    fire,
    /** The server restarted: the transport drops, then the socket reconnects. */
    restart: () => {
      socket.connected = false;
      fire("disconnect", "transport close");
      socket.connected = true;
      fire("connect");
    },
  };
}

let fake: ReturnType<typeof makeFakeSocket>;
vi.mock("socket.io-client", () => ({ io: () => fake.socket }));
vi.mock("@/lib/api-client", () => ({ setOnRefreshSuccess: vi.fn() }));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { useSocket, useSocketStatus, __resetSocketStatusForTests } from "@/lib/socket-client";
import { jobRoom } from "@metis/shared";
import { joinJobRoom } from "@/lib/job-rooms";
import { useFollowJobs, __resetActiveJobsForTests } from "@/hooks/use-active-jobs";
import { ConnectionStatus } from "@/components/realtime/connection-status";

const subscribes = (jobId: string) =>
  fake.socket.emit.mock.calls.filter(
    ([e, p]) => e === "subscribe:job" && (p as { jobId: string }).jobId === jobId,
  ).length;

/** Mount the app-wide pieces and return the live socket and status. */
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
  __resetActiveJobsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a followed job refused after a server restart (#655)", () => {
  it("shows no error and stops re-subscribing the refused room", async () => {
    const status = await mountApp();
    joinJobRoom(fake.socket as never, "job-forgotten");
    joinJobRoom(fake.socket as never, "job-known");

    fake.restart();
    expect(subscribes("job-forgotten")).toBe(2);
    fake.fire("auth:error", {
      message: "FORBIDDEN: no access to job",
      room: jobRoom("job-forgotten"),
    });

    expect(status.result.current.error).toBeNull();
    expect(toastError).not.toHaveBeenCalled();

    fake.socket.emit.mockClear();
    fake.restart();
    expect(subscribes("job-forgotten")).toBe(0);
    expect(subscribes("job-known")).toBe(1);
  });

  it("covers useFollowJobs, which follows jobs the server may have forgotten", async () => {
    const status = await mountApp();
    renderHook(() => useFollowJobs(["ingest-1"]));
    await waitFor(() => expect(subscribes("ingest-1")).toBe(1));

    fake.restart();
    fake.fire("auth:error", { message: "FORBIDDEN: no access to job", room: jobRoom("ingest-1") });
    expect(status.result.current.error).toBeNull();
    expect(toastError).not.toHaveBeenCalled();

    fake.socket.emit.mockClear();
    fake.restart();
    expect(subscribes("ingest-1")).toBe(0);
  });

  it("still shows a connection-level auth:error that names no room", async () => {
    const status = await mountApp();
    joinJobRoom(fake.socket as never, "job-1");
    fake.fire("auth:error", { message: "UNAUTHORIZED" });
    expect(status.result.current.error).toBe("UNAUTHORIZED");
    expect(toastError).toHaveBeenCalledWith("UNAUTHORIZED");
    // And it is not mistaken for a room refusal.
    fake.socket.emit.mockClear();
    fake.restart();
    expect(subscribes("job-1")).toBe(1);
  });

  it("still shows a handshake rejection (connect_error)", async () => {
    const status = await mountApp();
    joinJobRoom(fake.socket as never, "job-1");
    fake.fire("connect_error", new Error("TOKEN_EXPIRED"));
    expect(status.result.current.error).toBe("TOKEN_EXPIRED");
    expect(toastError).toHaveBeenCalledWith("TOKEN_EXPIRED");
  });
});
