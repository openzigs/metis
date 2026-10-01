/**
 * #622 — the Socket.IO cluster adapter is selected by the datasource: Postgres
 * gets the shared `LISTEN` / `NOTIFY` adapter, anything else (SQLite dev, unset)
 * keeps the default in-memory adapter with no new config.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
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

  it("logs, never throws, when the attachments table cannot be created", async () => {
    const pool = new FakePgNotifyBus().pool();
    pool.query = vi.fn(async () => {
      throw new Error("permission denied");
    }) as unknown as Pool["query"];
    const cluster = createPostgresClusterAdapter(pool);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("attachments table"),
        expect.objectContaining({ error: "permission denied" }),
      ),
    );
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
