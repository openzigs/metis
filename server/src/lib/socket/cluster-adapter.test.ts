/**
 * #622 — the Socket.IO cluster adapter is selected by the datasource: Postgres
 * gets the shared `LISTEN` / `NOTIFY` adapter, anything else (SQLite dev, unset)
 * keeps the default in-memory adapter with no new config.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const { warn, error } = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error }),
}));

import {
  SOCKET_IO_ATTACHMENTS_TABLE,
  createPostgresClusterAdapter,
  resolveSocketClusterAdapter,
} from "./cluster-adapter.js";
import { FakePgNotifyBus } from "../../../tests/helpers/fake-pg-notify-bus.js";

const flush = () => new Promise((r) => setImmediate(r));

describe("resolveSocketClusterAdapter", () => {
  const made: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((m) => m.close()));
    warn.mockReset();
  });

  it.each([undefined, "", "file:./dev.db", "sqlite:./dev.db"])(
    "keeps the in-memory adapter for DATABASE_URL=%s and builds no pool",
    (url) => {
      const makePool = vi.fn();
      const env = url === undefined ? {} : { DATABASE_URL: url };
      expect(resolveSocketClusterAdapter(env, makePool)).toBeNull();
      expect(makePool).not.toHaveBeenCalled();
    },
  );

  it.each(["postgres://u:p@db:5432/metis", "postgresql://u:p@db:5432/metis"])(
    "builds the Postgres adapter for %s",
    (url) => {
      const bus = new FakePgNotifyBus();
      const makePool = vi.fn(() => bus.pool());
      const resolved = resolveSocketClusterAdapter({ DATABASE_URL: url }, makePool);
      expect(resolved).not.toBeNull();
      made.push(resolved!);
      expect(makePool).toHaveBeenCalledWith(url);
      expect(typeof resolved!.adapter).toBe("function");
    },
  );

  it("trims DATABASE_URL as Prisma's provider resolution does", () => {
    const bus = new FakePgNotifyBus();
    const makePool = vi.fn(() => bus.pool());
    const resolved = resolveSocketClusterAdapter(
      { DATABASE_URL: "  postgres://u:p@db:5432/metis\n" },
      makePool,
    );
    expect(resolved).not.toBeNull();
    made.push(resolved!);
    expect(makePool).toHaveBeenCalledWith("postgres://u:p@db:5432/metis");
  });
});

describe("createPostgresClusterAdapter", () => {
  afterEach(() => warn.mockReset());

  it("creates the attachments table the adapter needs, under an advisory lock", async () => {
    const bus = new FakePgNotifyBus();
    const cluster = createPostgresClusterAdapter(bus.pool());
    await flush();
    const ddl = bus.statements.find((s) => s.includes("CREATE"));
    expect(ddl).toBeDefined();
    expect(ddl).toContain("pg_advisory_xact_lock");
    expect(ddl).toContain(`CREATE UNLOGGED TABLE IF NOT EXISTS ${SOCKET_IO_ATTACHMENTS_TABLE}`);
    for (const col of ["id", "created_at", "payload"]) expect(ddl).toContain(col);
    await cluster.close();
  });

  it("logs once, naming the CREATE privilege, never throws, when the attachments table cannot be created", async () => {
    error.mockReset();
    const pool = new FakePgNotifyBus().pool();
    pool.query = vi.fn(async () => {
      throw new Error("permission denied for schema public");
    }) as unknown as Pool["query"];
    const cluster = createPostgresClusterAdapter(pool);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/attachments table.*needs CREATE/),
        expect.objectContaining({ error: "permission denied for schema public" }),
      ),
    );
    expect(error).toHaveBeenCalledTimes(1);
    await cluster.close();
  });

  it("logs an idle-client pool error instead of crashing the process", async () => {
    const pool = new FakePgNotifyBus().pool();
    const cluster = createPostgresClusterAdapter(pool);
    // An EventEmitter with no 'error' listener throws on emit.
    expect(() => pool.emit("error", new Error("connection reset"))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("pool"),
      expect.objectContaining({ error: "connection reset" }),
    );
    await cluster.close();
  });

  it("logs an error on the checked-out LISTEN client instead of crashing the process", async () => {
    // pg-pool drops its idle 'error' listener from a client it hands out, so a
    // dropped LISTEN connection (failover, restart, pg_terminate_backend) emits
    // 'error' on the client itself — never on the pool.
    const bus = new FakePgNotifyBus();
    const pool = bus.pool();
    const cluster = createPostgresClusterAdapter(pool);
    const { Server } = await import("socket.io");
    const { createServer } = await import("node:http");
    const io = new Server(createServer(), { adapter: cluster.adapter });
    await vi.waitFor(() => expect(bus.clients.size).toBe(1));
    const [listenClient] = bus.clients;

    expect(() =>
      listenClient.emit("error", new Error("terminating connection due to administrator command")),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("connection error"),
      expect.objectContaining({ error: "terminating connection due to administrator command" }),
    );
    await io.close();
    await cluster.close();
  });

  it("releases a LISTEN client whose connection ended, so its pool slot is freed", async () => {
    // The adapter reconnects on 'end' but never releases the dead client; held,
    // it keeps a slot and the next LISTEN client fills the 2-connection pool.
    const bus = new FakePgNotifyBus();
    const cluster = createPostgresClusterAdapter(bus.pool());
    const { Server } = await import("socket.io");
    const { createServer } = await import("node:http");
    const io = new Server(createServer(), { adapter: cluster.adapter });
    await vi.waitFor(() => expect(bus.clients.size).toBe(1));
    const [dropped] = bus.clients;

    dropped.emit("end");

    expect(dropped.released).toBe(true);
    expect(dropped.releasedWith).toBeInstanceOf(Error);
    await io.close();
    await cluster.close();
  });

  it("leaves releasing a healthy LISTEN client to the adapter's own close()", async () => {
    const bus = new FakePgNotifyBus();
    const cluster = createPostgresClusterAdapter(bus.pool());
    const { Server } = await import("socket.io");
    const { createServer } = await import("node:http");
    const io = new Server(createServer(), { adapter: cluster.adapter });
    await vi.waitFor(() => expect(bus.clients.size).toBe(1));
    const [held] = bus.clients;

    await io.close();
    // Released once, healthy — the fake throws on a second release.
    expect(held.released).toBe(true);
    expect(held.releasedWith).toBeUndefined();
    expect(() => held.emit("end")).not.toThrow();
    await cluster.close();
  });

  it("routes an adapter publish failure to the log", async () => {
    const pool = new FakePgNotifyBus().pool();
    const cluster = createPostgresClusterAdapter(pool);
    await flush();
    pool.query = vi.fn(async () => {
      throw new Error("notify failed");
    }) as unknown as Pool["query"];
    const { Server } = await import("socket.io");
    const { createServer } = await import("node:http");
    const io = new Server(createServer(), { adapter: cluster.adapter });
    io.in("user:u-1").disconnectSockets(true);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("cluster adapter"),
        expect.objectContaining({ error: "notify failed" }),
      ),
    );
    await io.close();
    await cluster.close();
  });

  it("close() ends the pool, once", async () => {
    const pool = new FakePgNotifyBus().pool();
    const end = vi.spyOn(pool, "end");
    const cluster = createPostgresClusterAdapter(pool);
    await cluster.close();
    await cluster.close();
    expect(pool.ended).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
