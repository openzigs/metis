/**
 * #622 — an in-process stand-in for Postgres `LISTEN` / `pg_notify`, shaped as
 * the slice of `pg.Pool` that `@socket.io/postgres-adapter` uses: `connect()`
 * hands out a listening client, `query("SELECT pg_notify($1, $2)")` delivers the
 * payload to every client LISTENing on that channel, and every other statement
 * (the attachments table DDL and cleanup) is recorded and answered empty.
 * A client is a real EventEmitter — so an `error` emitted on a checked-out
 * client with no listener throws, as a dropped real `LISTEN` connection's does —
 * and, like pg-pool's, its `release` throws when called twice.
 *
 * One bus with one pool per replica stands for one shared database, so the real
 * adapter and real Socket.IO servers can be driven across "replicas" in the
 * default unit suite, without a live Postgres. The real-Postgres proof of the
 * same scenarios is `socket-cluster-adapter-postgres.integration.test.ts`.
 */
import { EventEmitter } from "node:events";
import type { Pool } from "pg";

class FakeListenClient extends EventEmitter {
  readonly channels = new Set<string>();
  released = false;
  /** The error passed to `release`, which tells pg-pool to discard the client. */
  releasedWith: Error | undefined;

  constructor(
    private readonly bus: FakePgNotifyBus,
    /** The pool that checked this client out. */
    readonly pool: object,
  ) {
    super();
  }

  async query(sql: string): Promise<{ rows: never[] }> {
    const listen = /^LISTEN "(.+)"$/.exec(sql.trim());
    if (listen) this.channels.add(listen[1]);
    return { rows: [] };
  }

  release(err?: Error): void {
    if (this.released)
      throw new Error("Release called on client which has already been released to the pool.");
    this.released = true;
    this.releasedWith = err;
    this.bus.clients.delete(this);
  }
}

export class FakePgNotifyBus {
  readonly clients = new Set<FakeListenClient>();
  /** Every non-notify statement any pool ran, in order. */
  readonly statements: string[] = [];
  /**
   * #651 — pools cut off from the bus (`sever`): they neither send nor receive,
   * and a new connection waits on the promise until `restore`.
   */
  private readonly severed = new Map<object, { healed: Promise<void>; heal: () => void }>();

  /**
   * #651 — cut `pool`'s replica off the database without closing anything, as a
   * replica that dies (or freezes) looks to its peers: its NOTIFYs stop arriving
   * and it hears nothing, while its own sockets stay connected to it. A
   * `connect()` meanwhile — the adapter re-establishing a dropped `LISTEN` —
   * waits until `restore`.
   */
  sever(pool: object): void {
    if (this.severed.has(pool)) return;
    let heal = () => {};
    const healed = new Promise<void>((r) => (heal = r));
    this.severed.set(pool, { healed, heal });
  }

  /** #651 — heal a `sever`: the pool sends and receives again, and connects resume. */
  restore(pool: object): void {
    this.severed.get(pool)?.heal();
    this.severed.delete(pool);
  }

  /** A pool for one replica. `ended` flips when the adapter's owner ends it. */
  pool(): Pool & { ended: boolean } {
    const emitter = new EventEmitter();
    const pool = Object.assign(emitter, {
      ended: false,
      connect: async () => {
        await this.severed.get(pool)?.healed;
        const client = new FakeListenClient(this, pool);
        this.clients.add(client);
        return client;
      },
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("pg_notify")) {
          if (this.severed.has(pool)) return { rows: [] };
          const [channel, payload] = params as [string, string];
          // Postgres delivers NOTIFY asynchronously, after the statement returns.
          setImmediate(() => {
            for (const client of this.clients) {
              if (client.channels.has(channel) && !this.severed.has(client.pool)) {
                client.emit("notification", { channel, payload });
              }
            }
          });
          return { rows: [] };
        }
        this.statements.push(sql);
        return { rows: [] };
      },
      end: async () => {
        pool.ended = true;
      },
    });
    return pool as unknown as Pool & { ended: boolean };
  }
}
