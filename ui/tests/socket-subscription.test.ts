/**
 * #642 — `keepSubscribed` re-sends a room subscription on every reconnect.
 * #647 — `keepRoomSubscribed` sends the unsubscribe only when the room's last
 * follower releases.
 * #672 — `followedRooms` exposes the live count per room key, so call-site
 * tests can pin the key each one uses to the server's room name.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  followedRooms,
  keepRoomSubscribed,
  keepSubscribed,
  onReconnect,
} from "@/lib/socket-subscription";
import { presenceFollow, taskFollow } from "@/lib/socket-rooms";
import { presenceRoom, taskRoom } from "@metis/shared";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

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

  it("reconciles on the connect that flushes a buffered subscribe, without re-subscribing", () => {
    const s = createFakeSocket(false);
    const subscribe = vi.fn();
    const reconcile = vi.fn();
    keepSubscribed(s as never, subscribe, reconcile);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    // socket.io-client flushes the buffered subscribe itself; the view mounted
    // mid-gap still re-reads what it may have missed since its mount-time read.
    s.connect();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    s.reconnect();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("onReconnect on a socket that was still down reconciles on its first connect", () => {
    const s = createFakeSocket(false);
    const reconcile = vi.fn();
    onReconnect(s as never, reconcile);
    expect(reconcile).not.toHaveBeenCalled();
    s.connect();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(s.emit).not.toHaveBeenCalled();
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

// #682 — a room join refused by the server's join rate limit is re-sent after
// `retryAfterMs` plus jitter; an authorization refusal changes nothing.
describe("keepRoomSubscribed after the join rate limit refuses its room (#682)", () => {
  const JITTER = 125; // Math.random() pinned to 0.5 → half of the 250 ms jitter
  const rateLimited = (room: string, retryAfterMs = 3_000) => ({
    message: "RATE_LIMITED: too many room joins, try again shortly",
    room,
    code: "RATE_LIMITED",
    retryAfterMs,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * A server that refuses the first `limited` `subscribe:task` joins as
   * rate-limited, then admits; it delivers a room's events only to a socket
   * that joined it.
   */
  function serverFor(s: FakeSocket, limited: number) {
    const joined = new Set<string>();
    let refusals = limited;
    s.emit.mockImplementation((...args: unknown[]) => {
      const [event, payload] = args as [string, { taskId: string }];
      if (event !== "subscribe:task") return;
      const room = taskRoom(payload.taskId);
      if (refusals > 0) {
        refusals -= 1;
        s.fire("auth:error", rateLimited(room));
      } else joined.add(room);
    });
    return {
      publish: (taskId: string, data: unknown) => {
        if (joined.has(taskRoom(taskId))) s.fire("task:progress", data);
      },
    };
  }

  it("re-subscribes after the delay and then receives the room's events", () => {
    const s = createFakeSocket();
    const server = serverFor(s, 1);
    const received = vi.fn();
    s.on("task:progress", received);
    keepRoomSubscribed(s as never, taskFollow(s as never, "t1"));
    expect(s.emitted("subscribe:task")).toBe(1);
    server.publish("t1", { pct: 10 });
    expect(received).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3_000 + JITTER - 1);
    expect(s.emitted("subscribe:task")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(s.emitted("subscribe:task")).toBe(2);
    server.publish("t1", { pct: 20 });
    expect(received).toHaveBeenCalledWith({ pct: 20 });
    expect(followedRooms(s as never).get(taskRoom("t1"))).toBe(1);
  });

  it("retries until admitted, each refusal naming its own delay", () => {
    const s = createFakeSocket();
    serverFor(s, 3);
    keepRoomSubscribed(s as never, taskFollow(s as never, "t1"));
    vi.advanceTimersByTime(3 * (3_000 + JITTER));
    expect(s.emitted("subscribe:task")).toBe(4);
    vi.advanceTimersByTime(60_000);
    expect(s.emitted("subscribe:task")).toBe(4);
  });

  it("retries only the follower whose room the refusal names", () => {
    const s = createFakeSocket();
    const task = vi.fn();
    const other = vi.fn();
    keepRoomSubscribed(s as never, { room: taskRoom("t1"), subscribe: task, unsubscribe: vi.fn() });
    keepRoomSubscribed(s as never, {
      room: taskRoom("t2"),
      subscribe: other,
      unsubscribe: vi.fn(),
    });
    s.fire("auth:error", rateLimited(taskRoom("t1")));
    s.fire("auth:error", rateLimited(taskRoom("t1"))); // one pending retry, not two
    vi.advanceTimersByTime(3_000 + JITTER);
    expect(task).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("retries a presence room the same way", () => {
    const s = createFakeSocket();
    keepRoomSubscribed(s as never, presenceFollow(s as never, "discussion", "d1"));
    s.fire("auth:error", rateLimited(presenceRoom("discussion", "d1"), 500));
    vi.advanceTimersByTime(500 + JITTER);
    expect(s.emitted("presence:join")).toBe(2);
  });

  it("does not retry after release, and detaches its refusal listener", () => {
    const s = createFakeSocket();
    const subscribe = vi.fn();
    const release = keepRoomSubscribed(s as never, {
      room: taskRoom("t1"),
      subscribe,
      unsubscribe: vi.fn(),
    });
    expect(s.listeners("auth:error")).toBe(1);
    s.fire("auth:error", rateLimited(taskRoom("t1")));
    release();
    expect(s.listeners("auth:error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("leaves the retry to the reconnect, which cancels it", () => {
    const s = createFakeSocket();
    const subscribe = vi.fn();
    keepRoomSubscribed(s as never, { room: taskRoom("t1"), subscribe, unsubscribe: vi.fn() });
    s.fire("auth:error", rateLimited(taskRoom("t1")));
    s.disconnect();
    vi.advanceTimersByTime(3_000 + JITTER);
    expect(subscribe).toHaveBeenCalledTimes(1); // down at the delay: nothing sent
    s.connect();
    expect(subscribe).toHaveBeenCalledTimes(2);
    s.fire("auth:error", rateLimited(taskRoom("t1")));
    s.reconnect(); // re-subscribes now; the pending retry is dropped
    vi.advanceTimersByTime(60_000);
    expect(subscribe).toHaveBeenCalledTimes(3);
  });

  it("does not retry on an authorization refusal, and keeps the room as before", () => {
    const s = createFakeSocket();
    const subscribe = vi.fn();
    keepRoomSubscribed(s as never, { room: taskRoom("t1"), subscribe, unsubscribe: vi.fn() });
    s.fire("auth:error", { message: "FORBIDDEN: no access to task", room: taskRoom("t1") });
    vi.advanceTimersByTime(60_000);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(followedRooms(s as never).get(taskRoom("t1"))).toBe(1);
  });

  it("registers no refusal listener for a subscription without a room", () => {
    const s = createFakeSocket();
    keepSubscribed(s as never, vi.fn());
    onReconnect(s as never, vi.fn());
    expect(s.listeners("auth:error")).toBe(0);
  });
});
