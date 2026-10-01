/**
 * #659 — a revocation whose PUBLISH fails reaches no other replica, and those
 * replicas, still LISTENing, get no reconnect to re-check on (#649). Each
 * clustered replica therefore re-validates its sockets on an interval.
 *
 * Two real Socket.IO servers on the real `@socket.io/postgres-adapter`, over
 * the in-process notify bus (`helpers/fake-pg-notify-bus.ts`). Every NOTIFY
 * from A's pool rejects, as one from a pool that has timed out does, while B
 * keeps listening. A SCIM deprovision handled on A then has to reach B's socket
 * through B's sweep. The control arm gives B a sweep that never comes due and
 * shows the socket survives: the outcome is owed to the sweep, not to a late
 * relay. The real-Postgres proof is in
 * `socket-cluster-adapter-postgres.integration.test.ts`.
 *
 * The first block pins the sweep's wiring on one server: when it runs, its
 * production default, and that closing the server stops it.
 */
import http from "node:http";
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
import {
  SOCKET_REVALIDATE_INTERVAL_MS,
  createSocketServer,
  type MetisIOServer,
} from "../src/lib/socket/server.js";
import { readEpoch } from "../src/lib/socket/revocation-relay.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { __resetScimTokens, addScimToken, scimRouter } from "../src/routes/scim.js";

const SCIM_AUTH = "Bearer scim-659-token";
/** The test's sweep interval, and so its bound. */
const SWEEP_MS = 150;

const replicas: Replica[] = [];
let adapters: SocketClusterAdapter[] = [];
const open: ClientSocket[] = [];
let app: Express;

beforeEach(() => {
  __resetScimTokens();
  addScimToken("scim-659-token");
  app = express();
  app.use(express.json());
  app.use("/scim/v2", scimRouter());
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) s.close();
  registerSocketServer(null as never);
  __resetScimTokens();
  for (const r of replicas.splice(0)) await r.close();
  await Promise.all(adapters.map((x) => x.close()));
  adapters = [];
});

describe("#659 periodic re-validation sweep — wiring", () => {
  it("runs on the given interval and stops when the server closes", async () => {
    seed([], []);
    const r = await startReplica(undefined, undefined, SWEEP_MS);
    replicas.push(r);
    // Each pass bumps the revocation epoch once, even with no sockets.
    const start = readEpoch(r.io, "revocation");
    await vi.waitFor(() => expect(readEpoch(r.io, "revocation")).toBeGreaterThanOrEqual(start + 2));

    await r.close();
    replicas.splice(0);
    const closedAt = readEpoch(r.io, "revocation");
    await new Promise((res) => setTimeout(res, SWEEP_MS * 3));
    expect(readEpoch(r.io, "revocation")).toBe(closedAt);
  });

  it("does not sweep a single-replica server with no adapter", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const io: MetisIOServer = createSocketServer(http.createServer());
    replicas.push({ io, port: 0, roomHas: () => false, close: () => io.close() });

    expect(setInterval).not.toHaveBeenCalled();
  });

  it("defaults to SOCKET_REVALIDATE_INTERVAL_MS on a clustered server", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const cluster = createPostgresClusterAdapter(new FakePgNotifyBus().pool());
    adapters.push(cluster);
    const io: MetisIOServer = createSocketServer(http.createServer(), { adapter: cluster.adapter });
    replicas.push({ io, port: 0, roomHas: () => false, close: () => io.close() });

    expect(SOCKET_REVALIDATE_INTERVAL_MS).toBe(60_000);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), SOCKET_REVALIDATE_INTERVAL_MS);
  });
});

describe("#659 a revocation whose publish fails on A, while B stays listening", () => {
  async function startPair(sweepB: number) {
    const bus = new FakePgNotifyBus();
    const poolA = bus.pool();
    const query = poolA.query.bind(poolA) as (sql: string, params?: unknown[]) => unknown;
    const publishes = { failing: false, failed: 0 };
    poolA.query = (async (sql: string, params?: unknown[]) => {
      if (publishes.failing && sql.includes("pg_notify")) {
        publishes.failed++;
        throw new Error("timeout exceeded when trying to connect");
      }
      return query(sql, params);
    }) as unknown as typeof poolA.query;
    adapters = [createPostgresClusterAdapter(poolA), createPostgresClusterAdapter(bus.pool())];
    const a = await startReplica(adapters[0].adapter, adapters[0].onListening);
    const b = await startReplica(adapters[1].adapter, adapters[1].onListening, sweepB);
    replicas.push(a, b);
    registerSocketServer(a.io);
    await vi.waitFor(async () => {
      expect(await a.io.of("/").adapter.serverCount()).toBe(2);
      expect(await b.io.of("/").adapter.serverCount()).toBe(2);
    });
    return { a, b, publishes, bus };
  }

  it("closes B's socket of the deprovisioned user within one sweep interval", async () => {
    const { b, publishes, bus } = await startPair(SWEEP_MS);
    seed(["u-gone", "u-kept"], []);
    const gone = await connectUser(b, "u-gone", open);
    const kept = await connectUser(b, "u-kept", open);
    const listening = [...bus.clients].filter((c) => c.channels.size > 0).length;

    publishes.failing = true;
    const started = Date.now();
    const res = await request(app).delete("/scim/v2/Users/u-gone").set("Authorization", SCIM_AUTH);
    expect(res.status).toBe(204);

    await vi.waitFor(() => expect(gone.disconnectReason).toBe("io server disconnect"), {
      timeout: SWEEP_MS * 10,
      interval: 10,
    });
    // Within the bound: one interval plus one pass (a handful of ms here).
    expect(Date.now() - started).toBeLessThan(SWEEP_MS * 3);
    // The publish really failed, and B never lost its LISTEN connection.
    expect(publishes.failed).toBeGreaterThan(0);
    expect([...bus.clients].filter((c) => c.channels.size > 0)).toHaveLength(listening);
    expect(kept.socket.connected).toBe(true);
    expect(kept.disconnectReason).toBeNull();
  });

  it("control: with no sweep due, B's socket survives the failed publish", async () => {
    const { b, publishes } = await startPair(3_600_000);
    seed(["u-gone"], []);
    const gone = await connectUser(b, "u-gone", open);

    publishes.failing = true;
    const res = await request(app).delete("/scim/v2/Users/u-gone").set("Authorization", SCIM_AUTH);
    expect(res.status).toBe(204);
    await new Promise((r) => setTimeout(r, SWEEP_MS * 3));

    expect(publishes.failed).toBeGreaterThan(0);
    expect(gone.socket.connected).toBe(true);
    expect(gone.disconnectReason).toBeNull();
  });
});
