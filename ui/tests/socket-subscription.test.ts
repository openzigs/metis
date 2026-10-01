/**
 * #642 — `keepSubscribed` re-sends a room subscription on every reconnect.
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
    const release = keepSubscribed(s as never, subscribe, unsubscribe);
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
