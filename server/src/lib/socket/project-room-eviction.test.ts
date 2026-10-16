/**
 * #1212 — project-room eviction runs after the workspace write has committed,
 * so it is best-effort (logged, never thrown), moves the eviction epoch before
 * it acts, and is relayed to the other replicas when clustered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projectFindMany = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({ prisma: { project: { findMany: projectFindMany } } }));

import {
  EVICT_PROJECT_MEMBER_EVENT,
  EVICT_PROJECT_ROOM_EVENT,
  evictMemberProjectRooms,
  evictWorkspaceProjectRooms,
  wireProjectRoomEvictionRelay,
} from "./project-room-eviction.js";
import { readEpoch } from "./revocation-relay.js";
import { registerSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";

function fakeServer() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const leave = vi.fn();
  const inLeave = vi.fn();
  const localLeave = vi.fn();
  const localInLeave = vi.fn();
  const io = {
    socketsLeave: leave,
    in: vi.fn(() => ({ socketsLeave: inLeave })),
    local: { socketsLeave: localLeave, in: vi.fn(() => ({ socketsLeave: localInLeave })) },
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => listeners.set(event, fn)),
    serverSideEmit: vi.fn(),
  };
  return {
    io,
    server: io as unknown as MetisIOServer,
    listeners,
    leave,
    inLeave,
    localLeave,
    localInLeave,
  };
}

beforeEach(() => {
  projectFindMany.mockReset();
  projectFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
});
afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

describe("project-room eviction", () => {
  it("empties every project room of a deleted workspace, after moving the epoch", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    let epochAtLeave = -1;
    f.leave.mockImplementation(() => {
      epochAtLeave = readEpoch(f.server, "eviction");
    });
    await evictWorkspaceProjectRooms("ws-1");
    expect(projectFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      select: { id: true },
    });
    expect(f.leave).toHaveBeenCalledWith(["project:p1", "project:p2"]);
    expect(epochAtLeave).toBe(1);
  });

  it("takes only the removed member's sockets out of the workspace's project rooms", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    await evictMemberProjectRooms("u-1", "ws-1");
    expect(f.io.in).toHaveBeenCalledWith("user:u-1");
    expect(f.inLeave).toHaveBeenCalledWith(["project:p1", "project:p2"]);
    expect(f.leave).not.toHaveBeenCalled();
    expect(readEpoch(f.server, "eviction")).toBe(1);
  });

  it("does nothing for a workspace with no projects", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    projectFindMany.mockResolvedValue([]);
    await evictMemberProjectRooms("u-1", "ws-1");
    await evictWorkspaceProjectRooms("ws-1");
    expect(f.inLeave).not.toHaveBeenCalled();
    expect(f.leave).not.toHaveBeenCalled();
  });

  it("does not throw when the project lookup fails", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    projectFindMany.mockRejectedValue(new Error("db down"));
    await expect(evictMemberProjectRooms("u-1", "ws-1")).resolves.toBeUndefined();
    await expect(evictWorkspaceProjectRooms("ws-1")).resolves.toBeUndefined();
    expect(f.inLeave).not.toHaveBeenCalled();
  });

  it("does not throw when the adapter fails", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    f.leave.mockImplementation(() => {
      throw new Error("adapter down");
    });
    f.inLeave.mockImplementation(() => {
      throw new Error("adapter down");
    });
    await expect(evictWorkspaceProjectRooms("ws-1")).resolves.toBeUndefined();
    await expect(evictMemberProjectRooms("u-1", "ws-1")).resolves.toBeUndefined();
  });

  it("is a no-op with no registered server", async () => {
    await evictMemberProjectRooms("u-1", "ws-1");
    await evictWorkspaceProjectRooms("ws-1");
    expect(projectFindMany).not.toHaveBeenCalled();
  });
});

describe("project-room eviction relay", () => {
  it("relays each project room's eviction when clustered", async () => {
    const f = fakeServer();
    wireProjectRoomEvictionRelay(f.server, true);
    registerSocketServer(f.server);
    await evictWorkspaceProjectRooms("ws-1");
    await evictMemberProjectRooms("u-1", "ws-1");
    expect(f.io.serverSideEmit.mock.calls).toEqual([
      [EVICT_PROJECT_ROOM_EVENT, "p1"],
      [EVICT_PROJECT_ROOM_EVENT, "p2"],
      [EVICT_PROJECT_MEMBER_EVENT, "u-1", "p1"],
      [EVICT_PROJECT_MEMBER_EVENT, "u-1", "p2"],
    ]);
  });

  it("applies a relayed eviction to local sockets, after moving this replica's epoch", () => {
    const f = fakeServer();
    wireProjectRoomEvictionRelay(f.server, true);
    let epochAtLeave = -1;
    f.localLeave.mockImplementation(() => {
      epochAtLeave = readEpoch(f.server, "eviction");
    });
    f.listeners.get(EVICT_PROJECT_ROOM_EVENT)!("p1");
    expect(f.localLeave).toHaveBeenCalledWith("project:p1");
    expect(epochAtLeave).toBe(1);

    f.listeners.get(EVICT_PROJECT_MEMBER_EVENT)!("u-1", "p2");
    expect(f.io.local.in).toHaveBeenCalledWith("user:u-1");
    expect(f.localInLeave).toHaveBeenCalledWith("project:p2");
    expect(readEpoch(f.server, "eviction")).toBe(2);
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
