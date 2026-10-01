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
 * Every adapter and pool error is logged, never thrown: evictions run after the
 * database write has committed (#588, #612), and an idle pool client's error
 * with no listener would crash the process.
 */
import pg from "pg";
import type { Pool } from "pg";
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
      log.warn("could not create the socket cluster adapter attachments table", {
        table: SOCKET_IO_ATTACHMENTS_TABLE,
        error: err.message,
      });
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

/**
 * The cluster adapter for this process: Postgres when the datasource is
 * Postgres, otherwise `null` (keep the in-memory adapter).
 */
export function resolveSocketClusterAdapter(
  env: NodeJS.ProcessEnv = process.env,
  makePool: (connectionString: string) => Pool = (connectionString) =>
    new pg.Pool({ connectionString, max: POOL_MAX }),
): SocketClusterAdapter | null {
  const url = env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) return null;
  return createPostgresClusterAdapter(makePool(url));
}
