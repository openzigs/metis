/**
 * #649 — `revalidateLocalSockets`: what a replica does to the sockets it holds
 * once its cluster adapter's `LISTEN` connection is back. One real Socket.IO
 * server and real clients; the live-user and membership reads are stubbed so
 * each outcome — and each failure — can be chosen. The cross-replica scenario
 * is `socket-cluster-reconnect-649.test.ts`.
 */
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { AuthPayload } from "@metis/shared";

const live = vi.hoisted(() => ({
  users: new Map<string, AuthPayload | Error | null>(),
  workspaces: new Map<string, string[] | Error>(),
  inFlight: 0,
  maxInFlight: 0,
  /** While set, every live-user read waits on it — a slow pass. */
  userGate: undefined as Promise<void> | undefined,
  /**
   * While set, the NEXT membership read takes its answer at once and then
   * waits on it before returning — a stale read held open. Cleared by that read.
   */
  membershipGate: undefined as Promise<void> | undefined,
}));
vi.mock("../src/lib/auth/live-auth-payload.js", () => ({
  loadLiveAuthPayload: vi.fn(async (userId: string) => {
    live.inFlight++;
    live.maxInFlight = Math.max(live.maxInFlight, live.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    if (live.userGate) await live.userGate;
    live.inFlight--;
    const user = live.users.get(userId);
    if (user instanceof Error) throw user;
    return user ?? null;
  }),
}));
vi.mock("../src/lib/auth/live-workspace-ids.js", () => ({
  readLiveWorkspaceIds: vi.fn(async (userId: string) => {
    const ids = live.workspaces.get(userId) ?? [];
    const gate = live.membershipGate;
    live.membershipGate = undefined;
    if (gate) await gate;
    if (ids instanceof Error) throw ids;
    return ids;
  }),
}));

import { loadLiveAuthPayload } from "../src/lib/auth/live-auth-payload.js";
import { readLiveWorkspaceIds } from "../src/lib/auth/live-workspace-ids.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import {
  REVALIDATE_CONCURRENCY,
  createSocketServer,
  revalidateLocalSockets,
  type MetisIOServer,
} from "../src/lib/socket/server.js";
import { readEpoch } from "../src/lib/socket/revocation-relay.js";
import { logger } from "../src/lib/logger.js";
import { mcpStatusWorkspaceRoom } from "../src/lib/mcp/status-rooms.js";

const payload = (userId: string, role = "coordinator"): AuthPayload => ({
  userId,
  username: userId,
  role,
  permissions: [],
  workspaces: [],
});

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;
let listeners: Array<() => void>;
const open: ClientSocket[] = [];

beforeEach(async () => {
  live.users.clear();
  live.workspaces.clear();
  live.maxInFlight = 0;
  live.userGate = undefined;
  live.membershipGate = undefined;
  listeners = [];
  httpServer = http.createServer();
  io = createSocketServer(httpServer, { onAdapterListening: (l) => listeners.push(l) });
  port = await new Promise<number>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () =>
      resolve((httpServer.address() as { port: number }).port),
    ),
  );
});

afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  await io.close();
  vi.mocked(loadLiveAuthPayload).mockClear();
  vi.mocked(readLiveWorkspaceIds).mockClear();
});

interface Conn {
  socket: ClientSocket;
  sid: string;
  reason: string | null;
}

/** Connect `userId` (live, with `workspaces`) and subscribe to MCP status. */
async function connect(userId: string, workspaces: string[] = []): Promise<Conn> {
  live.users.set(userId, payload(userId));
  live.workspaces.set(userId, workspaces);
  const { accessToken } = issueTokens(payload(userId));
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: accessToken },
    transports: ["websocket"],
    reconnection: false,
  });
  open.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("auth:ok", () => resolve());
    socket.once("connect_error", reject);
  });
  const conn: Conn = { socket, sid: socket.id!, reason: null };
  socket.on("disconnect", (reason) => (conn.reason = reason));
  socket.emit("subscribe:mcp");
  // The subscribe's own membership read has finished once it has joined.
  await vi.waitFor(() =>
    expect(io.sockets.adapter.rooms.get("mcp:status")?.has(conn.sid)).toBe(true),
  );
  for (const ws of workspaces) {
    await vi.waitFor(() =>
      expect(io.sockets.adapter.rooms.get(mcpStatusWorkspaceRoom(ws))?.has(conn.sid)).toBe(true),
    );
  }
  return conn;
}

const inRoom = (ws: string, c: Conn) =>
  io.sockets.adapter.rooms.get(mcpStatusWorkspaceRoom(ws))?.has(c.sid) ?? false;

describe("#649 revalidateLocalSockets", () => {
  it("disconnects a user no longer live and leaves a live one connected", async () => {
    const gone = await connect("u-gone");
    const kept = await connect("u-kept");
    live.users.set("u-gone", null);

    await revalidateLocalSockets(io);

    await vi.waitFor(() => expect(gone.reason).toBe("io server disconnect"));
    expect(kept.socket.connected).toBe(true);
  });

  it("closes the transport of a socket whose role changed", async () => {
    const demoted = await connect("u-role");
    live.users.set("u-role", payload("u-role", "viewer"));

    await revalidateLocalSockets(io);

    await vi.waitFor(() => expect(demoted.reason).toBe("transport close"));
  });

  it("closes the transport when the live-user lookup fails", async () => {
    const c = await connect("u-blip");
    live.users.set("u-blip", new Error("db down"));

    await revalidateLocalSockets(io);

    await vi.waitFor(() => expect(c.reason).toBe("transport close"));
  });

  it("takes a socket out of a workspace room it lost, keeping the ones it still has", async () => {
    const c = await connect("u-ws", ["ws-lost", "ws-kept"]);
    live.workspaces.set("u-ws", ["ws-kept"]);

    await revalidateLocalSockets(io);

    expect(inRoom("ws-lost", c)).toBe(false);
    expect(inRoom("ws-kept", c)).toBe(true);
    expect(c.socket.connected).toBe(true);
  });

  it("closes the transport of a socket in a workspace room when the membership lookup fails", async () => {
    const c = await connect("u-ws-blip", ["ws-1"]);
    const noRooms = await connect("u-no-ws");
    live.workspaces.set("u-ws-blip", new Error("db down"));
    live.workspaces.set("u-no-ws", new Error("db down"));
    vi.mocked(readLiveWorkspaceIds).mockClear();

    await revalidateLocalSockets(io);

    await vi.waitFor(() => expect(c.reason).toBe("transport close"));
    // No workspace room to lose: its memberships are never read.
    expect(noRooms.socket.connected).toBe(true);
    expect(readLiveWorkspaceIds).not.toHaveBeenCalledWith("u-no-ws");
  });

  it("reads each user once, a bounded number at a time", async () => {
    const users = Array.from({ length: REVALIDATE_CONCURRENCY * 3 }, (_, i) => `u-${i}`);
    for (const u of users) await connect(u);
    await connect("u-0");
    vi.mocked(loadLiveAuthPayload).mockClear();
    live.maxInFlight = 0;

    await revalidateLocalSockets(io);

    expect(loadLiveAuthPayload).toHaveBeenCalledTimes(users.length);
    expect(live.maxInFlight).toBe(REVALIDATE_CONCURRENCY);
  });

  it("moves both #613 epochs, so an in-flight handshake or subscribe re-reads", async () => {
    const before = [readEpoch(io, "revocation"), readEpoch(io, "eviction")];

    await revalidateLocalSockets(io);

    expect(readEpoch(io, "revocation")).toBe(before[0] + 1);
    expect(readEpoch(io, "eviction")).toBe(before[1] + 1);
    expect(loadLiveAuthPayload).not.toHaveBeenCalled();
  });

  it("runs on every signal from the adapter's onListening", async () => {
    const gone = await connect("u-hook");
    live.users.set("u-hook", null);
    expect(listeners).toHaveLength(1);

    listeners[0]();

    await vi.waitFor(() => expect(gone.reason).toBe("io server disconnect"));
  });

  it("coalesces signals during a running pass into one more pass, never exceeding the read bound", async () => {
    // A flapping LISTEN connection fires the hook again while a slow pass runs.
    // Each pass bumps the revocation epoch once, so the epoch counts passes.
    const users = Array.from({ length: REVALIDATE_CONCURRENCY * 3 }, (_, i) => `u-flap-${i}`);
    for (const u of users) await connect(u);
    vi.mocked(loadLiveAuthPayload).mockClear();
    live.maxInFlight = 0;
    let unblock!: () => void;
    live.userGate = new Promise<void>((r) => (unblock = r));
    const epoch = readEpoch(io, "revocation");

    listeners[0]();
    await vi.waitFor(() => expect(loadLiveAuthPayload).toHaveBeenCalled());
    listeners[0]();
    listeners[0]();
    listeners[0]();
    await new Promise((r) => setTimeout(r, 20));
    expect(live.maxInFlight).toBeLessThanOrEqual(REVALIDATE_CONCURRENCY);
    unblock();
    live.userGate = undefined;

    // Exactly one trailing pass, which re-reads every user once.
    await vi.waitFor(() => expect(loadLiveAuthPayload).toHaveBeenCalledTimes(users.length * 2));
    await new Promise((r) => setTimeout(r, 50));
    expect(readEpoch(io, "revocation") - epoch).toBe(2);
    expect(loadLiveAuthPayload).toHaveBeenCalledTimes(users.length * 2);
    expect(live.maxInFlight).toBeLessThanOrEqual(REVALIDATE_CONCURRENCY);
  });

  it("joins the call in flight, and runs afresh once it has settled", async () => {
    const first = revalidateLocalSockets(io);
    const joined = revalidateLocalSockets(io);
    expect(joined).toBe(first);
    await first;
    const epoch = readEpoch(io, "revocation");
    await revalidateLocalSockets(io);
    expect(readEpoch(io, "revocation")).toBe(epoch + 1);
  });

  it("keeps a workspace room a subscribe joined while the membership read was in flight", async () => {
    // The pass's membership read predates the grant of ws-new; the subscribe
    // that joins ws-new finishes before it returns. ws-new was never in the
    // room set that read was judging, so it must not be left.
    const c = await connect("u-race", ["ws-old"]);
    let release!: () => void;
    live.membershipGate = new Promise<void>((r) => (release = r));
    vi.mocked(readLiveWorkspaceIds).mockClear();

    const pass = revalidateLocalSockets(io);
    await vi.waitFor(() => expect(readLiveWorkspaceIds).toHaveBeenCalledWith("u-race"));
    live.workspaces.set("u-race", ["ws-old", "ws-new"]);
    c.socket.emit("subscribe:mcp");
    await vi.waitFor(() => expect(inRoom("ws-new", c)).toBe(true));
    release();
    await pass;

    expect(inRoom("ws-new", c)).toBe(true);
    expect(inRoom("ws-old", c)).toBe(true);
  });

  it("still leaves a room held before the read that the read no longer allows", async () => {
    const c = await connect("u-race-lost", ["ws-old", "ws-gone"]);
    let release!: () => void;
    live.membershipGate = new Promise<void>((r) => (release = r));
    live.workspaces.set("u-race-lost", ["ws-old"]);
    vi.mocked(readLiveWorkspaceIds).mockClear();

    const pass = revalidateLocalSockets(io);
    await vi.waitFor(() => expect(readLiveWorkspaceIds).toHaveBeenCalledWith("u-race-lost"));
    release();
    await pass;

    expect(inRoom("ws-gone", c)).toBe(false);
    expect(inRoom("ws-old", c)).toBe(true);
  });
});

describe("#659 revalidateLocalSockets log level by trigger", () => {
  /** The level of each re-validation pass logged by the socket module. */
  function passLevels(write: ReturnType<typeof vi.spyOn>): string[] {
    return write.mock.calls
      .map(([info]) => info as { level: string; message: string; module?: string })
      .filter((i) => i.module === "socket" && /re-validat/i.test(i.message))
      .map((i) => i.level);
  }

  it("logs a LISTEN pass at info and a periodic sweep at debug", async () => {
    await connect("u-log");
    const write = vi.spyOn(logger, "write");
    try {
      await revalidateLocalSockets(io, "listen");
      await revalidateLocalSockets(io, "sweep");
      expect(passLevels(write)).toEqual(["info", "debug"]);
    } finally {
      write.mockRestore();
    }
  });

  it("logs the coalesced pass at info when a LISTEN signal joined a running sweep", async () => {
    await connect("u-log-join");
    let unblock!: () => void;
    live.userGate = new Promise<void>((r) => (unblock = r));
    const write = vi.spyOn(logger, "write");
    try {
      const sweep = revalidateLocalSockets(io, "sweep");
      await vi.waitFor(() => expect(loadLiveAuthPayload).toHaveBeenCalledWith("u-log-join"));
      void revalidateLocalSockets(io, "listen");
      void revalidateLocalSockets(io, "sweep");
      unblock();
      live.userGate = undefined;
      await sweep;
      expect(passLevels(write)).toEqual(["debug", "info"]);
    } finally {
      write.mockRestore();
    }
  });

  it("logs the trailing pass at debug when only a sweep joined a running LISTEN pass", async () => {
    await connect("u-log-trail");
    let unblock!: () => void;
    live.userGate = new Promise<void>((r) => (unblock = r));
    const write = vi.spyOn(logger, "write");
    try {
      const pass = revalidateLocalSockets(io, "listen");
      await vi.waitFor(() => expect(loadLiveAuthPayload).toHaveBeenCalledWith("u-log-trail"));
      void revalidateLocalSockets(io, "sweep");
      unblock();
      live.userGate = undefined;
      await pass;
      expect(passLevels(write)).toEqual(["info", "debug"]);
    } finally {
      write.mockRestore();
    }
  });
});
