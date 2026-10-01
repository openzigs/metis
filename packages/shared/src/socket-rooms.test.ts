/**
 * #672 — the Socket.IO room names the server joins and the UI reference-counts.
 * These strings are wire contract: the server's `subscribe:*` / `presence:join`
 * handlers join exactly these rooms and its emitters address them, so a change
 * here is a protocol change, not a rename.
 */
import { describe, expect, it } from "vitest";
import {
  analysisRoom,
  bgRunRoom,
  connectorRoom,
  isPresenceArtifactType,
  jobRoom,
  PRESENCE_ARTIFACT_TYPES,
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
    ["connector", connectorRoom("c1"), "connector:c1"],
    ["job", jobRoom("j1"), "job:j1"],
    ["bg-run", bgRunRoom("r1"), "run:r1"],
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
      connectorRoom("x"),
      jobRoom("x"),
      bgRunRoom("x"),
      ...PRESENCE_ARTIFACT_TYPES.map((type) => presenceRoom(type, "x")),
    ];
    expect(new Set(rooms).size).toBe(rooms.length);
  });
});

describe("presence artifact types (#676)", () => {
  it("accepts every listed type", () => {
    for (const type of PRESENCE_ARTIFACT_TYPES) expect(isPresenceArtifactType(type)).toBe(true);
  });

  it.each([["requirement"], ["discussion:x"], [""], [42], [null], [undefined]])(
    "rejects %j",
    (value) => {
      expect(isPresenceArtifactType(value)).toBe(false);
    },
  );

  it("no listed type contains the room separator, so a presence room parses one way", () => {
    for (const type of PRESENCE_ARTIFACT_TYPES) expect(type).not.toContain(":");
  });
});
