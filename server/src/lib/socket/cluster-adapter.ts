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
 * Selection (`selectSocketClusterAdapter`) follows the datasource, as the
 * reindex lease's does: a Postgres `DATABASE_URL` gets the cluster adapter,
 * anything else (SQLite dev, unset) keeps the in-memory adapter with no new
 * config. `NODE_ENV=test` never selects it, so a Postgres `DATABASE_URL` in the
 * unit suite opens no pool. A single-replica Postgres deployment pays one held
 * `LISTEN` connection and a small pool (`POOL_MAX` connections per replica).
 *
 * The adapter stores a message over Postgres' 8000-byte NOTIFY limit, or one
 * carrying binary, in an attachments table. Like the other shared Postgres
 * backends it is self-created (UNLOGGED, behind an advisory lock), not migrated.
 * The table is created BEFORE the adapter is installed, and if that fails the
 * adapter is not installed at all: socket.io-adapter's `broadcast` returns
 * before its local delivery when the publish rejects, so an adapter without its
 * table would drop every large or binary emit even for sockets on the same
 * replica. The process keeps the in-memory adapter and logs that cross-replica
 * eviction is disabled.
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
 *
 * Timeouts (`socketClusterPoolConfig`): a broadcast awaits its NOTIFY before the
 * local delivery, so a connection attempt or a query that never answers would
 * stall every emit on this replica. A bounded connect, a client-side query
 * timeout and a server-side statement timeout turn that hang into a rejected
 * publish — logged by the error handler — within seconds.
 */
import pg from "pg";
import type { Pool, PoolClient, PoolConfig } from "pg";
import { createAdapter } from "@socket.io/postgres-adapter";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket-cluster-adapter");

/** The adapter's default attachments table name, created here. */
export const SOCKET_IO_ATTACHMENTS_TABLE = "socket_io_attachments";

/** Advisory lock serialising the table creation across replicas booting together. */
const TABLE_LOCK_ID = 622_000_001;

/** One connection held for `LISTEN`, one for `NOTIFY` / attachment I/O. */
const POOL_MAX = 2;

/**
 * The adapter pool's bounds (see the module header). A NOTIFY, an attachment
 * INSERT / SELECT and the 30 s cleanup DELETE are all single-row or indexed
 * statements on an UNLOGGED table, so 5 s is generous for each while still
 * failing a hung connection well inside a client's patience. The idle timeout
 * applies to the NOTIFY connection only — the `LISTEN` client is never idle in
 * the pool.
 */
export const SOCKET_CLUSTER_POOL_TIMEOUTS = Object.freeze({
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 5_000,
  statement_timeout: 5_000,
});

/** The `pg.Pool` config for the adapter's pool. */
export function socketClusterPoolConfig(connectionString: string): PoolConfig {
  return { connectionString, max: POOL_MAX, ...SOCKET_CLUSTER_POOL_TIMEOUTS };
}

export interface SocketClusterAdapter {
  /** Pass as `new Server(httpServer, { adapter })`. */
  adapter: ReturnType<typeof createAdapter>;
  /** End the adapter's pool. Call after `io.close()`, which releases its `LISTEN` client. */
  close(): Promise<void>;
}

/**
 * Create the adapter's attachments table if it is missing. Rejects when it
 * cannot be created (typically: the database user lacks CREATE on the schema).
 */
export async function ensureSocketClusterAttachmentsTable(pool: Pool): Promise<void> {
  await pool.query(
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
  );
}

/**
 * Build the cluster adapter over `pool`, which it owns from here on. The
 * attachments table must already exist (`ensureSocketClusterAttachmentsTable`).
 */
export function createPostgresClusterAdapter(pool: Pool): SocketClusterAdapter {
  pool.on("error", (err) => {
    log.warn("socket cluster adapter pool error", { error: err.message });
  });
  // The adapter takes its LISTEN client with a bare `pool.connect()`; pg-pool's
  // own `pool.query` passes a callback and manages its client itself.
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient>;
  pool.connect = ((...args: unknown[]) =>
    args.length > 0 ? connect(...args) : connect().then(holdListenClient)) as Pool["connect"];

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
 * The Postgres URL the cluster adapter should use in this process, or `null`
 * to keep the in-memory adapter: not under `NODE_ENV=test`, and only for a
 * Postgres datasource.
 */
export function selectSocketClusterAdapter(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV === "test") return null;
  // Trimmed, as `resolveDatabaseProvider` (lib/prisma.ts) trims it: otherwise a
  // stray leading space puts Prisma on Postgres and the sockets in memory.
  const url = (env.DATABASE_URL ?? "").trim();
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) return null;
  return url;
}

/**
 * The cluster adapter for this process, ready to install: Postgres when
 * `selectSocketClusterAdapter` picks it and its attachments table is in place,
 * otherwise `null` (keep the in-memory adapter). Never rejects.
 */
export async function resolveSocketClusterAdapter(
  env: NodeJS.ProcessEnv = process.env,
  makePool: (connectionString: string) => Pool = (connectionString) =>
    new pg.Pool(socketClusterPoolConfig(connectionString)),
): Promise<SocketClusterAdapter | null> {
  const url = selectSocketClusterAdapter(env);
  if (!url) return null;
  const pool = makePool(url);
  try {
    await ensureSocketClusterAttachmentsTable(pool);
  } catch (err) {
    log.error(
      "could not create the socket cluster adapter attachments table — the database user needs " +
        "CREATE on the schema. Cross-replica socket eviction is DISABLED: this replica keeps the " +
        "in-memory adapter, so SCIM deprovisions, role changes and MCP status evictions reach " +
        "only the sockets connected to it",
      { table: SOCKET_IO_ATTACHMENTS_TABLE, error: (err as Error).message },
    );
    await pool.end().catch(() => {});
    return null;
  }
  return createPostgresClusterAdapter(pool);
}
