/**
 * #672 — the Socket.IO room names the server joins and the UI reference-counts.
 * These strings are wire contract: the server's `subscribe:*` / `presence:join`
 * handlers join exactly these rooms and its emitters address them, so a change
 * here is a protocol change, not a rename.
 */
import { describe, expect, it } from "vitest";
import {
  analysisRoom,
  presenceRoom,
  publishRoom,
  sessionRoom,
  taskRoom,
  threadRoom,
} from "./socket-rooms.js";

describe("socket room names (#672)", () => {
  it.each([
    ["thread", threadRoom("t1"), "thread:t1"],
    ["session", sessionRoom("s1"), "session:s1"],
    ["task", taskRoom("k1"), "task:k1"],
    ["analysis", analysisRoom("a1"), "analysis:a1"],
    ["publish", publishRoom("b1"), "publish:b1"],
    ["presence", presenceRoom("discussion", "d1"), "presence:discussion:d1"],
  ])("%s room", (_kind, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it("rooms of different kinds never collide on a shared id", () => {
    const rooms = [
      threadRoom("x"),
      sessionRoom("x"),
      taskRoom("x"),
      analysisRoom("x"),
      publishRoom("x"),
      presenceRoom("x", "x"),
    ];
    expect(new Set(rooms).size).toBe(rooms.length);
  });
});
