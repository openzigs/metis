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
 * adapter is not installed at all: without its table every large or binary
 * emit's publish would fail, so no other replica would ever see one. The process
 * keeps the in-memory adapter and logs that cross-replica eviction is disabled.
 *
 * Local delivery never waits on the publish (`deliverLocallyFirst`). Upstream
 * (socket.io-adapter 2.5.6 `ClusterAdapter`), `broadcast`, `addSockets`,
 * `delSockets` and `disconnectSockets` each `await` the publish before the
 * local operation, and `broadcast` RETURNS from its catch without delivering
 * when the publish rejects. A small message's NOTIFY failure is swallowed
 * inside the Postgres adapter's own `publish`, but a large or binary one goes
 * through the attachments INSERT, whose rejection is not — so a dropped
 * connection, a failover, the 5 s statement / query timeout, or a 5 s wait for
 * the single non-`LISTEN` pool connection lost the emit for sockets on THIS
 * replica too, single-replica deployments included; and every other emit, join,
 * leave and disconnect sat behind the NOTIFY for up to that long. So the
 * adapter's `publishAndReturnOffset` is replaced, per instance, by one that
 * starts the real publish, logs its failure, and resolves at once. Every one of
 * those methods then runs its local operation a microtask later, whatever the
 * database does; peers still get the publish exactly as before.
 *
 * Ordering: the real publish is still STARTED synchronously, so the message is
 * serialised before the local operation mutates the packet (as upstream), and
 * publishes go out in call order (as upstream). Local operations now also run
 * in call order on the same microtask queue — upstream they ran in NOTIFY
 * completion order, which a large message's extra INSERT could reorder. Local
 * delivery no longer waits for peers to be told; nothing relied on that, and a
 * revocation (`disconnectSockets`, `socketsLeave`) now takes effect locally at
 * once instead of after a database round trip — the #613 epochs are bumped
 * before either is called and their `serverSideEmit` relay is unchanged. The
 * returned offset is `""`, which is what the Postgres adapter's `doPublish`
 * always returns (it does not support connection state recovery). The cost: a
 * publish that fails is lost to the OTHER replicas — cross-replica delivery
 * misses the outage window, as with a dropped `LISTEN` connection (#649). A lost
 * revocation still lands there: every clustered replica re-validates its sockets
 * on an interval (`SOCKET_REVALIDATE_INTERVAL_MS` in `server.ts`, #659).
 *
 * Reconnect window (#649): while a replica's `LISTEN` connection is down — the
 * ~1-3 s before the adapter reconnects after a failover, restart or
 * `pg_terminate_backend` — every NOTIFY is lost to it, and the adapter does not
 * replay. A SCIM deprovision, role change or MCP status eviction published then
 * never reaches that replica's sockets. So `onListening` fires each time the
 * `LISTEN` connection is (re)established — once its `LISTEN` statements have
 * all completed — and the socket server re-validates every socket it holds
 * against the database (`revalidateLocalSockets`). A revocation committed
 * during the outage is seen by that re-read; one committed after it arrives
 * over the restored `LISTEN`. It fires on the first connection too, which
 * covers sockets accepted before a boot-time `LISTEN` came up.
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
 * queues forever. The same leak follows a `LISTEN` that fails on a connection
 * still alive (say, on the 5 s statement timeout): the adapter retries on a new
 * client and abandons the old one unreleased, with no `end` to release it. So
 * a new `LISTEN` checkout first discards, as broken, any client still held
 * (`releaseSuperseded`).
 *
 * Timeouts (`socketClusterPoolConfig`): local delivery no longer waits on the
 * NOTIFY, but a connection attempt or a query that never answers would still
 * hold the pool's one NOTIFY connection, queueing every later publish behind it
 * forever. A bounded connect, a client-side query timeout and a server-side
 * statement timeout turn that hang into a failed publish — logged — within
 * seconds.
 */
import pg from "pg";
import type { Pool, PoolClient, PoolConfig } from "pg";
import { createAdapter } from "@socket.io/postgres-adapter";
import { createChildLogger } from "../logger.js";
import { ADAPTER_NODE_REMOVED_EVENT } from "./cluster-presence.js";

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
  /**
   * #649 — call `listener` every time the adapter's `LISTEN` connection is
   * (re)established. A throw from it is logged.
   */
  onListening(listener: () => void): void;
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

/** The adapter's peer heartbeat (#651 tests shorten it); omitted, upstream's 5 s / 10 s. */
export type SocketClusterHeartbeat = Pick<
  NonNullable<Parameters<typeof createAdapter>[1]>,
  "heartbeatInterval" | "heartbeatTimeout"
>;

/**
 * Build the cluster adapter over `pool`, which it owns from here on. The
 * attachments table must already exist (`ensureSocketClusterAttachmentsTable`).
 */
export function createPostgresClusterAdapter(
  pool: Pool,
  heartbeat: SocketClusterHeartbeat = {},
): SocketClusterAdapter {
  pool.on("error", (err) => {
    log.warn("socket cluster adapter pool error", { error: err.message });
  });
  // The adapter takes its LISTEN client with a bare `pool.connect()`; pg-pool's
  // own `pool.query` passes a callback and manages its client itself.
  const listeners: Array<() => void> = [];
  const listening = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        log.warn("socket cluster adapter listening hook failed", { error: (err as Error).message });
      }
    }
  };
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<PoolClient>;
  // The adapter keeps ONE LISTEN client (`PubSubClient.client`), so a new bare
  // checkout always supersedes the one held before it.
  let held: PoolClient | undefined;
  pool.connect = ((...args: unknown[]) => {
    if (args.length > 0) return connect(...args);
    releaseSuperseded(held);
    held = undefined;
    return connect().then((client) => {
      held = client;
      return holdListenClient(client, listening, () => {
        if (held === client) held = undefined;
      });
    });
  }) as Pool["connect"];

  const createNamespaceAdapter = createAdapter(pool, {
    ...heartbeat,
    tableName: SOCKET_IO_ATTACHMENTS_TABLE,
    errorHandler: (err: Error) => {
      log.warn("socket cluster adapter error", { error: err.message });
    },
  });
  // A `function`, not an arrow: Socket.IO calls it with `new`, and a
  // constructor that returns an object yields that object.
  const adapter = function (nsp: Parameters<typeof createNamespaceAdapter>[0]) {
    return announceNodeRemoval(deliverLocallyFirst(createNamespaceAdapter(nsp)));
  } as typeof createNamespaceAdapter;

  let ended: Promise<void> | undefined;
  return {
    adapter,
    onListening: (listener) => {
      listeners.push(listener);
    },
    close: () => (ended ??= pool.end()),
  };
}

/** The protected `ClusterAdapter` method every cluster-wide operation awaits. */
interface ClusterPublisher {
  publishAndReturnOffset(message: { type?: number }): Promise<string>;
}

/**
 * Make `adapter`'s local operations independent of its publish; see the module
 * header. The publish is started synchronously and its failure logged, never
 * thrown; the operation awaiting it resumes at once.
 */
export function deliverLocallyFirst<T extends object>(adapter: T): T {
  const target = adapter as unknown as ClusterPublisher;
  const publish = target.publishAndReturnOffset.bind(adapter);
  target.publishAndReturnOffset = (message) => {
    let sent: Promise<string>;
    try {
      sent = publish(message);
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent.catch((err: unknown) => {
      log.warn(
        "socket cluster adapter publish failed — the operation reached this replica's sockets only",
        { type: message.type, error: err instanceof Error ? err.message : String(err) },
      );
    });
    return Promise.resolve("");
  };
  return adapter;
}

/** The protected `ClusterAdapterWithHeartbeat` method that drops a peer replica. */
interface NodeRemover {
  removeNode(uid: string): void;
  emit(event: string, ...args: unknown[]): boolean;
}

/**
 * #651 — emit `ADAPTER_NODE_REMOVED_EVENT` on `adapter` each time it drops a
 * peer replica: socket.io-adapter 2.5.6 `ClusterAdapterWithHeartbeat.removeNode`
 * runs when a peer's heartbeat lapses (`heartbeatTimeout`, swept every second)
 * or the peer closes its adapter, and announces nothing. Presence
 * (`cluster-presence.ts`) re-lists its rooms on it, so a replica that died
 * without its sockets disconnecting stops counting. A throw from a listener is
 * logged: the adapter's own sweep timer calls this.
 *
 * `removeNode` is protected, not public API, and `@socket.io/postgres-adapter`
 * 0.5.0 accepts `socket.io-adapter` `^2.5.4`. If an upgrade drops it, the
 * adapter is returned unpatched with a warning: everything works except the
 * dead-replica re-list (a dead replica's viewers then stay listed until the
 * room's next change, or the next partition heal). `socket.io-adapter` is
 * deliberately NOT pinned (no direct dependency, no pnpm override): the
 * lockfile already fixes 2.5.6 under `--frozen-lockfile`, so it moves only in a
 * reviewed lockfile change, where the "is installed on every namespace adapter"
 * test fails if the method is gone — and a pin would hold back that package's
 * security fixes.
 */
export function announceNodeRemoval<T extends object>(adapter: T): T {
  const target = adapter as unknown as Partial<NodeRemover> & Pick<NodeRemover, "emit">;
  if (typeof target.removeNode !== "function") {
    log.warn(
      "socket cluster adapter has no removeNode (written against socket.io-adapter 2.5.6) — a dead replica's presence is not re-listed until the room's next change",
      { removeNode: typeof target.removeNode },
    );
    return adapter;
  }
  const removeNode = target.removeNode.bind(adapter);
  target.removeNode = (uid) => {
    removeNode(uid);
    try {
      target.emit(ADAPTER_NODE_REMOVED_EVENT, uid);
    } catch (err) {
      log.warn("socket cluster adapter node-removal listener failed", {
        error: (err as Error).message,
      });
    }
  };
  return adapter;
}

/**
 * Guard the adapter's long-held `LISTEN` client, and call `listening` once its
 * `LISTEN` statements have all succeeded; see the module header. `onRelease`
 * runs on the client's first release, whoever releases it; a later release is
 * a no-op, so the adapter's own close() can never double-release a client
 * `releaseSuperseded` already discarded.
 */
function holdListenClient(
  client: PoolClient,
  listening: () => void,
  onRelease: () => void,
): PoolClient {
  client.on("error", (err) => {
    log.warn("socket cluster adapter connection error", { error: err.message });
  });
  const release = client.release.bind(client);
  let released = false;
  client.release = ((err?: Error | boolean) => {
    if (released) return;
    released = true;
    onRelease();
    release(err);
  }) as PoolClient["release"];
  // The adapter's own close() strips every `end` listener before it releases
  // the client, so this fires only for a connection lost while held.
  client.once("end", () => {
    client.release(new Error("socket cluster adapter LISTEN connection ended"));
  });
  notifyWhenListening(client, listening);
  return client;
}

/**
 * Discard a `LISTEN` client the adapter has abandoned but never released.
 * Upstream `PubSubClient.initClient` (`@socket.io/postgres-adapter@0.5.0`
 * `dist/util.js` L91-99), when a `LISTEN` rejects on a connection that is still
 * alive, schedules a retry on a new client without releasing this one, and no
 * `end` ever comes to release it here: it keeps its slot, so with `POOL_MAX` 2
 * the retry's client fills the pool and every NOTIFY times out. Its `end`
 * listeners are stripped first, as the adapter's close() does: otherwise the
 * adapter's would schedule yet another reconnect when the pool ends it, and
 * this module's would release it a second time.
 */
function releaseSuperseded(client: PoolClient | undefined): void {
  if (!client) return;
  log.warn("socket cluster adapter replaced a LISTEN client it never released — discarding it");
  client.removeAllListeners("end");
  client.release(new Error("socket cluster adapter LISTEN client superseded"));
}

/**
 * Call `listening` once, after the `LISTEN` statements the adapter issues on
 * `client` have all succeeded. The adapter awaits them one after another, each
 * issued in the previous one's continuation, so a check deferred to the next
 * macrotask sees the next one already pending. A failed `LISTEN` never fires:
 * the adapter then retries on a new client, which fires instead.
 */
function notifyWhenListening(client: PoolClient, listening: () => void): void {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  let pending = 0;
  let failed = false;
  let fired = false;
  client.query = ((...args: unknown[]) => {
    const result = query(...args);
    if (typeof args[0] !== "string" || !args[0].startsWith("LISTEN ")) return result;
    pending++;
    Promise.resolve(result).then(
      () => {
        pending--;
        setImmediate(() => {
          if (pending > 0 || failed || fired) return;
          fired = true;
          listening();
        });
      },
      () => {
        pending--;
        failed = true;
      },
    );
    return result;
  }) as PoolClient["query"];
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
