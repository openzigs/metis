/**
 * #622 — the Socket.IO cluster adapter carries a SCIM deprovision disconnect
 * and the MCP status evictions to a socket held by ANOTHER replica, over a REAL
 * Postgres `LISTEN` / `NOTIFY`.
 *
 * Two real Socket.IO servers, each with its OWN pool built by the production
 * `resolveSocketClusterAdapter` (with `NODE_ENV=production`, which the unit
 * runner's `test` would otherwise rule out) — two replicas sharing one
 * database. The registry (what the SCIM and workspace routes reach for) holds
 * replica A; the evicted user is connected to B. Users and memberships come from
 * the shared Prisma mock: what is under test is the adapter's reach, not the
 * user table. `socket-cluster-eviction-622.test.ts` runs the same scenarios in
 * the default suite over an in-process notify bus, with a no-adapter control.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only under
 * `pnpm test:integration` with a Postgres `DATABASE_URL`.
 */
import express, { type Express } from "express";
import request from "supertest";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

vi.mock("../src/lib/prisma.js", async () =>
  (await import("./helpers/two-replica-prisma.js")).prismaModuleMock(),
);
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// #613 × #622 — one handshake read can be held open; every other read passes through.
const liveUserGate = vi.hoisted(() => ({
  userId: null as string | null,
  reached: null as (() => void) | null,
  release: null as Promise<void> | null,
}));
vi.mock("../src/lib/auth/live-auth-payload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth/live-auth-payload.js")>();
  return {
    loadLiveAuthPayload: async (userId: string) => {
      const result = await actual.loadLiveAuthPayload(userId);
      if (liveUserGate.userId !== userId) return result;
      liveUserGate.userId = null;
      liveUserGate.reached?.();
      await liveUserGate.release;
      return result;
    },
  };
});
vi.mock("../src/lib/auth/jwt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth/jwt.js")>()),
  revokeAllUserSessions: vi.fn(async () => {}),
}));

import { db, seed } from "./helpers/two-replica-prisma.js";
import { connectUser, startReplica, type Replica } from "./helpers/two-replica-sockets.js";
import {
  SOCKET_IO_ATTACHMENTS_TABLE,
  resolveSocketClusterAdapter,
  type SocketClusterAdapter,
} from "../src/lib/socket/cluster-adapter.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { disconnectUserSockets, reconnectUserSockets } from "../src/lib/socket/user-disconnect.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import {
  evictMemberMcpStatusRoom,
  evictWorkspaceMcpStatusRoom,
} from "../src/lib/socket/mcp-status-eviction.js";
import { mcpStatusWorkspaceRoom } from "../src/lib/mcp/status-rooms.js";
import { __resetScimTokens, addScimToken, scimRouter } from "../src/routes/scim.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const SCIM_AUTH = "Bearer scim-622-pg-token";

describe.runIf(enabled)("#622 Socket.IO cluster adapter on real Postgres (integration)", () => {
  let clusters: SocketClusterAdapter[];
  let a: Replica;
  let b: Replica;
  let app: Express;
  const open: ClientSocket[] = [];

  beforeAll(async () => {
    // Start without the attachments table, so the creation test sees THIS run's DDL.
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin
      .query(`DROP TABLE IF EXISTS ${SOCKET_IO_ATTACHMENTS_TABLE}`)
      .finally(() => admin.end());
    const env = { ...process.env, NODE_ENV: "production" };
    clusters = (await Promise.all([
      resolveSocketClusterAdapter(env),
      resolveSocketClusterAdapter(env),
    ])) as SocketClusterAdapter[];
    expect(clusters.every(Boolean)).toBe(true);
    a = await startReplica(clusters[0].adapter);
    b = await startReplica(clusters[1].adapter);
    registerSocketServer(a.io);
    // Each replica has heard the other's heartbeat, so both LISTEN clients are up.
    await vi.waitFor(
      async () => {
        expect(await a.io.of("/").adapter.serverCount()).toBe(2);
        expect(await b.io.of("/").adapter.serverCount()).toBe(2);
      },
      { timeout: 15_000 },
    );
    __resetScimTokens();
    addScimToken("scim-622-pg-token");
    app = express();
    app.use(express.json());
    app.use("/scim/v2", scimRouter());
  });

  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });

  afterAll(async () => {
    registerSocketServer(null as never);
    __resetScimTokens();
    await a.close();
    await b.close();
    await Promise.all(clusters.map((c) => c.close()));
  });

  it("creates the adapter's attachments table", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await vi.waitFor(async () => {
        const { rows } = await pool.query("SELECT to_regclass($1) AS t", [
          SOCKET_IO_ATTACHMENTS_TABLE,
        ]);
        expect(rows[0].t).toBe(SOCKET_IO_ATTACHMENTS_TABLE);
      });
    } finally {
      await pool.end();
    }
  });

  it("relays an emit over NOTIFY's 8000-byte limit through the attachments table", async () => {
    seed(["u-big"], []);
    const onB = await connectUser(b, "u-big", open);
    const received: string[] = [];
    onB.socket.on("heartbeat", (e: { pad?: string }) => {
      if (e.pad) received.push(e.pad);
    });
    const pad = "x".repeat(10_000);

    a.io.to("user:u-big").emit("heartbeat", { ts: Date.now(), pad } as never);

    await vi.waitFor(() => expect(received).toEqual([pad]), { timeout: 10_000 });
  });

  it("a SCIM deprovision handled on A disconnects the user's socket on B", async () => {
    seed(["u-gone", "u-kept"], []);
    const goneOnB = await connectUser(b, "u-gone", open);
    const keptOnB = await connectUser(b, "u-kept", open);

    const res = await request(app).delete("/scim/v2/Users/u-gone").set("Authorization", SCIM_AUTH);
    expect(res.status).toBe(204);

    await vi.waitFor(() => expect(goneOnB.disconnectReason).toBe("io server disconnect"), {
      timeout: 10_000,
    });
    expect(b.io.sockets.sockets.has(goneOnB.sid)).toBe(false);
    expect(keptOnB.socket.connected).toBe(true);
  });

  it("a role-change reconnect on A closes the transport of the user's socket on B, which reconnects", async () => {
    seed(["u-role", "u-other"], []);
    const onB = await connectUser(b, "u-role", open, { reconnection: true });
    const otherOnB = await connectUser(b, "u-other", open);

    reconnectUserSockets("u-role");

    await vi.waitFor(
      () => {
        expect(onB.disconnectReason).toBe("transport close");
        expect(onB.handshakes).toBe(2);
        expect(onB.socket.connected).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(otherOnB.disconnectReason).toBeNull();
  });

  it("a workspace delete evicted on A takes B's socket out of the workspace room", async () => {
    const ws = `ws-622-del-${Date.now()}`;
    seed(["u-1"], [[ws, "u-1"]]);
    const s1 = await connectUser(b, "u-1", open);
    await vi.waitFor(() => expect(b.roomHas(mcpStatusWorkspaceRoom(ws), s1.sid)).toBe(true));

    evictWorkspaceMcpStatusRoom(ws);

    await vi.waitFor(() => expect(b.roomHas(mcpStatusWorkspaceRoom(ws), s1.sid)).toBe(false), {
      timeout: 10_000,
    });
    expect(s1.socket.connected).toBe(true);
  });

  it("a member removal evicted on A takes only that member's socket on B out of the room", async () => {
    const ws = `ws-622-mem-${Date.now()}`;
    seed(
      ["u-removed", "u-stays"],
      [
        [ws, "u-removed"],
        [ws, "u-stays"],
      ],
    );
    const room = mcpStatusWorkspaceRoom(ws);
    const removed = await connectUser(b, "u-removed", open);
    const stays = await connectUser(b, "u-stays", open);
    await vi.waitFor(() => {
      expect(b.roomHas(room, removed.sid)).toBe(true);
      expect(b.roomHas(room, stays.sid)).toBe(true);
    });

    evictMemberMcpStatusRoom("u-removed", ws);

    await vi.waitFor(() => expect(b.roomHas(room, removed.sid)).toBe(false), { timeout: 10_000 });
    expect(b.roomHas(room, stays.sid)).toBe(true);
  });

  // #613 × #622 — B's handshake read the user as active and is held before the
  // join; the deprovision on A misses B's not-yet-joined socket, so only the
  // relayed revocation epoch makes B re-read the user once the socket joins.
  it("a deprovision on A while B's handshake live-user read is held disconnects B's socket", async () => {
    seed(["u-race"], []);
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    Object.assign(liveUserGate, {
      userId: "u-race",
      reached,
      release: new Promise<void>((r) => (release = r)),
    });
    const { accessToken } = issueTokens({
      userId: "u-race",
      username: "u-race",
      role: "coordinator",
      permissions: [],
      workspaces: [],
    });
    const socket = ioClient(`http://127.0.0.1:${b.port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
    });
    open.push(socket);
    let disconnectReason: string | null = null;
    socket.on("disconnect", (reason) => {
      disconnectReason = reason;
    });
    const authOk = new Promise<void>((r) => socket.once("auth:ok", () => r()));
    await atGate;

    db.users.get("u-race")!.status = "inactive";
    disconnectUserSockets("u-race");
    // A barrier relayed after the revocation: once B has it, B has the revocation.
    const landed = new Promise<void>((r) =>
      (b.io as unknown as { on(e: string, f: () => void): void }).on("metis:test:barrier", r),
    );
    (a.io as unknown as { serverSideEmit(e: string): void }).serverSideEmit("metis:test:barrier");
    await landed;

    release();
    await authOk;
    await vi.waitFor(() => expect(disconnectReason).toBe("io server disconnect"), {
      timeout: 10_000,
    });
  });

  it("delivers a large emit to the same replica at once while its publish is blocked, and loses it only cross-replica", async () => {
    // Another session holds the attachments table, so the large emit's INSERT
    // waits until the 5 s statement timeout and then rejects. Upstream
    // socket.io-adapter awaited that publish and returned without delivering
    // locally; the socket on A must get the emit now, and B — told nothing —
    // is the outage's cost.
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const holder = await admin.connect();
    try {
      seed(["u-blocked"], []);
      const onA = await connectUser(a, "u-blocked", open);
      const onB = await connectUser(b, "u-blocked", open);
      const gotA: string[] = [];
      const gotB: string[] = [];
      onA.socket.on("heartbeat", (e: { pad?: string }) => e.pad && gotA.push(e.pad));
      onB.socket.on("heartbeat", (e: { pad?: string }) => e.pad && gotB.push(e.pad));
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE ${SOCKET_IO_ATTACHMENTS_TABLE} IN ACCESS EXCLUSIVE MODE`);
      const pad = "y".repeat(10_000);

      const started = Date.now();
      a.io.to("user:u-blocked").emit("heartbeat", { ts: started, pad } as never);

      await vi.waitFor(() => expect(gotA).toEqual([pad]), { timeout: 2_000 });
      expect(Date.now() - started).toBeLessThan(2_000);
      // Past the statement timeout: the publish has failed, and B never got it.
      await new Promise((r) => setTimeout(r, 6_000));
      expect(gotA).toEqual([pad]);
      expect(gotB).toEqual([]);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await admin.end();
    }
  });

  // Last: it drops every replica's LISTEN connection. Before the client-level
  // 'error' listener, pg emitted the termination on the checked-out client with
  // nothing listening and the process died (exit 1, "Unhandled error event").
  it("survives Postgres terminating the LISTEN connections, and relays evictions again", async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const listenPids = async () =>
      (
        await admin.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND query LIKE 'LISTEN "socket.io#%'`,
        )
      ).rows.map((r) => r.pid);
    try {
      const before = await listenPids();
      expect(before.length).toBeGreaterThanOrEqual(2);
      await admin.query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [before]);

      // The adapter reconnects ~1-3 s later on a fresh backend.
      await vi.waitFor(
        async () => {
          const after = await listenPids();
          expect(after.length).toBeGreaterThanOrEqual(2);
          for (const pid of after) expect(before).not.toContain(pid);
        },
        { timeout: 15_000, interval: 250 },
      );

      seed(["u-after-drop"], []);
      const onB = await connectUser(b, "u-after-drop", open);
      const res = await request(app)
        .delete("/scim/v2/Users/u-after-drop")
        .set("Authorization", SCIM_AUTH);
      expect(res.status).toBe(204);
      await vi.waitFor(() => expect(onB.disconnectReason).toBe("io server disconnect"), {
        timeout: 10_000,
      });
    } finally {
      await admin.end();
    }
  });
});
