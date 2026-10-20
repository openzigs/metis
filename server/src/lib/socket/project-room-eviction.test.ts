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
const revalidate = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("./server.js", () => ({ REVALIDATE_CONCURRENCY: 2, revalidateLocalSockets: revalidate }));
// #1251 — the job-room re-judgement is a spy too; which jobs it is limited to
// (`jobTouchesProjects`) runs for real against the job-scope memory.
const rejudgeJob = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("./job-rooms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./job-rooms.js")>()),
  rejudgeJobRooms: rejudgeJob,
}));

import {
  REJUDGE_ALL_PROJECT_ROOMS_EVENT,
  REJUDGE_PROJECT_ROOM_EVENT,
  REJUDGE_USER_PROJECT_ROOMS_EVENT,
  evictMemberProjectRooms,
  evictProjectRoom,
  evictWorkspaceProjectRooms,
  wireProjectRoomEvictionRelay,
} from "./project-room-eviction.js";
import { readEpoch } from "./revocation-relay.js";
import { _resetJobLifecycleMemory, rememberJobScope } from "./job-events.js";
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
  rejudgeJob.mockClear();
  revalidate.mockClear();
  _resetJobLifecycleMemory();
});
afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

describe("project-room eviction", () => {
  it("re-judges every room of a deleted workspace's projects in place, after moving the epoch", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    let epochAtRejudge = -1;
    rejudge.mockImplementation(async () => {
      epochAtRejudge = readEpoch(f.server, "eviction");
    });
    await evictWorkspaceProjectRooms("ws-1");
    expect(projectFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1" },
      select: { id: true },
    });
    expect(rejudged()).toEqual([
      ["s-alice", "project:p1"],
      ["s-bob", "project:p1"],
      ["s-bob", "project:p2"],
      ["s-carol", "project:p2"],
    ]);
    expect(epochAtRejudge).toBe(1);
  });

  it("runs the bounded re-validation pass, not a fan-out, when the workspace's projects cannot be listed", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    projectFindMany.mockRejectedValue(new Error("db down"));
    await expect(evictWorkspaceProjectRooms("ws-1")).resolves.toBeUndefined();
    expect(revalidate).toHaveBeenCalledWith(f.server, "listen");
    expect(rejudge).not.toHaveBeenCalled();
    expect(readEpoch(f.server, "eviction")).toBe(1);
  });

  it("re-judges at most REVALIDATE_CONCURRENCY sockets at once", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    let inFlight = 0;
    let most = 0;
    rejudge.mockImplementation(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
    });
    await evictProjectRoom("p2");
    await evictMemberProjectRooms("bob", "ws-1");
    const s = f.io.of().sockets;
    for (let i = 0; i < 6; i++) s.set(`s-x${i}`, sock(`s-x${i}`, `x${i}`, ["project:p9"]));
    await evictProjectRoom("p9");
    expect(rejudge).toHaveBeenCalledTimes(2 + 1 + 6);
    expect(most).toBe(2);
  });

  it("does nothing more for a deleted workspace with no projects", async () => {
    const f = fakeServer();
    registerSocketServer(f.server);
    projectFindMany.mockResolvedValue([]);
    await evictWorkspaceProjectRooms("ws-1");
    expect(rejudge).not.toHaveBeenCalled();
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
      [REJUDGE_PROJECT_ROOM_EVENT, "p1"],
      [REJUDGE_PROJECT_ROOM_EVENT, "p2"],
      [REJUDGE_USER_PROJECT_ROOMS_EVENT, "bob"],
      [REJUDGE_PROJECT_ROOM_EVENT, "p1"],
      [REJUDGE_ALL_PROJECT_ROOMS_EVENT, "workspace-lookup-failed"],
    ]);
  });

  it("applies each relayed eviction to local sockets, after moving this replica's epoch", async () => {
    const f = fakeServer();
    wireProjectRoomEvictionRelay(f.server, true);
    let epochAtRejudge = -1;
    rejudge.mockImplementationOnce(async () => {
      epochAtRejudge = readEpoch(f.server, "eviction");
    });
    f.listeners.get(REJUDGE_PROJECT_ROOM_EVENT)!("p1");
    f.listeners.get(REJUDGE_USER_PROJECT_ROOMS_EVENT)!("carol");
    f.listeners.get(REJUDGE_ALL_PROJECT_ROOMS_EVENT)!("workspace-lookup-failed");
    await vi.waitFor(() => expect(rejudge).toHaveBeenCalledTimes(3));
    expect(rejudged()).toEqual([
      ["s-alice", "project:p1"],
      ["s-bob", "project:p1"],
      ["s-carol", "*"],
    ]);
    expect(revalidate).toHaveBeenCalledWith(f.server, "listen");
    expect(epochAtRejudge).toBe(1);
    expect(readEpoch(f.server, "eviction")).toBe(3);
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

describe("#1251 — job-room eviction", () => {
  /** A server whose `dave` watches three jobs and `erin` one of another project. */
  function withJobWatchers() {
    const f = fakeServer();
    const s = f.io.of().sockets;
    s.set("s-dave", sock("s-dave", "dave", ["job:j-p1", "job:j-p2", "job:j-impact"]));
    s.set("s-erin", sock("s-erin", "erin", ["job:j-p2"]));
    rememberJobScope("j-p1", "analysis", "p1");
    rememberJobScope("j-p2", "analysis", "p2");
    rememberJobScope("j-impact", "impact-analysis", null);
    registerSocketServer(f.server);
    return f;
  }
  /** `[socketId, jobs the call is limited to]` per `rejudgeJobRooms` call. */
  const jobRejudged = (jobs = ["j-p1", "j-p2", "j-impact", "j-unknown"]) =>
    rejudgeJob.mock.calls.map((c) => {
      const [socket, , opts] = c as unknown as [
        { id: string },
        unknown,
        { failClosed: boolean; only?: (jobId: string) => boolean },
      ];
      expect(opts.failClosed).toBe(true);
      return [socket.id, opts.only ? jobs.filter(opts.only) : "*"];
    });

  it("re-judges every job room of the removed member's sockets", async () => {
    withJobWatchers();
    await evictMemberProjectRooms("dave", "ws-1");
    expect(jobRejudged()).toEqual([["s-dave", "*"]]);
    expect(rejudgeJob.mock.calls[0]![1]).toEqual({ userId: "dave" });
  });

  it("re-judges a project's job rooms and every cross-project or unplaced job, not another project's", async () => {
    withJobWatchers();
    await evictProjectRoom("p1");
    expect(jobRejudged()).toEqual([["s-dave", ["j-p1", "j-impact", "j-unknown"]]]);
  });

  it("re-judges a deleted workspace's job rooms in one pass, not once per project", async () => {
    withJobWatchers();
    await evictWorkspaceProjectRooms("ws-1");
    expect(jobRejudged()).toEqual([
      ["s-dave", ["j-p1", "j-p2", "j-impact", "j-unknown"]],
      ["s-erin", ["j-p1", "j-p2", "j-impact", "j-unknown"]],
    ]);
  });

  it("leaves job rooms to the re-validation pass when the workspace's projects cannot be listed", async () => {
    withJobWatchers();
    projectFindMany.mockRejectedValue(new Error("db down"));
    await evictWorkspaceProjectRooms("ws-1");
    expect(rejudgeJob).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("applies relayed project and member evictions to job rooms too", async () => {
    const f = withJobWatchers();
    wireProjectRoomEvictionRelay(f.server, true);
    f.listeners.get(REJUDGE_PROJECT_ROOM_EVENT)!("p2");
    await vi.waitFor(() => expect(rejudgeJob).toHaveBeenCalledTimes(2));
    f.listeners.get(REJUDGE_USER_PROJECT_ROOMS_EVENT)!("erin");
    await vi.waitFor(() => expect(rejudgeJob).toHaveBeenCalledTimes(3));
    expect(jobRejudged()).toEqual([
      ["s-dave", ["j-p2", "j-impact", "j-unknown"]],
      ["s-erin", ["j-p2", "j-impact", "j-unknown"]],
      ["s-erin", "*"],
    ]);
  });
});
