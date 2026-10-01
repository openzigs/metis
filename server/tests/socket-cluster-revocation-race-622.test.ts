/**
 * #622 × #613 — a revocation handled on ONE replica must re-check a handshake or
 * `subscribe:mcp` in flight on ANOTHER.
 *
 * #613 closed the window between a socket's read of live state and its room
 * join with an epoch the revocation bumps and the reader re-checks. That epoch
 * is per server (per process in a deployment). With the cluster adapter the
 * revocation's disconnect / `socketsLeave` reaches every replica, but finds a
 * socket that has not yet joined its room on the other replica — and unless the
 * other replica's epoch moves too, nothing re-checks it there. Every revocation
 * is therefore relayed (`revocation-relay.ts`); the receiving replica bumps its
 * own epoch.
 *
 * Two real Socket.IO servers share the real `@socket.io/postgres-adapter` over
 * the in-process notify bus. Each test holds B's read open with a gate,
 * commits the revocation on A, waits for A's relays to land on B (a barrier
 * event relayed after them), then releases B's read with its stale result.
 * Server vitest has `retry: 2`, so every gate and fixture is created per attempt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
interface Gate {
  read: "liveUser" | "workspaces";
  userId: string;
  reached: Deferred;
  release: Deferred;
}

const state = vi.hoisted(() => ({
  gates: [] as Gate[],
  /** `readLiveWorkspaceIds` calls by user id, counted while `countWorkspaceReads`. */
  workspaceReads: 0,
  countWorkspaceReads: false,
}));

/** Run `read` to completion, then — if a gate is armed for it — hold its (stale) result. */
async function gated<T>(read: Gate["read"], userId: string, run: () => Promise<T>): Promise<T> {
  const result = await run();
  const i = state.gates.findIndex((g) => g.read === read && g.userId === userId);
  if (i === -1) return result;
  const [gate] = state.gates.splice(i, 1);
  gate.reached.resolve();
  await gate.release.promise;
  return result;
}

vi.mock("../src/lib/prisma.js", async () =>
  (await import("./helpers/two-replica-prisma.js")).prismaModuleMock(),
);
vi.mock("../src/lib/auth/live-workspace-ids.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth/live-workspace-ids.js")>();
  return {
    ...actual,
    readLiveWorkspaceIds: (userId: string) => {
      if (state.countWorkspaceReads) state.workspaceReads += 1;
      return gated("workspaces", userId, () => actual.readLiveWorkspaceIds(userId));
    },
  };
});
vi.mock("../src/lib/auth/live-auth-payload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth/live-auth-payload.js")>();
  return {
    loadLiveAuthPayload: (userId: string) =>
      gated("liveUser", userId, () => actual.loadLiveAuthPayload(userId)),
  };
});

import { db, seed } from "./helpers/two-replica-prisma.js";
import { startReplica, type Replica } from "./helpers/two-replica-sockets.js";
import { FakePgNotifyBus } from "./helpers/fake-pg-notify-bus.js";
import {
  createPostgresClusterAdapter,
  type SocketClusterAdapter,
} from "../src/lib/socket/cluster-adapter.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { disconnectUserSockets } from "../src/lib/socket/user-disconnect.js";
import { evictWorkspaceMcpStatusRoom } from "../src/lib/socket/mcp-status-eviction.js";
import { mcpStatusWorkspaceRoom } from "../src/lib/mcp/status-rooms.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import type { MetisIOServer } from "../src/lib/socket/server.js";

const WS = "ws-622-race";
const ROOM = mcpStatusWorkspaceRoom(WS);
const BARRIER = "metis:test:barrier";

let a: Replica;
let b: Replica;
let adapters: SocketClusterAdapter[] = [];
const open: ClientSocket[] = [];

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function arm(read: Gate["read"], userId: string): Gate {
  const gate: Gate = { read, userId, reached: deferred(), release: deferred() };
  state.gates.push(gate);
  return gate;
}

interface ServerSideEvents {
  on(event: string, fn: () => void): unknown;
  serverSideEmit(event: string): unknown;
}
const sse = (io: MetisIOServer) => io as unknown as ServerSideEvents;

/** Resolve once B has handled every relay A published before this call. */
async function relaysLanded(): Promise<void> {
  const landed = deferred();
  sse(b.io).on(BARRIER, () => landed.resolve());
  sse(a.io).serverSideEmit(BARRIER);
  await landed.promise;
}

async function startClusteredPair(): Promise<void> {
  const bus = new FakePgNotifyBus();
  adapters = [createPostgresClusterAdapter(bus.pool()), createPostgresClusterAdapter(bus.pool())];
  a = await startReplica(adapters[0].adapter);
  b = await startReplica(adapters[1].adapter);
  // The routes run on A: `getSocketServer()` is A's server.
  registerSocketServer(a.io);
  await vi.waitFor(async () => {
    expect(await a.io.of("/").adapter.serverCount()).toBe(2);
    expect(await b.io.of("/").adapter.serverCount()).toBe(2);
  });
}

interface Client {
  socket: ClientSocket;
  authOk: Promise<void>;
  disconnectReason: string | null;
}

/** Open a socket to `replica` with every listener attached before the handshake. */
function openClient(replica: Replica, userId: string): Client {
  const { accessToken } = issueTokens({
    userId,
    username: userId,
    role: "coordinator",
    permissions: [],
    workspaces: [],
  });
  const socket = ioClient(`http://127.0.0.1:${replica.port}`, {
    auth: { token: accessToken },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000,
  });
  open.push(socket);
  const authOk = deferred();
  const client: Client = { socket, authOk: authOk.promise, disconnectReason: null };
  socket.once("auth:ok", () => authOk.resolve());
  socket.on("disconnect", (reason) => {
    client.disconnectReason = reason;
  });
  return client;
}

afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  state.gates = [];
  state.workspaceReads = 0;
  state.countWorkspaceReads = false;
  registerSocketServer(null as never);
  await a?.close();
  await b?.close();
  await Promise.all(adapters.map((x) => x.close()));
  adapters = [];
});

describe("#622 × #613 — a revocation on A re-checks a read in flight on B", () => {
  it("a deprovision on A while B's handshake live-user read is held disconnects B's socket", async () => {
    await startClusteredPair();
    seed(["u-race"], []);
    const gate = arm("liveUser", "u-race");
    const client = openClient(b, "u-race");
    // B's handshake read the user as still active and is held before the join.
    await gate.reached.promise;

    // The SCIM deprovision on A: the write commits, then A disconnects the
    // user's sockets — cluster-wide, but B's socket is not in `user:{id}` yet.
    db.users.get("u-race")!.status = "inactive";
    disconnectUserSockets("u-race");
    await relaysLanded();

    gate.release.resolve();
    // B admits the socket on its stale read, then the moved epoch re-reads.
    await client.authOk;
    await vi.waitFor(() => expect(client.disconnectReason).toBe("io server disconnect"));
    expect(b.io.sockets.sockets.size).toBe(0);
  });

  it("a workspace eviction on A while B's subscribe:mcp membership read is held keeps B's socket out of the room", async () => {
    await startClusteredPair();
    seed(["u-ws"], [[WS, "u-ws"]]);
    const client = openClient(b, "u-ws");
    await client.authOk;
    const sid = client.socket.id!;
    const gate = arm("workspaces", "u-ws");
    state.countWorkspaceReads = true;
    client.socket.emit("subscribe:mcp");
    // B read the membership and is held before the join.
    await gate.reached.promise;

    // The workspace delete on A: the write commits, then A evicts the room —
    // cluster-wide, but B's socket has not joined it yet.
    db.members.delete(`${WS}:u-ws`);
    evictWorkspaceMcpStatusRoom(WS);
    await relaysLanded();

    gate.release.resolve();
    // B joins the stale room, then the moved epoch re-reads and leaves it.
    await vi.waitFor(() => expect(b.roomHas(ROOM, sid) || state.workspaceReads === 2).toBe(true));
    await vi.waitFor(() => expect(b.roomHas(ROOM, sid)).toBe(false));
    expect(state.workspaceReads).toBe(2);
    // Eviction, not disconnection.
    expect(client.socket.connected).toBe(true);
  });
});
