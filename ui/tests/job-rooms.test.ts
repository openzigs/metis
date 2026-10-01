/**
 * #430 — `job:{id}` room membership is reference-counted on the client, so one
 * follower leaving does not cut off another follower of the same job.
 */
import { describe, it, expect, vi } from "vitest";
import { bgRunRoom, connectorRoom, jobRoom } from "@metis/shared";
import { joinJobRoom } from "@/lib/job-rooms";

const fakeSocket = (connected = true) => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    connected,
    emit: vi.fn(),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    }),
    off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(fn);
    }),
    listeners: (event: string) => handlers.get(event)?.size ?? 0,
    fire: (event: string, ...args: unknown[]) => {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(...args);
    },
    /** The transport dropped and came back: the server lost every room. */
    reconnect: () => {
      socket.connected = false;
      socket.connected = true;
      socket.fire("connect");
    },
  };
  return socket;
};
type Fake = ReturnType<typeof fakeSocket>;
const join = (s: Fake, jobId: string) => joinJobRoom(s as never, jobId);
const subscribes = (s: Fake, jobId?: string) =>
  s.emit.mock.calls.filter(
    ([e, p]) => e === "subscribe:job" && (!jobId || (p as { jobId: string }).jobId === jobId),
  ).length;

describe("joinJobRoom", () => {
  it("subscribes on every join so each follower gets the replay", () => {
    const s = fakeSocket();
    join(s, "j1");
    join(s, "j1");
    expect(s.emit).toHaveBeenCalledTimes(2);
    expect(s.emit).toHaveBeenNthCalledWith(2, "subscribe:job", { jobId: "j1" });
  });

  it("leaves the room only when the last follower releases", () => {
    const s = fakeSocket();
    const a = join(s, "j1");
    const b = join(s, "j1");
    a();
    expect(s.emit).not.toHaveBeenCalledWith("unsubscribe:job", expect.anything());
    b();
    expect(s.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "j1" });
  });

  it("counts a double release once", () => {
    const s = fakeSocket();
    const a = join(s, "j1");
    join(s, "j1");
    a();
    a();
    expect(s.emit).not.toHaveBeenCalledWith("unsubscribe:job", expect.anything());
  });

  it("counts each job and each socket separately", () => {
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    join(s1, "j1");
    const other = join(s1, "j2");
    const elsewhere = join(s2, "j1");
    other();
    elsewhere();
    expect(s1.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "j2" });
    expect(s1.emit).not.toHaveBeenCalledWith("unsubscribe:job", { jobId: "j1" });
    expect(s2.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "j1" });
  });

  it("subscribes afresh after the room was fully released", () => {
    const s = fakeSocket();
    join(s, "j1")();
    const again = join(s, "j1");
    again();
    expect(s.emit.mock.calls.filter(([e]) => e === "unsubscribe:job")).toHaveLength(2);
  });
});

// #486 — a reconnect drops the socket's rooms on the server. `job-rooms.ts`
// re-joins them itself, once per room, instead of once per following hook.
describe("joinJobRoom across a reconnect", () => {
  it("owns one connect listener per socket, however many rooms and followers", () => {
    const s = fakeSocket();
    join(s, "j1");
    join(s, "j1");
    join(s, "j2");
    expect(s.listeners("connect")).toBe(1);
  });

  it("re-joins a room with two followers exactly once", () => {
    const s = fakeSocket();
    join(s, "j1");
    join(s, "j1");
    s.emit.mockClear();
    s.reconnect();
    expect(subscribes(s, "j1")).toBe(1);
    s.reconnect();
    expect(subscribes(s, "j1")).toBe(2);
  });

  it("re-joins every room that still has followers, and none that was released", () => {
    const s = fakeSocket();
    join(s, "j1");
    const leave2 = join(s, "j2");
    join(s, "j3");
    leave2();
    s.emit.mockClear();
    s.reconnect();
    expect(subscribes(s, "j1")).toBe(1);
    expect(subscribes(s, "j2")).toBe(0);
    expect(subscribes(s, "j3")).toBe(1);
  });

  it("sends no extra subscribe on the first connect", () => {
    // Emits made before the first connect are buffered by socket.io-client and
    // reach the server on it.
    const s = fakeSocket(false);
    join(s, "j1");
    join(s, "j1");
    s.connected = true;
    s.fire("connect");
    expect(subscribes(s)).toBe(2);
  });

  it("does not re-join a room whose subscribe is still buffered from the outage", () => {
    const s = fakeSocket();
    join(s, "j1");
    s.connected = false;
    join(s, "j2"); // buffered; flushed on the coming connect
    s.emit.mockClear();
    s.connected = true;
    s.fire("connect");
    expect(subscribes(s, "j1")).toBe(1);
    expect(subscribes(s, "j2")).toBe(0);
    // The buffer is flushed now, so the next reconnect re-joins both.
    s.reconnect();
    expect(subscribes(s, "j1")).toBe(2);
    expect(subscribes(s, "j2")).toBe(1);
  });

  it("drops the connect listener when the last room is released", () => {
    const s = fakeSocket();
    const a = join(s, "j1");
    const b = join(s, "j2");
    a();
    expect(s.listeners("connect")).toBe(1);
    b();
    expect(s.listeners("connect")).toBe(0);
    s.emit.mockClear();
    s.reconnect();
    expect(subscribes(s)).toBe(0);
    // A fresh join installs the listener again.
    join(s, "j1");
    expect(s.listeners("connect")).toBe(1);
  });

  it("keeps each socket's rooms to that socket", () => {
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    join(s1, "j1");
    join(s2, "j2");
    s1.emit.mockClear();
    s2.emit.mockClear();
    s1.reconnect();
    expect(subscribes(s1, "j1")).toBe(1);
    expect(subscribes(s1, "j2")).toBe(0);
    expect(subscribes(s2)).toBe(0);
  });
});

// #655 — the server refuses a join it cannot scope with an `auth:error` that
// names the room. A refused job room is dropped, so it is not re-subscribed.
describe("joinJobRoom after the server refuses a room", () => {
  const refuse = (s: Fake, room: string) =>
    s.fire("auth:error", { message: "FORBIDDEN: no access to job", room });

  it("stops re-subscribing a refused room and keeps the others", () => {
    const s = fakeSocket();
    join(s, "j1");
    join(s, "j1");
    join(s, "j2");
    s.reconnect();
    refuse(s, jobRoom("j1"));
    s.emit.mockClear();
    s.reconnect();
    expect(subscribes(s, "j1")).toBe(0);
    expect(subscribes(s, "j2")).toBe(1);
  });

  it("forgets a refused room whose subscribe is still buffered", () => {
    const s = fakeSocket();
    join(s, "j2");
    s.connected = false;
    join(s, "j1");
    refuse(s, jobRoom("j1"));
    s.emit.mockClear();
    s.connected = true;
    s.fire("connect");
    s.reconnect();
    expect(subscribes(s, "j1")).toBe(0);
    expect(subscribes(s, "j2")).toBe(2);
  });

  it("ignores a refusal of a room it does not follow, of another kind, or with no room", () => {
    const s = fakeSocket();
    join(s, "j1");
    refuse(s, jobRoom("other"));
    refuse(s, connectorRoom("j1"));
    refuse(s, bgRunRoom("j1"));
    s.fire("auth:error", { message: "UNAUTHORIZED" });
    s.fire("auth:error", undefined);
    s.emit.mockClear();
    s.reconnect();
    expect(subscribes(s, "j1")).toBe(1);
  });

  it("makes the refused room's releases no-ops, even after it is followed afresh", () => {
    const s = fakeSocket();
    const stale = join(s, "j1");
    refuse(s, jobRoom("j1"));
    const fresh = join(s, "j1");
    stale();
    expect(s.emit).not.toHaveBeenCalledWith("unsubscribe:job", expect.anything());
    s.emit.mockClear();
    s.reconnect();
    expect(subscribes(s, "j1")).toBe(1);
    fresh();
    expect(s.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "j1" });
  });

  it("drops its listeners when the last followed room is refused", () => {
    const s = fakeSocket();
    join(s, "j1");
    expect(s.listeners("auth:error")).toBe(1);
    refuse(s, jobRoom("j1"));
    expect(s.listeners("connect")).toBe(0);
    expect(s.listeners("auth:error")).toBe(0);
  });
});
