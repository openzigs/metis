/**
 * #612 — the disconnect runs after the deprovision has committed, so an
 * adapter error must be logged, never thrown into the SCIM route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { disconnectUserSockets, reconnectUserSockets } from "./user-disconnect.js";
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
