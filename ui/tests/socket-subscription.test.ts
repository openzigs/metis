/**
 * #642 — `keepSubscribed` re-sends a room subscription on every reconnect.
 * #647 — and sends the unsubscribe only when the room's last follower releases.
 */
import { describe, it, expect, vi } from "vitest";
import { keepSubscribed } from "@/lib/socket-subscription";
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
    const release = keepSubscribed(s as never, subscribe, { room: "r:1", unsubscribe });
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

describe("keepSubscribed reference-counts a room per socket (#647)", () => {
  function follow(s: ReturnType<typeof createFakeSocket>, room: string) {
    const subscribe = vi.fn();
    const unsubscribe = vi.fn();
    const release = keepSubscribed(s as never, subscribe, { room, unsubscribe });
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
