/**
 * #1290 — `rejudgeProjectDataRooms` re-judges a socket's project-data rooms
 * with each room's join rule (spies here), and `recheckJoinAfterEviction`
 * closes the window in which an eviction ran while a join's check was in
 * flight. The rules themselves, against a real database, are driven in
 * `tests/socket-project-data-rooms-1290.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";

const rules = vi.hoisted(() => ({
  analysis: vi.fn(),
  session: vi.fn(),
  connector: vi.fn(),
  run: vi.fn(),
  presence: vi.fn(),
  thread: vi.fn(),
}));
vi.mock("./analysis-room-access.js", () => ({ canJoinAnalysisRoom: rules.analysis }));
vi.mock("./room-access.js", () => ({
  canJoinSessionRoom: rules.session,
  canJoinConnectorRoom: rules.connector,
  canJoinBgRunRoom: rules.run,
  canJoinPresenceRoom: rules.presence,
}));
vi.mock("../discussions/access.js", () => ({ canAccessThread: rules.thread }));

import {
  evictionEpochOf,
  isProjectDataRoom,
  projectDataRoomsOf,
  recheckJoinAfterEviction,
  rejudgeProjectDataRooms,
} from "./project-data-rooms.js";
import { _resetRoomProjects, onRoomEvicted, roomTouchesProjects } from "./room-scope.js";
import { bumpEpoch } from "./revocation-relay.js";
import type { MetisIOServer } from "./server.js";

const user = { userId: "bob", role: "coordinator" } as AuthPayload;

function socket(rooms: string[]) {
  const server = {} as MetisIOServer;
  const s = {
    id: "s-bob",
    rooms: new Set(["s-bob", "user:bob", "project:p1", "job:j1", "mcp:status", ...rooms]),
    leave: vi.fn(async (room: string) => void s.rooms.delete(room)),
    conn: { close: vi.fn() },
    nsp: { server },
  };
  return s;
}

const ALL = [
  "analysis:a1",
  "session:s1",
  "connector:c1",
  "run:r1",
  "thread:t1",
  "presence:discussion:t1",
  "presence:spec-kit-artifact:p1:spec.md",
];

beforeEach(() => {
  for (const rule of Object.values(rules)) rule.mockReset();
  _resetRoomProjects();
});

describe("project-data room names", () => {
  it("recognises every project-data kind and no other room", () => {
    for (const room of ALL) expect(isProjectDataRoom(room), room).toBe(true);
    for (const room of ["project:p1", "job:j1", "user:u", "mcp:status", "task:t", "publish:b"]) {
      expect(isProjectDataRoom(room), room).toBe(false);
    }
    // A bare prefix names no resource.
    expect(isProjectDataRoom("analysis:")).toBe(false);
    expect(projectDataRoomsOf(socket(["analysis:a1"]))).toEqual(["analysis:a1"]);
  });
});

describe("rejudgeProjectDataRooms", () => {
  it("judges each room with its own join rule, leaves those refused, and touches no other room", async () => {
    rules.analysis.mockResolvedValue(false);
    rules.session.mockResolvedValue(true);
    rules.connector.mockResolvedValue(false);
    rules.run.mockResolvedValue(true);
    rules.thread.mockResolvedValue({ ok: false, reason: "forbidden" });
    rules.presence.mockImplementation(async (_u: unknown, type: string) => type === "discussion");
    const s = socket(ALL);
    await rejudgeProjectDataRooms(s, user, { failClosed: true });

    expect(rules.analysis).toHaveBeenCalledWith(user, "a1");
    expect(rules.session).toHaveBeenCalledWith(user, "s1");
    expect(rules.connector).toHaveBeenCalledWith(user, "c1");
    expect(rules.run).toHaveBeenCalledWith(user, "r1");
    expect(rules.thread).toHaveBeenCalledWith({ id: "bob", role: "coordinator" }, "t1");
    expect(rules.presence).toHaveBeenCalledWith(user, "discussion", "t1");
    expect(rules.presence).toHaveBeenCalledWith(user, "spec-kit-artifact", "p1:spec.md");
    expect([...s.rooms].sort()).toEqual(
      [
        "s-bob",
        "user:bob",
        "project:p1",
        "job:j1",
        "mcp:status",
        "session:s1",
        "run:r1",
        "presence:discussion:t1",
      ].sort(),
    );
    expect(s.conn.close).not.toHaveBeenCalled();
  });

  it("records a thread's project when its rule admits", async () => {
    rules.thread.mockResolvedValue({ ok: true, projectId: "p9" });
    await rejudgeProjectDataRooms(socket(["thread:t1"]), user, { failClosed: true });
    expect(roomTouchesProjects("thread:t1", new Set(["p9"]))).toBe(true);
    expect(roomTouchesProjects("thread:t1", new Set(["p1"]))).toBe(false);
  });

  it("refuses a presence room of an unknown artifact type without a lookup", async () => {
    const s = socket(["presence:unknown:x", "presence:nocolon"]);
    await rejudgeProjectDataRooms(s, user, { failClosed: true });
    expect(rules.presence).not.toHaveBeenCalled();
    expect(s.rooms.has("presence:unknown:x")).toBe(false);
    expect(s.rooms.has("presence:nocolon")).toBe(false);
  });

  it("judges only the rooms `only` accepts", async () => {
    rules.analysis.mockResolvedValue(false);
    const s = socket(["analysis:a1", "analysis:a2"]);
    await rejudgeProjectDataRooms(s, user, { failClosed: true, only: (r) => r === "analysis:a2" });
    expect(rules.analysis).toHaveBeenCalledTimes(1);
    expect(s.rooms.has("analysis:a1")).toBe(true);
    expect(s.rooms.has("analysis:a2")).toBe(false);
  });

  it("keeps a room whose check throws when failing open", async () => {
    rules.run.mockRejectedValue(new Error("db down"));
    const s = socket(["run:r1"]);
    await expect(rejudgeProjectDataRooms(s, user, { failClosed: false })).resolves.toBeUndefined();
    expect(s.rooms.has("run:r1")).toBe(true);
    expect(s.conn.close).not.toHaveBeenCalled();
  });

  it("leaves the rooms and closes the transport once when failing closed", async () => {
    rules.run.mockRejectedValue(new Error("db down"));
    rules.connector.mockRejectedValue(new Error("db down"));
    const s = socket(["run:r1", "connector:c1"]);
    await rejudgeProjectDataRooms(s, user, { failClosed: true });
    expect(s.rooms.has("run:r1")).toBe(false);
    expect(s.rooms.has("connector:c1")).toBe(false);
    expect(s.conn.close).toHaveBeenCalledTimes(1);
  });

  it("tells the socket's eviction listeners, and never rejects when leaving or a listener fails", async () => {
    rules.analysis.mockResolvedValue(false);
    rules.session.mockResolvedValue(true);
    const s = socket(["analysis:a1", "session:s1"]);
    s.leave.mockRejectedValueOnce(new Error("adapter down"));
    const evicted: string[] = [];
    onRoomEvicted(s, () => {
      throw new Error("listener bug");
    });
    onRoomEvicted(s, (room) => evicted.push(room));
    await expect(rejudgeProjectDataRooms(s, user, { failClosed: true })).resolves.toBeUndefined();
    expect(evicted).toEqual(["analysis:a1"]);
  });
});

describe("recheckJoinAfterEviction", () => {
  it("does nothing when no eviction ran during the join's check", async () => {
    const s = socket(["analysis:a1"]);
    await recheckJoinAfterEviction(s, user, "analysis:a1", evictionEpochOf(s));
    expect(rules.analysis).not.toHaveBeenCalled();
    expect(s.rooms.has("analysis:a1")).toBe(true);
  });

  it("re-judges only the joined room, failing closed, when an eviction ran", async () => {
    const s = socket(["analysis:a1", "analysis:other"]);
    const before = evictionEpochOf(s);
    bumpEpoch(s.nsp.server, "eviction");
    rules.analysis.mockRejectedValue(new Error("db down"));
    await recheckJoinAfterEviction(s, user, "analysis:a1", before);
    expect(rules.analysis).toHaveBeenCalledTimes(1);
    expect(s.rooms.has("analysis:a1")).toBe(false);
    expect(s.rooms.has("analysis:other")).toBe(true);
    expect(s.conn.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a joined room the rule still admits after an eviction ran", async () => {
    const s = socket(["thread:t1"]);
    const before = evictionEpochOf(s);
    bumpEpoch(s.nsp.server, "eviction");
    rules.thread.mockResolvedValue({ ok: true, projectId: "p1" });
    await recheckJoinAfterEviction(s, user, "thread:t1", before);
    expect(s.rooms.has("thread:t1")).toBe(true);
    expect(s.conn.close).not.toHaveBeenCalled();
  });
});
