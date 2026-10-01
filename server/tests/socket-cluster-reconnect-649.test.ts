/**
 * #649 — a revocation published while one replica's `LISTEN` connection is down
 * is lost to that replica (the adapter reconnects but does not replay), so on
 * reconnect the replica re-validates every socket it holds.
 *
 * Two real Socket.IO servers on the real `@socket.io/postgres-adapter`, over the
 * in-process notify bus (`helpers/fake-pg-notify-bus.ts`). B's `LISTEN` client
 * is dropped (`end`, as a failover or `pg_terminate_backend` ends it) and its
 * reconnect held, so every NOTIFY published meanwhile misses B; the revocations
 * then run on A. The control arm builds B without the re-validation hook and
 * shows the deprovisioned socket survives the reconnect: the outcome is owed to
 * the hook, not to a late relay. The real-Postgres proof is in
 * `socket-cluster-adapter-postgres.integration.test.ts`.
 */
import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import type { Pool } from "pg";

vi.mock("../src/lib/prisma.js", async () =>
  (await import("./helpers/two-replica-prisma.js")).prismaModuleMock(),
);
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/auth/jwt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth/jwt.js")>()),
  revokeAllUserSessions: vi.fn(async () => {}),
}));

import { db, seed } from "./helpers/two-replica-prisma.js";
import { connectUser, startReplica, type Replica } from "./helpers/two-replica-sockets.js";
import { FakePgNotifyBus } from "./helpers/fake-pg-notify-bus.js";
import {
  createPostgresClusterAdapter,
  type SocketClusterAdapter,
} from "../src/lib/socket/cluster-adapter.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { evictMemberMcpStatusRoom } from "../src/lib/socket/mcp-status-eviction.js";
import { mcpStatusWorkspaceRoom } from "../src/lib/mcp/status-rooms.js";
import { __resetScimTokens, addScimToken, scimRouter } from "../src/routes/scim.js";

const SCIM_AUTH = "Bearer scim-649-token";
const WS = "ws-649";
const ROOM = mcpStatusWorkspaceRoom(WS);

let a: Replica;
let b: Replica;
let adapters: SocketClusterAdapter[] = [];
let app: Express;
const open: ClientSocket[] = [];

/** B's pool, whose `connect` can be held to keep its LISTEN connection down. */
function gatedPool(bus: FakePgNotifyBus) {
  const pool = bus.pool();
  const connect = pool.connect.bind(pool) as () => Promise<unknown>;
  const gate = { held: null as Promise<void> | null, release: () => {} };
  pool.connect = (async () => {
    await gate.held;
    return connect();
  }) as unknown as Pool["connect"];
  return { pool, gate };
}

async function startPair(revalidate: boolean) {
  const bus = new FakePgNotifyBus();
  const { pool: poolB, gate } = gatedPool(bus);
  adapters = [createPostgresClusterAdapter(bus.pool()), createPostgresClusterAdapter(poolB)];
  a = await startReplica(adapters[0].adapter, adapters[0].onListening);
  b = await startReplica(adapters[1].adapter, revalidate ? adapters[1].onListening : undefined);
  registerSocketServer(a.io);
  await vi.waitFor(async () => {
    expect(await a.io.of("/").adapter.serverCount()).toBe(2);
    expect(await b.io.of("/").adapter.serverCount()).toBe(2);
  });
  // A connected first, so B's LISTEN client is the second one the bus handed out.
  const [, bClient] = [...bus.clients];
  const beforeDrop = new Set(bus.clients);
  return {
    /** Drop B's LISTEN connection and hold its reconnect. */
    dropB() {
      gate.held = new Promise<void>((r) => (gate.release = r));
      bClient.emit("end");
      expect(bus.clients.has(bClient)).toBe(false);
    },
    /** Let B reconnect, and wait until it LISTENs again. */
    async restoreB() {
      gate.release();
      await vi.waitFor(
        () =>
          expect([...bus.clients].some((c) => !beforeDrop.has(c) && c.channels.size > 0)).toBe(
            true,
          ),
        { timeout: 6_000 },
      );
    },
  };
}

beforeEach(() => {
  __resetScimTokens();
  addScimToken("scim-649-token");
  app = express();
  app.use(express.json());
  app.use("/scim/v2", scimRouter());
});

afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  registerSocketServer(null as never);
  __resetScimTokens();
  await a?.close();
  await b?.close();
  await Promise.all(adapters.map((x) => x.close()));
  adapters = [];
});

describe("#649 revocations published during a LISTEN reconnect window", () => {
  it("are applied to the replica's sockets once its LISTEN connection is back", async () => {
    const pair = await startPair(true);
    seed(
      ["u-gone", "u-removed", "u-kept"],
      [
        [WS, "u-removed"],
        [WS, "u-kept"],
      ],
    );
    const gone = await connectUser(b, "u-gone", open);
    const removed = await connectUser(b, "u-removed", open);
    const kept = await connectUser(b, "u-kept", open);
    await vi.waitFor(() => {
      expect(b.roomHas(ROOM, removed.sid)).toBe(true);
      expect(b.roomHas(ROOM, kept.sid)).toBe(true);
    });

    pair.dropB();
    const res = await request(app).delete("/scim/v2/Users/u-gone").set("Authorization", SCIM_AUTH);
    expect(res.status).toBe(204);
    db.members.delete(`${WS}:u-removed`);
    evictMemberMcpStatusRoom("u-removed", WS);
    // The window is real: B heard neither revocation.
    await new Promise((r) => setTimeout(r, 100));
    expect(gone.socket.connected).toBe(true);
    expect(b.roomHas(ROOM, removed.sid)).toBe(true);

    await pair.restoreB();

    await vi.waitFor(() => {
      expect(gone.disconnectReason).toBe("io server disconnect");
      expect(b.roomHas(ROOM, removed.sid)).toBe(false);
    });
    expect(removed.socket.connected).toBe(true);
    expect(kept.socket.connected).toBe(true);
    expect(b.roomHas(ROOM, kept.sid)).toBe(true);
  }, 15_000);

  it("control: without the re-validation hook the deprovisioned socket survives the reconnect", async () => {
    const pair = await startPair(false);
    seed(["u-gone"], []);
    const gone = await connectUser(b, "u-gone", open);

    pair.dropB();
    const res = await request(app).delete("/scim/v2/Users/u-gone").set("Authorization", SCIM_AUTH);
    expect(res.status).toBe(204);
    await pair.restoreB();
    await new Promise((r) => setTimeout(r, 200));

    expect(gone.socket.connected).toBe(true);
    expect(gone.disconnectReason).toBeNull();
  }, 15_000);
});
