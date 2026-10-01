/**
 * #622 — a SCIM deprovision and the MCP status evictions reach a socket held by
 * ANOTHER replica once the replicas share the Postgres cluster adapter.
 *
 * Two real Socket.IO servers (two "replicas"), each built by the real
 * `createSocketServer` with the real `@socket.io/postgres-adapter`, over one
 * in-process `LISTEN` / `pg_notify` bus standing in for the shared database
 * (`helpers/fake-pg-notify-bus.ts`). The registry — what the SCIM and workspace
 * routes reach for — holds replica A; the evicted user is connected to B.
 * `socket-cluster-adapter-postgres.integration.test.ts` runs the same
 * scenarios against a real Postgres.
 *
 * The control arm builds the same two replicas with NO adapter (single-replica
 * dev mode) and shows the eviction then does not reach B: the cross-replica
 * assertions are owed to the adapter, not to the harness.
 */
import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";

vi.mock("../src/lib/prisma.js", async () =>
  (await import("./helpers/two-replica-prisma.js")).prismaModuleMock(),
);
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/auth/jwt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth/jwt.js")>()),
  revokeAllUserSessions: vi.fn(async () => {}),
}));

import { seed } from "./helpers/two-replica-prisma.js";
import { connectUser, startReplica, type Replica } from "./helpers/two-replica-sockets.js";
import { FakePgNotifyBus } from "./helpers/fake-pg-notify-bus.js";
import {
  createPostgresClusterAdapter,
  type SocketClusterAdapter,
} from "../src/lib/socket/cluster-adapter.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import {
  evictMemberMcpStatusRoom,
  evictWorkspaceMcpStatusRoom,
} from "../src/lib/socket/mcp-status-eviction.js";
import { mcpStatusWorkspaceRoom } from "../src/lib/mcp/status-rooms.js";
import { __resetScimTokens, addScimToken, scimRouter } from "../src/routes/scim.js";

const SCIM_AUTH = "Bearer scim-622-token";
const WS = "ws-622";
const ROOM = mcpStatusWorkspaceRoom(WS);

let a: Replica;
let b: Replica;
let adapters: SocketClusterAdapter[] = [];
let app: Express;
const open: ClientSocket[] = [];

async function startPair(clustered: boolean): Promise<void> {
  const bus = new FakePgNotifyBus();
  adapters = clustered
    ? [createPostgresClusterAdapter(bus.pool()), createPostgresClusterAdapter(bus.pool())]
    : [];
  a = await startReplica(adapters[0]?.adapter);
  b = await startReplica(adapters[1]?.adapter);
  // The routes run on A: `getSocketServer()` is A's server.
  registerSocketServer(a.io);
  if (clustered) {
    // Each replica has heard the other's heartbeat, so both listen.
    await vi.waitFor(async () => {
      expect(await a.io.of("/").adapter.serverCount()).toBe(2);
      expect(await b.io.of("/").adapter.serverCount()).toBe(2);
    });
  }
}

beforeEach(() => {
  __resetScimTokens();
  addScimToken("scim-622-token");
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

describe("#622 evictions reach every replica through the cluster adapter", () => {
  it("a SCIM deprovision handled on A disconnects the user's socket on B", async () => {
    await startPair(true);
    seed(["u-gone", "u-kept"], []);
    const goneOnB = await connectUser(b, "u-gone", open);
    const goneOnA = await connectUser(a, "u-gone", open);
    const keptOnB = await connectUser(b, "u-kept", open);

    const res = await request(app).delete("/scim/v2/Users/u-gone").set("Authorization", SCIM_AUTH);
    expect(res.status).toBe(204);

    await vi.waitFor(() => {
      for (const s of [goneOnB, goneOnA]) {
        expect(s.socket.connected).toBe(false);
        expect(s.disconnectReason).toBe("io server disconnect");
      }
    });
    expect(b.io.sockets.sockets.has(goneOnB.sid)).toBe(false);
    expect(keptOnB.socket.connected).toBe(true);
  });

  it("SCIM PATCH active=false handled on A disconnects the user's socket on B", async () => {
    await startPair(true);
    seed(["u-off"], []);
    const onB = await connectUser(b, "u-off", open);

    const res = await request(app)
      .patch("/scim/v2/Users/u-off")
      .set("Authorization", SCIM_AUTH)
      .send({ Operations: [{ op: "replace", path: "active", value: false }] });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(onB.disconnectReason).toBe("io server disconnect"));
  });

  it("a workspace delete evicted on A takes B's sockets out of the workspace room", async () => {
    await startPair(true);
    seed(
      ["u-1", "u-2"],
      [
        [WS, "u-1"],
        [WS, "u-2"],
      ],
    );
    const s1 = await connectUser(b, "u-1", open);
    const s2 = await connectUser(b, "u-2", open);
    await vi.waitFor(() => {
      expect(b.roomHas(ROOM, s1.sid)).toBe(true);
      expect(b.roomHas(ROOM, s2.sid)).toBe(true);
    });

    evictWorkspaceMcpStatusRoom(WS);

    await vi.waitFor(() => {
      expect(b.roomHas(ROOM, s1.sid)).toBe(false);
      expect(b.roomHas(ROOM, s2.sid)).toBe(false);
    });
    // Eviction, not disconnection.
    expect(s1.socket.connected).toBe(true);
  });

  it("a member removal evicted on A takes only that member's socket on B out of the room", async () => {
    await startPair(true);
    seed(
      ["u-removed", "u-stays"],
      [
        [WS, "u-removed"],
        [WS, "u-stays"],
      ],
    );
    const removed = await connectUser(b, "u-removed", open);
    const stays = await connectUser(b, "u-stays", open);
    await vi.waitFor(() => {
      expect(b.roomHas(ROOM, removed.sid)).toBe(true);
      expect(b.roomHas(ROOM, stays.sid)).toBe(true);
    });

    evictMemberMcpStatusRoom("u-removed", WS);

    await vi.waitFor(() => expect(b.roomHas(ROOM, removed.sid)).toBe(false));
    expect(b.roomHas(ROOM, stays.sid)).toBe(true);
  });
});

describe("#622 control arm — no adapter (single-replica dev mode)", () => {
  it("an eviction on A does not reach B, so the cross-replica reach above is the adapter's", async () => {
    await startPair(false);
    seed(["u-gone"], [[WS, "u-gone"]]);
    const onB = await connectUser(b, "u-gone", open);
    const onA = await connectUser(a, "u-gone", open);
    await vi.waitFor(() => expect(b.roomHas(ROOM, onB.sid)).toBe(true));

    evictWorkspaceMcpStatusRoom(WS);
    const res = await request(app).delete("/scim/v2/Users/u-gone").set("Authorization", SCIM_AUTH);
    expect(res.status).toBe(204);

    // Single-replica mode still works locally: A's socket is closed.
    await vi.waitFor(() => expect(onA.disconnectReason).toBe("io server disconnect"));
    // B never heard about either eviction.
    expect(onB.socket.connected).toBe(true);
    expect(b.roomHas(ROOM, onB.sid)).toBe(true);
  });
});
