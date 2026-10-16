/**
 * #1212 — the edges of the `project:{id}` handlers and re-judgement that the
 * end-to-end scenario (`tests/socket-project-room-members-1212.test.ts`) does
 * not reach: malformed payloads, unsubscribe, a `leave` that throws, a re-check
 * that throws, and a re-judgement limited to one room.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";

const canJoin = vi.hoisted(() => vi.fn());
vi.mock("./room-access.js", () => ({ canJoinProjectRoom: canJoin }));

import {
  PROJECT_ROOM_DENIAL,
  rejudgeProjectRooms,
  wireProjectRoomHandlers,
  type ProjectRoomSocket,
} from "./project-rooms.js";
import { bumpEpoch } from "./revocation-relay.js";
import type { MetisIOServer } from "./server.js";

const USER: AuthPayload = { userId: "u1", username: "u1", role: "developer", permissions: [] };

function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const server = {} as MetisIOServer;
  const socket = {
    id: "s1",
    data: { user: USER },
    rooms: new Set<string>(["s1"]),
    nsp: { server },
    emitted: [] as unknown[],
    on: (event: string, h: (payload: unknown) => unknown) => void handlers.set(event, h),
    emit: (_event: string, payload: unknown) => void socket.emitted.push(payload),
    join: vi.fn(async (room: string) => void socket.rooms.add(room)),
    leave: vi.fn(async (room: string) => void socket.rooms.delete(room)),
  };
  wireProjectRoomHandlers(socket as unknown as ProjectRoomSocket);
  const call = (event: string, payload: unknown) => handlers.get(event)!(payload);
  return { socket, server, call };
}

beforeEach(() => {
  canJoin.mockReset();
});

describe("subscribe:project / unsubscribe:project edges", () => {
  it("ignores a payload with no usable projectId, without running the check", async () => {
    const { socket, call } = fakeSocket();
    for (const payload of [undefined, null, {}, { projectId: "" }, { projectId: 7 }]) {
      await call("subscribe:project", payload);
      await call("unsubscribe:project", payload);
    }
    expect(canJoin).not.toHaveBeenCalled();
    expect(socket.leave).not.toHaveBeenCalled();
  });

  it("unsubscribe leaves the room", async () => {
    const { socket, call } = fakeSocket();
    socket.rooms.add("project:p1");
    await call("unsubscribe:project", { projectId: "p1" });
    expect(socket.rooms.has("project:p1")).toBe(false);
  });

  it("still refuses when leaving the room throws", async () => {
    const { socket, call } = fakeSocket();
    socket.rooms.add("project:p1");
    canJoin.mockResolvedValue(false);
    socket.leave.mockRejectedValueOnce(new Error("adapter down"));
    await call("subscribe:project", { projectId: "p1" });
    expect(socket.emitted).toEqual([{ message: PROJECT_ROOM_DENIAL }]);
  });

  it("leaves when the re-check after a concurrent eviction throws twice (fail closed)", async () => {
    const { socket, server, call } = fakeSocket();
    canJoin
      .mockImplementationOnce(async () => {
        bumpEpoch(server, "eviction");
        return true;
      })
      .mockRejectedValue(new Error("db down"));
    await call("subscribe:project", { projectId: "p1" });
    expect(socket.join).toHaveBeenCalledWith("project:p1");
    expect(socket.rooms.has("project:p1")).toBe(false);
    expect(socket.emitted).toEqual([{ message: PROJECT_ROOM_DENIAL }]);
  });

  it("keeps the join when the re-check after a concurrent eviction still admits", async () => {
    const { socket, server, call } = fakeSocket();
    canJoin
      .mockImplementationOnce(async () => {
        bumpEpoch(server, "eviction");
        return true;
      })
      .mockResolvedValue(true);
    await call("subscribe:project", { projectId: "p1" });
    expect(canJoin).toHaveBeenCalledTimes(2);
    expect(socket.rooms.has("project:p1")).toBe(true);
    expect(socket.emitted).toEqual([]);
  });
});

describe("rejudgeProjectRooms", () => {
  const socketIn = (...rooms: string[]) => ({
    id: "s1",
    rooms: new Set(["s1", "user:u1", ...rooms]),
    leave: vi.fn(async function (this: void, room: string) {
      void room;
    }),
  });

  it("judges only project rooms, audited as a re-judgement, and leaves the refused ones", async () => {
    const s = socketIn("project:p1", "project:p2", "thread:t1");
    canJoin.mockImplementation(async (_u: AuthPayload, projectId: string) => projectId === "p1");
    await rejudgeProjectRooms(s, USER, { failClosed: true });
    expect(canJoin.mock.calls).toEqual([
      [USER, "p1", "socket.project_room.revalidate"],
      [USER, "p2", "socket.project_room.revalidate"],
    ]);
    expect(s.leave.mock.calls).toEqual([["project:p2"]]);
  });

  it("limits itself to `only`", async () => {
    const s = socketIn("project:p1", "project:p2");
    canJoin.mockResolvedValue(false);
    await rejudgeProjectRooms(s, USER, { failClosed: true, only: "project:p2" });
    expect(s.leave.mock.calls).toEqual([["project:p2"]]);
  });

  it("on a lookup error keeps the room when failing open and leaves it when failing closed", async () => {
    const s = socketIn("project:p1");
    canJoin.mockRejectedValue(new Error("db down"));
    await rejudgeProjectRooms(s, USER, { failClosed: false });
    expect(s.leave).not.toHaveBeenCalled();
    await rejudgeProjectRooms(s, USER, { failClosed: true });
    expect(s.leave.mock.calls).toEqual([["project:p1"]]);
  });
});
