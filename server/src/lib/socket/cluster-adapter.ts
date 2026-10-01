/**
 * #622 — the Socket.IO cluster adapter that makes room operations reach every
 * replica.
 *
 * With Socket.IO's default in-memory adapter, `io.in(room).disconnectSockets()`,
 * `socketsLeave()` and `io.to(room).emit()` reach only the sockets connected to
 * the replica that runs them, so a SCIM deprovision or an MCP status eviction
 * missed every socket held by another replica. `@socket.io/postgres-adapter`
 * relays those operations over Postgres `LISTEN` / `NOTIFY` on the database the
 * deployment already shares — no new managed service.
 *
 * Selection follows the datasource, as the reindex lease's does:
 * a Postgres `DATABASE_URL` gets the cluster adapter, anything else (SQLite dev,
 * unset) keeps the in-memory adapter with no new config. A single-replica
 * Postgres deployment pays one held `LISTEN` connection and a small pool
 * (`POOL_MAX` connections per replica).
 *
 * The adapter stores a message over Postgres' 8000-byte NOTIFY limit, or one
 * carrying binary, in an attachments table. Like the other shared Postgres
 * backends it is self-created (UNLOGGED, behind an advisory lock), not migrated.
 *
 * Every adapter, pool and connection error is logged, never thrown: evictions
 * run after the database write has committed (#588, #612), and a pg client's
 * `error` with no listener crashes the process. `pool.on("error")` covers idle
 * clients only — pg-pool removes its idle listener from a client it hands out —
 * and the adapter's `LISTEN` client is held checked out for the process's life.
 * Postgres drops that connection on a failover, restart, `pg_terminate_backend`
 * or TCP timeout, so `holdListenClient` gives it its own `error` listener, and on
 * its `end` releases it to the pool as broken: the adapter reconnects on `end`
 * but never releases the dead client, which would keep its slot — with
 * `POOL_MAX` 2, the new `LISTEN` client then fills the pool and every NOTIFY
 * queues forever.
 */
import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { createAdapter } from "@socket.io/postgres-adapter";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket-cluster-adapter");

/** The adapter's default attachments table name, created here. */
export const SOCKET_IO_ATTACHMENTS_TABLE = "socket_io_attachments";

/** Advisory lock serialising the table creation across replicas booting together. */
const TABLE_LOCK_ID = 622_000_001;

/** One connection held for `LISTEN`, one for `NOTIFY` / attachment I/O. */
const POOL_MAX = 2;

export interface SocketClusterAdapter {
  /** Pass as `new Server(httpServer, { adapter })`. */
  adapter: ReturnType<typeof createAdapter>;
  /** End the adapter's pool. Call after `io.close()`, which releases its `LISTEN` client. */
  close(): Promise<void>;
}

/** Build the cluster adapter over `pool`, which it owns from here on. */
export function createPostgresClusterAdapter(pool: Pool): SocketClusterAdapter {
  pool.on("error", (err) => {
    log.warn("socket cluster adapter pool error", { error: err.message });
  });
  // The adapter takes its LISTEN client with a bare `pool.connect()`; pg-pool's
  // own `pool.query` passes a callback and manages its client itself.
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient>;
  pool.connect = ((...args: unknown[]) =>
    args.length > 0 ? connect(...args) : connect().then(holdListenClient)) as Pool["connect"];

  pool
    .query(
      `DO $$
       BEGIN
         PERFORM pg_advisory_xact_lock(${TABLE_LOCK_ID});
         CREATE UNLOGGED TABLE IF NOT EXISTS ${SOCKET_IO_ATTACHMENTS_TABLE} (
           id         bigserial UNIQUE,
           created_at timestamptz DEFAULT NOW(),
           payload    bytea
         );
       EXCEPTION WHEN duplicate_table OR duplicate_object THEN
         NULL;
       END $$;`,
    )
    .catch((err: Error) => {
      // Once, at boot: without the table the adapter's 30 s cleanup DELETE warns
      // on every tick, which reads as a transient fault rather than a grant.
      log.error(
        "could not create the socket cluster adapter attachments table — the database user needs CREATE on the schema",
        { table: SOCKET_IO_ATTACHMENTS_TABLE, error: err.message },
      );
    });

  const adapter = createAdapter(pool, {
    tableName: SOCKET_IO_ATTACHMENTS_TABLE,
    errorHandler: (err: Error) => {
      log.warn("socket cluster adapter error", { error: err.message });
    },
  });

  let ended: Promise<void> | undefined;
  return {
    adapter,
    close: () => (ended ??= pool.end()),
  };
}

/** Guard the adapter's long-held `LISTEN` client; see the module header. */
function holdListenClient(client: PoolClient): PoolClient {
  client.on("error", (err) => {
    log.warn("socket cluster adapter connection error", { error: err.message });
  });
  // The adapter's own close() strips every `end` listener before it releases
  // the client, so this fires only for a connection lost while held.
  client.once("end", () => {
    client.release(new Error("socket cluster adapter LISTEN connection ended"));
  });
  return client;
}

/**
 * The cluster adapter for this process: Postgres when the datasource is
 * Postgres, otherwise `null` (keep the in-memory adapter).
 */
export function resolveSocketClusterAdapter(
  env: NodeJS.ProcessEnv = process.env,
  makePool: (connectionString: string) => Pool = (connectionString) =>
    new pg.Pool({ connectionString, max: POOL_MAX }),
): SocketClusterAdapter | null {
  // Trimmed, as `resolveDatabaseProvider` (lib/prisma.ts) trims it: otherwise a
  // stray leading space puts Prisma on Postgres and the sockets in memory.
  const url = (env.DATABASE_URL ?? "").trim();
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) return null;
  return createPostgresClusterAdapter(makePool(url));
}
