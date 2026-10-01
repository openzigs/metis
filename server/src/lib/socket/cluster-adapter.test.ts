/**
 * #622 — the Socket.IO cluster adapter is selected by the datasource: Postgres
 * gets the shared `LISTEN` / `NOTIFY` adapter, anything else (SQLite dev, unset)
 * keeps the default in-memory adapter with no new config, and so does a
 * Postgres database where its attachments table cannot be created.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const { warn, error } = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error }),
}));

import {
  createServer as createNetServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import pg from "pg";
import { createServer as createHttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import { EventEmitter } from "node:events";
import { ADAPTER_NODE_REMOVED_EVENT } from "./cluster-presence.js";
import {
  SOCKET_IO_ATTACHMENTS_TABLE,
  announceNodeRemoval,
  createPostgresClusterAdapter,
  deliverLocallyFirst,
  ensureSocketClusterAttachmentsTable,
  resolveSocketClusterAdapter,
  selectSocketClusterAdapter,
  socketClusterPoolConfig,
} from "./cluster-adapter.js";
import { FakePgNotifyBus } from "../../../tests/helpers/fake-pg-notify-bus.js";

const flush = () => new Promise((r) => setImmediate(r));

const PG_URL = "postgres://u:p@db:5432/metis";
const PROD = { NODE_ENV: "production" } as const;

describe("selectSocketClusterAdapter", () => {
  it.each([undefined, "", "file:./dev.db", "sqlite:./dev.db", "mysql://u:p@db/metis"])(
    "keeps the in-memory adapter for DATABASE_URL=%s",
    (url) => {
      const env = url === undefined ? { ...PROD } : { ...PROD, DATABASE_URL: url };
      expect(selectSocketClusterAdapter(env)).toBeNull();
    },
  );

  it.each([PG_URL, "postgresql://u:p@db:5432/metis"])("selects Postgres for %s", (url) => {
    expect(selectSocketClusterAdapter({ ...PROD, DATABASE_URL: url })).toBe(url);
  });

  it.each(["production", "development", undefined])(
    "selects Postgres under NODE_ENV=%s",
    (nodeEnv) => {
      const env =
        nodeEnv === undefined
          ? { DATABASE_URL: PG_URL }
          : { NODE_ENV: nodeEnv, DATABASE_URL: PG_URL };
      expect(selectSocketClusterAdapter(env)).toBe(PG_URL);
    },
  );

  it("never selects Postgres under NODE_ENV=test, so the unit suite opens no pool", () => {
    expect(selectSocketClusterAdapter({ NODE_ENV: "test", DATABASE_URL: PG_URL })).toBeNull();
  });

  it("trims DATABASE_URL as Prisma's provider resolution does", () => {
    expect(selectSocketClusterAdapter({ ...PROD, DATABASE_URL: `  ${PG_URL}\n` })).toBe(PG_URL);
  });
});

describe("resolveSocketClusterAdapter", () => {
  const made: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((m) => m.close()));
    warn.mockReset();
    error.mockReset();
  });

  it("builds no pool when the in-memory adapter is selected", async () => {
    const makePool = vi.fn();
    expect(
      await resolveSocketClusterAdapter({ NODE_ENV: "test", DATABASE_URL: PG_URL }, makePool),
    ).toBeNull();
    expect(
      await resolveSocketClusterAdapter({ ...PROD, DATABASE_URL: "file:./dev.db" }, makePool),
    ).toBeNull();
    expect(makePool).not.toHaveBeenCalled();
  });

  it("creates the attachments table, then builds the adapter on that pool", async () => {
    const bus = new FakePgNotifyBus();
    const makePool = vi.fn(() => bus.pool());
    const resolved = await resolveSocketClusterAdapter({ ...PROD, DATABASE_URL: PG_URL }, makePool);
    expect(resolved).not.toBeNull();
    made.push(resolved!);
    expect(makePool).toHaveBeenCalledWith(PG_URL);
    expect(typeof resolved!.adapter).toBe("function");
    expect(bus.statements.some((s) => s.includes("CREATE UNLOGGED TABLE"))).toBe(true);
  });

  it("falls back to the in-memory adapter, ends the pool and says eviction is disabled, when the table cannot be created", async () => {
    const pool = new FakePgNotifyBus().pool();
    pool.query = vi.fn(async () => {
      throw new Error("permission denied for schema public");
    }) as unknown as Pool["query"];

    const resolved = await resolveSocketClusterAdapter(
      { ...PROD, DATABASE_URL: PG_URL },
      () => pool,
    );

    expect(resolved).toBeNull();
    expect(pool.ended).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/needs CREATE.*Cross-replica socket eviction is DISABLED/s),
      expect.objectContaining({ error: "permission denied for schema public" }),
    );
  });

  it("builds its default pool with bounded connect, query and statement timeouts", async () => {
    // The default factory is the production one: reach it through a URL that
    // refuses immediately, so the DDL fails fast and the pool is ended.
    const refused = "postgres://u:p@127.0.0.1:1/metis";
    const RealPool = pg.Pool;
    const Pool = vi.spyOn(pg, "Pool").mockImplementation(function (config) {
      return new RealPool(config);
    } as never);
    try {
      const resolved = await resolveSocketClusterAdapter({ ...PROD, DATABASE_URL: refused });
      expect(resolved).toBeNull();
      expect(Pool).toHaveBeenCalledTimes(1);
      expect(Pool).toHaveBeenCalledWith(socketClusterPoolConfig(refused));
    } finally {
      Pool.mockRestore();
    }
    expect(socketClusterPoolConfig(PG_URL)).toEqual({
      connectionString: PG_URL,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
  });
});

describe("socket cluster adapter pool timeouts", () => {
  let silent: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (silent ? silent.close(() => r()) : r()));
    silent = undefined;
  });

  it("fails a connection that never answers instead of hanging the publish", async () => {
    // A TCP peer that accepts and then says nothing: without
    // connectionTimeoutMillis, pg waits for its startup reply forever and every
    // emit waiting on NOTIFY waits with it.
    const sockets: Socket[] = [];
    silent = createNetServer((s) => sockets.push(s));
    const port = await new Promise<number>((resolve) =>
      silent!.listen(0, "127.0.0.1", () => resolve((silent!.address() as AddressInfo).port)),
    );
    const config = socketClusterPoolConfig(`postgres://u:p@127.0.0.1:${port}/metis`);
    const pool = new pg.Pool({ ...config, connectionTimeoutMillis: 200 });
    const started = Date.now();
    await expect(pool.query("SELECT 1")).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    await pool.end();
    for (const s of sockets) s.destroy();
  });
});

describe("createPostgresClusterAdapter", () => {
  afterEach(() => warn.mockReset());

  it("ensureSocketClusterAttachmentsTable creates the table the adapter needs, under an advisory lock", async () => {
    const bus = new FakePgNotifyBus();
    await ensureSocketClusterAttachmentsTable(bus.pool());
    const ddl = bus.statements.find((s) => s.includes("CREATE"));
    expect(ddl).toBeDefined();
    expect(ddl).toContain("pg_advisory_xact_lock");
    expect(ddl).toContain(`CREATE UNLOGGED TABLE IF NOT EXISTS ${SOCKET_IO_ATTACHMENTS_TABLE}`);
    for (const col of ["id", "created_at", "payload"]) expect(ddl).toContain(col);
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

  it("discards a LISTEN client the adapter abandoned after a failed LISTEN on a live connection", async () => {
    // Upstream initClient retries on a new client when a LISTEN rejects, but
    // never releases the old one, and a live connection never emits `end`.
    // Held, it keeps a slot and the retry's client fills the 2-connection pool.
    const bus = new FakePgNotifyBus();
    const pool = bus.pool();
    type Client = Awaited<ReturnType<typeof bus.pool>["connect"]> & {
      query: (sql: string) => Promise<unknown>;
      release: (err?: Error) => void;
      released: boolean;
      releasedWith: Error | undefined;
      emit: (event: string) => boolean;
    };
    const checkedOut: Client[] = [];
    const connect = pool.connect.bind(pool) as unknown as () => Promise<Client>;
    pool.connect = (async () => {
      const client = await connect();
      if (checkedOut.length === 0) {
        client.query = async () => {
          throw new Error("canceling statement due to statement timeout");
        };
      }
      // pg-pool ends a client released with an error, which emits `end`.
      const release = client.release.bind(client);
      client.release = (err?: Error) => {
        release(err);
        if (err) setImmediate(() => client.emit("end"));
      };
      checkedOut.push(client);
      return client;
    }) as unknown as Pool["connect"];
    const cluster = createPostgresClusterAdapter(pool);
    const listening = vi.fn();
    cluster.onListening(listening);
    // Synchronously, so the namespace's channel is registered before the first
    // client's LISTEN loop runs — the LISTEN then fails inside initClient.
    const io = new SocketIOServer(createHttpServer(), { adapter: cluster.adapter });

    await vi.waitFor(() => expect(listening).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    const [abandoned, retry] = checkedOut;
    expect(abandoned.released).toBe(true);
    expect(abandoned.releasedWith).toBeInstanceOf(Error);
    expect([...bus.clients]).toEqual([retry]);
    // Discarding it must not set the adapter's own reconnect off again (its
    // `end` listener would), which would discard the healthy retry in turn.
    await new Promise((r) => setTimeout(r, 3_200));
    expect(checkedOut).toHaveLength(2);
    expect(retry.released).toBe(false);

    await io.close();
    // The adapter's close() released the retry, healthy, exactly once.
    expect(retry.released).toBe(true);
    expect(retry.releasedWith).toBeUndefined();
    await cluster.close();
  }, 15_000);

  it("lets the adapter release a LISTEN client already discarded as superseded, without a double release", async () => {
    // Two overlapping upstream reconnects (a failed LISTEN's retry and the same
    // connection's `end`) can leave the adapter's `client` pointing at one this
    // module discarded; its close() then releases it again.
    const bus = new FakePgNotifyBus();
    const pool = bus.pool();
    const cluster = createPostgresClusterAdapter(pool);
    const first = (await pool.connect()) as unknown as {
      release: () => void;
      released: boolean;
      releasedWith: Error | undefined;
    };
    await pool.connect();

    expect(first.released).toBe(true);
    expect(first.releasedWith).toBeInstanceOf(Error);
    // The fake, like pg-pool, throws on a second release.
    expect(() => first.release()).not.toThrow();
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

  describe("#649 onListening", () => {
    async function start(bus: FakePgNotifyBus, pool = bus.pool()) {
      const cluster = createPostgresClusterAdapter(pool);
      const listening = vi.fn();
      cluster.onListening(listening);
      const { Server } = await import("socket.io");
      const { createServer } = await import("node:http");
      const io = new Server(createServer(), { adapter: cluster.adapter });
      return { cluster, io, listening };
    }

    it("fires once the LISTEN connection is up, and again after it is re-established", async () => {
      const bus = new FakePgNotifyBus();
      const { cluster, io, listening } = await start(bus);
      await vi.waitFor(() => expect(listening).toHaveBeenCalledTimes(1));
      const [first] = bus.clients;
      expect(first.channels.size).toBe(1);

      first.emit("end");
      // The adapter reconnects 1-3 s later on a fresh client.
      await vi.waitFor(() => expect(listening).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      const [second] = bus.clients;
      expect(second).not.toBe(first);
      expect(second.channels.size).toBe(1);
      await io.close();
      await cluster.close();
    }, 10_000);

    it("fires once per connection, not again when a later namespace LISTENs on it", async () => {
      const bus = new FakePgNotifyBus();
      const { cluster, io, listening } = await start(bus);
      // A second namespace LISTENs on the same, already-listening client.
      await vi.waitFor(() => expect(listening).toHaveBeenCalledTimes(1));
      io.of("/second");
      await vi.waitFor(() => expect([...bus.clients][0].channels.size).toBe(2));
      await flush();
      await flush();
      expect(listening).toHaveBeenCalledTimes(1);
      await io.close();
      await cluster.close();
    });

    it("waits for every LISTEN on a new connection, not just the first to succeed", async () => {
      // Both namespaces exist before the LISTEN client connects, so the adapter
      // issues both LISTENs on that one client, one after the other. Hold the
      // second open after the first has succeeded: nothing may fire until it does.
      const bus = new FakePgNotifyBus();
      const pool = bus.pool();
      let releaseSecond!: () => void;
      const secondHeld = new Promise<void>((r) => (releaseSecond = r));
      let secondIssued = false;
      const connect = pool.connect.bind(pool) as () => Promise<{
        query: (sql: string) => Promise<unknown>;
      }>;
      pool.connect = (async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = async (sql: string) => {
          if (sql.includes("/second")) {
            secondIssued = true;
            await secondHeld;
          }
          return query(sql);
        };
        return client;
      }) as unknown as Pool["connect"];
      const { cluster, io, listening } = await start(bus, pool);
      io.of("/second");

      await vi.waitFor(() => expect(secondIssued).toBe(true));
      const [client] = bus.clients;
      // The first LISTEN has completed; the second is still held.
      expect(client.channels.size).toBe(1);
      await new Promise((r) => setTimeout(r, 50));
      expect(listening).not.toHaveBeenCalled();

      releaseSecond();
      await vi.waitFor(() => expect(client.channels.size).toBe(2));
      await vi.waitFor(() => expect(listening).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 50));
      expect(listening).toHaveBeenCalledTimes(1);
      expect(bus.clients.size).toBe(1);
      await io.close();
      await cluster.close();
    });

    it("waits for a slow LISTEN to finish", async () => {
      const bus = new FakePgNotifyBus();
      const pool = bus.pool();
      let finish!: () => void;
      const slow = new Promise<void>((r) => (finish = r));
      const connect = pool.connect.bind(pool) as () => Promise<{ query: (sql: string) => unknown }>;
      pool.connect = (async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = async (sql: string) => {
          await slow;
          return query(sql);
        };
        return client;
      }) as unknown as Pool["connect"];
      const { cluster, io, listening } = await start(bus, pool);
      await vi.waitFor(() => expect(bus.clients.size).toBe(1));
      await new Promise((r) => setTimeout(r, 50));
      expect(listening).not.toHaveBeenCalled();
      finish();
      await vi.waitFor(() => expect(listening).toHaveBeenCalledTimes(1));
      await io.close();
      await cluster.close();
    });

    it("does not fire when any LISTEN on the connection fails", async () => {
      // Two namespaces: "/" LISTENs, then "/second" fails. The adapter then
      // retries on a new client, which is what should fire, not this one.
      const bus = new FakePgNotifyBus();
      const pool = bus.pool();
      const connect = pool.connect.bind(pool) as () => Promise<{
        query: (sql: string) => Promise<unknown>;
      }>;
      pool.connect = (async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = async (sql: string) => {
          if (sql.includes("/second")) throw new Error("LISTEN failed");
          return query(sql);
        };
        return client;
      }) as unknown as Pool["connect"];
      const cluster = createPostgresClusterAdapter(pool);
      const listening = vi.fn();
      cluster.onListening(listening);
      const { Server } = await import("socket.io");
      const { createServer } = await import("node:http");
      const io = new Server(createServer(), { adapter: cluster.adapter });
      io.of("/second");
      await vi.waitFor(() => expect([...bus.clients][0]?.channels.size).toBe(1));
      await new Promise((r) => setTimeout(r, 50));
      expect(listening).not.toHaveBeenCalled();
      await io.close();
      await cluster.close();
    });

    it("logs a listener that throws and still calls the others", async () => {
      const bus = new FakePgNotifyBus();
      const { cluster, io, listening } = await start(bus);
      const after = vi.fn();
      cluster.onListening(() => {
        throw new Error("hook broke");
      });
      cluster.onListening(after);
      await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1));
      expect(listening).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("listening hook failed"),
        expect.objectContaining({ error: "hook broke" }),
      );
      await io.close();
      await cluster.close();
    });
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

describe("local delivery never depends on the cluster publish", () => {
  // socket.io-adapter's ClusterAdapter awaits the publish before every local
  // operation, and its broadcast returns WITHOUT delivering when the publish
  // rejects — which a large or binary emit's attachments INSERT does on a
  // dropped connection or a statement timeout. A hung query stalls it outright.
  type Fault = "rejects" | "hangs";
  const faults: Fault[] = ["rejects", "hangs"];

  let teardown: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const t of teardown.reverse()) await t();
    teardown = [];
    warn.mockReset();
  });

  /** One replica on the fake bus, a client connected to it, its pool then broken. */
  async function replicaWithBrokenPool(fault: Fault) {
    const bus = new FakePgNotifyBus();
    const pool = bus.pool();
    const cluster = createPostgresClusterAdapter(pool);
    const httpServer = createHttpServer();
    const io = new SocketIOServer(httpServer, { adapter: cluster.adapter });
    teardown.push(() => cluster.close());
    teardown.push(() => io.close());
    await vi.waitFor(() => expect(bus.clients.size).toBe(1));
    io.on("connection", (s) => void s.join("room:r"));
    const port = await new Promise<number>((resolve) =>
      httpServer.listen(0, "127.0.0.1", () => resolve((httpServer.address() as AddressInfo).port)),
    );
    const client = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      reconnection: false,
    });
    teardown.push(() => void client.close());
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("connect_error", reject);
    });
    await vi.waitFor(() => expect(io.sockets.adapter.rooms.get("room:r")?.size).toBe(1));
    const sid = client.id!;
    pool.query = vi.fn(() =>
      fault === "rejects"
        ? Promise.reject(new Error("Connection terminated unexpectedly"))
        : new Promise(() => {}),
    ) as unknown as Pool["query"];
    return { io, client, sid, pool };
  }

  const payloads: Array<[string, () => unknown]> = [
    ["a small", () => ({ n: 1 })],
    ["a large (over NOTIFY's 8000 bytes)", () => ({ pad: "x".repeat(10_000) })],
    ["a binary", () => ({ blob: Buffer.from([1, 2, 3]) })],
  ];

  for (const fault of faults) {
    for (const [label, make] of payloads) {
      it(`delivers ${label} room emit to a socket on the same replica when the publish ${fault}`, async () => {
        const { io, client, pool } = await replicaWithBrokenPool(fault);
        const received: unknown[] = [];
        client.on("evt", (e: unknown) => received.push(e));

        io.to("room:r").emit("evt", make());

        await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 1_000 });
        expect(pool.query).toHaveBeenCalled();
      });
    }

    it(`disconnects a socket on the same replica when the publish ${fault}`, async () => {
      const { io, client } = await replicaWithBrokenPool(fault);
      let reason: string | null = null;
      client.on("disconnect", (r) => (reason = r));

      io.in("room:r").disconnectSockets(true);

      await vi.waitFor(() => expect(reason).toBe("io server disconnect"), { timeout: 1_000 });
    });

    it(`takes a socket on the same replica out of a room when the publish ${fault}`, async () => {
      const { io, sid } = await replicaWithBrokenPool(fault);

      io.in("room:r").socketsLeave("room:r");

      await vi.waitFor(
        () => expect(io.sockets.adapter.rooms.get("room:r")?.has(sid) ?? false).toBe(false),
        {
          timeout: 1_000,
        },
      );
    });

    it(`puts a socket on the same replica into a room when the publish ${fault}`, async () => {
      const { io, sid } = await replicaWithBrokenPool(fault);

      io.in("room:r").socketsJoin("room:joined");

      await vi.waitFor(
        () => expect(io.sockets.adapter.rooms.get("room:joined")?.has(sid)).toBe(true),
        {
          timeout: 1_000,
        },
      );
    });
  }

  it("logs a rejected publish as a warning", async () => {
    const { io } = await replicaWithBrokenPool("rejects");

    io.to("room:r").emit("evt", { pad: "x".repeat(10_000) });

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("this replica's sockets only"),
        expect.objectContaining({ error: "Connection terminated unexpectedly" }),
      ),
    );
  });

  it("deliverLocallyFirst logs a publish that throws synchronously and still resolves", async () => {
    const adapter = {
      publishAndReturnOffset: vi.fn((_m: { type?: number }): Promise<string> => {
        throw new Error("boom");
      }),
    };
    deliverLocallyFirst(adapter);

    await expect(adapter.publishAndReturnOffset({ type: 3 })).resolves.toBe("");
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("publish failed"),
        expect.objectContaining({ type: 3, error: "boom" }),
      ),
    );
  });
});

// #651 — presence re-lists its rooms when the adapter drops a dead peer replica.
describe("announceNodeRemoval", () => {
  it("emits ADAPTER_NODE_REMOVED_EVENT after the adapter drops a peer", () => {
    const order: string[] = [];
    const adapter = Object.assign(new EventEmitter(), {
      removeNode: vi.fn((uid: string) => void order.push(`removed ${uid}`)),
    });
    announceNodeRemoval(adapter);
    adapter.on(ADAPTER_NODE_REMOVED_EVENT, (uid: string) => order.push(`announced ${uid}`));

    adapter.removeNode("peer-1");

    expect(order).toEqual(["removed peer-1", "announced peer-1"]);
  });

  it("logs a listener that throws, so the adapter's sweep timer never sees it", () => {
    const adapter = Object.assign(new EventEmitter(), { removeNode: vi.fn() });
    announceNodeRemoval(adapter);
    adapter.on(ADAPTER_NODE_REMOVED_EVENT, () => {
      throw new Error("listener broke");
    });

    expect(() => adapter.removeNode("peer-1")).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("node-removal listener failed"), {
      error: "listener broke",
    });
  });

  it.each([
    ["missing", {}],
    ["not a function", { removeNode: "renamed" }],
  ])(
    "leaves an adapter whose removeNode is %s unpatched, and warns naming the version",
    (_label, extra) => {
      warn.mockClear();
      const adapter = Object.assign(new EventEmitter(), extra);

      expect(() => announceNodeRemoval(adapter)).not.toThrow();
      expect(announceNodeRemoval(adapter)).toBe(adapter);
      expect((adapter as { removeNode?: unknown }).removeNode).toBe(
        (extra as { removeNode?: unknown }).removeNode,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("socket.io-adapter 2.5.6"),
        expect.any(Object),
      );
    },
  );

  it("is installed on every namespace adapter createPostgresClusterAdapter builds", async () => {
    const bus = new FakePgNotifyBus();
    const cluster = createPostgresClusterAdapter(bus.pool(), {
      heartbeatInterval: 50,
      heartbeatTimeout: 100,
    });
    const peer = createPostgresClusterAdapter(bus.pool());
    const httpA = createHttpServer();
    const httpB = createHttpServer();
    const ioA = new SocketIOServer(httpA, { adapter: cluster.adapter });
    const ioB = new SocketIOServer(httpB, { adapter: peer.adapter });
    try {
      const removed = vi.fn();
      (ioA.of("/").adapter as unknown as EventEmitter).on(ADAPTER_NODE_REMOVED_EVENT, removed);
      await vi.waitFor(async () => expect(await ioA.of("/").adapter.serverCount()).toBe(2));

      await ioB.close();

      await vi.waitFor(() => expect(removed).toHaveBeenCalledOnce());
    } finally {
      await ioA.close();
      await Promise.all([cluster.close(), peer.close()]);
    }
  });
});
