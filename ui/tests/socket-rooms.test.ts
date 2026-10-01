/**
 * #672 — each room-follow factory pairs one server room name with the
 * subscribe and unsubscribe events that join and leave exactly that room.
 * `keepRoomSubscribed` counts followers by `room`, so a factory whose room
 * disagreed with its events (or with the server) would leave a room early or
 * never. The room is asserted against the `@metis/shared` factory the server's
 * join handler uses.
 */
import { describe, it, expect } from "vitest";
import {
  analysisRoom,
  presenceRoom,
  publishRoom,
  sessionRoom,
  taskRoom,
  threadRoom,
} from "@metis/shared";
import {
  analysisFollow,
  presenceFollow,
  publishFollow,
  sessionFollow,
  taskFollow,
  threadFollow,
} from "@/lib/socket-rooms";
import { createFakeSocket } from "./helpers/fake-socket";

const s = createFakeSocket();
const cases = [
  [
    "thread",
    threadFollow(s as never, "t1"),
    threadRoom("t1"),
    "subscribe:thread",
    "unsubscribe:thread",
    { threadId: "t1" },
  ],
  [
    "session",
    sessionFollow(s as never, "s1"),
    sessionRoom("s1"),
    "subscribe:session",
    "unsubscribe:session",
    { sessionId: "s1" },
  ],
  [
    "task",
    taskFollow(s as never, "k1"),
    taskRoom("k1"),
    "subscribe:task",
    "unsubscribe:task",
    { taskId: "k1" },
  ],
  [
    "analysis",
    analysisFollow(s as never, "a1"),
    analysisRoom("a1"),
    "subscribe:analysis",
    "unsubscribe:analysis",
    { analysisId: "a1" },
  ],
  [
    "publish",
    publishFollow(s as never, "b1"),
    publishRoom("b1"),
    "subscribe:publish",
    "unsubscribe:publish",
    { batchId: "b1" },
  ],
  [
    "presence",
    presenceFollow(s as never, "discussion", "d1"),
    presenceRoom("discussion", "d1"),
    "presence:join",
    "presence:leave",
    { artifactType: "discussion", artifactId: "d1" },
  ],
] as const;

describe("room-follow factories (#672)", () => {
  it.each(cases)(
    "%s: room, subscribe and unsubscribe agree",
    (_k, follow, room, sub, unsub, payload) => {
      expect(follow.room).toBe(room);
      s.emit.mockClear();
      follow.subscribe();
      expect(s.emit.mock.calls).toEqual([[sub, payload]]);
      s.emit.mockClear();
      follow.unsubscribe();
      expect(s.emit.mock.calls).toEqual([[unsub, payload]]);
    },
  );
});

describe("room-follow factory types (#676)", () => {
  it("accepts only a listed presence artifact type", () => {
    // @ts-expect-error — a free-form type could make two `type:id` rooms collide.
    const follow = presenceFollow(s as never, "requirement", "x");
    expect(follow.room).toBe("presence:requirement:x");
  });
});
