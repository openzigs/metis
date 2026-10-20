/**
 * #1290 — the room → project record that limits a project eviction to that
 * project's rooms, and the per-socket eviction listeners.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_REMEMBERED_ROOMS,
  _resetRoomProjects,
  onRoomEvicted,
  rememberRoomProject,
  roomEvicted,
  roomTouchesProjects,
} from "./room-scope.js";

beforeEach(() => _resetRoomProjects());

describe("roomTouchesProjects", () => {
  const p1 = new Set(["p1"]);

  it("places a recorded room by its project", () => {
    rememberRoomProject("analysis:a1", "p1");
    rememberRoomProject("analysis:a2", "p2");
    expect(roomTouchesProjects("analysis:a1", p1)).toBe(true);
    expect(roomTouchesProjects("analysis:a2", p1)).toBe(false);
  });

  it("judges a room it holds no record for, and never one recorded as project-less", () => {
    rememberRoomProject("session:s-free", null);
    expect(roomTouchesProjects("analysis:unknown", p1)).toBe(true);
    expect(roomTouchesProjects("session:s-free", p1)).toBe(false);
  });

  it("keeps at most MAX_REMEMBERED_ROOMS records, dropping the oldest first", () => {
    rememberRoomProject("room:first", "p2");
    rememberRoomProject("room:second", "p2");
    for (let i = 0; i < MAX_REMEMBERED_ROOMS - 2; i++) rememberRoomProject(`room:${i}`, "p2");
    // Re-recording moves a room to the newest end.
    rememberRoomProject("room:first", "p2");
    rememberRoomProject("room:overflow", "p2");
    // `room:second` was the oldest and is forgotten: it is judged again.
    expect(roomTouchesProjects("room:second", p1)).toBe(true);
    expect(roomTouchesProjects("room:first", p1)).toBe(false);
    expect(roomTouchesProjects("room:overflow", p1)).toBe(false);
  });
});

describe("eviction listeners", () => {
  it("calls every listener of that socket only, past one that throws", () => {
    const a = {};
    const b = {};
    const heard: string[] = [];
    onRoomEvicted(a, () => {
      throw new Error("bug");
    });
    onRoomEvicted(a, (room) => heard.push(`a:${room}`));
    onRoomEvicted(b, (room) => heard.push(`b:${room}`));
    roomEvicted(a, "thread:t1");
    roomEvicted({}, "thread:t2");
    expect(heard).toEqual(["a:thread:t1"]);
  });
});
