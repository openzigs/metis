/**
 * #642 — a minimal stand-in for the shared Socket.IO client that can simulate a
 * disconnect + reconnect. Listeners persist across the reconnect (as they do on
 * a real socket.io-client instance); the server-side rooms do not, which is why
 * a subscriber must re-send its `subscribe:*` on `connect`.
 */
import { vi, type Mock } from "vitest";

type Handler = (...args: unknown[]) => void;
type Spy = Mock<(...args: unknown[]) => unknown>;

export function createFakeSocket(connected = true) {
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    connected,
    emit: vi.fn() as Spy,
    on: vi.fn((event: string, fn: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
      return socket;
    }) as Spy,
    off: vi.fn((event: string, fn: Handler) => {
      handlers.get(event)?.delete(fn);
      return socket;
    }) as Spy,
    listeners: (event: string) => handlers.get(event)?.size ?? 0,
    /** Deliver a server event to every registered listener. */
    fire: (event: string, ...args: unknown[]) => {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(...args);
    },
    disconnect: () => {
      socket.connected = false;
      socket.fire("disconnect", "transport close");
    },
    connect: () => {
      socket.connected = true;
      socket.fire("connect");
    },
    /** The transport dropped and came back: the server lost every room. */
    reconnect: () => {
      socket.disconnect();
      socket.connect();
    },
    /** How many times `event` was emitted with a payload matching `payload`. */
    emitted: (event: string, payload?: unknown) =>
      socket.emit.mock.calls.filter(
        ([e, p]) =>
          e === event && (payload === undefined || JSON.stringify(p) === JSON.stringify(payload)),
      ).length,
  };
  return socket;
}

export type FakeSocket = ReturnType<typeof createFakeSocket>;
