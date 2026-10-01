/**
 * #612 — the disconnect runs after the deprovision has committed, so an
 * adapter error must be logged, never thrown into the SCIM route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECONNECT_USER_EVENT,
  disconnectUserSockets,
  reconnectUserSockets,
  wireReconnectUserRelay,
} from "./user-disconnect.js";
import { registerSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";

describe("disconnectUserSockets", () => {
  afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

  it("disconnects the user's personal room, closing the connection", () => {
    const disconnectSockets = vi.fn();
    const io = { in: vi.fn(() => ({ disconnectSockets })) } as unknown as MetisIOServer;
    registerSocketServer(io);
    disconnectUserSockets("u-1");
    expect(io.in).toHaveBeenCalledWith("user:u-1");
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it("does not throw when the adapter fails", () => {
    const io = {
      in: vi.fn(() => ({
        disconnectSockets: () => {
          throw new Error("adapter down");
        },
      })),
    } as unknown as MetisIOServer;
    registerSocketServer(io);
    expect(() => disconnectUserSockets("u-1")).not.toThrow();
  });

  it("is a no-op with no registered server", () => {
    registerSocketServer(null as unknown as MetisIOServer);
    expect(() => disconnectUserSockets("u-1")).not.toThrow();
  });
});

// #633 — a role change closes the transport (no disconnect packet), so the
// client's reconnect loop re-handshakes with the new durable role.
describe("reconnectUserSockets", () => {
  afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

  function fakeServer(rooms: Map<string, Set<string>>, sids: string[]) {
    const conns = new Map(sids.map((sid) => [sid, { close: vi.fn() }]));
    const io = {
      sockets: {
        adapter: { rooms },
        sockets: new Map(sids.map((sid) => [sid, { conn: conns.get(sid) }])),
      },
    } as unknown as MetisIOServer;
    registerSocketServer(io);
    return conns;
  }

  it("closes the transport of every socket in the user's personal room, and only those", () => {
    const conns = fakeServer(
      new Map([
        ["user:u-1", new Set(["a", "b"])],
        ["user:u-2", new Set(["c"])],
      ]),
      ["a", "b", "c"],
    );
    reconnectUserSockets("u-1");
    expect(conns.get("a")!.close).toHaveBeenCalledOnce();
    expect(conns.get("b")!.close).toHaveBeenCalledOnce();
    expect(conns.get("c")!.close).not.toHaveBeenCalled();
  });

  it("is a no-op for a user with no open socket", () => {
    const conns = fakeServer(new Map(), ["a"]);
    expect(() => reconnectUserSockets("u-1")).not.toThrow();
    expect(conns.get("a")!.close).not.toHaveBeenCalled();
  });

  it("does not throw when a close fails", () => {
    const conns = fakeServer(new Map([["user:u-1", new Set(["a"])]]), ["a"]);
    conns.get("a")!.close.mockImplementation(() => {
      throw new Error("transport gone");
    });
    expect(() => reconnectUserSockets("u-1")).not.toThrow();
  });

  it("is a no-op with no registered server", () => {
    registerSocketServer(null as unknown as MetisIOServer);
    expect(() => reconnectUserSockets("u-1")).not.toThrow();
  });
});

// #622 — with the cluster adapter, the other replicas close their own transports.
describe("reconnectUserSockets relay", () => {
  afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

  function relayServer(rooms: Map<string, Set<string>>, sids: string[]) {
    const conns = new Map(sids.map((sid) => [sid, { close: vi.fn() }]));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const io = {
      sockets: {
        adapter: { rooms },
        sockets: new Map(sids.map((sid) => [sid, { conn: conns.get(sid) }])),
      },
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => listeners.set(event, fn)),
      serverSideEmit: vi.fn(),
    };
    return { io, server: io as unknown as MetisIOServer, conns, listeners };
  }

  it("relays the reconnect to the other replicas when the server is clustered", () => {
    const { io, server, conns } = relayServer(new Map([["user:u-1", new Set(["a"])]]), ["a"]);
    wireReconnectUserRelay(server, true);
    registerSocketServer(server);
    reconnectUserSockets("u-1");
    expect(conns.get("a")!.close).toHaveBeenCalledOnce();
    expect(io.serverSideEmit).toHaveBeenCalledWith(RECONNECT_USER_EVENT, "u-1");
  });

  it("neither relays nor listens without the cluster adapter, where serverSideEmit is unsupported", () => {
    const { io, server } = relayServer(new Map(), []);
    wireReconnectUserRelay(server, false);
    registerSocketServer(server);
    reconnectUserSockets("u-1");
    expect(io.on).not.toHaveBeenCalled();
    expect(io.serverSideEmit).not.toHaveBeenCalled();
  });

  it("a relayed reconnect closes the transports of that user's local sockets only", () => {
    const { server, conns, listeners } = relayServer(
      new Map([
        ["user:u-1", new Set(["a"])],
        ["user:u-2", new Set(["b"])],
      ]),
      ["a", "b"],
    );
    wireReconnectUserRelay(server, true);
    listeners.get(RECONNECT_USER_EVENT)!("u-1");
    expect(conns.get("a")!.close).toHaveBeenCalledOnce();
    expect(conns.get("b")!.close).not.toHaveBeenCalled();
  });

  it("ignores a malformed relay and never throws from a failing close", () => {
    const { server, conns, listeners } = relayServer(new Map([["user:u-1", new Set(["a"])]]), [
      "a",
    ]);
    wireReconnectUserRelay(server, true);
    const onRelay = listeners.get(RECONNECT_USER_EVENT)!;
    onRelay(42);
    onRelay("");
    expect(conns.get("a")!.close).not.toHaveBeenCalled();
    conns.get("a")!.close.mockImplementation(() => {
      throw new Error("transport gone");
    });
    expect(() => onRelay("u-1")).not.toThrow();
  });

  it("still relays when a local close fails, and never throws when the relay does", () => {
    const { io, server, conns } = relayServer(new Map([["user:u-1", new Set(["a"])]]), ["a"]);
    conns.get("a")!.close.mockImplementation(() => {
      throw new Error("transport gone");
    });
    wireReconnectUserRelay(server, true);
    registerSocketServer(server);
    reconnectUserSockets("u-1");
    expect(io.serverSideEmit).toHaveBeenCalledOnce();
    io.serverSideEmit.mockImplementation(() => {
      throw new Error("adapter down");
    });
    expect(() => reconnectUserSockets("u-1")).not.toThrow();
  });
});
