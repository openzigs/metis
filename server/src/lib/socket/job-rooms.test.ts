/**
 * #1251 — `rejudgeJobRooms` re-judges a socket's `job:{id}` rooms with the
 * `subscribe:job` rule (`resolveJobRoomScope`, a spy here), and
 * `recheckJobJoinAfterEviction` closes the window in which an eviction ran
 * while a join's check was in flight. The rule itself, against a real
 * database, is driven in `tests/impact-job-room-member-removal-1251.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";

const resolve = vi.hoisted(() => vi.fn());
vi.mock("./room-access.js", () => ({ resolveJobRoomScope: resolve }));

import {
  jobIdsOf,
  jobTouchesProjects,
  recheckJobJoinAfterEviction,
  rejudgeJobRooms,
} from "./job-rooms.js";
import { _resetJobLifecycleMemory, rememberJobScope } from "./job-events.js";
import { bumpEpoch, readEpoch } from "./revocation-relay.js";
import type { MetisIOServer } from "./server.js";

const user = { userId: "bob", role: "coordinator" } as AuthPayload;
const SCOPE = { kind: "impact-analysis", projectId: null };

function socket(rooms: string[]) {
  const server = {} as MetisIOServer;
  const s = {
    id: "s-bob",
    rooms: new Set(["s-bob", "user:bob", "project:p1", ...rooms]),
    leave: vi.fn(async (room: string) => void s.rooms.delete(room)),
    conn: { close: vi.fn() },
    nsp: { server },
  };
  return s;
}

beforeEach(() => {
  resolve.mockReset();
  _resetJobLifecycleMemory();
});

describe("rejudgeJobRooms", () => {
  it("leaves each job room the rule refuses, keeps the rest, and touches no other room", async () => {
    resolve.mockImplementation(async (_u: unknown, jobId: string) =>
      jobId === "j-keep" ? SCOPE : null,
    );
    const s = socket(["job:j-keep", "job:j-gone"]);
    await rejudgeJobRooms(s, user, { failClosed: true });
    expect([...s.rooms].sort()).toEqual(["job:j-keep", "project:p1", "s-bob", "user:bob"]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith(user, "j-gone", { onStoreError: "throw" });
    expect(s.conn.close).not.toHaveBeenCalled();
  });

  it("judges only the jobs `only` accepts", async () => {
    resolve.mockResolvedValue(null);
    const s = socket(["job:j-1", "job:j-2"]);
    await rejudgeJobRooms(s, user, { failClosed: true, only: (id) => id === "j-2" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(s.rooms.has("job:j-1")).toBe(true);
    expect(s.rooms.has("job:j-2")).toBe(false);
  });

  it("keeps a room whose check throws when failing open", async () => {
    resolve.mockRejectedValue(new Error("db down"));
    const s = socket(["job:j-1"]);
    await expect(rejudgeJobRooms(s, user, { failClosed: false })).resolves.toBeUndefined();
    expect(s.rooms.has("job:j-1")).toBe(true);
    expect(s.conn.close).not.toHaveBeenCalled();
  });

  it("leaves the room and closes the transport once when failing closed", async () => {
    resolve.mockRejectedValue(new Error("db down"));
    const s = socket(["job:j-1", "job:j-2"]);
    await rejudgeJobRooms(s, user, { failClosed: true });
    expect(s.rooms.has("job:j-1")).toBe(false);
    expect(s.rooms.has("job:j-2")).toBe(false);
    expect(s.conn.close).toHaveBeenCalledTimes(1);
  });

  it("never rejects when leaving a room fails", async () => {
    resolve.mockResolvedValue(null);
    const s = socket(["job:j-1"]);
    s.leave.mockRejectedValueOnce(new Error("adapter down"));
    await expect(rejudgeJobRooms(s, user, { failClosed: true })).resolves.toBeUndefined();
  });
});

describe("recheckJobJoinAfterEviction", () => {
  it("does nothing when no eviction ran during the join's check", async () => {
    const s = socket(["job:j-1"]);
    await recheckJobJoinAfterEviction(s, user, "j-1", readEpoch(s.nsp.server, "eviction"));
    expect(resolve).not.toHaveBeenCalled();
    expect(s.rooms.has("job:j-1")).toBe(true);
  });

  it("re-judges only the joined room, failing closed, when an eviction ran", async () => {
    const s = socket(["job:j-1", "job:j-other"]);
    const before = readEpoch(s.nsp.server, "eviction");
    bumpEpoch(s.nsp.server, "eviction");
    resolve.mockRejectedValue(new Error("db down"));
    await recheckJobJoinAfterEviction(s, user, "j-1", before);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(s.rooms.has("job:j-1")).toBe(false);
    expect(s.rooms.has("job:j-other")).toBe(true);
    expect(s.conn.close).toHaveBeenCalledTimes(1);
  });
});

describe("job-room helpers", () => {
  it("lists the job ids of a socket's job rooms only", () => {
    expect(jobIdsOf(socket(["job:a", "job:b"]))).toEqual(["a", "b"]);
  });

  it("places a job against a set of projects by its remembered scope", () => {
    rememberJobScope("j-p1", "analysis", "p1");
    rememberJobScope("j-p2", "analysis", "p2");
    rememberJobScope("j-impact", "impact-analysis", null);
    const p1 = new Set(["p1"]);
    expect(jobTouchesProjects("j-p1", p1)).toBe(true);
    expect(jobTouchesProjects("j-p2", p1)).toBe(false);
    expect(jobTouchesProjects("j-impact", p1)).toBe(true);
    expect(jobTouchesProjects("j-unknown", p1)).toBe(true);
  });
});
