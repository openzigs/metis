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
}));
vi.mock("../src/lib/auth/live-auth-payload.js", () => ({
  loadLiveAuthPayload: vi.fn(async (userId: string) => {
    live.inFlight++;
    live.maxInFlight = Math.max(live.maxInFlight, live.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    live.inFlight--;
    const user = live.users.get(userId);
    if (user instanceof Error) throw user;
    return user ?? null;
  }),
}));
vi.mock("../src/lib/auth/live-workspace-ids.js", () => ({
  readLiveWorkspaceIds: vi.fn(async (userId: string) => {
    const ids = live.workspaces.get(userId) ?? [];
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
});
