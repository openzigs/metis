/**
 * #642 — `keepSubscribed` re-sends a room subscription on every reconnect.
 * #647 — `keepRoomSubscribed` sends the unsubscribe only when the room's last
 * follower releases.
 * #672 — `followedRooms` exposes the live count per room key, so call-site
 * tests can pin the key each one uses to the server's room name.
 */
import { describe, it, expect, vi } from "vitest";
import {
  followedRooms,
  keepRoomSubscribed,
  keepSubscribed,
  onReconnect,
} from "@/lib/socket-subscription";
import { createFakeSocket } from "./helpers/fake-socket";

describe("keepSubscribed", () => {
  it("subscribes immediately", () => {
    const s = createFakeSocket();
    const subscribe = vi.fn();
    keepSubscribed(s as never, subscribe);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("re-subscribes on each reconnect", () => {
    const s = createFakeSocket();
    const subscribe = vi.fn();
    keepSubscribed(s as never, subscribe);
    s.reconnect();
    expect(subscribe).toHaveBeenCalledTimes(2);
    s.reconnect();
    expect(subscribe).toHaveBeenCalledTimes(3);
  });

  it("does not re-send a subscribe still sitting in the send buffer", () => {
    // Emitted while down: socket.io-client flushes it on the next connect.
    const s = createFakeSocket(false);
    const subscribe = vi.fn();
    keepSubscribed(s as never, subscribe);
    s.connect();
    expect(subscribe).toHaveBeenCalledTimes(1);
    // A later reconnect is a real room loss and does re-send.
    s.reconnect();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("release stops re-subscribing and unsubscribes once", () => {
    const s = createFakeSocket();
    const subscribe = vi.fn();
    const unsubscribe = vi.fn();
    const release = keepRoomSubscribed(s as never, { room: "r:1", subscribe, unsubscribe });
    release();
    release();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(s.listeners("connect")).toBe(0);
    s.reconnect();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("release without an unsubscribe only detaches the connect listener", () => {
    const s = createFakeSocket();
    const release = keepSubscribed(s as never, vi.fn());
    expect(s.listeners("connect")).toBe(1);
    release();
    expect(s.listeners("connect")).toBe(0);
  });
});

describe("keepRoomSubscribed reference-counts a room per socket (#647)", () => {
  function follow(s: ReturnType<typeof createFakeSocket>, room: string) {
    const subscribe = vi.fn();
    const unsubscribe = vi.fn();
    const release = keepRoomSubscribed(s as never, { room, subscribe, unsubscribe });
    return { subscribe, unsubscribe, release };
  }

  it("keeps the room while another follower remains, and leaves it with the last", () => {
    const s = createFakeSocket();
    const a = follow(s, "thread:t1");
    const b = follow(s, "thread:t1");
    a.release();
    expect(a.unsubscribe).not.toHaveBeenCalled();
    expect(b.unsubscribe).not.toHaveBeenCalled();
    // The remaining follower still re-joins after a reconnect.
    s.reconnect();
    expect(b.subscribe).toHaveBeenCalledTimes(2);
    expect(a.subscribe).toHaveBeenCalledTimes(1);
    b.release();
    expect(b.unsubscribe).toHaveBeenCalledTimes(1);
    expect(a.unsubscribe).not.toHaveBeenCalled();
  });

  it("a repeated release does not count as a second follower leaving", () => {
    const s = createFakeSocket();
    const a = follow(s, "task:t1");
    const b = follow(s, "task:t1");
    a.release();
    a.release();
    expect(a.unsubscribe).not.toHaveBeenCalled();
    expect(b.unsubscribe).not.toHaveBeenCalled();
    b.release();
    expect(b.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("counts each room separately", () => {
    const s = createFakeSocket();
    const a = follow(s, "session:s1");
    const b = follow(s, "session:s2");
    a.release();
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    expect(b.unsubscribe).not.toHaveBeenCalled();
  });

  it("counts each socket separately", () => {
    const s1 = createFakeSocket();
    const s2 = createFakeSocket();
    const a = follow(s1, "analysis:a1");
    follow(s2, "analysis:a1");
    a.release();
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a room left by its last follower is joined afresh by the next", () => {
    const s = createFakeSocket();
    const a = follow(s, "publish:b1");
    a.release();
    const b = follow(s, "publish:b1");
    const c = follow(s, "publish:b1");
    c.release();
    expect(c.unsubscribe).not.toHaveBeenCalled();
    b.release();
    expect(b.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("followedRooms (#672)", () => {
  it("reports the live follower count per room key on one socket", () => {
    const s = createFakeSocket();
    const other = createFakeSocket();
    const a = keepRoomSubscribed(s as never, {
      room: "thread:t1",
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    });
    keepRoomSubscribed(s as never, { room: "thread:t1", subscribe: vi.fn(), unsubscribe: vi.fn() });
    keepRoomSubscribed(s as never, { room: "task:k1", subscribe: vi.fn(), unsubscribe: vi.fn() });
    keepRoomSubscribed(other as never, {
      room: "task:k9",
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    });
    keepSubscribed(s as never, vi.fn());
    expect(followedRooms(s as never)).toEqual(
      new Map([
        ["thread:t1", 2],
        ["task:k1", 1],
      ]),
    );
    a();
    expect(followedRooms(s as never).get("thread:t1")).toBe(1);
  });

  it("is empty for a socket nothing follows, and once every follower has released", () => {
    const s = createFakeSocket();
    expect(followedRooms(s as never).size).toBe(0);
    const release = keepRoomSubscribed(s as never, {
      room: "session:s1",
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    });
    release();
    expect(followedRooms(s as never).size).toBe(0);
  });

  it("returns a snapshot the caller cannot use to corrupt the count", () => {
    const s = createFakeSocket();
    const unsubscribe = vi.fn();
    const release = keepRoomSubscribed(s as never, { room: "r", subscribe: vi.fn(), unsubscribe });
    (followedRooms(s as never) as Map<string, number>).set("r", 5);
    release();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile on reconnect (#646)", () => {
  it("keepSubscribed runs reconcile after each re-subscribe, never on mount", () => {
    const s = createFakeSocket();
    const order: string[] = [];
    keepSubscribed(
      s as never,
      () => order.push("subscribe"),
      () => order.push("reconcile"),
    );
    expect(order).toEqual(["subscribe"]);
    s.reconnect();
    expect(order).toEqual(["subscribe", "subscribe", "reconcile"]);
    s.reconnect();
    expect(order.filter((o) => o === "reconcile")).toHaveLength(2);
  });

  it("does not reconcile on the initial connect of a socket that was still down", () => {
    const s = createFakeSocket(false);
    const reconcile = vi.fn();
    keepSubscribed(s as never, vi.fn(), reconcile);
    s.connect();
    expect(reconcile).not.toHaveBeenCalled();
    s.reconnect();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("keepRoomSubscribed reconciles on reconnect and stops once released", () => {
    const s = createFakeSocket();
    const reconcile = vi.fn();
    const release = keepRoomSubscribed(
      s as never,
      { room: "task:t1", subscribe: vi.fn(), unsubscribe: vi.fn() },
      reconcile,
    );
    s.reconnect();
    expect(reconcile).toHaveBeenCalledTimes(1);
    release();
    s.reconnect();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("onReconnect reconciles on each reconnect and joins no room", () => {
    const s = createFakeSocket();
    const reconcile = vi.fn();
    const release = onReconnect(s as never, reconcile);
    expect(reconcile).not.toHaveBeenCalled();
    s.reconnect();
    s.reconnect();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(s.emit).not.toHaveBeenCalled();
    expect(followedRooms(s as never).size).toBe(0);
    release();
    expect(s.listeners("connect")).toBe(0);
    s.reconnect();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
