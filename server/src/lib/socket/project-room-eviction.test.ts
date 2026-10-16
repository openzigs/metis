/**
 * #1212 — project-room eviction runs after the workspace or project write has
 * committed, so it is best-effort (logged, never thrown), moves the eviction
 * epoch before it acts, and is relayed to the other replicas when clustered.
 * The room re-judgement itself is driven end to end in
 * `tests/socket-project-room-members-1212.test.ts`; here it is a spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projectFindMany = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({ prisma: { project: { findMany: projectFindMany } } }));
const rejudge = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("./project-rooms.js", () => ({ rejudgeProjectRooms: rejudge }));

import {
  EVICT_PROJECT_ROOM_EVENT,
  REJUDGE_ALL_PROJECT_ROOMS_EVENT,
  REJUDGE_PROJECT_ROOM_EVENT,
  REJUDGE_USER_PROJECT_ROOMS_EVENT,
  evictMemberProjectRooms,
  evictProjectRoom,
  evictWorkspaceProjectRooms,
  wireProjectRoomEvictionRelay,
} from "./project-room-eviction.js";
import { readEpoch } from "./revocation-relay.js";
import { registerSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";

function sock(id: string, userId: string, rooms: string[]) {
  return { id, data: { user: { userId } }, rooms: new Set([id, ...rooms]) };
}

function fakeServer() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sockets = new Map(
    [
      sock("s-alice", "alice", ["project:p1"]),
      sock("s-bob", "bob", ["project:p1", "project:p2"]),
      sock("s-carol", "carol", ["project:p2"]),
    ].map((s) => [s.id, s]),
  );
  const io = {
    socketsLeave: vi.fn(),
    local: { socketsLeave: vi.fn() },
    of: vi.fn(() => ({ sockets })),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => listeners.set(event, fn)),
    serverSideEmit: vi.fn(),
  };
  return { io, server: io as unknown as MetisIOServer, listeners };
}

/** The socket ids `rejudge` was called with, and the room it was limited to. */
const rejudged = () =>
  rejudge.mock.calls.map((c) => {
    const [socket, , opts] = c as unknown as [{ id: string }, unknown, { only?: string }];
    return [socket.id, opts.only ?? "*"];
  });

beforeEach(() => {
  projectFindMany.mockReset();
  projectFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
  rejudge.mockClear();
});
afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

describe("project-room eviction", () => {
  it("empties every project room of a deleted workspace, after moving the epoch", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    let epochAtLeave = -1;
    f.io.socketsLeave.mockImplementation(() => {
      epochAtLeave = readEpoch(f.server, "eviction");
    });
    await evictWorkspaceProjectRooms("ws-1");
    expect(projectFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      select: { id: true },
    });
    expect(f.io.socketsLeave).toHaveBeenCalledWith(["project:p1", "project:p2"]);
    expect(epochAtLeave).toBe(1);
    expect(rejudge).not.toHaveBeenCalled();
  });

  it("re-judges every local socket, fail closed, when the workspace's projects cannot be listed", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    projectFindMany.mockRejectedValue(new Error("db down"));
    await expect(evictWorkspaceProjectRooms("ws-1")).resolves.toBeUndefined();
    expect(f.io.socketsLeave).not.toHaveBeenCalled();
    expect(rejudged()).toEqual([
      ["s-alice", "*"],
      ["s-bob", "*"],
      ["s-carol", "*"],
    ]);
    expect(rejudge.mock.calls[0]![2]).toEqual({ failClosed: true, only: undefined });
    expect(readEpoch(f.server, "eviction")).toBe(1);
  });

  it("does nothing more for a deleted workspace with no projects", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    projectFindMany.mockResolvedValue([]);
    await evictWorkspaceProjectRooms("ws-1");
    expect(f.io.socketsLeave).not.toHaveBeenCalled();
    expect(rejudge).not.toHaveBeenCalled();
  });

  it("does not throw when the adapter fails", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    f.io.socketsLeave.mockImplementation(() => {
      throw new Error("adapter down");
    });
    await expect(evictWorkspaceProjectRooms("ws-1")).resolves.toBeUndefined();
  });

  it("re-judges every project room of only the removed member's sockets, with no project lookup", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    await evictMemberProjectRooms("bob", "ws-1");
    expect(projectFindMany).not.toHaveBeenCalled();
    expect(rejudged()).toEqual([["s-bob", "*"]]);
    expect(rejudge.mock.calls[0]![1]).toEqual({ userId: "bob" });
    expect(readEpoch(f.server, "eviction")).toBe(1);
  });

  it("re-judges only the assigned project's room, after moving the epoch", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    let epochAtRejudge = -1;
    rejudge.mockImplementation(async () => {
      epochAtRejudge = readEpoch(f.server, "eviction");
    });
    await evictProjectRoom("p2");
    expect(rejudged()).toEqual([
      ["s-bob", "project:p2"],
      ["s-carol", "project:p2"],
    ]);
    expect(epochAtRejudge).toBe(1);
  });

  it("is a no-op with no registered server", async () => {
    await evictMemberProjectRooms("u-1", "ws-1");
    await evictWorkspaceProjectRooms("ws-1");
    await evictProjectRoom("p1");
    expect(projectFindMany).not.toHaveBeenCalled();
    expect(rejudge).not.toHaveBeenCalled();
  });
});

describe("project-room eviction relay", () => {
  it("relays each eviction when clustered", async () => {
    const f = fakeServer();
    wireProjectRoomEvictionRelay(f.server, true);
    registerSocketServer(f.server);
    await evictWorkspaceProjectRooms("ws-1");
    await evictMemberProjectRooms("bob", "ws-1");
    await evictProjectRoom("p1");
    projectFindMany.mockRejectedValue(new Error("db down"));
    await evictWorkspaceProjectRooms("ws-2");
    expect(f.io.serverSideEmit.mock.calls).toEqual([
      [EVICT_PROJECT_ROOM_EVENT, "p1"],
      [EVICT_PROJECT_ROOM_EVENT, "p2"],
      [REJUDGE_USER_PROJECT_ROOMS_EVENT, "bob"],
      [REJUDGE_PROJECT_ROOM_EVENT, "p1"],
      [REJUDGE_ALL_PROJECT_ROOMS_EVENT, "workspace-lookup-failed"],
    ]);
  });

  it("applies each relayed eviction to local sockets, after moving this replica's epoch", async () => {
    const f = fakeServer();
    wireProjectRoomEvictionRelay(f.server, true);
    let epochAtLeave = -1;
    f.io.local.socketsLeave.mockImplementation(() => {
      epochAtLeave = readEpoch(f.server, "eviction");
    });
    f.listeners.get(EVICT_PROJECT_ROOM_EVENT)!("p1");
    expect(f.io.local.socketsLeave).toHaveBeenCalledWith("project:p1");
    expect(epochAtLeave).toBe(1);

    f.listeners.get(REJUDGE_PROJECT_ROOM_EVENT)!("p1");
    f.listeners.get(REJUDGE_USER_PROJECT_ROOMS_EVENT)!("carol");
    f.listeners.get(REJUDGE_ALL_PROJECT_ROOMS_EVENT)!("workspace-lookup-failed");
    await vi.waitFor(() => expect(rejudge).toHaveBeenCalledTimes(6));
    expect(rejudged()).toEqual([
      ["s-alice", "project:p1"],
      ["s-bob", "project:p1"],
      ["s-carol", "*"],
      ["s-alice", "*"],
      ["s-bob", "*"],
      ["s-carol", "*"],
    ]);
    expect(readEpoch(f.server, "eviction")).toBe(4);
  });

  it("neither listens nor relays without the cluster adapter", async () => {
    const f = fakeServer();
    wireProjectRoomEvictionRelay(f.server, false);
    registerSocketServer(f.server);
    await evictWorkspaceProjectRooms("ws-1");
    expect(f.io.on).not.toHaveBeenCalled();
    expect(f.io.serverSideEmit).not.toHaveBeenCalled();
  });
});
