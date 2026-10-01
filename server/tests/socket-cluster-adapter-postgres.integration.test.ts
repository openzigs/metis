/**
 * #622 — the Socket.IO cluster adapter carries a SCIM deprovision disconnect
 * and the MCP status evictions to a socket held by ANOTHER replica, over a REAL
 * Postgres `LISTEN` / `NOTIFY`.
 *
 * Two real Socket.IO servers, each with its OWN pool built by the production
 * `resolveSocketClusterAdapter(process.env)` — two replicas sharing one
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
import {
  SOCKET_IO_ATTACHMENTS_TABLE,
  resolveSocketClusterAdapter,
  type SocketClusterAdapter,
} from "../src/lib/socket/cluster-adapter.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
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
    clusters = [
      resolveSocketClusterAdapter(process.env)!,
      resolveSocketClusterAdapter(process.env)!,
    ];
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
});
